/* ---------- отправка ---------- */
function httpErr(r){
  return r.text().then(function(t){
    var j=null,msg=t||('HTTP '+r.status);
    try{j=JSON.parse(t);var er=j.error||j;msg=er.message||er.detail||j.message||t||('HTTP '+r.status)}catch(e){}
    if(typeof msg!=='string')msg=JSON.stringify(msg);
    var e=new Error(msg.slice(0,700));e.status=r.status;e.payload=j;e.headers=r.headers;return e;
  },function(){var e=new Error('HTTP '+r.status);e.status=r.status;return e;});
}
function niceErr(e){
  var s=e.status,m=e.message||'',er=e.payload&&(e.payload.error||e.payload)||{},md=er.metadata||{};
  if(!s){
    if(/failed to fetch|load failed|networkerror/i.test(m))
      return host(S.cfg.url).indexOf('nvidia')>=0
        ?'NVIDIA не разрешает запросы из браузера (CORS). Используйте совместимый endpoint, например OpenRouter.'
        :'Не удалось связаться с сервером. Проверьте интернет, адрес API и поддержку CORS. Подробности: '+m;
    return m;
  }
  if(s===401||s===403)return 'Ошибка авторизации ('+s+'): '+m+' Проверьте ключ и адрес API.';
  if(s===402){
    var src=md.limit_source||md.reason||'не указан';
    var hint=md.remedy_hint||md.message||'';
    return 'OpenRouter отклонил запрос (402). Источник ограничения: '+src+'. Ответ сервера: '+m+(hint?' Подсказка: '+hint:'')+'. Это само по себе НЕ доказывает, что баланс аккаунта равен нулю.';
  }
  if(s===404){
    if(/no endpoints found that support (?:base64 )?image input/i.test(m))return 'Выбранная модель не поддерживает входные изображения. Для фото нужна vision-модель, у которой входные модальности включают image. В OpenRouter можно использовать бесплатный роутер openrouter/free. Ответ: '+m;
    if(/data policy|guardrail/i.test(m))return 'OpenRouter не нашёл доступный бесплатный сервер из-за настроек приватности. Проверьте настройки бесплатных моделей. Ответ: '+m;
    return 'Не найдено (404). Проверьте endpoint и ID модели. Ответ: '+m;
  }
  if(s===429)return 'Превышен лимит запросов (429): '+m+'. Подождите и повторите.';
  if(s>=500)return 'Сервер модели вернул ошибку '+s+': '+m;
  return 'Ошибка HTTP '+s+': '+m;
}

/* ---------- вложения ---------- */
var TEXT_EXTS='txt md csv tsv json xml html htm css js mjs cjs ts tsx jsx py java c h cpp hpp cs go rs php rb swift kt sql sh bat ps1 yaml yml toml ini conf cfg log env properties diff patch vue svelte ipynb gradle'.split(' ');
function extOf(n){var m=String(n||'').toLowerCase().match(/\.([a-z0-9]+)$/);return m?m[1]:''}