(function(){
'use strict';
var $=function(s){return document.querySelector(s)};

/*MD-START*/
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function inline(s){
  var codes=[];
  s=s.replace(/`([^`\n]+)`/g,function(_,c){codes.push(c);return '\u0000'+(codes.length-1)+'\u0000'});
  s=s.replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>');
  s=s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g,'$1<i>$2</i>');
  s=s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s=s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)])/g,'$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g,function(_,i){return '<code>'+codes[+i]+'</code>'});
}
function codeExt(lang){
  var x=String(lang||'').toLowerCase().replace(/^language-/,'');
  var map={python:'py',py:'py',javascript:'js',js:'js',mjs:'mjs',cjs:'cjs',typescript:'ts',ts:'ts',jsx:'jsx',tsx:'tsx',html:'html',htm:'html',css:'css',json:'json',xml:'xml',sql:'sql',bash:'sh',shell:'sh',sh:'sh',yaml:'yaml',yml:'yaml',toml:'toml',markdown:'md',md:'md',text:'txt',txt:'txt',plain:'txt',java:'java',c:'c',h:'h',cpp:'cpp',hpp:'hpp',csharp:'cs',cs:'cs',go:'go',rust:'rs',rs:'rs',php:'php',ruby:'rb',rb:'rb',swift:'swift',kotlin:'kt',kt:'kt',powershell:'ps1',ps1:'ps1',vue:'vue',svelte:'svelte'};
  return map[x]||'txt';
}
function codeBlock(code,lang,name,num,files){
  var ext=codeExt(lang),fn=String(name||('code-'+num+'.'+ext)).replace(/^.*[\\/]/,'').replace(/[^\w. -]/g,'_').slice(0,90);
  if(!/\.[a-z0-9]{1,8}$/i.test(fn))fn+='.'+ext;
  files.push({name:fn,lang:lang||'Текстовый файл',code:code});
  return '';
}
function fileCards(files){
  return files.map(function(f){
    return '<button class="fileout" type="button" data-name="'+esc(f.name)+'" data-lang="'+esc(codeExt(f.lang))+'" title="Нажмите, чтобы отправить код в чат бота; стрелка — скачать или скопировать" aria-label="Отправить код файла '+esc(f.name)+' в чат бота"><span class="fileico">📄</span><span class="filemeta"><span class="filename">'+esc(f.name)+'</span><span class="filedesc">'+esc(f.lang||'Код')+' · '+fmtN(f.code.length)+' символов · нажмите, чтобы отправить в чат бота</span></span><span class="filedown" title="Скачать или скопировать">&#8595;</span><span class="file-source" hidden>'+esc(f.code)+'</span></button>';
  }).join('');
}
function isSep(l){return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)}
function cells(l){l=l.trim();if(l.charAt(0)==='|')l=l.slice(1);if(l.charAt(l.length-1)==='|')l=l.slice(0,-1);return l.split('|').map(function(x){return x.trim()})}
function table(h,rows){
  var t='<div class="tbl"><table><thead><tr>'+h.map(function(c){return '<th>'+inline(esc(c))+'</th>'}).join('')+'</tr></thead><tbody>';
  rows.forEach(function(r){t+='<tr>'+r.map(function(c){return '<td>'+inline(esc(c))+'</td>'}).join('')+'</tr>'});
  return t+'</tbody></table></div>';
}
function buildList(items){
  var h='',st=[];
  items.forEach(function(it){
    while(st.length&&it.indent<st[st.length-1].indent){h+='</li></'+st.pop().tag+'>'}
    var top=st[st.length-1],body=inline(esc(it.text)).replace(/\n/g,'<br>');
    if(!top||it.indent>top.indent){h+='<'+it.tag+'><li>'+body;st.push({indent:it.indent,tag:it.tag})}
    else{h+='</li><li>'+body}
  });
  while(st.length)h+='</li></'+st.pop().tag+'>';
  return h;
}
function md(src,files){
  files=files||[];
  var L=src.replace(/\r/g,'').replace(/\t/g,'  ').split('\n'),out=[],i=0,m,codeNo=0;
  var blockStart=/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/,hr=/^\s*([-*_])(\s*\1){2,}\s*$/,li=/^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  while(i<L.length){
    var l=L[i];
    if((m=l.match(/^\s*```\s*([\w+#.-]*)(?:\s+([^\s`]+))?/))){
      var buf=[];i++;
      while(i<L.length&&!/^\s*```/.test(L[i])){buf.push(L[i]);i++}
      i++;codeBlock(buf.join('\n'),m[1],m[2],++codeNo,files);continue;
    }
    if(/^\s*$/.test(l)){i++;continue}
    if((m=l.match(/^(#{1,6})\s+(.*)$/))){var n=Math.min(m[1].length+1,6);out.push('<h'+n+'>'+inline(esc(m[2]))+'</h'+n+'>');i++;continue}
    if(hr.test(l)){out.push('<hr>');i++;continue}
    if(/^\s*>/.test(l)){var q=[];while(i<L.length&&/^\s*>/.test(L[i])){q.push(L[i].replace(/^\s*>\s?/,''));i++}out.push('<blockquote>'+md(q.join('\n'),files)+'</blockquote>');continue}
    if(l.indexOf('|')>=0&&i+1<L.length&&isSep(L[i+1])){
      var head=cells(l),rows=[];i+=2;
      while(i<L.length&&L[i].indexOf('|')>=0&&!/^\s*$/.test(L[i])){rows.push(cells(L[i]));i++}
      out.push(table(head,rows));continue;
    }
    if(li.test(l)){
      var items=[];
      while(i<L.length){
        var lm=L[i].match(li);
        if(lm){items.push({indent:lm[1].length,tag:/\d/.test(lm[2])?'ol':'ul',text:lm[3]});i++;continue}
        if(items.length&&/^\s{2,}\S/.test(L[i])){items[items.length-1].text+='\n'+L[i].trim();i++;continue}
        if(/^\s*$/.test(L[i])){var j=i;while(j<L.length&&/^\s*$/.test(L[j]))j++;if(j<L.length&&li.test(L[j])){i=j;continue}}
        break;
      }
      out.push(buildList(items));continue;
    }
    var p=[l];i++;
    while(i<L.length&&!/^\s*$/.test(L[i])&&!blockStart.test(L[i])&&!hr.test(L[i])){p.push(L[i]);i++}
    out.push('<p>'+inline(esc(p.join('\n'))).replace(/\n/g,'<br>')+'</p>');
  }
  return out.join('');
}
function cleanTags(t){
  t=t.replace(/<remember>[\s\S]*?<\/remember>/g,'');
  var o=t.indexOf('<remember>');if(o>=0)t=t.slice(0,o);
  t=t.replace(/<summary>[\s\S]*?<\/summary>/g,'');
  o=t.indexOf('<summary>');if(o>=0)t=t.slice(0,o);
  var i=t.lastIndexOf('<');
  if(i>=0&&t.length-i<12){var tail=t.slice(i);if('<remember>'.indexOf(tail)===0||'<think>'.indexOf(tail)===0||'<summary>'.indexOf(tail)===0)t=t.slice(0,i)}
  return t;
}
function parts(m){
  var c=m.content||'',th=m.reasoning||'';
  c=c.replace(/<think>([\s\S]*?)<\/think>/g,function(_,x){th+=(th?'\n':'')+x;return ''});
  var o=c.indexOf('<think>');
  if(o>=0){th+=(th?'\n':'')+c.slice(o+7);c=c.slice(0,o)}
  var e=c.indexOf('</think>');
  if(e>=0){th+=(th?'\n':'')+c.slice(0,e);c=c.slice(e+8)}
  return{think:th.trim(),text:cleanTags(c).replace(/^\s+/,'').replace(/\s+$/,'')};
}
/*MD-END*/
