/* ---------- контекст: пересказ, закрепления, меню, баланс ---------- */
function nv(k,d){var v=parseFloat(S.cfg[k]);return isNaN(v)?d:v}
function liveFrom(c){return c&&c.sumUpTo?Math.min(c.sumUpTo,c.msgs.length):0}
function msgChars(m){var n=(m.content||'').length+(m.quote&&m.quote.text?m.quote.text.length:0);(m.attachments||[]).forEach(function(f){n+=(f.text||'').length+100});return n}
function totalTokens(c){var n=0;if(c)c.msgs.forEach(function(m){n+=msgChars(m)});return Math.round(n/3)}
function pinCount(c){return c?c.msgs.filter(function(m){return m.pin}).length:0}
function fmtTok(v){return v>=1000000?(v/1000000)+'M':fmtN(v)}
function pinText(c){
  var up=liveFrom(c),list=[];
  for(var i=0;i<up;i++){if(c.msgs[i].pin)list.push(c.msgs[i])}
  if(!list.length)return '';
  var cap=Math.max(300,nv('pinCap',4000))*3,each=Math.max(300,Math.floor(cap/list.length));
  var out=list.map(function(m){
    var tx=(m.role==='user'?(m.content||''):parts(m).text).trim();
    if(tx.length>each){var h=Math.floor(each*.65);tx=tx.slice(0,h)+'\n[…сокращено…]\n'+tx.slice(tx.length-(each-h))}
    return (m.role==='user'?'Пользователь':'Ты')+': '+tx;
  });
  return '\n\nЗакреплённые сообщения из начала чата (пользователь просил этого не забывать):\n'+out.join('\n---\n');
}
function sumTask(K){return '\n\nСЛУЖЕБНАЯ ЗАДАЧА (пользователь это не видит): после основного ответа, в самом конце, добавь блок <summary>…</summary> с кратким пересказом этого чата для твоей будущей памяти. Включи прежний пересказ (если он есть выше) и всё, что было в чате до сих пор, КРОМЕ последних '+K+' сообщений (они останутся в чате дословно). Сохрани цели пользователя, принятые решения, важные факты, имена, числа, названия файлов и функций, нерешённые вопросы. Пиши плотно, без вступлений и оценок, не длиннее 500 слов. Не упоминай этот блок в основном ответе.'}
function takeSummary(c,a,wanted,before,K,up){
  var m=/<summary>([\s\S]*?)<\/summary>/.exec(a.content);
  var strip=function(t){return String(t).replace(/<summary>[\s\S]*?<\/summary>/g,'').replace(/<summary>[\s\S]*$/,'').replace(/\s+$/,'')};
  a.content=strip(a.content);
  if(typeof a.apiFinalContent==='string')a.apiFinalContent=strip(a.apiFinalContent);
  if(!wanted||!m)return false;
  var s=m[1].trim();if(s.length<40)return false;
  var cut=Math.max(up,before-K);
  while(cut>up&&c.msgs[cut]&&c.msgs[cut].role!=='user')cut--;
  if(cut<=up)return false;
  c.sum=s;c.sumUpTo=cut;c.needSum=false;return true;
}

