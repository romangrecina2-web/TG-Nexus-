function renderProviderCatalog(){
  var select=$('#providerCatalog');if(!select)return;
  select.innerHTML='';
  PROVIDER_CATALOG.forEach(function(item){
    var option=document.createElement('option');
    option.value=item.id;option.textContent=item.name;select.appendChild(option);
  });
}
function addCatalogProvider(){
  if(!hasProPlan()){toast('Дополнительные API-профили доступны в TG Nexus PRO.');return}
  var id=$('#providerCatalog').value;
  var item=PROVIDER_CATALOG.find(function(provider){return provider.id===id});
  if(!item)return;
  var existing=(S.cfg.providers||[]).find(function(profile){return profile.url===item.url});
  if(existing){applyProviderProfile(existing);toast('Этот API-профиль уже сохранён.');return}
  if((S.cfg.providers||[]).length>=30){toast('Можно сохранить не больше 30 профилей API.');return}
  syncActiveProviderProfile();
  var profile={
    id:'provider_'+makeId(),catalogId:item.id,name:item.name,url:item.url,
    model:item.defaultModel||'',models:item.defaultModel?[item.defaultModel]:[],
    protocol:item.protocol||'openai',authType:item.authType||'bearer',
    modelsEndpoint:item.modelsEndpoint!==false,
    chatPath:item.chatPath,responsesPath:item.responsesPath,messagesPath:item.messagesPath,
    modelsPath:item.modelsPath,responsesModels:item.responsesModels,responsesImages:item.responsesImages,notice:item.notice
  };
  S.cfg.providers.push(profile);
  applyProviderProfile(profile);
  $('#providerName').value=item.name;
  toast('Добавлен профиль '+item.name+'. Введите свой API-ключ и выберите модель.');
}
function activeProviderProfile(){
  var profiles=Array.isArray(S.cfg.providers)?S.cfg.providers:(S.cfg.providers=[]);
  var profile=profiles.find(function(item){return item.id===S.cfg.activeProviderId});
  if(!profile){
    profile={id:'default',name:host(S.cfg.url)||'Основной API',url:S.cfg.url,model:S.cfg.model,models:(S.cfg.models||[]).slice()};
    profiles.unshift(profile);S.cfg.activeProviderId=profile.id;
  }
  var catalogProfile=PROVIDER_CATALOG.find(function(item){return item.id===profile.catalogId||item.url===profile.url})||null;
  if(catalogProfile){
    profile.catalogId=catalogProfile.id;
    ['chatPath','responsesPath','messagesPath','modelsPath','responsesModels','responsesImages','notice'].forEach(function(key){
      if(profile[key]===undefined&&catalogProfile[key]!==undefined)profile[key]=catalogProfile[key];
    });
    if(catalogProfile.protocol==='responses'&&profile.protocol!=='anthropic'){
      profile.protocol='responses';
      if(S.cfg.activeProviderId===profile.id)S.cfg.protocol='responses';
    }
    if(profile.authType===undefined)profile.authType=catalogProfile.authType;
    if(profile.modelsEndpoint===undefined)profile.modelsEndpoint=catalogProfile.modelsEndpoint!==false;
  }
  return profile;
}
function syncActiveProviderProfile(){
  if(!S||!S.cfg)return null;
  var profile=activeProviderProfile();
  profile.url=String(S.cfg.url||profile.url||'').trim().replace(/\/+$/,'');
  profile.model=String(S.cfg.model||'').trim().slice(0,256);
  profile.models=(Array.isArray(S.cfg.models)?S.cfg.models:[]).filter(function(x){return typeof x==='string'&&x.trim()}).slice(0,100);
  profile.protocol=S.cfg.protocol||'openai';profile.authType=S.cfg.authType||'bearer';profile.modelsEndpoint=S.cfg.modelsEndpoint!==false;
  if(profile.model&&profile.models.indexOf(profile.model)<0)profile.models.unshift(profile.model);
  return profile;
}
function renderProviderProfiles(){
  var select=$('#providerProfile'),name=$('#providerName'),remove=$('#providerRemove');
  if(!select)return;
  var profiles=S.cfg.providers||[];
  select.innerHTML='';
  profiles.forEach(function(profile){
    var option=document.createElement('option');option.value=profile.id;option.textContent=profile.name+' · '+host(profile.url);select.appendChild(option);
  });
  select.value=S.cfg.activeProviderId;
  var active=activeProviderProfile();
  if(name&&document.activeElement!==name)name.value=active.name||'';
  if(remove)remove.disabled=profiles.length<=1;
}
function applyProviderProfile(profile){
  if(!profile)return;
  S.cfg.activeProviderId=profile.id;
  S.cfg.url=profile.url;
  S.cfg.protocol=profile.protocol||'openai';S.cfg.authType=profile.authType||'bearer';S.cfg.modelsEndpoint=profile.modelsEndpoint!==false;
  S.cfg.model=profile.model||profile.models&&profile.models[0]||'';
  S.cfg.models=(Array.isArray(profile.models)?profile.models:[]).slice(0,100);
  if(S.cfg.model&&S.cfg.models.indexOf(S.cfg.model)<0)S.cfg.models.unshift(S.cfg.model);
  var currentChat=cur();if(currentChat&&(!S.cfg.model||S.cfg.models.indexOf(currentChat.model)<0))currentChat.model=S.cfg.model;
  if(host(S.cfg.url).indexOf('openrouter.ai')<0)S.cfg.internet=false;
  ACTIVE_KEY=providerKeyMemory[S.cfg.url]||'';
  keyInputTouched=false;
  keyStorageStatus=ACTIVE_KEY?'session':'loading';
  saveNow();
  fillSet();
  keyRestorePromise=restoreSavedApiKey().then(function(restored){if(restored)queueRemoteSync(true,false);return restored});
  fillChatModel();updSub();render(true);
}
function saveProviderProfile(){
  var url=String($('#cUrl').value||'').trim().replace(/\/+$/,'');
  if(!validApiBase(url)){toast('Профиль не сохранён: укажите корректный HTTPS-адрес API.');return}
  syncActiveProviderProfile();
  var profile=(S.cfg.providers||[]).find(function(item){return item.url===url})||null;
  if(!profile){
    if(S.cfg.providers.length>=30){toast('Можно сохранить не больше 30 профилей API.');return}
    profile={id:'provider_'+makeId(),name:'',url:url,model:'',models:[]};
    S.cfg.providers.push(profile);
  }
  profile.name=String($('#providerName').value||host(url)||'API').trim().slice(0,48)||host(url)||'API';
  profile.url=url;profile.model=String($('#cModel').value||S.cfg.model||'').trim().slice(0,256);profile.protocol=S.cfg.protocol||'openai';profile.authType=S.cfg.authType||'bearer';profile.modelsEndpoint=S.cfg.modelsEndpoint!==false;
  profile.models=(S.cfg.models||[]).slice(0,100);
  if(profile.model&&profile.models.indexOf(profile.model)<0)profile.models.unshift(profile.model);
  S.cfg.activeProviderId=profile.id;
  saveNow();renderProviderProfiles();toast('Профиль сохранён. Ключ хранится отдельно в защищённом хранилище.');
}
async function removeProviderProfile(){
  if((S.cfg.providers||[]).length<=1){toast('Нельзя удалить последний профиль API.');return}
  syncActiveProviderProfile();
  var active=activeProviderProfile();
  if(!confirm('Удалить профиль «'+active.name+'» и сохранённый для него ключ на этом устройстве?'))return;
  try{
    if(secureKeyStorage&&secureKeyStorage.isAvailable())await secureKeyStorage.remove(active.url);
  }catch(error){toast('Не удалось удалить ключ профиля. Профиль оставлен без изменений.');return}
  delete providerKeyMemory[active.url];
  S.cfg.providers=S.cfg.providers.filter(function(item){return item.id!==active.id});
  var next=S.cfg.providers[0];
  applyProviderProfile(next);
  toast('Профиль удалён');
}
function switchProviderProfile(id){
  if(!hasProPlan()&&id!==S.cfg.activeProviderId){toast('Переключение API-профилей доступно в TG Nexus PRO.');renderProviderProfiles();return}
  syncActiveProviderProfile();
  var profile=(S.cfg.providers||[]).find(function(item){return item.id===id});
  if(!profile)return;
  applyProviderProfile(profile);
}