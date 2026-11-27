function syncStatus(message,cls){
  var el=$('#syncStatus');if(!el)return;
  el.textContent='Синхронизация: '+message;
  el.className='note'+(cls?' '+cls:'');
}
function remoteSyncRequest(action,state){
  if(!BACKEND_API_BASE||!TG||!TG.initData)throw new Error('Откройте Mini App из Telegram для синхронизации.');
  var payload={action:action,initData:TG.initData};
  if(state)payload.state=state;
  return fetch(BACKEND_API_BASE+'/api/sync',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(75000)
  }).then(async function(response){
    var data=await response.json().catch(function(){return{}});
    if(!response.ok||!data.ok)throw new Error(data.error||('HTTP '+response.status));
    return data.state||{};
  });
}
function syncSettingsPayload(){
  return {
    systemPrompt:String(S.cfg.sys||'').slice(0,20000),
    temperature:S.cfg.temp===''?null:Math.max(0,Math.min(2,Number(S.cfg.temp)||0)),
    maxTokens:S.cfg.max===''?1200:Math.max(1,Math.min(32000,Math.round(Number(S.cfg.max)||1200))),
    reasoning:String(S.cfg.reasoning||'auto'),
    balBase:S.cfg.balBase===''?null:Number(S.cfg.balBase),
    balUsage:Math.max(0,Number(S.cfg.balUsage)||0),
    minBal:Math.max(0,Math.min(10000,Number(S.cfg.minBal)||0)),
    internetSearch:!!S.cfg.internet,
    sandbox:!!S.cfg.sandbox,
    sandboxInternet:!!S.cfg.sandboxInternet,
    sandboxTimeout:Math.max(1,Math.min(3600,Math.round(Number(S.cfg.sandboxTimeout)||60))),
    requestTimeoutSeconds:Math.max(10,Math.min(7200,Math.round(Number(S.cfg.requestTimeoutSeconds)||120))),
    multiAgent:!!S.cfg.multiAgent,
    agentCount:Math.max(1,Math.min(20,Math.round(Number(S.cfg.agentCount)||3))),
    autoMemory:!!S.cfg.auto,
    askCode:!!S.cfg.askCode,
    balanceCheck:!!S.cfg.balOn,
    sumAt:Math.max(2000,Math.min(2000000,Math.round(Number(S.cfg.sumAt)||10000))),
    keep:Math.max(2,Math.min(100,Math.round(Number(S.cfg.keep)||4))),
    pinCap:Math.max(300,Math.min(100000,Math.round(Number(S.cfg.pinCap)||4000)))
  };
}
function makeRemoteSyncState(includeApiKey,clearApiKey){
  var chats=S.chats.slice().sort(function(a,b){return(Number(b.ts)||0)-(Number(a.ts)||0)}).slice(0,40).map(function(chat){
    var messages=(chat.msgs||[]).filter(function(m){return m&&(m.role==='user'||m.role==='assistant')&&typeof m.content==='string'})
      .slice(-25).map(function(m){
        if(!m.id)m.id=makeId();
        var content=String(m.content||'');
        if(m.role==='user'&&Array.isArray(m.attachments)){
          m.attachments.forEach(function(file){if(file&&typeof file.text==='string'&&file.text)content+='\n\n[Файл '+String(file.name||'attachment').slice(0,100)+']\n'+file.text.slice(0,2500)});
        }
        return {id:String(m.id).slice(0,160),role:m.role,content:content.slice(0,2500),createdAt:Number(m.ts)||Number(chat.ts)||Date.now()};
      });
    return {id:String(chat.id).slice(0,128),title:String(chat.title||'Чат').slice(0,100),model:String(chat.model||S.cfg.model||'').slice(0,256),createdAt:Number(chat.createdAt)||Number(chat.ts)||Date.now(),updatedAt:Number(chat.updatedAt)||Number(chat.ts)||Date.now(),messages:messages};
  });
  var activeProvider=activeProviderProfile();
  var state={apiBaseUrl:S.cfg.url,apiProviderId:activeProvider.catalogId||activeProvider.id,apiProtocol:S.cfg.protocol||'openai',apiAuthType:S.cfg.authType||'bearer',modelsEndpoint:S.cfg.modelsEndpoint!==false,model:S.cfg.model,settings:syncSettingsPayload(),activeChatId:S.cur,chats:chats};
  if(includeApiKey&&ACTIVE_KEY)state.apiKey=ACTIVE_KEY;
  if(clearApiKey)state.clearApiKey=true;
  return state;
}
function mergeRemoteChats(remoteChats,resetModels){
  if(!Array.isArray(remoteChats))return;
  var byId=Object.create(null);
  S.chats.forEach(function(chat){byId[String(chat.id)]=chat});
  remoteChats.forEach(function(remote){
    if(!remote||typeof remote.id!=='string')return;
    var chat=byId[remote.id];
    if(!chat){
      chat={id:remote.id,title:String(remote.title||'Чат'),msgs:[],model:resetModels?S.cfg.model:(remote.model||S.cfg.model),draft:'',draftAttachments:[],ts:Number(remote.updatedAt)||Date.now(),createdAt:Number(remote.createdAt)||Date.now()};
      S.chats.push(chat);byId[remote.id]=chat;
    }
    var localByMessage={};
    (chat.msgs||[]).forEach(function(message){if(message&&message.id)localByMessage[String(message.id)]=message});
    (remote.messages||[]).forEach(function(message){
      if(!message||!message.id||!['user','assistant'].includes(message.role)||typeof message.content!=='string')return;
      var existing=localByMessage[String(message.id)];
      if(existing){if(!existing.content&&message.content)existing.content=message.content;return}
      var imported={id:String(message.id),role:message.role,content:message.content,ts:Number(message.createdAt)||Number(remote.updatedAt)||Date.now()};
      chat.msgs.push(imported);localByMessage[imported.id]=imported;
    });
    chat.msgs.sort(function(a,b){return(Number(a.ts)||0)-(Number(b.ts)||0)});
    var remoteUpdated=Number(remote.updatedAt)||0;
    if(remoteUpdated>=(Number(chat.updatedAt)||Number(chat.ts)||0)){
      if(remote.title)chat.title=String(remote.title).slice(0,100);
      if(resetModels)chat.model=S.cfg.model||'';
      else if(remote.model)chat.model=String(remote.model).slice(0,256);
    }
    chat.ts=Math.max(Number(chat.ts)||0,remoteUpdated);
    chat.updatedAt=Math.max(Number(chat.updatedAt)||0,remoteUpdated);
    if(!chat.createdAt)chat.createdAt=Number(remote.createdAt)||chat.ts;
  });
  S.chats.sort(function(a,b){return(Number(b.ts)||0)-(Number(a.ts)||0)});
}
async function applyRemoteSyncState(state){
  if(!state)return;
  var plan=state.plan||null;
  ACCOUNT_PLAN={tier:plan&&plan.tier==='pro'?'pro':(state.pro&&state.pro.active?'pro':'free'),
    pro:!!(plan&&plan.tier==='pro')||!!(state.pro&&state.pro.active),
    admin:!!(plan&&plan.admin),limits:plan&&plan.limits||null,
    expiresAt:Number(plan&&plan.expiresAt)||0};
  if(state.initialized!==true){if(typeof updatePlanUi==='function')updatePlanUi();return;}
  var previousBase=S.cfg.url;
  var previousCatalog=PROVIDER_CATALOG.find(function(item){return item.url===previousBase})||null;
  var previousProviderId=previousCatalog?previousCatalog.id:null;
  var nextBase=typeof state.apiBaseUrl==='string'&&validApiBase(state.apiBaseUrl)?state.apiBaseUrl:previousBase;
  var nextCatalog=PROVIDER_CATALOG.find(function(item){return item.id===state.apiProviderId||item.url===nextBase})||null;
  var nextProviderId=state.apiProviderId|| (nextCatalog?nextCatalog.id:null);
  var providerChanged=previousBase!==nextBase || (!!previousProviderId&&!!nextProviderId&&previousProviderId!==nextProviderId);
  if(typeof state.apiBaseUrl==='string'&&validApiBase(state.apiBaseUrl)){
    S.cfg.url=state.apiBaseUrl;
    if(providerChanged){
      S.cfg.model=typeof state.model==='string'?state.model:'';
      S.cfg.models=S.cfg.model?[S.cfg.model]:[];
      S.chats.forEach(function(chat){chat.model=S.cfg.model});
      if(nextCatalog){
        var activeProfile=(S.cfg.providers||[]).find(function(profile){return profile.url===S.cfg.url||profile.catalogId===nextCatalog.id});
        if(!activeProfile&&S.cfg.providers.length<30){
          activeProfile={id:'catalog_'+nextCatalog.id,catalogId:nextCatalog.id,name:nextCatalog.name,url:nextBase,model:S.cfg.model,models:S.cfg.models.slice(),protocol:nextCatalog.protocol||'openai',authType:nextCatalog.authType||'bearer',modelsEndpoint:nextCatalog.modelsEndpoint!==false,chatPath:nextCatalog.chatPath,responsesPath:nextCatalog.responsesPath,messagesPath:nextCatalog.messagesPath,modelsPath:nextCatalog.modelsPath,responsesModels:nextCatalog.responsesModels,responsesImages:nextCatalog.responsesImages,notice:nextCatalog.notice};
          S.cfg.providers.push(activeProfile);
        }
        if(!activeProfile){
          activeProfile=activeProviderProfile();
          activeProfile.catalogId=nextCatalog.id;
          activeProfile.name=nextCatalog.name;
        }
        activeProfile.url=S.cfg.url;
        activeProfile.protocol=nextCatalog.protocol==='responses'?'responses':(state.apiProtocol||nextCatalog.protocol||'openai');
        activeProfile.authType=state.apiAuthType||nextCatalog.authType||'bearer';
        ['chatPath','responsesPath','messagesPath','modelsPath','responsesModels','responsesImages','notice'].forEach(function(key){
          if(activeProfile[key]===undefined&&nextCatalog[key]!==undefined)activeProfile[key]=nextCatalog[key];
        });
        activeProfile.modelsEndpoint=typeof state.modelsEndpoint==='boolean'?state.modelsEndpoint:nextCatalog.modelsEndpoint!==false;
        activeProfile.model=S.cfg.model;
        activeProfile.models=S.cfg.models.slice();
        S.cfg.activeProviderId=activeProfile.id;
      }
    }
    if(providerChanged){
      ACTIVE_KEY='';keyInputTouched=false;keyStorageStatus='loading';
      if(secureKeyStorage&&secureKeyStorage.isAvailable()){
        try{
          var restored=await secureKeyStorage.load(S.cfg.url);
          if(restored.matches&&restored.key){ACTIVE_KEY=restored.key;keyStorageStatus='saved'}
          else keyStorageStatus=restored.found?'other-provider':'empty';
        }catch(error){keyStorageStatus='error'}
      }
    }
  }
  if(state.apiProtocol==='anthropic'||state.apiProtocol==='openai'||state.apiProtocol==='responses')S.cfg.protocol=state.apiProtocol;
  if(['bearer','key','api-key','x-api-key'].indexOf(state.apiAuthType)>=0)S.cfg.authType=state.apiAuthType;
  if(typeof state.modelsEndpoint==='boolean')S.cfg.modelsEndpoint=state.modelsEndpoint;
  if(typeof state.model==='string'){
    if(state.model.trim()){
      S.cfg.model=state.model;addSavedModel(state.model);
    }else if(providerChanged){
      S.cfg.model='';S.cfg.models=[];
    }
  }
  var settings=state.settings||{};
  if(Object.prototype.hasOwnProperty.call(settings,'systemPrompt')&&typeof settings.systemPrompt==='string')S.cfg.sys=settings.systemPrompt;
  if(Object.prototype.hasOwnProperty.call(settings,'temperature')){
    if(settings.temperature===null||settings.temperature===undefined)S.cfg.temp='';
    else if(Number.isFinite(Number(settings.temperature)))S.cfg.temp=String(settings.temperature);
  }
  if(Object.prototype.hasOwnProperty.call(settings,'maxTokens')&&Number.isFinite(Number(settings.maxTokens)))S.cfg.max=String(settings.maxTokens);
  if(typeof settings.reasoning==='string'&&['auto','minimal','low','medium','high','xhigh'].includes(settings.reasoning))S.cfg.reasoning=settings.reasoning;
  if(Object.prototype.hasOwnProperty.call(settings,'balBase'))S.cfg.balBase=settings.balBase===null?'':String(settings.balBase);
  if(Number.isFinite(Number(settings.balUsage)))S.cfg.balUsage=Math.max(0,Number(settings.balUsage));
  if(Number.isFinite(Number(settings.minBal)))S.cfg.minBal=Math.max(0,Math.min(10000,Number(settings.minBal)));
  if(typeof settings.internetSearch==='boolean')S.cfg.internet=settings.internetSearch;
  if(typeof settings.sandbox==='boolean')S.cfg.sandbox=settings.sandbox;
  if(typeof settings.sandboxInternet==='boolean')S.cfg.sandboxInternet=settings.sandboxInternet;
  if(Number.isFinite(Number(settings.sandboxTimeout)))S.cfg.sandboxTimeout=settings.sandboxTimeout;
  if(Number.isFinite(Number(settings.requestTimeoutSeconds)))S.cfg.requestTimeoutSeconds=Math.max(10,Math.min(7200,Math.round(Number(settings.requestTimeoutSeconds))));
  if(typeof settings.multiAgent==='boolean')S.cfg.multiAgent=settings.multiAgent;
  if(Number.isFinite(Number(settings.agentCount)))S.cfg.agentCount=settings.agentCount;
  if(typeof settings.autoMemory==='boolean')S.cfg.auto=settings.autoMemory;
  if(typeof settings.askCode==='boolean')S.cfg.askCode=settings.askCode;
  if(typeof settings.balanceCheck==='boolean')S.cfg.balOn=settings.balanceCheck;
  if(Number.isFinite(Number(settings.sumAt)))S.cfg.sumAt=settings.sumAt;
  if(Number.isFinite(Number(settings.keep)))S.cfg.keep=settings.keep;
  if(Number.isFinite(Number(settings.pinCap)))S.cfg.pinCap=settings.pinCap;
  mergeRemoteChats(state.chats,providerChanged);
  if(typeof state.activeChatId==='string'&&S.chats.some(function(chat){return chat.id===state.activeChatId}))S.cur=state.activeChatId;
  if(typeof state.apiKey==='string'&&state.apiKey&&state.apiKey!==ACTIVE_KEY){
    ACTIVE_KEY=state.apiKey;providerKeyMemory[keyApiBase()]=state.apiKey;
    if(secureKeyStorage&&secureKeyStorage.isAvailable()){
      try{await secureKeyStorage.save(S.cfg.url,ACTIVE_KEY);keyStorageStatus='saved'}
      catch(error){keyStorageStatus='save-error'}
    }else keyStorageStatus=TG?'unsupported':'outside';
  }
  syncApplying=true;
  saveNow();
  syncApplying=false;
  fillChatModel();updSub();
  if($('#sheet').className==='on')fillSet();
}
async function pullRemoteSync(){
  syncStatus('подключаюсь к серверу…');
  var state=await remoteSyncRequest('pull');
  await applyRemoteSyncState(state);
  syncStatus('данные получены', 'ok');
  syncRetryCount=0;
  return state;
}
function queueRemoteSync(includeApiKey,clearApiKey){
  if(includeApiKey)syncPendingKey=true;
  if(clearApiKey)syncPendingClear=true;
  if(!syncReady||syncApplying||!TG||!BACKEND_API_BASE)return;
  if(syncTimer)clearTimeout(syncTimer);
  syncTimer=setTimeout(function(){flushRemoteSync()},900);
}
async function flushRemoteSync(){
  if(syncBusy){syncAgain=true;return}
  if(!syncReady||syncApplying||!TG||!BACKEND_API_BASE)return;
  syncBusy=true;syncAgain=false;
  var includeKey=syncPendingKey,clearKey=syncPendingClear;
  syncPendingKey=false;syncPendingClear=false;
  try{
    var state=makeRemoteSyncState(includeKey&&!clearKey,clearKey);
    var result=await remoteSyncRequest('push',state);
    await applyRemoteSyncState(result);
    syncStatus('синхронизировано', 'ok');
    syncRetryCount=0;
  }catch(error){
    if(includeKey)syncPendingKey=true;
    if(clearKey)syncPendingClear=true;
    syncRetryCount++;
    syncStatus('ошибка, повторю автоматически: '+String(error&&error.message||error).slice(0,100),'bad');
    if(syncTimer)clearTimeout(syncTimer);
    syncTimer=setTimeout(function(){flushRemoteSync()},syncRetryCount===1?60000:Math.min(60000,5000*syncRetryCount));
  }finally{
    syncBusy=false;
    if(syncAgain){syncAgain=false;queueRemoteSync(false,false)}
  }
}