/* баланс */
var priceCache={},priceLoaded=false;
async function modelInfo(){
  if(!priceLoaded){
    try{
      var r=await fetch(base()+'/models',{headers:hdrs()});if(!r.ok)throw 0;
      var j=await r.json();
      (j.data||[]).forEach(function(x){var p=x.pricing||{},tp=x.top_provider||{};priceCache[x.id]={p:+p.prompt||0,c:+p.completion||0,ctx:x.context_length||0,mx:tp.max_completion_tokens||0}});
      priceLoaded=true;
    }catch(e){}
  }
  return priceCache[activeModel(cur())]||null;
}
async function keyUsage(){
  try{var r=await fetch(base()+'/key',{headers:hdrs()});if(!r.ok)return null;var j=await r.json(),u=j.data&&j.data.usage;return typeof u==='number'?u:null}catch(e){return null}
}
async function balanceGuard(inTok,mo){
  if(!S.cfg.balOn||host(S.cfg.url).indexOf('openrouter.ai')<0)return null;
  if(/:free$/.test(activeModel(cur())))return null;
  if(S.cfg.balBase===''||isNaN(+S.cfg.balBase))return null;
  var inf=await modelInfo();if(!inf||(!inf.p&&!inf.c))return null;
  var usage=await keyUsage();if(usage===null)return null;
  var bal=+S.cfg.balBase-(usage-(+S.cfg.balUsage||0));
  var outTok=mo||inf.mx||Math.max(0,inf.ctx-inTok);
  var cost=inTok*inf.p+outTok*inf.c;
  var minus=Math.max(0,nv('minBal',10)),floor=-minus/100;
  if(bal-cost>=floor)return null;
  var can=inf.c>0?Math.floor((bal-floor-inTok*inf.p)/inf.c):0;
  return 'Запрос не отправлен: проверка баланса. Баланс по расчёту '+(bal<0?'−$':'$')+Math.abs(bal).toFixed(3)+', допустимый минус −'+minus+'¢. Запрос может стоить до $'+cost.toFixed(3)+' (ввод ≈'+fmtN(inTok)+' ток.'+(mo?'':', лимит ответа не задан, взят максимум модели')+'). '+(can>=1000?'Задайте лимит ответа не больше '+fmtN(can)+' токенов или пополните баланс.':'Пополните баланс или выберите модель с «:free».');
}

/* размер ответа для кода */
var tokCb=null,tokSteps=[];
async function askTok(cb){
  if(!priceLoaded&&host(S.cfg.url).indexOf('openrouter.ai')>=0)await modelInfo();
  var model=activeModel(cur()),inf=priceCache[model],mx=inf&&inf.mx?inf.mx:1000000,ALL=[10000,16000,32000,64000,128000,256000,512000,1000000];
  tokSteps=ALL.filter(function(x){return x<=mx});
  if(!tokSteps.length||(tokSteps[tokSteps.length-1]<mx&&mx<1000000))tokSteps.push(mx);
  var want=nv('max',0)>0?nv('max',0):32000,idx=0;
  for(var k=0;k<tokSteps.length;k++){if(tokSteps[k]>=want){idx=k;break}idx=k}
  tokCb=cb;
  $('#mSheet').innerHTML='<div class="pv">Сколько токенов выделить на ответ</div><div class="tk"><div><b id="tokV"></b> <span id="tokC" class="note" style="display:inline"></span></div><input type="range" id="slr" min="0" max="'+(tokSteps.length-1)+'" value="'+idx+'"><small>Это потолок, платите только за то, что модель реально напишет. Но OpenRouter резервирует деньги под весь потолок.</small></div><button data-t="ok">Отправить</button><button data-t="no">Отмена</button>';
  $('#menu').className='on';tokDraw();
}
function tokDraw(){
  var v=tokSteps[+$('#slr').value],inf=priceCache[activeModel(cur())];
  $('#tokV').textContent=fmtTok(v)+' токенов';
  $('#tokC').textContent=/:free$/.test(activeModel(cur()))?'· бесплатная модель':(inf&&inf.c?'· до $'+(v*inf.c).toFixed(2)+' за ответ':'');
}

