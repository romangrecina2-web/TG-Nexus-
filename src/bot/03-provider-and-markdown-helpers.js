}function normalizeApiBase(value) {
  try {
    const url = new URL(String(value || DEFAULT_API_BASE_URL));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function findProviderById(id) {
  return PROVIDER_CATALOG.find((provider) => provider.id === String(id || '').trim().toLowerCase()) || null;
}

function findProviderByUrl(value) {
  const base = normalizeApiBase(value);
  if (!base) return null;
  return PROVIDER_CATALOG.find((provider) => normalizeApiBase(provider.url) === base) || null;
}

function splitTelegramText(value, maxLength = TELEGRAM_CHUNK_LENGTH) {
  let remaining = String(value == null ? '' : value);
  if (!remaining) return [' '];
  const result = [];
  while (remaining.length > maxLength) {
    let cut = maxLength;
    const minCut = Math.floor(maxLength * 0.65);
    const prefix = remaining.slice(0, maxLength);
    const newline = prefix.lastIndexOf('\n');
    const space = prefix.lastIndexOf(' ');
    const boundary = Math.max(newline, space);
    if (boundary >= minCut) cut = boundary + 1;
    if (cut > 0 && /[\uD800-\uDBFF]/.test(remaining.charAt(cut - 1))) cut -= 1;
    result.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) result.push(remaining);
  return result;
}



function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatInlineMarkdown(value) {
  const text = String(value);
  const tick = String.fromCharCode(96);
  const pattern = new RegExp(
    tick + "[^" + tick + "\\n]*" + tick +
    "|\\[[^\\n]+?\\]\\((?:https?:\\/\\/|tg:\\/\\/)[^\\s)]{1,2048}\\)" +
    "|\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__" +
    "|(?<![\\p{L}\\p{N}*])\\*(?!\\s)[^*\\n]+?\\*(?!\\*)" +
    "|(?<![\\p{L}\\p{N}])_(?!\\s)[^_\\n]+?_(?![\\p{L}\\p{N}])",
    'gu'
  );
  let result = '';
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith(tick)) {
      result += '<code>' + escapeHtml(token.slice(1, -1)) + '</code>';
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+|tg:\/\/[^\s)]+)\)$/u);
      if (!link) {
        result += escapeHtml(token);
      } else {
        let safe = false;
        try {
          const parsed = new URL(link[2]);
          safe = parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'tg:';
        } catch {}
        result += safe
          ? '<a href="' + escapeHtmlAttribute(link[2]) + '">' + formatInlineMarkdown(link[1]) + '</a>'
          : escapeHtml(token);
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      result += '<b>' + formatInlineMarkdown(token.slice(2, -2)) + '</b>';
    } else if (token.startsWith('*') || token.startsWith('_')) {
      result += '<i>' + formatInlineMarkdown(token.slice(1, -1)) + '</i>';
    } else {
      result += escapeHtml(token);
    }
    lastIndex = match.index + token.length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

function splitTableCells(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function markdownToTelegramHtml(markdown) {
  const lines = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const fence = String.fromCharCode(96).repeat(3);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimStart().startsWith(fence)) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        code.push(lines[i]);
        i += 1;
      }
      output.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }

    if (i + 1 < lines.length && line.includes('|') && lines[i + 1].includes('|') && isTableSeparator(lines[i + 1])) {
      const headers = splitTableCells(line);
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitTableCells(lines[i]);
        const values = cells.map((cell, index) => {
          const header = headers[index] || ('Колонка ' + (index + 1));
          return '<b>' + formatInlineMarkdown(header) + ':</b> ' + formatInlineMarkdown(cell);
        });
        output.push('• ' + values.join(' · '));
        i += 1;
      }
      i -= 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) continue;

    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      output.push('<b>' + formatInlineMarkdown(heading[1]) + '</b>');
      continue;
    }

    const bullet = line.match(/^(\s*)[*+-]\s+(.*)$/);
    if (bullet) {
      output.push((bullet[1] ? '  ' : '') + '• ' + formatInlineMarkdown(bullet[2]));
      continue;
    }

    output.push(formatInlineMarkdown(line));
  }

  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function telegramHtmlToPlainText(html) {
  return String(html)
    .replace(/<\/?(?:b|i|code|pre)(?:\s+[^>]*)?>/gi, '')
    .replace(/<a\s+href="[^"]*">/gi, '')
    .replace(/<\/a>/gi, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ({
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'"
    })[entity]);
}

function splitTelegramHtml(value, maxLength = TELEGRAM_CHUNK_LENGTH) {
  const html = String(value == null ? '' : value);
  if (!html) return [{ html: ' ', text: ' ' }];
  const tokenPattern = /<\/?(?:b|i|code|pre|a)(?:\s+href="[^"]*")?\s*>|&(?:amp|lt|gt|quot|#39);|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g;
  const tokens = html.match(tokenPattern) || [];
  const chunks = [];
  const stack = [];
  let current = '';

  function openTags(items) {
    return items.map((item) => item.raw).join('');
  }

  function closeTags(items) {
    return items.slice().reverse().map((item) => '</' + item.name + '>').join('');
  }

  function flush() {
    if (current.length > openTags(stack).length) {
      const completed = current + closeTags(stack);
      chunks.push({ html: completed, text: telegramHtmlToPlainText(completed) });
      current = openTags(stack);
    }
  }

  for (const token of tokens) {
    const opening = token.match(/^<(b|i|code|pre|a)(?:\s+href="[^"]*")?\s*>$/i);
    const closing = token.match(/^<\/(b|i|code|pre|a)>$/i);

    if (opening) {
      const item = { name: opening[1].toLowerCase(), raw: token };
      const nextStack = stack.concat(item);
      if (current.length + token.length + closeTags(nextStack).length > maxLength &&
          current.length > openTags(stack).length) flush();
      current += token;
      stack.push(item);
      continue;
    }

    if (closing && stack.length && stack[stack.length - 1].name === closing[1].toLowerCase()) {
      const nextStack = stack.slice(0, -1);
      if (current.length + token.length + closeTags(nextStack).length > maxLength &&
          current.length > openTags(stack).length) flush();
      current += token;
      stack.pop();
      continue;
    }

    if (current.length + token.length + closeTags(stack).length > maxLength &&
        current.length > openTags(stack).length) flush();
    current += token;
  }

  if (current.length > openTags(stack).length) {
    const completed = current + closeTags(stack);
    chunks.push({ html: completed, text: telegramHtmlToPlainText(completed) });
  }
  return chunks.length ? chunks : [{ html: ' ', text: ' ' }];
}

function isTelegramHtmlParseError(error) {
  const description = String(error && (error.telegramDescription || error.message) || '');
  return /parse entities|can't parse entities|cannot parse entities|unsupported (?:start|end) tag|can't find end of.*entity/i.test(description);
}
