/* ---------- состояние ---------- */
var KEY='shell_v2',OLD='my_shell_v1';
var PROVIDER_CATALOG=window.TGProviderCatalog||[];
var PROVIDER_ADAPTERS=window.TGProviderAdapters||null;
var PRESETS={
  or:{url:'https://openrouter.ai/api/v1',model:'nvidia/nemotron-3-ultra-550b-a55b:free'},
  nv:{url:'https://integrate.api.nvidia.com/v1',model:'nvidia/nemotron-3-ultra-550b-a55b'}
};
var AUTO='\n\nПамять: если пользователь просит что-то запомнить или сообщает устойчивый факт о себе (имя, город, предпочтения, цели, привычки), добавь в самый конец ответа тег <remember>короткий факт одной строкой</remember>. Не добавляй тег для разовых деталей и не упоминай этот тег в тексте ответа.';
var storageOK=true;
try{localStorage.setItem('_t','1');localStorage.removeItem('_t')}catch(e){storageOK=false}

function host(u){try{return new URL(u).hostname}catch(e){return String(u||'')}}
function validApiBase(value){try{var u=new URL(String(value||'')),local=['localhost','127.0.0.1','[::1]'].indexOf(u.hostname)>=0;return !u.username&&!u.password&&!u.search&&!u.hash&&(u.protocol==='https:'||(local&&u.protocol==='http:'))}catch(e){return false}}
function def(){return{v:2,cfg:{url:PRESETS.or.url,model:PRESETS.or.model,models:[PRESETS.or.model],wallpaperEnabled:false,sys:'Ты умный и дружелюбный ассистент. Отвечай по-русски, если не просят иначе. Пиши ясно и по делу.',temp:'',max:'',reasoning:'auto',internet:false,sandbox:false,sandboxInternet:false,multiAgent:false,agentCount:3,sandboxTimeout:60,requestTimeoutSeconds:120,auto:true,sumAt:10000,keep:4,pinCap:4000,askCode:true,balOn:true,minBal:10,balBase:'',balUsage:0,protocol:'openai',authType:'bearer',modelsEndpoint:true,providers:[{id:'default',name:'OpenRouter',url:PRESETS.or.url,model:PRESETS.or.model,models:[PRESETS.or.model],protocol:'openai',authType:'bearer',modelsEndpoint:true}],activeProviderId:'default',keys:{}},mem:[],chats:[],cur:null,stats:{day:'',n:0}}}
function makeId(){return 'm_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}
function fixChat(c){
  c.msgs=(c.msgs||[]).filter(function(m){return m.role==='user'||(m.content&&m.content.indexOf('\u26A0')!==0)||(m.role==='assistant'&&(m.originalVersion||m.regenVersions))});
  c.msgs.forEach(function(m,i){
    if(!m.id)m.id='m_'+String(c.id||'chat')+'_'+i;
    if(m.role==='assistant'&&m.regenVersions&&!Array.isArray(m.regenVersions))m.regenVersions=[];
    if(m.role==='assistant'&&m.originalVersion&&!m.content&&!m.reasoning&&!(m.execLog&&m.execLog.length)){
      var variants=m.regenVersions||[],active=Math.max(0,Math.min(variants.length,+m.activeVersion||0)),saved=active===0?m.originalVersion:variants[active-1];
      if(saved){m.content=saved.content||'';m.reasoning=saved.reasoning||'';m.execLog=saved.execLog||[];m.apiTrail=saved.apiTrail||[];m.apiFinalContent=saved.apiFinalContent;m.err=saved.err||'';}
    }
  });
  if(typeof c.draft!=='string')c.draft='';
  if(!Array.isArray(c.draftAttachments))c.draftAttachments=[];
  return c;
}
function norm(d){
  var b=def();
  d.cfg=d.cfg||{};
  var hasProviderProfiles=Array.isArray(d.cfg.providers)&&d.cfg.providers.length>0;
  for(var k in b.cfg)if(!(k in d.cfg))d.cfg[k]=b.cfg[k];
  d.cfg.keys={};d.cfg.models=Array.isArray(d.cfg.models)?d.cfg.models.filter(function(x){return typeof x==='string'&&x.trim()}).slice(0,100):[];
  if(d.cfg.model&&d.cfg.models.indexOf(d.cfg.model)<0)d.cfg.models.unshift(d.cfg.model);
  var providerSource=hasProviderProfiles?d.cfg.providers:[{
    id:'default',name:host(d.cfg.url)==='openrouter.ai'?'OpenRouter':(host(d.cfg.url)||'Основной API'),
    url:d.cfg.url,model:d.cfg.model,models:d.cfg.models
  }];
  d.cfg.providers=providerSource.slice(0,30).map(function(p,i){
    if(!p||typeof p!=='object')return null;
    var url=String(p.url||'').trim().replace(/\/+$/,'');
    if(!validApiBase(url))return null;
    var id=String(p.id||('provider_'+i)).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)||('provider_'+i);
    var name=String(p.name||host(url)||('API '+(i+1))).trim().slice(0,48);
    var model=String(p.model||'').trim().slice(0,256);
    var models=Array.isArray(p.models)?p.models.filter(function(x){return typeof x==='string'&&x.trim()&&!/\s/.test(x)}).slice(0,100):[];
    if(model&&models.indexOf(model)<0)models.unshift(model);
    var catalogProfile=PROVIDER_CATALOG.find(function(item){return item.id===p.catalogId||item.url===url})||null;
    var merged={id:id,name:name||host(url),url:url,model:model,models:models,
      protocol:['anthropic','openai','responses'].indexOf(p.protocol)>=0?p.protocol:(catalogProfile?catalogProfile.protocol:'openai'),
      authType:['bearer','key','api-key','x-api-key'].indexOf(p.authType)>=0?p.authType:(catalogProfile?catalogProfile.authType:'bearer'),
      modelsEndpoint:typeof p.modelsEndpoint==='boolean'?p.modelsEndpoint:(!catalogProfile||catalogProfile.modelsEndpoint!==false)};
    if(catalogProfile){
      merged.catalogId=catalogProfile.id;
      ['chatPath','responsesPath','messagesPath','modelsPath','responsesModels','responsesImages','notice'].forEach(function(key){
        if(p[key]===undefined&&catalogProfile[key]!==undefined)merged[key]=catalogProfile[key];
      });
      if(catalogProfile.protocol==='responses'&&p.protocol!=='anthropic')merged.protocol='responses';
    }else{
      ['chatPath','responsesPath','messagesPath','modelsPath','responsesModels','responsesImages','notice'].forEach(function(key){
        if(p[key]!==undefined)merged[key]=p[key];
      });
    }
    return merged;
  }).filter(Boolean);
  if(!d.cfg.providers.length)d.cfg.providers=[{
    id:'default',name:host(d.cfg.url)||'Основной API',url:d.cfg.url,model:d.cfg.model,models:d.cfg.models.slice(),protocol:d.cfg.protocol||'openai',authType:d.cfg.authType||'bearer',modelsEndpoint:d.cfg.modelsEndpoint!==false
  }];
  var activeProvider=d.cfg.providers.find(function(p){return p.id===d.cfg.activeProviderId})||
    d.cfg.providers.find(function(p){return p.url===String(d.cfg.url||'').replace(/\/+$/,'')})||d.cfg.providers[0];
  d.cfg.activeProviderId=activeProvider.id;
  activeProvider.url=String(d.cfg.url||activeProvider.url).replace(/\/+$/,'');
  activeProvider.model=String(d.cfg.model||activeProvider.model||'').slice(0,256);
  activeProvider.models=d.cfg.models.slice(0,100);
  d.cfg.protocol=activeProvider.protocol||'openai';d.cfg.authType=activeProvider.authType||'bearer';d.cfg.modelsEndpoint=activeProvider.modelsEndpoint!==false;
  d.cfg.wallpaperEnabled=!!d.cfg.wallpaperEnabled;d.cfg.sandbox=!!d.cfg.sandbox;d.cfg.sandboxInternet=!!d.cfg.sandboxInternet;if(!d.cfg.sandbox)d.cfg.sandboxInternet=false;d.cfg.multiAgent=!!d.cfg.multiAgent;d.cfg.agentCount=Math.max(1,Math.min(20,Math.round(Number(d.cfg.agentCount)||3)));d.cfg.sandboxTimeout=Math.max(1,Math.min(3600,Math.round(Number(d.cfg.sandboxTimeout)||60)));d.cfg.requestTimeoutSeconds=Math.max(10,Math.min(7200,Math.round(Number(d.cfg.requestTimeoutSeconds)||120)));
  d.mem=d.mem||[];d.chats=(d.chats||[]).map(fixChat);d.chats.forEach(function(c){if(!c.model)c.model=d.cfg.model});d.stats=d.stats||b.stats;
  if(d.cur&&!d.chats.some(function(c){return c.id===d.cur}))d.cur=null;
  return d;
}
function load(){
  try{var d=JSON.parse(localStorage.getItem(KEY));if(d&&d.cfg)return norm(d)}catch(e){}
  var s=def();
  try{
    var o=JSON.parse(localStorage.getItem(OLD));
    if(o&&o.cfg){
      if(o.cfg.url&&o.cfg.url.indexOf('nvidia')<0){s.cfg.url=o.cfg.url;s.cfg.model=o.cfg.model||s.cfg.model}
      if(o.cfg.sys)s.cfg.sys=o.cfg.sys;
      s.mem=String(o.cfg.mem||'').split('\n').map(function(x){return x.trim()}).filter(Boolean);
      s.chats=o.chats||[];s.cur=o.cur||null;
    }
  }catch(e){}
  return norm(s);
}
var ACCOUNT_PLAN={tier:'free',pro:false,admin:false,limits:null,expiresAt:0};
function hasProPlan(){return ACCOUNT_PLAN.admin===true||(ACCOUNT_PLAN.pro===true&&(!ACCOUNT_PLAN.expiresAt||ACCOUNT_PLAN.expiresAt>Date.now()));}
var S=load(),ACTIVE_KEY='',providerKeyMemory=Object.create(null),busy=false,ctrl=null,stuck=true,editIdx=null,errBox='',warned=false,pendingFiles=[],saveTimer=null;
var BACKEND_API_BASE=String(window.APP_CONFIG&&window.APP_CONFIG.apiBaseUrl||'').replace(/\/+$/,'');
var syncReady=false,syncApplying=false,syncBusy=false,syncAgain=false,syncTimer=null,syncPendingKey=false,syncPendingClear=false,syncRetryCount=0;
var TG=(window.Telegram&&window.Telegram.WebApp&&window.Telegram.WebApp.initData)?window.Telegram.WebApp:null;
var secureKeyStorage=(window.TGShellSecureKeyStorage&&TG)?window.TGShellSecureKeyStorage.create(TG):null;
var keyStorageStatus='loading',keyInputTouched=false,keyRestorePromise=null;
try{localStorage.removeItem(OLD);saveNow()}catch(e){}
function saveNow(){
  syncActiveProviderProfile();
  if(!storageOK)return;
  if(saveTimer){clearTimeout(saveTimer);saveTimer=null}
  try{localStorage.setItem(KEY,JSON.stringify(S,function(k,v){if(k==='keys'||k==='err')return undefined;if(k==='reasoning'&&this&&this.role==='assistant')return undefined;return v}))}
  catch(e){if(!warned){warned=true;toast('Не хватает места в памяти браузера. Скачайте копию и удалите старые чаты.')}}
  if(!syncApplying)queueRemoteSync(false,false);
}