/* меню сообщения */
var menuI=-1;
function closeMenu(){$('#menu').className=''}
function openMenu(i){
  var c=cur();if(!c)return;
  if(busy)return toast('Дождитесь окончания ответа');
  var m=c.msgs[i];if(!m)return;
  var tx=(m.role==='user'?(m.content||''):parts(m).text).replace(/\s+/g,' ');
  menuI=i;tokCb=null;
  $('#mSheet').innerHTML='<div class="pv">'+esc(short(tx)||'Сообщение')+'</div>'+
    [['copy','Копировать'],['edit','Изменить'],['pin',m.pin?'Открепить':'Закрепить'],['del','Удалить']].map(function(x){return '<button data-m="'+x[0]+'">'+x[1]+'</button>'}).join('');
  $('#menu').className='on';
}
$('#mBack').onclick=function(){closeMenu();tokCb=null};
$('#mSheet').addEventListener('input',function(e){if(e.target.id==='slr')tokDraw()});
$('#mSheet').addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('button');if(!b)return;
  var mm=b.getAttribute('data-m'),tk=b.getAttribute('data-t');
  if(mm){var i=menuI;closeMenu();msgAction(mm,i);return}
  if(tk==='ok'){var v=tokSteps[+$('#slr').value],cb=tokCb;tokCb=null;closeMenu();if(cb)cb(v);return}
  if(tk==='no'){tokCb=null;closeMenu()}
});
function markPin(i,on){var el=wrap.querySelector('.msg[data-i="'+i+'"]');if(el){if(on)el.classList.add('pinned');else el.classList.remove('pinned')}updSub()}
function msgAction(a,i){
  var c=cur();if(!c||busy)return;
  var m=c.msgs[i];if(!m)return;
  if(a==='copy'){copyText(m.role==='user'?m.content:parts(m).text).then(function(ok){toast(ok?'Скопировано':'Не удалось скопировать')})}
  else if(a==='pin'){m.pin=!m.pin;save();markPin(i,m.pin);toast(m.pin?'Закреплено: уйдёт модели даже после сжатия':'Откреплено')}
  else if(a==='edit'){
    if(m.role==='user'){
      if(i<liveFrom(c)&&!confirm('Это сообщение уже в пересказе. После изменения пересказ будет сброшен, и чат снова уйдёт модели целиком. Продолжить?'))return;
      startEdit(i);
    }else openTextEdit('Изменить ответ',parts(m).text,function(v){m.content=v;m.apiFinalContent=v;m.apiTrail=[];syncCurrentVersion(m);saveNow();render();toast('Ответ изменён')});
  }
  else if(a==='del'){
    if(!confirm('Удалить сообщение'+(m.role==='user'&&c.msgs[i+1]&&c.msgs[i+1].role==='assistant'?' вместе с ответом':'')+'?'))return;
    var n=(m.role==='user'&&c.msgs[i+1]&&c.msgs[i+1].role==='assistant')?2:1;
    var inCovered=Math.max(0,Math.min(i+n,liveFrom(c))-i);
    c.msgs.splice(i,n);
    if(c.sumUpTo){c.sumUpTo=Math.max(0,c.sumUpTo-inCovered);if(!c.sumUpTo){c.sum='';c.needSum=false}}
    save();render();toast('Удалено');
  }
}

