  function isCodeArtifactRequest(text) {
    return /(?:создай|создайте|напиши|напишите|сгенерируй|сгенерируйте|сделай|сделайте|разработай|реализуй|подготовь|сохрани|исправь|перепиши|обнови|build|create|write|generate|make|implement|prepare)\b[\s\S]{0,140}?(?:код|скрипт|программ|приложен|игр|сайт|страниц|бот|плагин|расширен|файл|проект|code|script|program|app|game|website|page|plugin|extension|file|project)/i.test(String(text || ''));
  }

  function codeFileExtension(language) {
    const key = String(language || '').toLowerCase().replace(/^language-/, '');
    const extensions = {
      python: 'py', py: 'py', javascript: 'js', js: 'js', mjs: 'mjs', cjs: 'cjs',
      typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx', html: 'html', htm: 'html',
      css: 'css', json: 'json', xml: 'xml', sql: 'sql', bash: 'sh', shell: 'sh', sh: 'sh',
      yaml: 'yaml', yml: 'yml', toml: 'toml', markdown: 'md', md: 'md', text: 'txt',
      txt: 'txt', java: 'java', c: 'c', h: 'h', cpp: 'cpp', hpp: 'hpp', csharp: 'cs',
      cs: 'cs', go: 'go', rust: 'rs', rs: 'rs', php: 'php', ruby: 'rb', rb: 'rb',
      swift: 'swift', kotlin: 'kt', kt: 'kt', powershell: 'ps1', ps1: 'ps1',
      vue: 'vue', svelte: 'svelte'
    };
    return extensions[key] || 'txt';
  }

  function safeGeneratedFileName(value, language, index) {
    let name = String(value || '').trim().replace(/^['"]|['"]$/g, '');
    name = name.split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 100);
    if (!name || name === '.' || name === '..') name = 'code-' + index;
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.' + codeFileExtension(language);
    return name;
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
    for (const match of matches) {
      const start = match.index + match[1].length;
      const end = match.index + match[0].length;
      const before = source.slice(lastIndex, start).trim();
      if (before) segments.push({ type: 'text', value: before });
      const parts = String(match[2] || '').trim().split(/\s+/).filter(Boolean);
      let language = parts[0] || 'text';
      let candidateName = '';
      if (/^[\w.-]+\.[a-z0-9]{1,8}$/i.test(language)) {
        candidateName = language;
        language = 'text';
      } else {
        const namePart = parts.slice(1).find((part) => /(?:filename=)?[^\s]+\.[a-z0-9]{1,8}$/i.test(part));
        if (namePart) candidateName = namePart.replace(/^filename=/i, '');
      }
      fileIndex += 1;
      const name = safeGeneratedFileName(candidateName, language, fileIndex);
      const content = String(match[3] || '').replace(/\s+$/, '') + '\n';
      segments.push({ type: 'file', name, language, content });
      lastIndex = end;
    }
    const tail = source.slice(lastIndex).trim();
    if (tail) segments.push({ type: 'text', value: tail });
    return segments;
  }

  async function sendAssistantResponse(chatId, answer, requestText) {
    const segments = splitAssistantFiles(answer, requestText);
    if (!segments || !segments.some((segment) => segment.type === 'file')) {
      await sendAssistantText(chatId, answer);
      return;
    }
    const files = segments.filter((segment) => segment.type === 'file');
    if (files.length > 5) {
      await sendText(chatId, 'Ответ содержит слишком много файлов (' + files.length + '). Максимум за одно сообщение — 5 файлов. Попросите ИИ разделить проект на части.');
      return;
    }
    for (const segment of segments) {
      if (segment.type === 'text') {
        await sendAssistantText(chatId, segment.value);
        continue;
      }
      const size = Buffer.byteLength(segment.content, 'utf8');
      if (!size || size > 2 * 1024 * 1024) {
        await sendText(chatId, 'Файл «' + segment.name + '» не отправлен: пустой или превышает лимит 2 МБ.');
        continue;
      }
      await sendTelegramDocument(chatId, {
        fileName: segment.name,
        mimeType: 'text/plain; charset=utf-8',
        caption: 'Файл с кодом: ' + segment.name,
        content: segment.content
      });
    }
  }

  const modelChoiceCache = new Map();
  const pendingTimeoutInput = new Map();
  const pendingSystemPromptInput = new Map();
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
