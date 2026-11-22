async function sendCodeToBot(fileName, code, language){
  var apiBase=String((window.APP_CONFIG&&window.APP_CONFIG.apiBaseUrl)||'').trim().replace(/\/+$/,'');
  if(!TG||!TG.initData){toast('Откройте мини-приложение из чата с ботом Telegram');return}
  if(!apiBase){toast('Отправка в чат бота ещё не настроена: сначала разверните сервер и укажите его адрес в config.js');return}
  if(!code){toast('В этом файле нет кода для отправки');return}
  toast('Отправляю файл в чат бота…');
  try{
    var response=await fetch(apiBase+'/api/send-code',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({initData:TG.initData,fileName:fileName,language:language||'txt',code:code})
    });
    var result=await response.json().catch(function(){return{}});
    if(!response.ok||!result.ok)throw new Error(result.error||('Ошибка отправки: HTTP '+response.status));
    toast('Файл «'+fileName+'» отправлен в чат бота');
  }catch(err){
    toast(err&&err.message?err.message:'Не удалось отправить файл в чат бота');
  }
}
wrap.addEventListener('click',function(e){
  var t=e.target;
  var quoteGo=t.closest&&t.closest('[data-quote-go]');
  if(quoteGo){var cgo=cur(),sid=quoteGo.getAttribute('data-quote-go'),at=cgo?cgo.msgs.findIndex(function(x){return x.id===sid}):-1;if(at>=0)goMsg(at);else toast('Исходное сообщение больше недоступно');return}
  var versionBtn=t.closest&&t.closest('[data-v]');
  if(versionBtn){var vm=versionBtn.closest('.msg'),vc=cur(),vi=vm&&vc?+vm.getAttribute('data-i'):-1;if(vi>=0){var mm=vc.msgs[vi],now=+mm.activeVersion||0;switchVersion(mm,now+(versionBtn.getAttribute('data-v')==='next'?1:-1))}return}
  if(t.id==='hSet'){openSet();return}
  if(t.id==='hOr'){applyPreset('or');render();return}
  var fileBtn=t.closest&&t.closest('.fileout');
  if(fileBtn){
    var source=fileBtn.querySelector('.file-source'),fileName=fileBtn.getAttribute('data-name')||'code.txt';
    var fileCode=source?source.textContent:'',lang=fileBtn.getAttribute('data-lang')||'txt';
    if(t.closest&&t.closest('.filedown'))saveText(fileName,fileCode);
    else sendCodeToBot(fileName,fileCode,lang);
    return;
  }
  if(t.classList&&t.classList.contains('cp')){
    var cb=t.closest('.cb');
    copyText(cb.querySelector('code').textContent).then(function(ok){t.textContent=ok?'Скопировано':'Не вышло';setTimeout(function(){t.textContent='Копировать'},1500)});
    return;
  }
  if(t.classList&&t.classList.contains('dl')){
    var block=t.closest('.cb'),code=block&&block.querySelector('code');if(!code)return;
    saveText(t.getAttribute('data-name')||'code.txt',code.textContent);return;
  }
  var a=t.getAttribute&&t.getAttribute('data-a');
  if(!a){
    if(t.classList&&t.classList.contains('sumline')){openSummary();return}
    if(t.closest&&t.closest('a,button,summary,details,.cb,.tbl,.fileoutputs'))return;
    var sel=window.getSelection&&window.getSelection();if(sel&&String(sel).length)return;
    var mg=t.closest&&t.closest('.msg');if(mg)openMenu(+mg.getAttribute('data-i'));
    return;
  }
  var msg=t.closest('.msg'),c=cur();if(!msg||!c)return;
  var i=+msg.getAttribute('data-i'),m=c.msgs[i];
  if(a==='copy')copyText(m.role==='user'?m.content:parts(m).text).then(function(ok){toast(ok?'Скопировано':'Не удалось скопировать')});
  if(a==='edit')startEdit(i);
  if(a==='regen')regen();
});
function startEdit(i){
  var c=cur();if(!c||busy)return;
  editIdx=i;inp.value=c.msgs[i].content;pendingFiles=(c.msgs[i].attachments||[]).map(function(f){return Object.assign({},f)});c.quoteDraft=c.msgs[i].quote?Object.assign({},c.msgs[i].quote):null;showQuoteDraft();renderPending();autosize();$('#edit').className='on';inp.focus();
}
function endEdit(){editIdx=null;$('#edit').className=''}
$('#eCancel').onclick=function(){var c=cur();endEdit();inp.value=c?(c.draft||''):'';pendingFiles=c?(c.draftAttachments||[]).slice():[];if(c)c.quoteDraft=null;showQuoteDraft();renderPending();autosize()};