/* панели */
var teCb=null;
function openPane(title,html){$('#p2t').textContent=title;$('#p2b').innerHTML=html;$('#pane2').className='on';var p=document.querySelector('#pane2 .pane');if(p)p.scrollTop=0}
function closePane(){$('#pane2').className='';teCb=null}
$('#p2x').onclick=closePane;
function goMsg(i){
  var el=wrap.querySelector('.msg[data-i="'+i+'"]');if(!el)return;
  el.scrollIntoView({behavior:'smooth',block:'start'});
  el.classList.add('flash');setTimeout(function(){el.classList.remove('flash')},1800);
}
function openTextEdit(title,text,cb){teCb=cb;openPane(title,'<textarea id="teTa">'+esc(text)+'</textarea><div class="btns"><button class="sec" data-s="te">Сохранить</button><button class="sec" data-s="tc">Отмена</button></div>')}
function openPins(){
  var c=cur(),h='',list=[];
  if(c)c.msgs.forEach(function(m,i){if(m.pin)list.push(i)});
  if(!list.length)h='<p class="none">Закреплённых нет. Нажмите на сообщение и выберите «Закрепить»: оно будет уходить модели всегда, даже когда старые сообщения сжаты.</p>';
  else list.forEach(function(i){
    var m=c.msgs[i],tx=(m.role==='user'?(m.content||''):parts(m).text).replace(/\s+/g,' ');
    h+='<div class="pin"><button class="pt" data-go="'+i+'"><b>'+(m.role==='user'?'Вы':'ИИ')+':</b> '+esc(tx.length>140?tx.slice(0,137)+'…':tx)+'<small>≈'+fmtN(Math.round(tx.length/3))+' ток.'+(i<liveFrom(c)?' · уже за пределами окна, уходит отдельно':'')+'</small></button><button class="x" data-un="'+i+'" aria-label="Открепить">✕</button></div>';
  });
  h+='<small>Нажмите на закреплённое, чтобы чат пролистался к нему. Закреплённое из пересказанной части отправляется сокращённо (начало и конец), общий лимит задаётся в настройках.</small>';
  openPane('Закреплённые',h);
}
function openSummary(){
  var c=cur();if(!c||!c.msgs.length)return toast('Сначала начните чат');
  var live=liveFrom(c);
  var h='<small>Пересказ не показывается в ленте, но уходит модели вместо '+live+' старых сообщений. Его пишет сам ИИ в конце одного из ответов, когда в запросе накопится больше '+fmtN(Math.max(2000,nv('sumAt',10000)))+' токенов. Можно поправить вручную: следующий пересказ возьмёт за основу вашу версию.</small>'+
  '<label for="sumTa">Пересказ'+(c.needSum?' (обновится в следующем ответе)':'')+'</label><textarea id="sumTa" placeholder="Пока пусто. Появится, когда чат вырастет до порога.">'+esc(c.sum||'')+'</textarea>'+
  '<div class="btns"><button class="sec" data-s="save">Сохранить</button><button class="sec" data-s="now">Сжать сейчас</button><button class="sec danger" data-s="clear">Сбросить</button></div>'+
  '<small>Сжато сообщений: '+live+' из '+c.msgs.length+'. Пересказ ≈'+fmtN(Math.round((c.sum||'').length/3))+' ток. «Сжать сейчас» добавит пересказ к следующему ответу, отдельного запроса не будет.</small>';
  openPane('Пересказ',h);
}
$('#bSum').onclick=openSummary;
$('#bPins').onclick=openPins;
$('#p2b').addEventListener('click',function(e){
  var t=e.target.closest&&e.target.closest('[data-go],[data-un],[data-s]');if(!t)return;
  var c=cur();if(!c)return;
  if(t.hasAttribute('data-go')){closePane();goMsg(+t.getAttribute('data-go'));return}
  if(t.hasAttribute('data-un')){var i=+t.getAttribute('data-un');if(c.msgs[i]){c.msgs[i].pin=false;save();markPin(i,false);openPins()}return}
  var s=t.getAttribute('data-s');
  if(s==='te'){var cb=teCb,v=$('#teTa').value.trim();if(!v)return toast('Текст пустой');closePane();if(cb)cb(v);return}
  if(s==='tc'){closePane();return}
  if(s==='save'){
    var v2=$('#sumTa').value.trim();
    if(!v2&&c.sumUpTo){if(!confirm('Пересказ пустой. Старые сообщения снова будут уходить модели целиком. Сбросить?'))return;c.sumUpTo=0;c.needSum=false}
    c.sum=v2;save();render();updSub();toast('Пересказ сохранён');return;
  }
  if(s==='now'){
    if(c.msgs.length-nv('keep',4)<=liveFrom(c)+1)return toast('Сообщений пока слишком мало для сжатия');
    c.needSum=true;save();toast('Пересказ будет добавлен к следующему ответу');openSummary();return;
  }
  if(s==='clear'){
    if(!confirm('Сбросить пересказ? Старые сообщения снова будут уходить модели целиком.'))return;
    c.sum='';c.sumUpTo=0;c.needSum=false;save();render();openSummary();return;
  }
});

/* настройки контекста */
[['#cSumAt','sumAt'],['#cKeep','keep'],['#cPinCap','pinCap'],['#cMinBal','minBal']].forEach(function(p){
  $(p[0]).addEventListener('input',function(){var v=parseInt(this.value,10);S.cfg[p[1]]=isNaN(v)?'':v;save();updSub()});
});
$('#cAskCode').addEventListener('change',function(){S.cfg.askCode=this.checked;save()});
$('#cBalOn').addEventListener('change',function(){S.cfg.balOn=this.checked;save()});
$('#cBalMan').addEventListener('change',async function(){
  var raw=this.value.trim().replace(',','.');
  if(!raw){S.cfg.balBase='';save();toast('Баланс сброшен, проверка отключена');return}
  var v=parseFloat(raw);if(isNaN(v)){toast('Введите число, например -0.13');return}
  if(!curKey()){toast('Сначала вставьте ключ');return}
  var u=await keyUsage();
  if(u===null){toast('Не удалось прочитать расход ключа. Проверка баланса не включится.');return}
  S.cfg.balBase=v;S.cfg.balUsage=u;save();toast('Баланс запомнен: $'+v);
});

