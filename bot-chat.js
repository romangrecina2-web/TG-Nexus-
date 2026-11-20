'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_API_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const MAX_STORED_BYTES = 50 * 1024 * 1024;
const MAX_CHATS_PER_USER = 100;
const MAX_MESSAGES_PER_CHAT = 40;
const MAX_MESSAGE_LENGTH = 50_000;
const TELEGRAM_CHUNK_LENGTH = 3_900;

const BOT_COMMANDS = [
  { command: 'start', description: 'Открыть мини-приложение' },
  { command: 'help', description: 'Краткая справка' },
  { command: 'chat', description: 'Показать список чатов' },
  { command: 'add_chat', description: 'Создать чат: /add_chat [название]' },
  { command: 'chat_equip', description: 'Выбрать чат: /chat_equip [название]' },
  { command: 'info', description: 'Показать список команд' },
  { command: 'key', description: 'Добавить или заменить API-ключ' },
  { command: 'model', description: 'Выбрать модель или показать список' }
];

function parseEncryptionKey(value) {
  const raw = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

  // Render generateValue emits a canonical Base64-encoded 256-bit secret.
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32 && decoded.toString('base64') === raw) return decoded;
  } catch {}
  return null;
}

function createEncryptedStore(options = {}) {
  const encryptionKey = parseEncryptionKey(options.encryptionKey);
  const dataDir = path.resolve(options.dataDir || path.join(__dirname, 'data'));
  const filePath = path.join(dataDir, 'telegram-bot-store.enc');
  const fsApi = options.fs || fs;
  let state = null;

  function load() {
    if (state) return state;
    if (!encryptionKey) throw new Error('Encrypted storage is not configured.');

    if (!fsApi.existsSync(filePath)) {
      state = { version: 1, users: {} };
      return state;
    }

    const packedText = fsApi.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(packedText, 'utf8') > MAX_STORED_BYTES * 2) {
      throw new Error('Encrypted storage exceeds the supported size.');
    }

    const packed = JSON.parse(packedText);
    if (!packed || packed.version !== 1 || !packed.iv || !packed.tag || !packed.data) {
      throw new Error('Encrypted storage has an invalid format.');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(packed.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(packed.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(packed.data, 'base64')),
      decipher.final()
    ]).toString('utf8');
    const decoded = JSON.parse(plain);
    if (!decoded || decoded.version !== 1 || !decoded.users || typeof decoded.users !== 'object') {
      throw new Error('Encrypted storage has an invalid payload.');
    }
    state = decoded;
    return state;
  }

  function save() {
    const current = load();
    const plain = Buffer.from(JSON.stringify(current), 'utf8');
    if (plain.length > MAX_STORED_BYTES) {
      throw new Error('Encrypted storage is full.');
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const packed = JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    });

    fsApi.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try { fsApi.chmodSync(dataDir, 0o700); } catch {}
    const tempPath = filePath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fsApi.writeFileSync(tempPath, packed, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsApi.renameSync(tempPath, filePath);
      try { fsApi.chmodSync(filePath, 0o600); } catch {}
    } finally {
      try { if (fsApi.existsSync(tempPath)) fsApi.unlinkSync(tempPath); } catch {}
    }
  }

  function getUser(userId) {
    const current = load();
    const id = String(userId);
    if (!current.users[id]) {
      current.users[id] = {
        apiKey: '',
        model: options.defaultModel || DEFAULT_MODEL,
        activeChatId: null,
        chats: []
      };
    }
    const user = current.users[id];
    if (typeof user.apiKey !== 'string') user.apiKey = '';
    if (!Array.isArray(user.chats)) user.chats = [];
    if (!user.model) user.model = options.defaultModel || DEFAULT_MODEL;
    return user;
  }

  return {
    enabled: !!encryptionKey,
    filePath,
    getUser,
    save
  };
}

