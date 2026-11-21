function renderPending(){
  var box=$('#attachList');box.innerHTML='';
  pendingFiles.forEach(function(f,i){var d=document.createElement('div');d.className='attachitem';var sp=document.createElement('span');sp.textContent=(f.dataUrl?'🖼 ':'📄 ')+f.name;var b=document.createElement('button');b.type='button';b.textContent='×';b.setAttribute('aria-label','Убрать файл');b.onclick=function(){pendingFiles.splice(i,1);var c=cur();if(c){c.draftAttachments=pendingFiles.map(function(x){return Object.assign({},x)});save()}renderPending()};d.appendChild(sp);d.appendChild(b);box.appendChild(d)});
  var c=cur();if(c&&editIdx===null){c.draftAttachments=pendingFiles.map(function(x){return Object.assign({},x)});save()}
}
function readAsBuffer(file){return new Promise(function(resolve,reject){var r=new FileReader();r.onload=function(){resolve(r.result)};r.onerror=function(){reject(new Error('Не удалось прочитать файл'))};r.readAsArrayBuffer(file)})}
function readAsData(file){return new Promise(function(resolve,reject){var r=new FileReader();r.onload=function(){resolve(r.result)};r.onerror=function(){reject(new Error('Не удалось прочитать изображение'))};r.readAsDataURL(file)})}
function decodeFile(buffer){
  var bytes=new Uint8Array(buffer),txt='';
  try{txt=new TextDecoder('utf-8',{fatal:false}).decode(bytes)}catch(e){txt=''}
  var bad=(txt.match(/\uFFFD/g)||[]).length;
  if(bad>Math.max(2,txt.length*.01)){try{txt=new TextDecoder('windows-1251').decode(bytes)}catch(e){}}
  return txt.replace(/^\uFEFF/,'');
}
function hashBuffer(buffer){
  if(window.crypto&&crypto.subtle&&crypto.subtle.digest)return crypto.subtle.digest('SHA-256',buffer).then(function(d){return Array.prototype.map.call(new Uint8Array(d),function(b){return b.toString(16).padStart(2,'0')}).join('')});
  var a=new Uint8Array(buffer),h1=2166136261,h2=0x9e3779b9;for(var i=0;i<a.length;i++){h1=Math.imul(h1^a[i],16777619);h2=Math.imul(h2+a[i]+(h2<<6)+(h2>>>2),2246822519)}return Promise.resolve(a.length+':'+(h1>>>0).toString(16)+':'+(h2>>>0).toString(16));
}
function verifyImageData(data){return new Promise(function(resolve,reject){var im=new Image();im.onload=function(){if(im.naturalWidth>0&&im.naturalHeight>0)resolve(true);else reject(new Error('Изображение не содержит корректных пикселей'))};im.onerror=function(){reject(new Error('Изображение повреждено или не поддерживается'))};im.src=data})}
function validateTextContent(bytes,txt){
  if(!bytes.length||!txt||!txt.trim())throw new Error('Файл пустой или не содержит читаемого текста');
  var controls=0;for(var i=0;i<bytes.length;i++)if(bytes[i]===0)controls++;
  if(controls>0)throw new Error('Файл похож на двоичный или повреждённый, а не на текстовый');
  var bad=(txt.match(/\uFFFD/g)||[]).length;if(bad>Math.max(5,txt.length*.03))throw new Error('Не удалось корректно декодировать содержимое файла');
}
async function attachSelected(list){
  var incoming=Array.prototype.slice.call(list||[]);if(!incoming.length)return;
  if(pendingFiles.length+incoming.length>5){toast('Можно прикрепить не больше 5 файлов за раз');return}
  var total=pendingFiles.reduce(function(n,f){return n+(f.size||0)},0),added=0;
  var imageMime={'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','webp':'image/webp','gif':'image/gif'};
  for(var i=0;i<incoming.length;i++){
    var f=incoming[i],ext=extOf(f.name),mime=f.type||'',isImg=/^image\/(png|jpeg|webp|gif)$/.test(mime)||(!mime&&!!imageMime[ext]);
    if(!f.size){toast('Файл «'+f.name+'» пустой');continue}
    if(isImg){
      var imgType=mime||imageMime[ext];
      if(!/^image\/(png|jpeg|webp|gif)$/.test(imgType)){toast('Тип изображения «'+f.name+'» не поддерживается');continue}
      if(f.size>700*1024||total+f.size>1200*1024){toast('Изображение слишком большое (максимум 700 КБ на файл)');continue}
      try{
        var ibuf=await readAsBuffer(f);if(!ibuf||ibuf.byteLength!==f.size)throw new Error('Размер прочитанного изображения не совпадает с размером файла');
        var ihash=await hashBuffer(ibuf);if(pendingFiles.some(function(x){return x.hash===ihash})){toast('Файл «'+f.name+'» уже прикреплён (совпадает содержимое)');continue}
        var data=await readAsData(f);if(typeof data!=='string'||data.indexOf(',')<0)throw new Error('Не удалось получить содержимое изображения');data='data:'+imgType+';base64,'+data.slice(data.indexOf(',')+1);
        await verifyImageData(data);
        pendingFiles.push({name:f.name,type:imgType,size:ibuf.byteLength,hash:ihash,dataUrl:data});total+=ibuf.byteLength;added++;
      }catch(e){toast('«'+f.name+'»: '+(e.message||'не удалось проверить изображение'))}
    }else if(TEXT_EXTS.indexOf(ext)>=0||/^text\//.test(mime)||/^(application\/(json|xml))$/.test(mime)){
      if(f.size>120*1024||total+f.size>260*1024){toast('Текстовый файл слишком большой (максимум 120 КБ на файл)');continue}
      try{
        var buf=await readAsBuffer(f);if(!buf||buf.byteLength!==f.size)throw new Error('Размер прочитанного файла не совпадает с размером оригинала');
        var txt=decodeFile(buf);validateTextContent(new Uint8Array(buf),txt);
        var thash=await hashBuffer(buf);if(pendingFiles.some(function(x){return x.hash===thash})){toast('Файл «'+f.name+'» уже прикреплён (совпадает содержимое)');continue}
        pendingFiles.push({name:f.name,type:mime||'text/plain',size:buf.byteLength,hash:thash,text:txt});total+=buf.byteLength;added++;
      }catch(e){toast('«'+f.name+'»: '+(e.message||'не удалось прочитать файл'))}
    }else{toast('Формат '+(ext||mime||'файла')+' пока не поддерживается. Используйте текстовые/кодовые файлы или изображения.')}
  }
  renderPending();if(added)toast('Проверено и прикреплено файлов: '+added);
}
$('#bAttach').onclick=function(){if(busy)return toast('Дождитесь окончания ответа');$('#fAttach').click()};
$('#fAttach').onchange=function(e){attachSelected(e.target.files);e.target.value=''};
