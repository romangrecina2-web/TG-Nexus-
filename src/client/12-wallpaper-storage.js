/* ---------- пользовательские обои: отдельное хранилище IndexedDB ---------- */
var wallDbPromise=null,wallpaperDraftBlob=null,wallpaperSavedBlob=null,wallPreviewUrl=null,wallAppliedUrl=null;
function wallDB(){
  if(!window.indexedDB)return Promise.reject(new Error('IndexedDB недоступна в этом браузере'));
  if(wallDbPromise)return wallDbPromise;
  wallDbPromise=new Promise(function(resolve,reject){var req=indexedDB.open('light_shell_assets_v1',1);req.onupgradeneeded=function(){var db=req.result;if(!db.objectStoreNames.contains('assets'))db.createObjectStore('assets')};req.onsuccess=function(){resolve(req.result)};req.onerror=function(){reject(req.error||new Error('Не удалось открыть IndexedDB'))};req.onblocked=function(){reject(new Error('Хранилище занято другой вкладкой'))}});
  return wallDbPromise;
}
function wallGet(){return wallDB().then(function(db){return new Promise(function(resolve,reject){var tx=db.transaction('assets','readonly'),r=tx.objectStore('assets').get('wallpaper');r.onsuccess=function(){resolve(r.result||null)};r.onerror=function(){reject(r.error||new Error('Не удалось прочитать обои'))}})})}
function wallPut(blob,name){return wallDB().then(function(db){return new Promise(function(resolve,reject){var tx=db.transaction('assets','readwrite');tx.objectStore('assets').put({blob:blob,name:name||'wallpaper'},'wallpaper');tx.oncomplete=function(){resolve(true)};tx.onerror=function(){reject(tx.error||new Error('Не удалось сохранить обои'))};tx.onabort=function(){reject(tx.error||new Error('Сохранение обоев отменено'))}})})}
function wallDelete(){return wallDB().then(function(db){return new Promise(function(resolve,reject){var tx=db.transaction('assets','readwrite');tx.objectStore('assets').delete('wallpaper');tx.oncomplete=function(){resolve(true)};tx.onerror=function(){reject(tx.error||new Error('Не удалось удалить обои'))}})})}
function setWallpaper(blob){
  if(wallAppliedUrl)URL.revokeObjectURL(wallAppliedUrl);wallAppliedUrl=null;
  if(!blob){document.body.classList.remove('wallpaper');document.body.style.removeProperty('--wallpaper-image');return}
  wallAppliedUrl=URL.createObjectURL(blob);document.body.style.setProperty('--wallpaper-image','url("'+wallAppliedUrl+'")');document.body.classList.add('wallpaper');
}
function showWallpaperPreview(blob,name){
  if(wallPreviewUrl)URL.revokeObjectURL(wallPreviewUrl);wallPreviewUrl=null;
  var box=$('#wallPreviewWrap'),img=$('#wallPreview');
  if(!blob){box.className='wall-preview';img.removeAttribute('src');return}
  wallPreviewUrl=URL.createObjectURL(blob);img.src=wallPreviewUrl;$('#wallStatus').textContent=name||'Предварительный просмотр';box.className='wall-preview on';
}
async function refreshWallpaperPreview(){
  try{var row=await wallGet();wallpaperSavedBlob=row&&row.blob||null;if(!wallpaperDraftBlob&&wallpaperSavedBlob)showWallpaperPreview(wallpaperSavedBlob,'Сохранённое изображение'+(S.cfg.wallpaperEnabled?' · сейчас применяется':' · сейчас отключено'));}
  catch(e){$('#wallStatus').textContent=e.message||'IndexedDB недоступна';}
}
$('#wallPick').onclick=function(){$('#fWallpaper').click()};
$('#fWallpaper').onchange=async function(e){
  var f=e.target.files&&e.target.files[0];e.target.value='';if(!f)return;
  if(!f.type||f.type.indexOf('image/')!==0){toast('Выберите файл изображения');return}
  if(!f.size){toast('Выбранное изображение пустое');return}
  if(f.size>50*1024*1024){toast('Изображение слишком большое (максимум 50 МБ)');return}
  var url=URL.createObjectURL(f);
  try{await new Promise(function(resolve,reject){var im=new Image();im.onload=function(){if(im.naturalWidth&&im.naturalHeight)resolve();else reject(new Error('Изображение не удалось декодировать'))};im.onerror=function(){reject(new Error('Файл изображения повреждён или не поддерживается'))};im.src=url});
    wallpaperDraftBlob=f;showWallpaperPreview(f,'Предпросмотр: '+f.name+' · '+fmtN(f.size)+' Б');
  }catch(err){toast(err.message||'Не удалось проверить изображение')}
  URL.revokeObjectURL(url);
};
$('#wallApply').onclick=async function(){
  var blob=wallpaperDraftBlob||wallpaperSavedBlob;if(!blob){toast('Сначала выберите изображение');return}
  try{await wallPut(blob,wallpaperDraftBlob&&wallpaperDraftBlob.name||'wallpaper');wallpaperSavedBlob=blob;wallpaperDraftBlob=null;S.cfg.wallpaperEnabled=true;saveNow();setWallpaper(blob);showWallpaperPreview(blob,'Обои сохранены и применены');toast('Обои применены')}
  catch(e){toast('Не удалось сохранить обои в IndexedDB: '+(e.message||e))}
};
$('#wallReset').onclick=function(){S.cfg.wallpaperEnabled=false;saveNow();setWallpaper(null);if(wallpaperSavedBlob)showWallpaperPreview(wallpaperSavedBlob,'Сохранено, но отключено · стандартный фон активен');toast('Стандартный фон восстановлен')};
$('#wallDelete').onclick=async function(){
  try{await wallDelete();wallpaperSavedBlob=null;wallpaperDraftBlob=null;S.cfg.wallpaperEnabled=false;saveNow();setWallpaper(null);showWallpaperPreview(null);toast('Пользовательские обои удалены')}
  catch(e){toast('Не удалось удалить обои: '+(e.message||e))}
};
async function initWallpaper(){
  try{var row=await wallGet();wallpaperSavedBlob=row&&row.blob||null;if(S.cfg.wallpaperEnabled&&wallpaperSavedBlob)setWallpaper(wallpaperSavedBlob);else if(S.cfg.wallpaperEnabled&&!wallpaperSavedBlob){S.cfg.wallpaperEnabled=false;save()}}
  catch(e){if(S.cfg.wallpaperEnabled)toast('Не удалось загрузить обои: '+(e.message||e))}
}