function normalizeApiBase(value) {
  try {
    const url = new URL(String(value || DEFAULT_API_BASE_URL));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
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

function createBotChat(options = {}) {
  const botToken = String(options.botToken || '');
  const apiBaseUrl = normalizeApiBase(options.apiBaseUrl || process.env.AI_API_BASE_URL || DEFAULT_API_BASE_URL);
  const defaultModel = String(options.defaultModel || process.env.AI_DEFAULT_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const configuredSystemPrompt = String(options.systemPrompt || process.env.AI_SYSTEM_PROMPT ||
    'Ты полезный и дружелюбный ИИ-ассистент. Отвечай ясно и по делу, на языке пользователя.');
  const formattingInstruction = 'Отвечай без таблиц и заголовков #. Используй короткие абзацы, простые списки и жирный шрифт только для важного.';
  const systemPrompt = configuredSystemPrompt.includes(formattingInstruction)
    ? configuredSystemPrompt
    : configuredSystemPrompt + '\n\n' + formattingInstruction;
  const fetchImpl = options.fetchImpl || global.fetch;
  const sendTelegramMessage = options.sendTelegramMessage || defaultSendTelegramMessage;
  const deleteTelegramMessage = options.deleteTelegramMessage || defaultDeleteTelegramMessage;
  const store = options.store || createEncryptedStore({
    encryptionKey: options.encryptionKey || process.env.BOT_DATA_ENCRYPTION_KEY,
    dataDir: options.dataDir || process.env.DATA_DIR,
    defaultModel
  });
  const rateBuckets = new Map();
  let lastRateSweep = Date.now();

  async function telegramRequest(method, payload) {
    if (!botToken) throw new Error('Telegram bot token is not configured.');
    const response = await fetchImpl('https://api.telegram.org/bot' + botToken + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      const error = new Error(result.description || 'Telegram request failed.');
      error.telegramDescription = result.description || '';
      error.telegramErrorCode = result.error_code || response.status;
      throw error;
    }
    return result.result;
  }

  async function defaultSendTelegramMessage(chatId, text, sendOptions = {}) {
    return telegramRequest('sendMessage', { chat_id: chatId, text, ...sendOptions });
  }

  async function defaultDeleteTelegramMessage(chatId, messageId) {
    return telegramRequest('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  async function sendText(chatId, text) {
    const chunks = splitTelegramText(text);
    for (const chunk of chunks) await sendTelegramMessage(chatId, chunk);
  }

  async function sendAssistantText(chatId, text) {
    const html = markdownToTelegramHtml(text);
    const chunks = splitTelegramHtml(html);
    for (const chunk of chunks) {
      try {
        await sendTelegramMessage(chatId, chunk.html, { parse_mode: 'HTML' });
      } catch (error) {
        if (!isTelegramHtmlParseError(error)) throw error;
        await sendTelegramMessage(chatId, chunk.text);
      }
    }
  }

  function isPrivateUserMessage(message) {
    return !!(message && message.chat && message.chat.type === 'private' &&
      message.from && !message.from.is_bot && Number(message.chat.id) === Number(message.from.id));
  }

  function parseCommand(text) {
    const match = String(text || '').match(/^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    return match ? { name: match[1].toLowerCase(), args: String(match[2] || '').trim() } : null;
  }

  function nextChatTitle(user) {
    let max = 0;
    user.chats.forEach((chat) => {
      const match = String(chat.title || '').match(/^Чат\s+(\d+)$/i);
      if (match) max = Math.max(max, Number(match[1]));
    });
    return 'Чат ' + (max + 1);
  }

  function createChat(user, title) {
    const chat = {
      id: crypto.randomUUID(),
      title: String(title || nextChatTitle(user)).replace(/\s+/g, ' ').trim().slice(0, 100) || nextChatTitle(user),
      model: user.model || defaultModel,
      createdAt: Date.now(),
      messages: []
    };
    user.chats.unshift(chat);
    if (user.chats.length > MAX_CHATS_PER_USER) user.chats.length = MAX_CHATS_PER_USER;
    user.activeChatId = chat.id;
    return chat;
  }

  function activeChat(user) {
    return user.chats.find((chat) => chat.id === user.activeChatId) || null;
  }

  function chatListText(user) {
    if (!user.chats.length) return 'Чатов пока нет. Создайте первый командой /add_chat.';
    const lines = ['Ваши чаты:'];
    user.chats.forEach((chat, index) => {
      const active = chat.id === user.activeChatId ? ' ← активный' : '';
      lines.push((index + 1) + '. ' + chat.title + active);
    });
    return lines.join('\n');
  }

  async function sendModelList(chatId, models, activeModel) {
    const unique = [...new Set(models)];
    if (!unique.length) {
      await sendText(chatId, 'Провайдер не вернул список моделей. Проверьте настройки API.');
      return;
    }
    const header = 'Текущая модель: ' + activeModel + '\nДоступные модели (' + unique.length + '):\n';
    await sendText(chatId, header + unique.map((model) => '• ' + model).join('\n'));
  }

  async function getModels(apiKey) {
    if (!apiBaseUrl) throw new Error('Provider endpoint is not configured.');
    const response = await fetchImpl(apiBaseUrl + '/models', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error('Provider model list request failed.');
    const payload = await response.json().catch(() => ({}));
    const source = Array.isArray(payload.data) ? payload.data :
      (Array.isArray(payload.models) ? payload.models : []);
    const models = source.map((item) => typeof item === 'string' ? item : item && item.id)
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());
    const configured = String(process.env.AI_ALLOWED_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean);
    return [...new Set(models.length ? models : configured)];
  }

  async function validateKey(apiKey) {
    if (!apiBaseUrl || typeof fetchImpl !== 'function') return false;
    try {
      const response = await fetchImpl(apiBaseUrl + '/models', {
        method: 'GET',
        headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000)
      });
      return !!response.ok;
    } catch {
      return false;
    }
  }

  function checkRateLimit(userId) {
    const now = Date.now();
    if (now - lastRateSweep >= 60_000) {
      for (const [id, bucket] of rateBuckets) {
        if (now - bucket.lastSeen > 180_000) rateBuckets.delete(id);
      }
      lastRateSweep = now;
    }
    const id = String(userId);
    const previous = rateBuckets.get(id);
    if (!previous) {
      if (rateBuckets.size >= 10_000) return false;
      rateBuckets.set(id, { startedAt: now, lastSeen: now, count: 1 });
      return true;
    }
    if (now - previous.startedAt >= 60_000) {
      previous.startedAt = now;
      previous.count = 0;
    }
    if (previous.count >= 12) return false;
    previous.count += 1;
    previous.lastSeen = now;
    return true;
  }

  async function handleKeyCommand(message, args) {
    // Remove the message before any validation request so the key is not left in chat history.
    try { await deleteTelegramMessage(message.chat.id, message.message_id); } catch {}

    if (!args || /\s/.test(args) || args.length > 2_048) {
      await sendText(message.chat.id, 'Использование: /key ваш_API_ключ');
      return;
    }
    if (!store.enabled) {
      await sendText(message.chat.id, 'Безопасное хранилище не настроено на сервере. Обратитесь к администратору.');
      return;
    }

    const valid = await validateKey(args);
    if (!valid) {
      await sendText(message.chat.id, 'Неудачно, проверьте ключ и повторите попытку');
      return;
    }

    try {
      const user = store.getUser(message.from.id);
      const previousKey = user.apiKey;
      user.apiKey = args;
      try {
        store.save();
      } catch (error) {
        user.apiKey = previousKey;
        throw error;
      }
      await sendText(message.chat.id, 'Удачно изменено');
    } catch {
      await sendText(message.chat.id, 'Не удалось безопасно сохранить ключ. Обратитесь к администратору.');
    }
  }

  async function handleModelCommand(message, user, args) {
    if (!user.apiKey) {
      await sendText(message.chat.id, 'Сначала добавьте API-ключ командой /key.');
      return;
    }
    let models;
    try {
      models = await getModels(user.apiKey);
    } catch {
      await sendText(message.chat.id, 'Не удалось получить список моделей. Проверьте API-ключ и настройки провайдера.');
      return;
    }
    if (!args) {
      await sendModelList(message.chat.id, models, (activeChat(user) || {}).model || user.model);
      return;
    }
    const selected = models.find((model) => model === args);
    if (!selected) {
      await sendText(message.chat.id, 'Ошибка: такой модели нет в списке доступных.');
      await sendModelList(message.chat.id, models, (activeChat(user) || {}).model || user.model);
      return;
    }

    user.model = selected;
    const chat = activeChat(user);
    if (chat) chat.model = selected;
    store.save();
    await sendText(message.chat.id, 'Модель выбрана: ' + selected);
  }

  function extractAssistantText(payload) {
    const content = payload && payload.choices && payload.choices[0] &&
      payload.choices[0].message && payload.choices[0].message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content.map((part) => part && (part.text || part.content) || '')
        .filter(Boolean).join('\n').trim();
    }
    return '';
  }

  async function requestAssistant(user, chat) {
    if (!apiBaseUrl) throw new Error('Provider endpoint is not configured.');
    const history = chat.messages.slice(-MAX_MESSAGES_PER_CHAT).map((message) => ({
      role: message.role,
      content: message.content
    }));
    const response = await fetchImpl(apiBaseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + user.apiKey
      },
      body: JSON.stringify({
        model: chat.model || user.model || defaultModel,
        messages: [{ role: 'system', content: systemPrompt }, ...history],
        max_tokens: 1_200
      }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!response.ok) throw new Error('Provider completion request failed.');
    const payload = await response.json().catch(() => ({}));
    const answer = extractAssistantText(payload);
    if (!answer) throw new Error('Provider returned an empty response.');
    return answer.slice(0, MAX_MESSAGE_LENGTH);
  }

  async function handleUserMessage(message, user, text) {
    let chat = activeChat(user);
    if (!chat) chat = createChat(user, nextChatTitle(user));
    if (!user.apiKey) {
      store.save();
      await sendText(message.chat.id, 'API-ключ не настроен. Добавьте его командой /key [ключ провайдера].');
      return;
    }
    if (!checkRateLimit(message.from.id)) {
      await sendText(message.chat.id, 'Слишком много запросов. Подождите минуту и повторите.');
      return;
    }

    chat.messages.push({ role: 'user', content: text.slice(0, MAX_MESSAGE_LENGTH) });
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }
    store.save();

    let answer;
    try {
      answer = await requestAssistant(user, chat);
    } catch {
      await sendText(message.chat.id, 'Не удалось получить ответ от ИИ. Проверьте подключение, ключ и выбранную модель.');
      return;
    }

    chat.messages.push({ role: 'assistant', content: answer });
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }
    store.save();
    await sendAssistantText(message.chat.id, answer);
  }

  async function processMessage(message, parsed, text) {
    const chatId = message.chat.id;
    const command = parsed && parsed.name;

    if (command === 'start' || command === 'help') return false;
    if (command === 'info') {
      await sendText(chatId,
        '/start — показать кнопку мини-приложения\n' +
        '/help — краткая справка\n' +
        '/chat — показать список всех чатов\n' +
        '/add_chat [название] — создать чат и сделать его активным\n' +
        '/chat_equip [название чата] — выбрать существующий чат\n' +
        '/info — список команд\n' +
        '/key [ключ провайдера] — добавить или заменить API-ключ\n' +
        '/model [название модели] — выбрать модель или показать доступные\n\n' +
        'Created tet0r');
      return true;
    }
    if (command === 'key') {
      await handleKeyCommand(message, parsed.args);
      return true;
    }
    if (command && !['chat', 'add_chat', 'chat_equip', 'model'].includes(command)) {
      await sendText(chatId, 'Неизвестная команда. Используйте /info для списка команд.');
      return true;
    }
    if (!store.enabled) {
      await sendText(chatId, 'Безопасное хранилище не настроено на сервере. Обратитесь к администратору.');
      return true;
    }

    let user;
    try {
      user = store.getUser(message.from.id);
    } catch {
      await sendText(chatId, 'Не удалось открыть зашифрованное хранилище. Обратитесь к администратору.');
      return true;
    }

    try {
      if (command === 'chat') {
        await sendText(chatId, chatListText(user));
        return true;
      }
      if (command === 'add_chat') {
        const title = parsed.args || nextChatTitle(user);
        const chat = createChat(user, title);
        store.save();
        await sendText(chatId, 'Создан и выбран чат «' + chat.title + '».');
        return true;
      }
      if (command === 'chat_equip') {
        const found = user.chats.find((chat) => String(chat.title || '').toLocaleLowerCase('ru') === parsed.args.toLocaleLowerCase('ru'));
        if (!parsed.args || !found) {
          await sendText(chatId, 'Ошибка: чат с таким названием не найден.');
          await sendText(chatId, chatListText(user));
          return true;
        }
        user.activeChatId = found.id;
        store.save();
        await sendText(chatId, 'Активный чат: «' + found.title + '».');
        return true;
      }
      if (command === 'model') {
        await handleModelCommand(message, user, parsed.args);
        return true;
      }
      if (parsed) {
        await sendText(chatId, 'Неизвестная команда. Используйте /info для списка команд.');
        return true;
      }
      await handleUserMessage(message, user, text);
      return true;
    } catch {
      try { await sendText(chatId, 'Не удалось выполнить команду. Повторите попытку позже.'); } catch {}
      return true;
    }
  }

  async function handleMessage(message) {
    if (!isPrivateUserMessage(message) || typeof message.text !== 'string') return false;
    const text = message.text.trim();
    if (!text) return false;
    const parsed = parseCommand(text);
    try {
      return await processMessage(message, parsed, text);
    } catch {
      try { await sendText(message.chat.id, 'Не удалось обработать сообщение. Повторите попытку позже.'); } catch {}
      return true;
    }
  }

  return {
    handleMessage,
    store,
    apiBaseUrl
  };
}

module.exports = {
  BOT_COMMANDS,
  DEFAULT_API_BASE_URL,
  DEFAULT_MODEL,
  createBotChat,
  createEncryptedStore,
  normalizeApiBase,
  parseEncryptionKey,
  markdownToTelegramHtml,
  splitTelegramHtml,
  splitTelegramText,
  telegramHtmlToPlainText
};