function saveText(name,text,mime){
  if(TG){copyText(text).then(function(ok){toast(ok?'Скопировано в буфер. В Телеграме скачивание недоступно':'Не удалось скопировать')});return}
  var b=new Blob([text],{type:mime||'text/plain;charset=utf-8'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},1500);
}
if(TG){
  TG.ready();TG.expand();try{TG.disableVerticalSwipes()}catch(e){}
  function syncTopInset(){
    var safe=TG.safeAreaInset||{},content=TG.contentSafeAreaInset||{};
    var top=TG.isFullscreen?(Number(safe.top)||0)+(Number(content.top)||0):0;
    document.documentElement.style.setProperty('--app-top-inset',top+'px');
  }
  syncTopInset();
  if(TG.onEvent){
    TG.onEvent('safeAreaChanged',syncTopInset);
    TG.onEvent('contentSafeAreaChanged',syncTopInset);
    TG.onEvent('fullscreenChanged',syncTopInset);
  }
  var PD={bg:'#12161f',panel:'#181d29',raise:'#212838',line:'#2b3347',text:'#e8ebf2',mute:'#9aa3b8',acc:'#e3a857',accfg:'#1d1405',me:'#273049',code:'#0d1017',err:'#ef8a80',ok:'#7bc47f'};
  var PL={bg:'#f3f5f9',panel:'#fff',raise:'#e9edf5',line:'#d5dbe6',text:'#1a2030',mute:'#5a6680',acc:'#9a5a00',accfg:'#fff',me:'#dce5f5',code:'#eef1f7',err:'#b3261e',ok:'#2c7a31'};
  var pal=TG.colorScheme==='light'?PL:PD,rs=document.documentElement.style;
  Object.keys(pal).forEach(function(k){rs.setProperty('--'+k,pal[k])});
  rs.setProperty('--wallpaper-overlay',TG.colorScheme==='light'?'rgba(243,245,249,.84)':'');
  try{TG.setHeaderColor(pal.bg);TG.setBackgroundColor(pal.bg)}catch(e){}
  document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href^="http"]');if(a){e.preventDefault();TG.openLink(a.href)}});
  var bb=TG.BackButton;
  function syncBack(){($('#drawer').className==='on'||$('#sheet').className==='on')?bb.show():bb.hide()}
  bb.onClick(function(){if($('#sheet').className==='on')$('#sDone').click();else closeDrawer();syncBack()});
  new MutationObserver(syncBack).observe($('#drawer'),{attributes:true});
  new MutationObserver(syncBack).observe($('#sheet'),{attributes:true});
}
if(!storageOK)$('#nostore').style.display='block';
if(TG){
  keyRestorePromise=restoreSavedApiKey();
  keyRestorePromise.then(async function(restored){
    var initialState=null;
    try{initialState=await pullRemoteSync()}
    catch(error){syncStatus('сервер пока недоступен: '+String(error&&error.message||error).slice(0,90),'bad')}
    syncReady=true;
    queueRemoteSync(!!ACTIVE_KEY||!initialState||initialState.initialized!==true,false);
    if(shouldOpenSettings())openSet();
    if(restored||ACTIVE_KEY)render();
  });
}else{
  keyStorageStatus='outside';updateKeyStorageUi();
  syncStatus('откройте Mini App через Telegram');
}
window.addEventListener('beforeunload',saveNow);
window.addEventListener('pagehide',saveNow);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')saveNow()});
setBusy();fillChatModel();restoreChatComposer(cur());render(true);initWallpaper();
if(!curKey())setTimeout(function(){if(!cur()||!cur().msgs.length)render()},0);
})();
