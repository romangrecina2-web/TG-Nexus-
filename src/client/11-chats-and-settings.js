/* ---------- чаты ---------- */
function openDrawer(){$('#dq').value='';drawerList();$('#drawer').className='on'}
function closeDrawer(){$('#drawer').className=''}
function drawerList(){
  var q=($('#dq').value||'').toLowerCase(),l=$('#list');l.innerHTML='';
  var cs=S.chats.slice().sort(function(a,b){return(b.ts||0)-(a.ts||0)}).filter(function(c){
    return !q||c.title.toLowerCase().indexOf(q)>=0||c.msgs.some(function(m){return(m.content||'').toLowerCase().indexOf(q)>=0||(m.attachments||[]).some(function(f){return f.name.toLowerCase().indexOf(q)>=0||(f.text||'').toLowerCase().indexOf(q)>=0})});
  });
  if(!cs.length){l.innerHTML='<div class="none">'+(q?'Ничего не найдено':'Чатов пока нет')+'</div>';return}
  cs.forEach(function(c){
    var r=document.createElement('div');r.className='row'+(c.id===S.cur?' cur':'');
    var t=document.createElement('button');t.className='t';t.textContent=c.title;
    t.onclick=function(){
      if(busy)return toast('Дождитесь окончания ответа');
      var old=cur();if(old){if(editIdx===null)old.draft=inp.value;old.draftAttachments=pendingFiles.map(function(f){return Object.assign({},f)});}
      saveNow();S.cur=c.id;endEdit();restoreChatComposer(c);fillChatModel();render(true);closeDrawer();
    };
    var e=document.createElement('button');e.className='x';e.innerHTML='&#9998;&#xFE0E;';e.setAttribute('aria-label','Переименовать');
    e.onclick=function(){var n=prompt('Название чата',c.title);if(n&&n.trim()){c.title=n.trim().slice(0,60);c.updatedAt=Date.now();save();drawerList();render()}};
    var x=document.createElement('button');x.className='x';x.innerHTML='&#10005;';x.setAttribute('aria-label','Удалить чат');
    x.onclick=function(){
      if(busy)return toast('Дождитесь окончания ответа');
      if(!confirm('Удалить чат «'+c.title+'»?'))return;
      S.chats=S.chats.filter(function(k){return k.id!==c.id});
      if(S.cur===c.id)S.cur=null;
      save();drawerList();render();
    };
    r.appendChild(t);r.appendChild(e);r.appendChild(x);l.appendChild(r);
  });
}
$('#bMenu').onclick=openDrawer;
$('#dBack').onclick=closeDrawer;
$('#dq').addEventListener('input',drawerList);
function fresh(){
  if(busy)return toast('Дождитесь окончания ответа');
  var old=cur();if(old&&editIdx===null){old.draft=inp.value;old.draftAttachments=pendingFiles.map(function(f){return Object.assign({},f)})}
  saveNow();S.cur=null;endEdit();inp.value='';pendingFiles=[];renderPending();showQuoteDraft();fillChatModel();autosize();saveNow();render(true);closeDrawer();inp.focus();
}
$('#bNew').onclick=fresh;
$('#bNewTop').onclick=fresh;

