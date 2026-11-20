'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const DEFAULT_API_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const MAX_STORED_BYTES = 50 * 1024 * 1024;
const MAX_CHATS_PER_USER = 100;
const MAX_MESSAGES_PER_CHAT = 40;
const MAX_MESSAGE_LENGTH = 50_000;
const TELEGRAM_CHUNK_LENGTH = 3_900;
const MAX_PENDING_UPDATES = 500;
const MAX_PROCESSED_UPDATE_IDS = 10_000;
const MAX_DEAD_LETTERS = 200;
const DEFAULT_WORKER_CONCURRENCY = 3;
const DEFAULT_MAX_UPDATE_ATTEMPTS = 8;

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
  const backupPath = filePath + '.bak';
  const fsApi = options.fs || fs;
  let state = null;
  let recoveredFromBackup = false;

  function decodeStoreFile(sourcePath) {
    const packedText = fsApi.readFileSync(sourcePath, 'utf8');
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
    if (!Array.isArray(decoded.queue)) decoded.queue = [];
    if (!Array.isArray(decoded.processedUpdateIds)) decoded.processedUpdateIds = [];
    if (!Array.isArray(decoded.deadLetterUpdates)) decoded.deadLetterUpdates = [];
    return decoded;
  }

  function load() {
    if (state) return state;
    if (!encryptionKey) throw new Error('Encrypted storage is not configured.');
    if (fsApi.existsSync(filePath)) {
      try {
        state = decodeStoreFile(filePath);
      } catch (primaryError) {
        if (!fsApi.existsSync(backupPath)) throw primaryError;
        state = decodeStoreFile(backupPath);
        recoveredFromBackup = true;
      }
      return state;
    }
    if (fsApi.existsSync(backupPath)) {
      state = decodeStoreFile(backupPath);
      recoveredFromBackup = true;
      return state;
    }
    state = {
      version: 1,
      users: {},
      queue: [],
      processedUpdateIds: [],
      deadLetterUpdates: []
    };
    return state;
  }

  function save() {
    const current = load();
    const plain = Buffer.from(JSON.stringify(current), 'utf8');
    if (plain.length > MAX_STORED_BYTES) throw new Error('Encrypted storage is full.');

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
    if (!recoveredFromBackup && fsApi.existsSync(filePath)) {
      fsApi.copyFileSync(filePath, backupPath);
      try { fsApi.chmodSync(backupPath, 0o600); } catch {}
    }

    const tempPath = filePath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fsApi.writeFileSync(tempPath, packed, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const fileFd = fsApi.openSync(tempPath, 'r');
      try { fsApi.fsyncSync(fileFd); } finally { fsApi.closeSync(fileFd); }
      fsApi.renameSync(tempPath, filePath);
      try { fsApi.chmodSync(filePath, 0o600); } catch {}
      try {
        const dirFd = fsApi.openSync(dataDir, 'r');
        try { fsApi.fsyncSync(dirFd); } finally { fsApi.closeSync(dirFd); }
      } catch {}
      recoveredFromBackup = false;
    } finally {
      try { if (fsApi.existsSync(tempPath)) fsApi.unlinkSync(tempPath); } catch {}
    }
  }

  function queueUserKey(update, updateId) {
    const message = update && (update.message || update.edited_message || update.channel_post);
    const userId = message && message.from && message.from.id;
    const chatId = message && message.chat && message.chat.id;
    return userId != null ? String(userId) : (chatId != null ? String(chatId) : 'update:' + String(updateId));
  }

  function queueItem(updateId) {
    return load().queue.find((item) => item.updateId === updateId) || null;
  }

  function enqueueUpdate(update) {
    if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      const error = new Error('Telegram update is missing a valid update_id.');
      error.status = 400;
      throw error;
    }
    const current = load();
    const id = update.update_id;
    const duplicate = current.processedUpdateIds.includes(id) ||
      current.queue.some((item) => item.updateId === id) ||
      current.deadLetterUpdates.some((item) => item.updateId === id);
    if (duplicate) return { accepted: false, duplicate: true, updateId: id };
    if (current.queue.length >= MAX_PENDING_UPDATES) {
      const error = new Error('Telegram update queue is full.');
      error.status = 503;
      throw error;
    }
    current.queue.push({
      updateId: id,
      userKey: queueUserKey(update, id),
      update,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      outbox: []
    });
    save();
    return { accepted: true, duplicate: false, updateId: id };
  }

  function recoverProcessingUpdates() {
    const current = load();
    let changed = false;
    for (const item of current.queue) {
      if (item.status === 'processing') {
        item.status = 'queued';
        item.nextAttemptAt = Date.now();
        item.recoveredAt = Date.now();
        changed = true;
      }
    }
    if (changed) save();
    return changed;
  }

  function claimNextUpdate(activeUserKeys = [], now = Date.now()) {
    const current = load();
    const blocked = new Set(activeUserKeys.map(String));
    for (const item of current.queue) {
      const userKey = String(item.userKey || queueUserKey(item.update, item.updateId));
      if (item.status === 'processing') {
        blocked.add(userKey);
        continue;
      }
      if (blocked.has(userKey)) continue;
      if (item.status !== 'queued' || Number(item.nextAttemptAt || 0) > now) {
        blocked.add(userKey);
        continue;
      }
      item.status = 'processing';
      item.attempts = Math.max(0, Number(item.attempts) || 0) + 1;
      item.startedAt = now;
      save();
      return {
        updateId: item.updateId,
        userKey,
        update: item.update,
        attempts: item.attempts,
        createdAt: item.createdAt
      };
    }
    return null;
  }

  function appendOutbox(updateId, message) {
    const item = queueItem(updateId);
    if (!item) throw new Error('The queued Telegram update no longer exists.');
    const index = item.outbox.length;
    item.outbox.push({
      chatId: message.chatId,
      text: String(message.text == null ? '' : message.text),
      options: message.options || {},
      status: 'pending',
      createdAt: Date.now()
    });
    save();
    return { index };
  }

  function getOutboxState(updateId) {
    const item = queueItem(updateId);
    if (!item) return { exists: false, pending: [] };
    return {
      exists: item.outbox.length > 0,
      pending: item.outbox.map((entry, index) => ({ ...entry, index }))
        .filter((entry) => entry.status !== 'delivered')
    };
  }

  function markOutboxDelivered(updateId, index) {
    const item = queueItem(updateId);
    if (!item || !item.outbox[index]) return false;
    if (item.outbox[index].status !== 'delivered') {
      item.outbox[index].status = 'delivered';
      item.outbox[index].deliveredAt = Date.now();
      save();
    }
    return true;
  }

  function completeUpdate(updateId) {
    const current = load();
    const index = current.queue.findIndex((item) => item.updateId === updateId);
    if (index < 0) return false;
    current.queue.splice(index, 1);
    current.processedUpdateIds.push(updateId);
    if (current.processedUpdateIds.length > MAX_PROCESSED_UPDATE_IDS) {
      current.processedUpdateIds.splice(0, current.processedUpdateIds.length - MAX_PROCESSED_UPDATE_IDS);
    }
    save();
    return true;
  }

  function retryUpdate(updateId, error, retryOptions = {}) {
    const current = load();
    const index = current.queue.findIndex((item) => item.updateId === updateId);
    if (index < 0) return { retried: false, deadLettered: false };
    const item = current.queue[index];
    const attempts = Math.max(1, Number(item.attempts) || 1);
    const errorCode = Number(error && (error.telegramErrorCode || error.status)) || null;
    const permanentTelegramError = errorCode >= 400 && errorCode < 500 && errorCode !== 429;
    const maxAttempts = Math.max(1, Number(retryOptions.maxAttempts) || DEFAULT_MAX_UPDATE_ATTEMPTS);

    if (permanentTelegramError || attempts >= maxAttempts) {
      current.queue.splice(index, 1);
      current.deadLetterUpdates.push({
        updateId,
        userKey: item.userKey,
        attempts,
        errorCode,
        errorName: String(error && error.name || 'Error').slice(0, 80),
        failedAt: Date.now()
      });
      if (current.deadLetterUpdates.length > MAX_DEAD_LETTERS) {
        current.deadLetterUpdates.splice(0, current.deadLetterUpdates.length - MAX_DEAD_LETTERS);
      }
      save();
      return { retried: false, deadLettered: true };
    }

    const exponential = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(attempts - 1, 8)));
    const retryAfter = Math.max(0, Number(error && error.retryAfterSeconds) || 0) * 1000;
    const delay = Math.min(15 * 60_000, Math.max(exponential, retryAfter));
    item.status = 'queued';
    item.nextAttemptAt = Date.now() + delay;
    item.lastErrorCode = errorCode;
    item.lastErrorName = String(error && error.name || 'Error').slice(0, 80);
    item.lastFailedAt = Date.now();
    save();
    return { retried: true, deadLettered: false, retryAt: item.nextAttemptAt };
  }

  function getQueueStats() {
    const current = load();
    const now = Date.now();
    const queued = current.queue.filter((item) => item.status === 'queued');
    const processing = current.queue.filter((item) => item.status === 'processing');
    const oldest = current.queue.reduce((min, item) => Math.min(min, Number(item.createdAt) || now), now);
    return {
      pending: queued.length,
      processing: processing.length,
      total: current.queue.length,
      deadLettered: current.deadLetterUpdates.length,
      oldestPendingAgeMs: current.queue.length ? Math.max(0, now - oldest) : 0,
      capacity: MAX_PENDING_UPDATES,
      recoveredFromBackup
    };
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
    backupPath,
    getUser,
    save,
    enqueueUpdate,
    recoverProcessingUpdates,
    claimNextUpdate,
    appendOutbox,
    getOutboxState,
    markOutboxDelivered,
    completeUpdate,
    retryUpdate,
    getQueueStats
  };
}function normalizeApiBase(value) {
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
  const rawSendTelegramMessage = options.sendTelegramMessage || defaultSendTelegramMessage;
  const deleteTelegramMessage = options.deleteTelegramMessage || defaultDeleteTelegramMessage;
  const store = options.store || createEncryptedStore({
    encryptionKey: options.encryptionKey || process.env.BOT_DATA_ENCRYPTION_KEY,
    dataDir: options.dataDir || process.env.DATA_DIR,
    defaultModel
  });
  const updateContext = new AsyncLocalStorage();

  async function sendTelegramMessage(chatId, text, sendOptions = {}) {
    const context = updateContext.getStore();
    if (!context || !Number.isSafeInteger(context.updateId)) {
      return rawSendTelegramMessage(chatId, text, sendOptions);
    }
    const queued = store.appendOutbox(context.updateId, { chatId, text, options: sendOptions });
    try {
      await rawSendTelegramMessage(chatId, text, sendOptions);
    } catch (error) {
      error.telegramDeliveryFailure = true;
      throw error;
    }
    store.markOutboxDelivered(context.updateId, queued.index);
  }
  const rateBuckets = new Map();
  const GLOBAL_AI_LIMIT_PER_MINUTE = Math.max(10, Number(options.globalAiLimitPerMinute) || 90);
  let lastRateSweep = Date.now();
  let globalRateStartedAt = lastRateSweep;
  let globalRateCount = 0;

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
      error.retryAfterSeconds = Number(result.parameters && result.parameters.retry_after) || 0;
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
    if (now - globalRateStartedAt >= 60_000) {
      globalRateStartedAt = now;
      globalRateCount = 0;
    }
    if (globalRateCount >= GLOBAL_AI_LIMIT_PER_MINUTE) return false;
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
      globalRateCount += 1;
      return true;
    }
    if (now - previous.startedAt >= 60_000) {
      previous.startedAt = now;
      previous.count = 0;
    }
    if (previous.count >= 12) return false;
    previous.count += 1;
    previous.lastSeen = now;
    globalRateCount += 1;
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
    } catch (error) {
      if (error && error.telegramDeliveryFailure) throw error;
      await sendText(chatId, 'Не удалось выполнить команду. Повторите попытку позже.');
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
    } catch (error) {
      if (error && error.telegramDeliveryFailure) throw error;
      await sendText(message.chat.id, 'Не удалось обработать сообщение. Повторите попытку позже.');
      return true;
    }
  }


  async function flushPendingOutbox(updateId) {
    const state = store.getOutboxState(updateId);
    for (const entry of state.pending) {
      await rawSendTelegramMessage(entry.chatId, entry.text, entry.options || {});
      store.markOutboxDelivered(updateId, entry.index);
    }
  }

  let workerStopped = true;
  let workerTimer = null;
  let workerHandler = null;
  let workerActive = 0;
  let workerConcurrency = DEFAULT_WORKER_CONCURRENCY;
  let workerMaxAttempts = DEFAULT_MAX_UPDATE_ATTEMPTS;
  const activeUserKeys = new Set();

  function scheduleWorker(delayMs = 0) {
    if (workerStopped || workerTimer) return;
    workerTimer = setTimeout(() => {
      workerTimer = null;
      pumpWorker();
    }, Math.max(0, delayMs));
    if (workerTimer && typeof workerTimer.unref === 'function') workerTimer.unref();
  }

  async function runQueuedUpdate(job) {
    try {
      const outbox = store.getOutboxState(job.updateId);
      if (outbox.exists) {
        await flushPendingOutbox(job.updateId);
      } else {
        await updateContext.run({ updateId: job.updateId }, () => workerHandler(job.update));
        await flushPendingOutbox(job.updateId);
      }
      store.completeUpdate(job.updateId);
    } catch (error) {
      try {
        const result = store.retryUpdate(job.updateId, error, { maxAttempts: workerMaxAttempts });
        if (result.deadLettered) {
          console.error('Telegram update moved to dead-letter storage.', {
            updateId: job.updateId,
            attempts: job.attempts,
            errorCode: Number(error && (error.telegramErrorCode || error.status)) || null
          });
        }
      } catch (storageError) {
        console.error('Could not persist Telegram update retry state.', {
          updateId: job.updateId,
          errorName: storageError && storageError.name ? storageError.name : 'Error'
        });
      }
    } finally {
      activeUserKeys.delete(job.userKey);
      workerActive = Math.max(0, workerActive - 1);
      scheduleWorker(0);
    }
  }

  function pumpWorker() {
    if (workerStopped || typeof workerHandler !== 'function') return;
    while (workerActive < workerConcurrency) {
      let job;
      try {
        job = store.claimNextUpdate([...activeUserKeys]);
      } catch (error) {
        console.error('Telegram update queue is unavailable.', {
          errorName: error && error.name ? error.name : 'Error'
        });
        scheduleWorker(5_000);
        return;
      }
      if (!job) break;
      workerActive += 1;
      activeUserKeys.add(job.userKey);
      void runQueuedUpdate(job);
    }
    if (!workerStopped && workerActive < workerConcurrency) {
      let stats;
      try { stats = store.getQueueStats(); } catch { stats = null; }
      if (stats && stats.pending > 0) scheduleWorker(1_000);
    }
  }

  function enqueueUpdate(update) {
    const result = store.enqueueUpdate(update);
    scheduleWorker(0);
    return result;
  }

  function startUpdateWorker(handler, workerOptions = {}) {
    if (typeof handler !== 'function') throw new TypeError('A Telegram update handler is required.');
    if (!workerStopped) return false;
    if (!store.enabled) {
      console.error('Telegram update worker is disabled because encrypted storage is not configured.');
      return false;
    }
    try {
      store.recoverProcessingUpdates();
    } catch (error) {
      console.error('Telegram update worker could not recover its queue.', {
        errorName: error && error.name ? error.name : 'Error'
      });
      return false;
    }
    workerHandler = handler;
    workerConcurrency = Math.max(1, Math.min(8, Math.round(Number(workerOptions.concurrency) || DEFAULT_WORKER_CONCURRENCY)));
    workerMaxAttempts = Math.max(1, Math.min(20, Math.round(Number(workerOptions.maxAttempts) || DEFAULT_MAX_UPDATE_ATTEMPTS)));
    workerStopped = false;
    scheduleWorker(0);
    return true;
  }

  async function stopUpdateWorker(stopOptions = {}) {
    workerStopped = true;
    if (workerTimer) {
      clearTimeout(workerTimer);
      workerTimer = null;
    }
    const timeoutMs = Math.max(0, Number(stopOptions.timeoutMs) || 20_000);
    const deadline = Date.now() + timeoutMs;
    while (workerActive > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return workerActive === 0;
  }

  function getWorkerStats() {
    return {
      ...store.getQueueStats(),
      running: !workerStopped,
      activeWorkers: workerActive,
      concurrency: workerConcurrency
    };
  }

  async function sendMessage(chatId, text, sendOptions = {}) {
    return sendTelegramMessage(chatId, text, sendOptions);
  }

  return {
    handleMessage,
    enqueueUpdate,
    startUpdateWorker,
    stopUpdateWorker,
    getWorkerStats,
    sendMessage,
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
