/* ---------- интерфейс ---------- */
var msgsEl=$('#msgs'),wrap=$('#wrap'),inp=$('#inp'),toastT=null;
var quoteSelection='',quoteSourceId='',paintTimer=null,lastPaint=0;
function toast(t){var e=$('#toast');e.textContent=t;e.className='on';clearTimeout(toastT);toastT=setTimeout(function(){e.className=''},2600)}
function toggleBottom(){var far=msgsEl.scrollHeight-msgsEl.scrollTop-msgsEl.clientHeight>180;$('#scrollBottom').className=far?'on':'';stuck=!far}
function stick(force){if(force||stuck)msgsEl.scrollTop=msgsEl.scrollHeight;toggleBottom()}
msgsEl.addEventListener('scroll',toggleBottom);
$('#scrollBottom').onclick=function(){stuck=true;msgsEl.scrollTo({top:msgsEl.scrollHeight,behavior:'smooth'});setTimeout(toggleBottom,220)};
function showQuoteDraft(){var c=cur(),q=c&&c.quoteDraft,bar=$('#quoteBar');if(!q){bar.className='';$('#quoteText').textContent='';$('#quoteSource').textContent='';return}$('#quoteText').textContent=q.text||'';$('#quoteSource').textContent=q.sourceIndex>=0?'Сообщение '+(q.sourceIndex+1)+' · нажмите на цитату после отправки, чтобы перейти к источнику':'Цитата';bar.className='on'}
$('#quoteRemove').onclick=function(){var c=cur();if(c){c.quoteDraft=null;save()}showQuoteDraft()};
function autosize(){inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,160)+'px'}
inp.addEventListener('input',function(){autosize();var c=cur();if(c&&editIdx===null){c.draft=inp.value;save()}});
function updateQuoteAction(){
  var sel=window.getSelection&&window.getSelection(),txt=sel?String(sel).trim():'';
  if(!txt||!sel||!sel.rangeCount){$('#quoteAction').className='';return}
  var node=sel.getRangeAt(0).commonAncestorContainer,el=node.nodeType===1?node:node.parentElement;
  var bub=el&&el.closest?el.closest('.msg.assistant .bub'):null,msg=bub&&bub.closest('.msg');
  if(!msg){$('#quoteAction').className='';return}
  quoteSelection=txt;quoteSourceId=msg.getAttribute('data-i');$('#quoteAction').className='on';
}
document.addEventListener('selectionchange',updateQuoteAction);
$('#quoteAction').onmousedown=function(e){e.preventDefault()};
$('#quoteAction').onclick=function(){var c=cur();if(!c||!quoteSelection)return;c.quoteDraft={text:quoteSelection,sourceId:c.msgs[+quoteSourceId]&&c.msgs[+quoteSourceId].id||'',sourceIndex:+quoteSourceId};save();showQuoteDraft();$('#quoteAction').className='';if(window.getSelection)window.getSelection().removeAllRanges();inp.focus()};
inp.addEventListener('keydown',function(e){if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();send()}});
function restoreChatComposer(c){inp.value=c?(c.draft||''):'';pendingFiles=c?(c.draftAttachments||[]).map(function(f){return Object.assign({},f)}):[];renderPending();autosize();showQuoteDraft()}
function setBusy(){var g=$('#go');g.innerHTML=busy?'&#9632;':'&#8593;';g.setAttribute('aria-label',busy?'Остановить':'Отправить')}
function fillChatModel(){
  var sel=$('#chatModel');if(!sel)return;
  var current=activeModel(cur()),list=S.cfg.models.slice();if(current&&list.indexOf(current)<0)list.unshift(current);
  sel.innerHTML=list.map(function(m){return '<option value="'+esc(m)+'">'+esc(m)+'</option>'}).join('');sel.value=current||'';
}
function updSub(){
  var c=cur(),m=activeModel(c).split('/').pop(),s=m+', ≈'+fmtN(estTokens(c))+' ток.';
  if(c&&liveFrom(c)>0)s+=' · чат ≈'+fmtN(totalTokens(c));
  $('#sub').textContent=s;
  var pb=$('#bPins'),sb=$('#bSum');
  if(pb)pb.textContent='📌 '+pinCount(c);
  if(sb)sb.className='qb'+(c&&c.sum?' on':'');
  var sel=$('#chatModel');if(sel&&sel.value!==activeModel(c))sel.value=activeModel(c);
}
function bubbleHTML(m,live,open){
  if(m.role==='user'){
    var uh='';
    if(m.quote){var qh='<div class="quote-in-msg"><small>Цитата из ответа ассистента</small>';
      qh+=m.quote.sourceId?'<button type="button" data-quote-go="'+esc(m.quote.sourceId)+'">'+esc(m.quote.text||'')+'</button>':esc(m.quote.text||'');uh+=qh+'</div>';
    }
    uh+='<div>'+esc(m.content||'')+'</div>';
    if(m.attachments&&m.attachments.length){uh+='<div class="filechips">'+m.attachments.map(function(f){return '<div class="attachitem"><span>'+(f.dataUrl?'🖼 ':'📄 ')+esc(f.name)+'</span></div>'}).join('')+'</div>'}
    return uh;
  }
  var p=parts(m),h='',files=[];
  if(p.think)h+='<details class="th"'+(open?' open':'')+'><summary>'+(live&&!p.text?'Думает…':'Рассуждения')+'</summary><div>'+esc(p.think)+'</div></details>';
  if(m.modelNotice)h+='<div class="model-note">'+esc(m.modelNotice)+'</div>';if(m.agentStatus)h+='<div class="model-note">'+esc(m.agentStatus)+'</div>';if(m.agentSummary)h+='<details class="th"><summary>Мультиагентный анализ</summary><div>'+esc(m.agentSummary)+'</div></details>';
  if(m.execLog&&m.execLog.length){var logText=m.execLog.map(function(x,i){return 'Запуск '+(i+1)+': '+x.status+'\n'+x.output}).join('\n\n');h+='<details class="th"><summary>Песочница · '+m.execLog.length+' запуск(ов)</summary><div>'+esc(logText)+'</div></details>'}
  if(p.text){h+=md(p.text,files);if(files.length)h+='<div class="fileoutputs">'+fileCards(files)+'</div>';}else if(live&&!p.think&&!m.execLog)h+='<span class="dots">…</span>';
  if(m.err)h+='<div class="err">'+esc(m.err)+'</div>';
  return h;
}
function fillBubble(el,m,live){
  var b=el.querySelector('.bub'),d=b.querySelector('details.th');
  b.innerHTML=bubbleHTML(m,live,d?d.open:false);
}
function versionBarHTML(m){
  if(busy||!m||!m.originalVersion||!m.regenVersions||!m.regenVersions.length)return '';
  var total=1+m.regenVersions.length,idx=Math.max(0,Math.min(total-1,+m.activeVersion||0));
  var label=idx===0?'Исходный ответ':('Повтор '+idx);
  return '<div class="versionbar"><button type="button" data-v="prev" '+(idx===0?'disabled':'')+' aria-label="Предыдущий вариант">‹</button><span class="vlabel">'+label+' · '+(idx+1)+' из '+total+'</span><button type="button" data-v="next" '+(idx===total-1?'disabled':'')+' aria-label="Следующий вариант">›</button></div>';
}
function responseSnapshot(m){return{content:m.content||'',reasoning:m.reasoning||'',execLog:(m.execLog||[]).map(function(x){return Object.assign({},x)}),apiTrail:(m.apiTrail||[]).map(function(x){return JSON.parse(JSON.stringify(x))}),apiFinalContent:m.apiFinalContent===undefined?undefined:m.apiFinalContent,modelNotice:m.modelNotice||'',agentStatus:m.agentStatus||'',agentSummary:m.agentSummary||'',err:m.err||''}}
function applyResponseSnapshot(m,v){m.content=v.content||'';m.reasoning=v.reasoning||'';m.execLog=(v.execLog||[]).map(function(x){return Object.assign({},x)});m.apiTrail=(v.apiTrail||[]).map(function(x){return JSON.parse(JSON.stringify(x))});m.apiFinalContent=v.apiFinalContent;m.modelNotice=v.modelNotice||'';m.agentStatus=v.agentStatus||'';m.agentSummary=v.agentSummary||'';m.err=v.err||''}
function syncCurrentVersion(m){
  if(!m||!m.originalVersion)return;
  var v=responseSnapshot(m),idx=Math.max(0,+m.activeVersion||0);
  if(idx===0)m.originalVersion=v;else if(m.regenVersions&&m.regenVersions[idx-1])m.regenVersions[idx-1]=v;
}
function switchVersion(m,idx){
  if(busy||!m||!m.originalVersion||!m.regenVersions)return;
  var max=m.regenVersions.length,at=Math.max(0,Math.min(max,idx));
  var current=+m.activeVersion||0;if(at===current)return;
  syncCurrentVersion(m);applyResponseSnapshot(m,at===0?m.originalVersion:m.regenVersions[at-1]);m.activeVersion=at;saveNow();render();
}
function actions(c,i){
  var m=c.msgs[i],last=i===c.msgs.length-1,a=[['copy','Копировать']];
  if(m.role==='user'){a.push(['edit','Изменить']);if(last)a.push(['regen','Повторить ответ'])}
  else if(last)a.push(['regen','Повторить']);
  return a.map(function(x){return '<button data-a="'+x[0]+'">'+x[1]+'</button>'}).join('');
}
function emptyHTML(){
  var h=host(S.cfg.url);
  if(h.indexOf('nvidia')>=0)return '<div class="hint"><h2>NVIDIA не пускает браузер</h2><p class="warn">Сервер NVIDIA запрещает запросы из браузера (защита CORS), поэтому с этим адресом чат не заработает.</p><p>Та же модель есть на OpenRouter, и там её можно использовать бесплатно.</p><button class="pri" id="hOr">Переключить на OpenRouter</button></div>';
  if(!curKey())return '<div class="hint"><h2>Подключите модель</h2><ol><li>Откройте <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">openrouter.ai/keys</a>, войдите и создайте ключ.</li><li>На <a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noopener noreferrer">openrouter.ai/settings/privacy</a> разрешите бесплатные модели.</li><li>Вставьте ключ в настройках.</li></ol><button class="pri" id="hSet">Открыть настройки</button></div>';
  return '<div class="hint"><h2>Чат готов</h2><p>Напишите сообщение. Чтобы ассистент запомнил что-то надолго, напишите «запомни: …».</p></div>';
}
function render(force){
  var c=cur();
  $('#ttl').textContent=c?c.title:'Новый чат';updSub();
  wrap.innerHTML='';
  if(!c||!c.msgs.length){wrap.innerHTML=emptyHTML();toggleBottom();return}
  c.msgs.forEach(function(m,i){
    var d=document.createElement('div');d.className='msg '+m.role+(m.pin?' pinned':'');d.setAttribute('data-i',i);
    var live=busy&&i===c.msgs.length-1&&m.role==='assistant';
    d.innerHTML='<div class="bub"></div>'+(live?'':'<div class="acts">'+actions(c,i)+'</div>')+versionBarHTML(m);
    d.querySelector('.bub').innerHTML=bubbleHTML(m,live,false);
    wrap.appendChild(d);
    if(c.sumUpTo&&i===liveFrom(c)-1){var sl=document.createElement('div');sl.className='sumline';sl.textContent='↑ выше уже в пересказе и модели не отправляется · нажмите, чтобы открыть пересказ';wrap.appendChild(sl)}
  });
  if(errBox){var e=document.createElement('div');e.className='err';e.textContent=errBox;wrap.appendChild(e)}
  stick(force);
}
var raf=false;
function paint(c){
  if(raf)return;
  raf=true;
  var delay=Math.max(0,100-(Date.now()-lastPaint));
  paintTimer=setTimeout(function(){requestAnimationFrame(function(){
    raf=false;lastPaint=Date.now();if(cur()!==c)return;
    var els=wrap.querySelectorAll('.msg'),el=els[els.length-1];
    if(el)fillBubble(el,c.msgs[c.msgs.length-1],true);
    updSub();stick();
  })},delay);
}
function copyText(t){
  var fb=function(){var x=document.createElement('textarea');x.value=t;x.style.cssText='position:fixed;opacity:0';document.body.appendChild(x);x.select();var ok=false;try{ok=document.execCommand('copy')}catch(e){}document.body.removeChild(x);return ok};
  if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(t).then(function(){return true},function(){return fb()});
  return Promise.resolve(fb());
}