/* ---------- настройки ---------- */
function applyPreset(p){
  var preset=PRESETS[p];if(!preset)return;
  syncActiveProviderProfile();
  var profile=(S.cfg.providers||[]).find(function(item){return item.url===preset.url});
  if(!profile){
    if((S.cfg.providers||[]).length>=12){toast('Сначала удалите профиль: разрешено не больше 12.');return}
    profile={id:'provider_'+makeId(),name:p==='or'?'OpenRouter':'NVIDIA',url:preset.url,model:preset.model,models:[preset.model]};
    S.cfg.providers.push(profile);
  }else{
    profile.name=p==='or'?'OpenRouter':'NVIDIA';
    profile.model=preset.model;
    if(profile.models.indexOf(preset.model)<0)profile.models.unshift(preset.model);
  }
  applyProviderProfile(profile);
}
function hint(){
  var profile=activeProviderProfile(),el=$('#hintProv');
  var mode=profile.protocol==='anthropic'?'Нативный Anthropic Messages API. ':
    profile.protocol==='responses'?'Responses API. ':'OpenAI Chat Completions API. ';
  var auth=profile.authType==='key'?'Авторизация: Authorization: Key. ':profile.authType==='x-api-key'?'Авторизация: x-api-key. ':'Авторизация Bearer. ';
  var models=profile.modelsEndpoint===false?'Список моделей через API недоступен: добавьте ID модели вручную. ':'Список моделей можно запросить кнопкой ниже. ';
  var route=profile.protocol==='responses'?'Маршрут: '+(profile.responsesPath||'/responses')+'. ':
    profile.protocol==='anthropic'?'Маршрут: '+(profile.messagesPath||'/messages')+'. ':
    'Маршрут: '+(profile.chatPath||'/chat/completions')+'. ';
  el.textContent=(profile.notice?String(profile.notice)+' ':'')+mode+route+auth+models+'Для браузерного подключения провайдер должен разрешать CORS. Расходы и лимиты определяет сам провайдер.';
}
function updatePlanUi(){
  var pro=hasProPlan(),info=$('#planStatus');
  if(info)info.textContent=pro?'Тариф: PRO · все функции открыты.':'Тариф: FREE · 1 200 токенов, 1 API-профиль, без поиска, песочницы и мультиагентности.';
  ['providerCatalog','providerAdd','providerSave','providerRemove','cInternet','cSandbox','cSandboxInternet','cMultiAgent','cSandboxTimeout','cReasoning'].forEach(function(id){var el=$('#'+id);if(el)el.disabled=!pro});
  var profileSelect=$('#providerProfile');if(profileSelect)profileSelect.disabled=!pro;
  var agent=$('#cAgentCount');if(agent)agent.disabled=!pro||!S.cfg.multiAgent;
  var sandboxNet=$('#cSandboxInternet');if(sandboxNet)sandboxNet.disabled=!pro||!S.cfg.sandbox;
  var timeout=$('#cRequestTimeout');if(timeout)timeout.max=pro?7200:120;
  var tokens=$('#cMax');if(tokens)tokens.max=pro?32000:1200;
  var prompt=$('#cSys');if(prompt)prompt.maxLength=pro?20000:2000;
  var providerName=$('#providerName');if(providerName)providerName.disabled=!pro;
}
function fillSet(){
  renderProviderCatalog();renderProviderProfiles();
  $('#cUrl').value=S.cfg.url;$('#cKey').value='';updateKeyStorageUi();$('#cModel').value=S.cfg.model;renderSavedModels();refreshWallpaperPreview();
  $('#cSys').value=S.cfg.sys;$('#cTemp').value=S.cfg.temp;$('#cMax').value=S.cfg.max;$('#cReasoning').value=S.cfg.reasoning||'auto';$('#cAuto').checked=!!S.cfg.auto;$('#cInternet').checked=!!S.cfg.internet;$('#cSandbox').checked=!!S.cfg.sandbox;$('#cSandboxInternet').checked=!!S.cfg.sandboxInternet;$('#cMultiAgent').checked=!!S.cfg.multiAgent;$('#cAgentCount').value=S.cfg.agentCount;$('#agentCountValue').textContent=S.cfg.agentCount;$('#cAgentCount').disabled=!S.cfg.multiAgent;$('#cSandboxTimeout').value=S.cfg.sandboxTimeout;$('#cRequestTimeout').value=S.cfg.requestTimeoutSeconds;$('#cSandboxInternet').disabled=!S.cfg.sandbox;
  var h=host(S.cfg.url);
  Array.prototype.forEach.call(document.querySelectorAll('#presets button'),function(b){b.className=host(PRESETS[b.getAttribute('data-p')].url)===h?'on':''});
  $('#cSumAt').value=S.cfg.sumAt;$('#cKeep').value=S.cfg.keep;$('#cPinCap').value=S.cfg.pinCap;$('#cMinBal').value=S.cfg.minBal;
  $('#cAskCode').checked=!!S.cfg.askCode;$('#cBalOn').checked=!!S.cfg.balOn;$('#cBalMan').value=S.cfg.balBase===''?'':S.cfg.balBase;
  hint();memList();updatePlanUi();
}
function memList(){
  var u=$('#mem');u.innerHTML='';
  if(!S.mem.length){u.innerHTML='<li class="empty"><span>Пока пусто</span></li>';return}
  S.mem.forEach(function(f,i){
    var li=document.createElement('li'),s=document.createElement('span'),b=document.createElement('button');
    s.textContent=f;b.innerHTML='&#10005;';b.setAttribute('aria-label','Удалить');
    b.onclick=function(){S.mem.splice(i,1);save();memList();updSub()};
    li.appendChild(s);li.appendChild(b);u.appendChild(li);
  });
}
function openSet(){fillSet();$('#tres').textContent='';$('#tres').className='note';$('#sheet').className='on'}
$('#bSet').onclick=openSet;
$('#syncNow').onclick=async function(){
  if(!TG){toast('Откройте Mini App из Telegram');return}
  syncStatus('обновляю данные…');
  try{
    await pullRemoteSync();
    syncReady=true;
    await flushRemoteSync();
  }catch(error){syncStatus('не удалось обновить: '+String(error&&error.message||error).slice(0,100),'bad')}
};
$('#sDone').onclick=function(){$('#sheet').className='';render()};
$('#presets').addEventListener('click',function(e){var p=e.target.getAttribute('data-p');if(p){applyPreset(p);$('#tres').textContent=''}});
$('#providerProfile').addEventListener('change',function(){switchProviderProfile(this.value)});
$('#providerAdd').addEventListener('click',addCatalogProvider);
$('#providerSave').addEventListener('click',saveProviderProfile);
$('#providerRemove').addEventListener('click',removeProviderProfile);
$('#cUrl').addEventListener('change',function(){
  var next=this.value.trim().replace(/\/+$/,'');
  if(!validApiBase(next)){this.value=S.cfg.url;toast('Адрес API должен использовать HTTPS. HTTP разрешён только для localhost.');return}
  if(next!==S.cfg.url){
    if(ACTIVE_KEY&&!keyInputTouched)providerKeyMemory[S.cfg.url]=ACTIVE_KEY;
    var existing=(S.cfg.providers||[]).find(function(profile){return profile.url===next});
    if(!hasProPlan()){
      if(existing&&existing.id!==S.cfg.activeProviderId){this.value=S.cfg.url;toast('Переключение API-профилей доступно в PRO.');return}
      var active=activeProviderProfile(),catalog=PROVIDER_CATALOG.find(function(item){return item.url===next})||null;
      active.url=next;active.name=catalog?catalog.name:(host(next)||'Основной API');active.catalogId=catalog?catalog.id:undefined;
      active.protocol=catalog?catalog.protocol||'openai':'openai';active.authType=catalog?catalog.authType||'bearer':'bearer';active.modelsEndpoint=catalog?catalog.modelsEndpoint!==false:true;
      active.model=catalog?catalog.defaultModel||'':'';active.models=active.model?[active.model]:[];
      S.cfg.url=next;S.cfg.model=active.model;S.cfg.models=active.models.slice();S.cfg.protocol=active.protocol;S.cfg.authType=active.authType;S.cfg.modelsEndpoint=active.modelsEndpoint;
      ACTIVE_KEY=providerKeyMemory[next]||'';keyInputTouched=false;keyStorageStatus=ACTIVE_KEY?'session':'loading';$('#cKey').value='';
      save();fillSet();keyRestorePromise=restoreSavedApiKey().then(function(restored){if(restored)queueRemoteSync(true,false);return restored});return;
    }
    if(existing){applyProviderProfile(existing);return}
    if((S.cfg.providers||[]).length>=30){this.value=S.cfg.url;toast('Сначала удалите профиль: разрешено не больше 30.');return}
    syncActiveProviderProfile();
    var added={id:'provider_'+makeId(),name:host(next)||'Новый API',url:next,model:'',models:[],protocol:'openai',authType:'bearer',modelsEndpoint:true};
    S.cfg.providers.push(added);S.cfg.activeProviderId=added.id;
    ACTIVE_KEY=providerKeyMemory[next]||'';keyInputTouched=false;keyStorageStatus=ACTIVE_KEY?'session':'loading';$('#cKey').value='';
  }
  S.cfg.url=next;if(host(S.cfg.url).indexOf('openrouter.ai')<0)S.cfg.internet=false;
  save();fillSet();keyRestorePromise=restoreSavedApiKey().then(function(restored){if(restored)queueRemoteSync(true,false);return restored});
});
$('#cKey').addEventListener('input',function(){keyInputTouched=true;ACTIVE_KEY=this.value.trim();keyStorageStatus=ACTIVE_KEY?'session':'empty';updateKeyStorageUi()});
$('#cKey').addEventListener('change',async function(){var el=this;keyInputTouched=true;ACTIVE_KEY=el.value.trim();if(!ACTIVE_KEY)return;el.value='';keyStorageStatus='session';updateKeyStorageUi();await $('#bTest').onclick()});
$('#cModel').addEventListener('input',function(){S.cfg.model=this.value.trim();save();fillChatModel()});
$('#cModel').addEventListener('change',function(){var v=this.value.trim();if(v){addSavedModel(v);saveNow();renderSavedModels();fillChatModel()}});
$('#chatModel').addEventListener('change',function(){var c=cur(),v=this.value;if(c){c.model=v;c.updatedAt=Date.now();saveNow();updSub();toast('Модель этого чата: '+v)}else{S.cfg.model=v;addSavedModel(v);saveNow();updSub()}});
function renderSavedModels(){
  var box=$('#savedModels');if(!box)return;box.innerHTML='';
  if(!S.cfg.models.length){box.innerHTML='<div class="none">Список моделей пуст</div>';return}
  S.cfg.models.forEach(function(model){var row=document.createElement('div');row.className='model-item';var name=document.createElement('span');name.textContent=model;var del=document.createElement('button');del.type='button';del.textContent='Удалить';del.onclick=function(){if(model===S.cfg.model){toast('Модель по умолчанию должна оставаться в списке');return}if(S.chats.some(function(c){return activeModel(c)===model})){toast('Модель используется в одном из чатов. Сначала выберите там другую.');return}S.cfg.models=S.cfg.models.filter(function(x){return x!==model});if(!S.cfg.models.length)addSavedModel(S.cfg.model);saveNow();renderSavedModels();fillChatModel()};row.appendChild(name);row.appendChild(del);box.appendChild(row)});
}
$('#modelAdd').onclick=function(){var v=$('#modelNew').value.trim();if(!v||/\s/.test(v))return toast('Введите ID модели без пробелов');if(S.cfg.models.indexOf(v)>=0)return toast('Эта модель уже сохранена');addSavedModel(v);$('#modelNew').value='';saveNow();renderSavedModels();fillChatModel();toast('Модель добавлена в общий список')};
$('#modelNew').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();$('#modelAdd').click()}});
$('#cSys').addEventListener('input',function(){
  var limit=hasProPlan()?20000:2000;
  if(this.value.length>limit){this.value=this.value.slice(0,limit);toast('Лимит инструкции Free — 2 000 символов.')}
  S.cfg.sys=this.value;save();
});
$('#cTemp').addEventListener('input',function(){S.cfg.temp=this.value.trim();save()});
$('#cMax').addEventListener('input',function(){
  var value=this.value.trim(),limit=hasProPlan()?32000:1200;
  if(value&&Number(value)>limit){value=String(limit);this.value=value;toast('Лимит вашего тарифа — '+limit+' токенов.')}
  S.cfg.max=value;save();
});
$('#cReasoning').addEventListener('change',function(){if(!hasProPlan()){this.value='auto';S.cfg.reasoning='auto';save();toast('Расширенные режимы рассуждений доступны в PRO.');return}S.cfg.reasoning=this.value;save();toast('Уровень рассуждений: '+this.options[this.selectedIndex].text)});
$('#cInternet').addEventListener('change',function(){
  if(!hasProPlan()){this.checked=false;S.cfg.internet=false;toast('Поиск в интернете доступен в TG Nexus PRO.');return}
  if(this.checked){
    if(host(S.cfg.url).indexOf('openrouter.ai')<0){this.checked=false;toast('Поиск в интернете сейчас поддерживается только через OpenRouter.');return}
    if(!confirm('Разрешить модели искать информацию в интернете через OpenRouter? Поиск может повлечь дополнительную плату, а запросы будут передаваться поисковому провайдеру.')){this.checked=false;return}
  }
  S.cfg.internet=this.checked;save();toast(this.checked?'Интернет-поиск разрешён':'Интернет-поиск отключён');
});
$('#cSandbox').addEventListener('change',function(){
  if(!hasProPlan()){this.checked=false;S.cfg.sandbox=false;S.cfg.sandboxInternet=false;toast('JavaScript-песочница доступна в TG Nexus PRO.');return}
  if(this.checked&&!confirm('Разрешить ИИ запускать JavaScript в изолированной песочнице браузера? Код может расходовать ресурсы устройства. Сетевой доступ включается отдельно. Файлы, хранилище и API-ключ недоступны.')){this.checked=false;return}
  S.cfg.sandbox=this.checked;
  if(!this.checked){S.cfg.sandboxInternet=false;$('#cSandboxInternet').checked=false}
  $('#cSandboxInternet').disabled=!this.checked;
  save();toast(this.checked?'Доступ к песочнице разрешён':'Песочница отключена');
});
$('#cSandboxInternet').addEventListener('change',function(){
  if(!hasProPlan()){this.checked=false;S.cfg.sandboxInternet=false;toast('Сетевой режим песочницы доступен в TG Nexus PRO.');return}
  if(this.checked&&!S.cfg.sandbox){this.checked=false;toast('Сначала включите запуск JavaScript в песочнице');return}
  if(this.checked&&!confirm('Разрешить выполняемому коду отправлять HTTPS-запросы к публичным доменам? Сайты увидят сетевые запросы с вашего устройства. Cookies, локальные адреса и API-ключ TG Shell не передаются. Действуют CORS и лимиты песочницы.')){this.checked=false;return}
  S.cfg.sandboxInternet=this.checked;save();toast(this.checked?'HTTPS-доступ в песочнице разрешён':'Интернет в песочнице отключён');
});
$('#cMultiAgent').addEventListener('change',function(){
  if(!hasProPlan()){this.checked=false;S.cfg.multiAgent=false;toast('Мультиагентность доступна в TG Nexus PRO.');return}
  if(this.checked&&!confirm('Включить мультиагентный режим для задач с кодом? Будут отправляться дополнительные запросы к выбранной модели и сохранённым моделям. Это может увеличить расход токенов и стоимость.')){this.checked=false;return}
  S.cfg.multiAgent=this.checked;$('#cAgentCount').disabled=!this.checked;save();toast(this.checked?'Мультиагентная разработка включена':'Мультиагентная разработка отключена');
});
$('#cAgentCount').addEventListener('input',function(){
  if(!hasProPlan()){this.value=1;S.cfg.agentCount=1;$('#agentCountValue').textContent='1';return}
  var value=Math.max(1,Math.min(20,Math.round(Number(this.value)||1)));
  this.value=value;$('#agentCountValue').textContent=value;S.cfg.agentCount=value;save();
});
$('#cSandboxTimeout').addEventListener('change',function(){
  var value=Math.max(1,Math.min(3600,Math.round(Number(this.value)||60)));
  this.value=value;S.cfg.sandboxTimeout=value;save();toast('Тайм-аут песочницы: '+value+' сек.');
});
$('#cRequestTimeout').addEventListener('change',function(){
  var value=Math.max(10,Math.min(hasProPlan()?7200:120,Math.round(Number(this.value)||120)));
  this.value=value;S.cfg.requestTimeoutSeconds=value;save();toast('Тайм-аут ответа провайдера: '+value+' сек.');
});
$('#cAuto').addEventListener('change',function(){S.cfg.auto=this.checked;save()});
$('#kEye').onclick=function(){var k=$('#cKey');k.type=k.type==='password'?'text':'password';this.textContent=k.type==='password'?'Показать':'Скрыть'};
$('#keyRemove').onclick=removeSavedApiKey;
function addMem(){var v=$('#mNew').value;if(addFact(v)){$('#mNew').value='';memList();updSub()}else if(v.trim())toast('Такой факт уже есть или он слишком длинный')}
$('#mAdd').onclick=addMem;
$('#mNew').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();addMem()}});
function note(t,cls){var o=$('#tres');o.className='note '+(cls||'');o.textContent=t}
$('#bTest').onclick=async function(){
  if(!curKey())return note(keyStorageStatus==='loading'?'Загружаю сохранённый ключ…':'Сначала вставьте ключ.','bad');
  if(!activeModel(cur()))return note('Сначала укажите ID модели в поле «Модель».','bad');
  note('Проверяю…');
  try{
    var t0=Date.now(),profile=activeProviderProfile();
    var request=PROVIDER_ADAPTERS.buildModelRequest(profile,{
      apiKey:curKey(),model:activeModel(cur()),maxTokens:40,
      messages:[{role:'user',content:'Ответь одним словом: готово'}],stream:false
    },!!TG);
    var r=await fetch(request.url,{method:'POST',signal:AbortSignal.timeout(requestTimeoutSeconds()*1000),headers:request.headers,body:JSON.stringify(request.body)});
    if(!r.ok)throw await httpErr(r);
    var j=PROVIDER_ADAPTERS.normalizePayload(profile,await r.json(),request.protocol),m=j.choices&&j.choices[0]&&j.choices[0].message,txt=(m&&m.content)||'';
    var out='Подключение работает ('+((Date.now()-t0)/1000).toFixed(1)+' с). Ответ модели: '+(txt.trim()||'пустой ответ');
    if(host(S.cfg.url).indexOf('openrouter')>=0){
      try{
        var k=await fetch(base()+'/key',{headers:hdrs()});
        if(k.ok){
          var kj=await k.json(),kd=kj.data||{};
          if(typeof kd.usage==='number')out+='\nРасходы ключа: $'+kd.usage.toFixed(4)+'.';
          if(typeof kd.limit==='number')out+='\nЛимит ключа: $'+kd.limit.toFixed(2)+'.';
          if(typeof kd.limit_remaining==='number')out+='\nОстаток лимита ключа: $'+kd.limit_remaining.toFixed(2)+'.';
          if(typeof kd.is_free_tier==='boolean')out+='\nТип ключа: '+(kd.is_free_tier?'бесплатный':'обычный')+'.';
          if(typeof kd.usage==='number'&&S.cfg.balBase!==''&&!isNaN(+S.cfg.balBase))out+='\nБаланс по расчёту: $'+(+S.cfg.balBase-(kd.usage-S.cfg.balUsage)).toFixed(3)+'.';
          var f=kd.free_model_daily_requests;if(f)out+='\nБесплатных запросов сегодня: использовано '+f.used+' из '+f.limit+'.';
        }else{var ke=await httpErr(k);out+='\nНе удалось прочитать статистику ключа: '+niceErr(ke)}
      }catch(e){out+='\nСтатистика ключа недоступна: '+(e.message||e)}
    }
    providerKeyMemory[keyApiBase()]=ACTIVE_KEY;keyInputTouched=false;
    var persistenceNote='';
    if(secureKeyStorage&&secureKeyStorage.isAvailable()){
      try{
        await secureKeyStorage.save(keyApiBase(),ACTIVE_KEY);
        keyStorageStatus='saved';
        persistenceNote='\nКлюч сохранён в защищённом хранилище Telegram на этом устройстве.';
      }catch(saveError){
        keyStorageStatus='save-error';
        persistenceNote='\nНе удалось сохранить ключ: '+(saveError&&saveError.message?saveError.message:'ошибка SecureStorage')+'.';
      }
    }else{
      keyStorageStatus=TG?'unsupported':'outside';
      persistenceNote=TG?'\nЭтот клиент не поддерживает защищённое сохранение. Ключ действует только до закрытия вкладки.':'\nОткройте Mini App из Telegram, чтобы включить защищённое сохранение ключа.';
    }
    updateKeyStorageUi();
    note(out+persistenceNote,'ok');
    queueRemoteSync(true,false);
  }catch(e){note(niceErr(e),'bad')}
};
$('#bModels').onclick=async function(){
  note('Загружаю список…');
  try{
    var profile=activeProviderProfile(),request=PROVIDER_ADAPTERS.modelsRequest(profile,curKey(),!!TG);
    var r=await fetch(request.url,{headers:request.headers});if(!r.ok)throw await httpErr(r);
    var j=await r.json(),ids=PROVIDER_ADAPTERS.extractModels(profile,j);
    ids.sort(function(a,b){var fa=/:free$/.test(a)?0:1,fb=/:free$/.test(b)?0:1;return fa-fb||(a<b?-1:1)});
    $('#mlist').innerHTML=Array.from(new Set(S.cfg.models.concat(ids))).map(function(i){return '<option value="'+esc(i)+'">' }).join('');
    note('Моделей найдено: '+ids.length+'. Выберите ID и добавьте его в сохранённый список, если хотите использовать в чатах.','ok');
  }catch(e){note(niceErr(e),'bad')}
};
$('#sExp').onclick=function(){
  saveText('chat-backup.json',JSON.stringify(S,function(k,v){return k==='keys'?undefined:v}),'application/json');
};
function importText(t){try{var d=JSON.parse(t);if(!d.cfg||!d.chats)throw 0;var oldUrl=S.cfg.url;S=norm(d);if(S.cfg.url!==oldUrl){ACTIVE_KEY='';$('#cKey').value=''}saveNow();fillSet();fillChatModel();restoreChatComposer(cur());render(true);toast('Копия загружена')}catch(x){toast('В буфере нет копии чатов')}}
$('#sImp').onclick=function(){if(TG&&TG.readTextFromClipboard)TG.readTextFromClipboard(function(t){if(t)importText(t);else $('#fImp').click()});else $('#fImp').click()};
$('#fImp').onchange=function(e){
  var f=e.target.files[0];if(!f)return;
  var r=new FileReader();
  r.onload=function(){
    try{
      var d=JSON.parse(r.result);if(!d.cfg||!d.chats)throw 0;
      var oldUrl=S.cfg.url;S=norm(d);if(S.cfg.url!==oldUrl){ACTIVE_KEY='';$('#cKey').value=''}saveNow();fillSet();fillChatModel();restoreChatComposer(cur());render(true);toast('Копия загружена');
    }catch(x){toast('Не удалось прочитать файл копии')}
  };
  r.readAsText(f);e.target.value='';
};
$('#sClr').onclick=function(){
  if(busy)return toast('Дождитесь окончания ответа');
  if(!confirm('Удалить все чаты? Память и настройки останутся.'))return;
  S.chats=[];S.cur=null;pendingFiles=[];inp.value='';showQuoteDraft();saveNow();render();toast('Чаты удалены');
};
