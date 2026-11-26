  function normalizeCodeLanguage(language) {
    const key = String(language || '').toLowerCase().replace(/^language-/, '');
    const aliases = {
      py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', htm: 'html', yml: 'yaml', md: 'markdown',
      sh: 'bash', rb: 'ruby', rs: 'rust', kt: 'kotlin', cs: 'csharp'
    };
    return aliases[key] || key;
  }

  function requestedCodeLanguage(text) {
    const value = String(text || '').normalize('NFKC').replace(/ё/gi, 'е');
    const patterns = [
      /(?:расширени[а-яё]*|розширен[а-яё]*|extension)\s+(?:с\s+)?\.?(html?|css|javascript|typescript|js|mjs|cjs|jsx|tsx|python|py|json|xml|sql|bash|shell|sh|yaml|yml|toml|markdown|md|text|txt|java|cpp|csharp|cs|go|rust|rs|php|ruby|rb|swift|kotlin|kt|powershell|ps1|vue|svelte)(?=$|[\s.,!?;:])/i,
      /(?:формат|format)\s+(?:файла\s+)?\.?(html?|css|javascript|typescript|js|mjs|cjs|jsx|tsx|python|py|json|xml|sql|bash|shell|sh|yaml|yml|toml|markdown|md|text|txt|java|cpp|csharp|cs|go|rust|rs|php|ruby|rb|swift|kotlin|kt|powershell|ps1|vue|svelte)(?=$|[\s.,!?;:])/i,
      /(?:^|\s)(?:в|во|у|into|to)\s+(?:(?:расширени|розширен)[а-яё]*\s+)?\.?(html?|css|javascript|typescript|js|mjs|cjs|jsx|tsx|python|py|json|xml|sql|bash|shell|sh|yaml|yml|toml|markdown|md|text|txt|java|cpp|csharp|cs|go|rust|rs|php|ruby|rb|swift|kotlin|kt|powershell|ps1|vue|svelte)(?=$|[\s.,!?;:])/i,
      /(?:^|\s)\.(html?|css|javascript|typescript|js|mjs|cjs|jsx|tsx|python|py|json|xml|sql|bash|shell|sh|yaml|yml|toml|markdown|md|text|txt|java|cpp|csharp|cs|go|rust|rs|php|ruby|rb|swift|kotlin|kt|powershell|ps1|vue|svelte)(?=$|[\s.,!?;:])/i
    ];
    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return normalizeCodeLanguage(match[1]);
    }
    return '';
  }

    function isCodeArtifactRequest(text) {
    const value = String(text || '').normalize('NFKC').replace(/ё/gi, 'е');
    const hasAction = /(?:созда|напиш|сгенерир|сдела|зроб|розроб|реализу|реаліз|подготов|підгот|сохран|зберег|исправ|виправ|перепиш|обнов|онов|передел|перероб|перевед|перетвор|преобраз|конверт|експорт|экспорт|выдай|віддай|build|create|write|generate|make|implement|prepare|convert|export|save)/i.test(value);
    const hasArtifact = /(?:код|скрипт|программ|програм|приложен|додат|застосун|игр|гра|сайт|страниц|сторін|бот|плагин|плагін|расширен|розширен|файл|проект|проєкт|code|script|program|app|game|website|page|bot|plugin|extension|file|project)/i.test(value);
    const requestedLanguage = requestedCodeLanguage(value);
    const hasExplicitLanguage = /(?:^|[\s.])(?:html?|css|javascript|typescript|js|mjs|cjs|jsx|tsx|python|py|json|xml|sql|bash|shell|sh|yaml|yml|toml|markdown|md|text|txt|java|cpp|csharp|cs|go|rust|rs|php|ruby|rb|swift|kotlin|kt|powershell|ps1|vue|svelte)(?:$|[\s.,!?;:])/i.test(value);
    return !!requestedLanguage || (hasAction && (hasArtifact || hasExplicitLanguage));
  }

  function codeFileExtension(language) {
    const key = normalizeCodeLanguage(language);
    const extensions = {
      python: 'py', javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
      html: 'html', css: 'css', json: 'json', xml: 'xml', sql: 'sql',
      bash: 'sh', shell: 'sh', yaml: 'yaml', toml: 'toml', markdown: 'md',
      text: 'txt', txt: 'txt', java: 'java', c: 'c', cpp: 'cpp', h: 'h',
      hpp: 'hpp', csharp: 'cs', go: 'go', rust: 'rs', php: 'php', ruby: 'rb',
      swift: 'swift', kotlin: 'kt', powershell: 'ps1', vue: 'vue', svelte: 'svelte'
    };
    return extensions[key] || 'txt';
  }

  function codeFileMimeType(language) {
    const key = normalizeCodeLanguage(language);
    const mimeTypes = {
      html: 'text/html; charset=utf-8',
      css: 'text/css; charset=utf-8',
      javascript: 'text/javascript; charset=utf-8',
      json: 'application/json; charset=utf-8',
      xml: 'application/xml; charset=utf-8',
      markdown: 'text/markdown; charset=utf-8'
    };
    return mimeTypes[key] || 'text/plain; charset=utf-8';
  }

  function safeGeneratedFileName(value, language, index) {
    let name = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    name = name.split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 100);
    if (!name || name === '.' || name === '..') {
      const defaults = {
        html: 'index.html', css: 'styles.css', javascript: 'script.js',
        typescript: 'index.ts', python: 'main.py', json: 'data.json',
        xml: 'document.xml', markdown: 'README.md', yaml: 'config.yaml'
      };
      name = defaults[normalizeCodeLanguage(language)] || 'code-' + index;
    }
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.' + codeFileExtension(language);
    return name;
  }

  function languageFromFileExtension(fileName) {
    const extension = String(fileName || '').split('.').pop().toLowerCase();
    const languages = {
      htm: 'html', html: 'html', css: 'css',
      js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
      py: 'python', json: 'json', xml: 'xml', sql: 'sql',
      sh: 'bash', bash: 'bash', yaml: 'yaml', yml: 'yaml',
      toml: 'toml', md: 'markdown', markdown: 'markdown', txt: 'text',
      java: 'java', c: 'c', h: 'h', cpp: 'cpp', hpp: 'hpp',
      cs: 'csharp', go: 'go', rs: 'rust', php: 'php', rb: 'ruby',
      swift: 'swift', kt: 'kotlin', ps1: 'powershell', vue: 'vue', svelte: 'svelte'
    };
    return languages[extension] || '';
  }

  function inferCodeLanguage(content, declaredLanguage, requestText) {
    const requestedLanguage = requestedCodeLanguage(requestText);
    if (requestedLanguage) return requestedLanguage;

    const source = String(content || '').replace(/^\uFEFF/, '').trimStart();
    const signature = source.slice(0, 2_000);
    if (/<!doctype\s+html\b|<html(?:\s|>)/i.test(signature)) return 'html';
    if (/^<\?xml\b/i.test(signature)) return 'xml';
    try {
      JSON.parse(source);
      return 'json';
    } catch {}

    return normalizeCodeLanguage(declaredLanguage || 'text') || 'text';
  }

  function splitAssistantFiles(answer, requestText) {
    const source = String(answer || '');
    const tick = String.fromCharCode(96).repeat(3);
    const fencePattern = new RegExp('(^|\\n)[ \\t]*' + tick + '([^\\n\\x60]*?)\\n([\\s\\S]*?)\\n?[ \\t]*' + tick, 'g');
    const matches = [...source.matchAll(fencePattern)];
    if (!matches.length) return null;
    const shouldCreateFiles = isCodeArtifactRequest(requestText) || matches.some((match) =>
      /(?:filename=)?[^\s\x60]+\.[a-z0-9]{1,8}(?:\s|$)/i.test(String(match[2] || ''))
    );
    if (!shouldCreateFiles) return null;

    const segments = [];
    let lastIndex = 0;
    let fileIndex = 0;
    const requestedLanguage = requestedCodeLanguage(requestText);
    for (const match of matches) {
      const start = match.index + match[1].length;
      const end = match.index + match[0].length;
      const before = source.slice(lastIndex, start).trim();
      if (before) segments.push({ type: 'text', value: before });
      const parts = String(match[2] || '').trim().split(/\s+/).filter(Boolean);
      let declaredLanguage = parts[0] || 'text';
      let candidateName = '';
      if (/^[\w.-]+\.[a-z0-9]{1,8}$/i.test(declaredLanguage)) {
        candidateName = declaredLanguage;
        declaredLanguage = 'text';
      } else {
        const namePart = parts.slice(1).find((part) => /(?:filename=)?[^\s]+\.[a-z0-9]{1,8}$/i.test(part));
        if (namePart) candidateName = namePart.replace(/^filename=/i, '');
      }

      const content = String(match[3] || '').replace(/\s+$/, '') + '\n';
      const language = inferCodeLanguage(content, declaredLanguage, requestText);
      if (candidateName) {
        const fileLanguage = languageFromFileExtension(candidateName);
        const desiredLanguage = requestedLanguage || language;
        if (desiredLanguage && fileLanguage && fileLanguage !== desiredLanguage) {
          candidateName = candidateName.replace(/\.[^.]+$/, '.' + codeFileExtension(desiredLanguage));
        }
      }
      fileIndex += 1;
      const name = safeGeneratedFileName(candidateName, language, fileIndex);
      segments.push({ type: 'file', name, language, content });
      lastIndex = end;
    }
    const tail = source.slice(lastIndex).trim();
    if (tail) segments.push({ type: 'text', value: tail });
    return segments;
  }

  async function sendAssistantResponse(chatId, answer, requestText, sendOptions = {}) {
    const segments = splitAssistantFiles(answer, requestText);
    if (!segments || !segments.some((segment) => segment.type === 'file')) {
      return sendAssistantText(chatId, answer, sendOptions);
    }
    const files = segments.filter((segment) => segment.type === 'file');
    if (files.length > 5) {
      await sendText(chatId, 'Ответ содержит слишком много файлов (' + files.length + '). Максимум за одно сообщение — 5 файлов. Попросите ИИ разделить проект на части.');
      return null;
    }
    let lastSent = null;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const isLast = index === segments.length - 1;
      if (segment.type === 'text') {
        lastSent = await sendAssistantText(chatId, segment.value, isLast ? sendOptions : {});
        continue;
      }
      const size = Buffer.byteLength(segment.content, 'utf8');
      if (!size || size > 2 * 1024 * 1024) {
        await sendText(chatId, 'Файл «' + segment.name + '» не отправлен: пустой или превышает лимит 2 МБ.');
        continue;
      }
      lastSent = await sendTelegramDocument(chatId, {
        fileName: segment.name,
        mimeType: codeFileMimeType(segment.language),
        caption: 'Файл с кодом: ' + segment.name,
        content: segment.content,
        ...(isLast && sendOptions.reply_markup ? { replyMarkup: sendOptions.reply_markup } : {})
      });
    }
    return lastSent;
  }

    const modelChoiceCache = new Map();
  const pendingTimeoutInput = new Map();
  const MAX_SYSTEM_PROMPT_LENGTH = 3_900;
  const tokenPresets = [512, 1200, 2000, 4000, 8000, 16000, 32000];
  const reasoningChoices = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  const reasoningLabels = {
    auto: 'Авто',
    minimal: 'Минимальный',
    low: 'Низкий',
    medium: 'Средний',
    high: 'Высокий',
    xhigh: 'Максимальный'
  };
