function shouldOpenSettings(){
  try{return new URL(window.location.href).searchParams.get('open')==='settings'}catch(error){return false}
}

function save(){if(!storageOK)return;if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(saveNow,420)}
function cur(){return S.chats.filter(function(c){return c.id===S.cur})[0]||null}
function activeModel(c){c=c||cur();return(c&&c.model)||S.cfg.model}
function addSavedModel(id){id=String(id||'').trim();if(id&&!/\s/.test(id)&&S.cfg.models.indexOf(id)<0)S.cfg.models.push(id);return id}
function newChat(){var now=Date.now(),c={id:String(now)+'_'+Math.random().toString(36).slice(2,6),title:'Новый чат',msgs:[],model:S.cfg.model,draft:'',draftAttachments:[],ts:now,createdAt:now,updatedAt:now};S.chats.unshift(c);S.cur=c.id;saveNow();return c}
function curKey(){return ACTIVE_KEY}
function keyApiBase(){return String(S.cfg.url||'').trim().replace(/\/+$/,'')}
function updateKeyStorageUi(){
  var input=$('#cKey'),status=$('#keyStatus'),remove=$('#keyRemove');
  var messages={
    loading:'Проверяю защищённое хранилище Telegram…',
    saved:'Ключ сохранён в защищённом хранилище Telegram на этом устройстве.',
    empty:'После успешной проверки ключ сохранится в защищённом хранилище Telegram.',
    'other-provider':'Для выбранного адреса API ключ не сохранён. Введите отдельный ключ для этого профиля.',
    unsupported:'Этот клиент Telegram не поддерживает SecureStorage. Ключ останется только в памяти вкладки.',
    outside:'Откройте Mini App внутри Telegram, чтобы использовать защищённое сохранение ключа.',
    error:'Не удалось прочитать защищённое хранилище. Введите ключ заново.',
    'save-error':'Подключение работает, но сохранить ключ не удалось. Он останется только в памяти вкладки.',
    session:'Ключ действует в текущей вкладке. После проверки приложение попробует сохранить его в SecureStorage Telegram.'
  };
  if(input){
    input.placeholder=keyStorageStatus==='saved'?'Ключ сохранён · введите новый, чтобы заменить':
      (keyStorageStatus==='loading'?'Загружаю сохранённый ключ…':(ACTIVE_KEY?'Ключ действует в текущей вкладке':'Вставьте API-ключ'));
  }
  if(status)status.textContent=messages[keyStorageStatus]||messages.empty;
  if(remove)remove.disabled=!(secureKeyStorage&&secureKeyStorage.isAvailable()&&keyStorageStatus==='saved');
}
async function restoreSavedApiKey(){
  if(!TG){keyStorageStatus='outside';updateKeyStorageUi();return false}
  if(!secureKeyStorage||!secureKeyStorage.isAvailable()){
    keyStorageStatus='unsupported';updateKeyStorageUi();return false;
  }
  keyStorageStatus='loading';updateKeyStorageUi();
  try{
    var result=await secureKeyStorage.load(keyApiBase());
    if(keyInputTouched){keyStorageStatus=ACTIVE_KEY?'session':'empty';updateKeyStorageUi();return !!ACTIVE_KEY}
    if(result.matches&&result.key){ACTIVE_KEY=result.key;providerKeyMemory[keyApiBase()]=result.key;keyStorageStatus='saved'}
    else if(providerKeyMemory[keyApiBase()]){ACTIVE_KEY=providerKeyMemory[keyApiBase()];keyStorageStatus='session'}
    else if(result.found&&!result.matches)keyStorageStatus='other-provider';
    else keyStorageStatus='empty';
  }catch(error){
    keyStorageStatus='error';
    console.warn('Telegram SecureStorage could not restore the provider key.');
  }
  updateKeyStorageUi();
  return !!ACTIVE_KEY;
}
async function removeSavedApiKey(){
  var currentBase=keyApiBase();
  if(!secureKeyStorage||!secureKeyStorage.isAvailable()){
    ACTIVE_KEY='';delete providerKeyMemory[currentBase];keyInputTouched=true;keyStorageStatus='unsupported';$('#cKey').value='';
    queueRemoteSync(false,true);updateKeyStorageUi();render();toast('API-ключ удалён с сервера; локальное хранилище Telegram недоступно');return;
  }
  try{
    await secureKeyStorage.remove(currentBase);
    ACTIVE_KEY='';delete providerKeyMemory[currentBase];keyInputTouched=true;keyStorageStatus='empty';$('#cKey').value='';
    queueRemoteSync(false,true);
    updateKeyStorageUi();render();toast('Сохранённый ключ этого API удалён');
  }catch(error){toast('Не удалось удалить сохранённый ключ')}
}
function base(){if(!validApiBase(S.cfg.url))throw new Error('Адрес API должен использовать HTTPS. HTTP разрешён только для localhost.');return S.cfg.url.replace(/\/+$/,'')}
function hdrs(){if(!PROVIDER_ADAPTERS)throw new Error('Provider adapter module is unavailable.');return PROVIDER_ADAPTERS.authHeaders(activeProviderProfile(),curKey(),!!TG)}
function memText(){return S.mem.length?'\n\nЧто ты знаешь о пользователе (учитывай это, но не пересказывай без нужды):\n- '+S.mem.join('\n- '):''}
function short(t){return t.length>60?t.slice(0,57)+'…':t}
function bump(){var d=new Date().toISOString().slice(0,10);if(S.stats.day!==d){S.stats.day=d;S.stats.n=0}S.stats.n++}
function addFact(f){
  f=String(f).replace(/\s+/g,' ').trim();
  if(!f||f.length>300)return false;
  if(S.mem.some(function(x){return x.toLowerCase()===f.toLowerCase()}))return false;
  S.mem.push(f);save();return true;
}
function harvest(text){
  var re=/<remember>([\s\S]*?)<\/remember>/g,m,added=[];
  while((m=re.exec(text))){if(addFact(m[1]))added.push(m[1].replace(/\s+/g,' ').trim())}
  return added;
}
function estTokens(c){var n=S.cfg.sys.length+memText().length;if(c){n+=(c.sum||'').length+pinText(c).length;for(var i=liveFrom(c);i<c.msgs.length;i++)n+=msgChars(c.msgs[i])}return Math.round(n/3)}
function apiContent(m){
  var txt=m.content||'',imgs=[];
  if(m.quote)txt='[Цитата из ответа ассистента]:\n'+(m.quote.text||'')+'\n[Конец цитаты]\n\n'+txt;
  (m.attachments||[]).forEach(function(f){
    if(f.text!==undefined)txt+='\n\n[Прикреплённый файл: '+f.name+']\n'+f.text+'\n[Конец файла: '+f.name+']';
    else if(f.dataUrl){txt+='\n[Прикреплено изображение: '+f.name+']';imgs.push({type:'image_url',image_url:{url:f.dataUrl}})}
  });
  if(!txt.trim())txt='Проанализируй прикреплённые файлы.';
  return imgs.length?[{type:'text',text:txt}].concat(imgs):txt;
}
function fmtN(n){return n>=1000?(n/1000).toFixed(n>=10000?0:1).replace('.0','')+'k':String(n)}
var visionCatalogCache=null,visionCatalogBase='',visionCatalogAt=0;
function isOpenRouterEndpoint(){return host(S.cfg.url).indexOf('openrouter.ai')>=0}
function messagesHaveImages(messages){
  return (messages||[]).some(function(m){
    return Array.isArray(m&&m.content)&&m.content.some(function(part){return part&&part.type==='image_url'});
  });
}
async function openRouterVisionModels(){
  var apiBase=base();
  if(visionCatalogCache&&visionCatalogBase===apiBase&&Date.now()-visionCatalogAt<300000)return visionCatalogCache;
  var r=await fetch(apiBase+'/models?input_modalities=image',{headers:hdrs()});
  if(!r.ok)throw await httpErr(r);
  var j=await r.json();
  visionCatalogCache=Array.isArray(j.data)?j.data:[];
  visionCatalogBase=apiBase;
  visionCatalogAt=Date.now();
  if(!visionCatalogCache.length)throw new Error('OpenRouter не вернул список моделей с поддержкой изображений');
  return visionCatalogCache;
}
async function resolveOpenRouterVisionModel(model){
  if(model==='openrouter/free')return {model:model,notice:''};
  try{
    var models=await openRouterVisionModels();
    if(models.some(function(item){return item&&item.id===model}))return {model:model,notice:''};
  }catch(e){}
  return {
    model:'openrouter/free',
    notice:'Модель «'+model+'» не принимает изображения. Для этого запроса используется бесплатный роутер OpenRouter (openrouter/free), который подбирает модель с поддержкой фото. Выбор модели чата не изменён.'
  };
}
