'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const PROVIDER_ADAPTERS = require('./provider-adapters');
const PROVIDER_CATALOG = require('./provider-catalog');

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
  { command: 'provider', description: 'Выбрать API-провайдера' },
  { command: 'key', description: 'Добавить или заменить API-ключ' },
  { command: 'model', description: 'Выбрать модель или показать список' },
  { command: 'test', description: 'Проверить реальный запрос к API' },
  { command: 'version', description: 'Показать версию backend' },
  { command: 'settings', description: 'Показать настройки ИИ' },
  { command: 'cancel', description: 'Отменить текущий ввод настройки' }
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
    const callbackQuery = update && update.callback_query;
    const message = update && (update.message || update.edited_message || update.channel_post ||
      (callbackQuery && callbackQuery.message));
    const userId = (callbackQuery && callbackQuery.from && callbackQuery.from.id) ||
      (message && message.from && message.from.id);
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
    const entry = {
      chatId: message.chatId,
      kind: message.kind === 'document' ? 'document' : 'message',
      text: String(message.text == null ? '' : message.text),
      options: message.options || {},
      status: 'pending',
      createdAt: Date.now()
    };
    if (entry.kind === 'document') {
      entry.fileName = String(message.fileName || 'code.txt').slice(0, 120);
      entry.mimeType = String(message.mimeType || 'text/plain; charset=utf-8').slice(0, 100);
      entry.caption = String(message.caption || '').slice(0, 900);
      entry.contentBase64 = String(message.contentBase64 || '');
    }
    item.outbox.push(entry);
    save();
    return { index };
  }

  function getOutboxState(updateId) {
    const item = queueItem(updateId);
    if (!item) return { exists: false, pending: [] };
    return {
      exists: item.outbox.length > 0,
      pending: item.outbox.map((entry, index) => ({ ...entry, index }))
        .filter((entry) => entry.status === 'pending')
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

  function discardOutbox(updateId, index) {
    const item = queueItem(updateId);
    if (!item || !item.outbox[index]) return false;
    if (item.outbox[index].status === 'pending') {
      item.outbox[index].status = 'discarded';
      item.outbox[index].discardedAt = Date.now();
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
        apiBaseUrl: options.apiBaseUrl || DEFAULT_API_BASE_URL,
        apiProviderId: findProviderByUrl(options.apiBaseUrl || DEFAULT_API_BASE_URL)?.id || 'custom',
        apiProtocol: 'openai',
        apiAuthType: 'bearer',
        modelsEndpoint: true,
        model: options.defaultModel || DEFAULT_MODEL,
        settings: {},
        activeChatId: null,
        chats: []
      };
    }
    const user = current.users[id];
    if (typeof user.apiKey !== 'string') user.apiKey = '';
    if (!normalizeApiBase(user.apiBaseUrl)) user.apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
    user.apiProviderId = findProviderByUrl(user.apiBaseUrl)?.id || 'custom';
    if (!['openai', 'anthropic'].includes(user.apiProtocol)) user.apiProtocol = 'openai';
    if (!['bearer', 'key', 'api-key', 'x-api-key'].includes(user.apiAuthType)) user.apiAuthType = 'bearer';
    user.modelsEndpoint = user.modelsEndpoint !== false;
    if (!user.settings || typeof user.settings !== 'object' || Array.isArray(user.settings)) user.settings = {};
    if (!Array.isArray(user.chats)) user.chats = [];
    if (!user.model && user.modelExplicit !== true) {
      const provider = findProviderByUrl(user.apiBaseUrl);
      user.model = provider && provider.defaultModel
        ? provider.defaultModel
        : (provider && provider.id !== 'openrouter' ? (options.defaultModel || '') : (options.defaultModel || DEFAULT_MODEL));
    }
    for (const chat of user.chats) {
      if (!chat || typeof chat !== 'object') continue;
      if (typeof chat.id !== 'string' || !chat.id) chat.id = crypto.randomUUID();
      if (!Array.isArray(chat.messages)) chat.messages = [];
      chat.messages.forEach((item, index) => {
        if (!item || typeof item !== 'object') return;
        if (typeof item.id !== 'string' || !item.id) item.id = 'legacy_' + chat.id + '_' + index;
        if (!Number.isFinite(Number(item.createdAt))) item.createdAt = Number(chat.createdAt) || Date.now();
      });
    }
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
    discardOutbox,
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
  const rawSendTelegramDocument = options.sendTelegramDocument || defaultSendTelegramDocument;
  const deleteTelegramMessage = options.deleteTelegramMessage || defaultDeleteTelegramMessage;
  const store = options.store || createEncryptedStore({
    encryptionKey: options.encryptionKey || process.env.BOT_DATA_ENCRYPTION_KEY,
    dataDir: options.dataDir || process.env.DATA_DIR,
    defaultModel,
    apiBaseUrl
  });
  const updateContext = new AsyncLocalStorage();

  async function sendTelegramMessage(chatId, text, sendOptions = {}) {
    const context = updateContext.getStore();
    if (!context || !Number.isSafeInteger(context.updateId)) {
      return rawSendTelegramMessage(chatId, text, sendOptions);
    }
    const queued = store.appendOutbox(context.updateId, { chatId, text, options: sendOptions });
    let sent;
    try {
      sent = await rawSendTelegramMessage(chatId, text, sendOptions);
    } catch (error) {
      // Telegram may reject malformed HTML. The formatter immediately retries as plain text;
      // discard the rejected variant so the worker does not retry invalid markup forever.
      if (isTelegramHtmlParseError(error)) {
        store.discardOutbox(context.updateId, queued.index);
      }
      error.telegramDeliveryFailure = true;
      throw error;
    }
    store.markOutboxDelivered(context.updateId, queued.index);
    return sent;
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

  async function defaultSendTelegramDocument(chatId, document) {
    if (!botToken) throw new Error('Telegram bot token is not configured.');
    const bytes = Buffer.from(String(document.contentBase64 || ''), 'base64');
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (document.caption) form.set('caption', String(document.caption).slice(0, 900));
    form.set('document', new Blob([bytes], { type: document.mimeType || 'text/plain; charset=utf-8' }), document.fileName || 'code.txt');
    const response = await fetchImpl('https://api.telegram.org/bot' + botToken + '/sendDocument', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      const error = new Error(result.description || 'Telegram document upload failed.');
      error.telegramDescription = result.description || '';
      error.telegramErrorCode = result.error_code || response.status;
      error.retryAfterSeconds = Number(result.parameters && result.parameters.retry_after) || 0;
      throw error;
    }
    return result.result;
  }

  async function defaultDeleteTelegramMessage(chatId, messageId) {
    return telegramRequest('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  const answerCallbackQuery = options.answerCallbackQuery || ((callbackQueryId, text = '') =>
    telegramRequest('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {})
    }));
  const editTelegramMessage = options.editTelegramMessage || ((chatId, messageId, text, replyMarkup) =>
    telegramRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup
    }));

  async function sendTelegramDocument(chatId, document) {
    const packet = {
      fileName: String(document.fileName || 'code.txt').slice(0, 120),
      mimeType: String(document.mimeType || 'text/plain; charset=utf-8').slice(0, 100),
      caption: String(document.caption || '').slice(0, 900),
      contentBase64: Buffer.from(document.content || '').toString('base64')
    };
    const context = updateContext.getStore();
    if (!context || !Number.isSafeInteger(context.updateId)) return rawSendTelegramDocument(chatId, packet);
    const queued = store.appendOutbox(context.updateId, { chatId, kind: 'document', ...packet });
    let sent;
    try {
      sent = await rawSendTelegramDocument(chatId, packet);
    } catch (error) {
      error.telegramDeliveryFailure = true;
      throw error;
    }
    store.markOutboxDelivered(context.updateId, queued.index);
    return sent;
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

  async function startGenerationIndicator(chatId) {
    const startedAt = Date.now();
    const sent = await sendTelegramMessage(chatId, 'Генерируем ответ... (0 сек.)');
    const messageId = sent && Number.isSafeInteger(Number(sent.message_id))
      ? Number(sent.message_id)
      : null;
    let stopped = false;
    let editing = false;
    let editInFlight = Promise.resolve();

    const elapsedSeconds = () => Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const editStatus = async (text) => {
      if (!messageId) return false;
      try {
        await editTelegramMessage(chatId, messageId, text);
        return true;
      } catch {
        return false;
      }
    };

    const timer = setInterval(() => {
      if (stopped || editing || !messageId) return;
      editing = true;
      const seconds = elapsedSeconds();
      editInFlight = editStatus('Генерируем ответ... (' + seconds + ' сек.)')
        .finally(() => { editing = false; });
    }, 1_000);
    if (typeof timer.unref === 'function') timer.unref();

    return {
      elapsedSeconds,
      async finish(finalText) {
        stopped = true;
        clearInterval(timer);
        await editInFlight;
        const seconds = elapsedSeconds();
        if (!messageId) {
          if (finalText) await sendText(chatId, finalText);
          return seconds;
        }
        if (finalText) {
          if (!(await editStatus(finalText))) await sendText(chatId, finalText);
        } else {
          try {
            await deleteTelegramMessage(chatId, messageId);
          } catch {
            await editStatus('Ответ готов за ' + seconds + ' сек.');
          }
        }
        return seconds;
      }
    };
  }

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
      /(?:filename=)?[^\\s\\x60]+\\.[a-z0-9]{1,8}(?:\\s|$)/i.test(String(match[2] || ''))
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
      const parts = String(match[2] || '').trim().split(/\\s+/).filter(Boolean);
      let language = parts[0] || 'text';
      let candidateName = '';
      if (/^[\\w.-]+\\.[a-z0-9]{1,8}$/i.test(language)) {
        candidateName = language;
        language = 'text';
      } else {
        const namePart = parts.slice(1).find((part) => /(?:filename=)?[^\\s]+\\.[a-z0-9]{1,8}$/i.test(part));
        if (namePart) candidateName = namePart.replace(/^filename=/i, '');
      }
      fileIndex += 1;
      const name = safeGeneratedFileName(candidateName, language, fileIndex);
      const content = String(match[3] || '').replace(/\\s+$/, '') + '\\n';
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

  function getSettingsUrl() {
    let value = options.webAppUrl || process.env.WEB_APP_URL || '';
    try {
      const target = new URL(value);
      if (target.protocol !== 'https:') return '';
      target.searchParams.set('open', 'settings');
      return target.toString();
    } catch {
      return '';
    }
  }

  function currentProvider(user) {
    return findProviderByUrl(user.apiBaseUrl || apiBaseUrl);
  }

  function defaultModelForUser(user) {
    const provider = currentProvider(user);
    if (provider && provider.defaultModel) return provider.defaultModel;
    return normalizeApiBase(user.apiBaseUrl || apiBaseUrl) === normalizeApiBase(apiBaseUrl) ? defaultModel : '';
  }

  function currentUserModel(user) {
    return (activeChat(user) || {}).model || user.model || defaultModelForUser(user) || 'не выбрана';
  }

  function currentProviderName(user) {
    const provider = currentProvider(user);
    return provider ? provider.name : 'Пользовательский endpoint';
  }

  function changeProvider(user, providerId) {
    const provider = findProviderById(providerId);
    if (!provider) return { ok: false, reason: 'unknown' };
    const nextBase = normalizeApiBase(provider.url);
    if (!nextBase) return { ok: false, reason: 'invalid' };
    if (normalizeApiBase(user.apiBaseUrl || apiBaseUrl) === nextBase &&
        user.apiProtocol === provider.protocol && user.apiAuthType === provider.authType &&
        user.modelsEndpoint === (provider.modelsEndpoint !== false)) {
      return { ok: true, changed: false, provider };
    }

    const previous = {
      apiBaseUrl: user.apiBaseUrl,
      apiBaseUrlExplicit: user.apiBaseUrlExplicit,
      apiProviderId: user.apiProviderId,
      apiProtocol: user.apiProtocol,
      apiAuthType: user.apiAuthType,
      modelsEndpoint: user.modelsEndpoint,
      apiKey: user.apiKey,
      model: user.model,
      modelExplicit: user.modelExplicit,
      chatModels: user.chats.map((chat) => ({ chat, model: chat.model }))
    };
    user.apiBaseUrl = nextBase;
    user.apiBaseUrlExplicit = true;
    user.apiProviderId = provider.id;
    user.apiProtocol = provider.protocol || 'openai';
    user.apiAuthType = provider.authType || 'bearer';
    user.modelsEndpoint = provider.modelsEndpoint !== false;
    user.apiKey = normalizeApiBase(previous.apiBaseUrl || apiBaseUrl) === nextBase ? previous.apiKey : '';
    if (normalizeApiBase(previous.apiBaseUrl || apiBaseUrl) !== nextBase) {
      user.model = provider.defaultModel || '';
      user.modelExplicit = true;
      for (const chat of user.chats) chat.model = user.model;
    }
    try {
      store.save();
    } catch (error) {
      Object.assign(user, {
        apiBaseUrl: previous.apiBaseUrl,
        apiBaseUrlExplicit: previous.apiBaseUrlExplicit,
        apiProviderId: previous.apiProviderId,
        apiProtocol: previous.apiProtocol,
        apiAuthType: previous.apiAuthType,
        modelsEndpoint: previous.modelsEndpoint,
        apiKey: previous.apiKey,
        model: previous.model,
        modelExplicit: previous.modelExplicit
      });
      for (const item of previous.chatModels) item.chat.model = item.model;
      throw error;
    }
    return { ok: true, changed: true, provider };
  }

  function currentTokenLimit(user) {
    return Math.max(1, Math.min(32_000, Math.round(Number(user.settings && user.settings.maxTokens) || 1_200)));
  }

  function currentRequestTimeout(user) {
    return Math.max(10, Math.min(7200, Math.round(Number(user.settings && user.settings.requestTimeoutSeconds) || 120)));
  }

  function settingsMessageText(user, view = 'main') {
    if (view === 'tokens') return 'Выберите лимит ответа. Текущее значение: ' + currentTokenLimit(user) + ' токенов.';
    if (view === 'timeout') return 'Выберите время ожидания ответа провайдера. Текущее значение: ' + currentRequestTimeout(user) + ' секунд.';
    if (view === 'timeout-input') return 'Отправьте одним сообщением целое число секунд от 10 до 7200. Максимум — 2 часа. Для отмены отправьте /cancel.';
    if (view === 'reasoning') {
      const current = user.settings && user.settings.reasoning || 'auto';
      return 'Выберите уровень рассуждений. Текущее значение: ' + (reasoningLabels[current] || 'Авто') + '.';
    }
    if (view === 'models') {
      const entry = modelChoiceCache.get(String(user.id || ''));
      const count = entry && Array.isArray(entry.models) ? entry.models.length : 0;
      return 'Выберите модель из списка провайдера' + (count ? ' (' + count + ' вариантов)' : '') + '.';
    }
    const providersView = String(view).match(/^providers:(\d+)$/);
    if (providersView) {
      const page = Math.max(0, Math.min(Math.ceil(PROVIDER_CATALOG.length / 10) - 1, Number(providersView[1])));
      const start = page * 10;
      const current = currentProvider(user);
      return 'Выберите API-провайдера. Сейчас: ' + currentProviderName(user) + '.\n' +
        PROVIDER_CATALOG.slice(start, start + 10).map((provider) =>
          (current && current.id === provider.id ? '✓ ' : '• ') + provider.name + ' (' + provider.id + ')'
        ).join('\n') + '\nСтраница ' + (page + 1) + ' из ' + Math.ceil(PROVIDER_CATALOG.length / 10) +
        '. При смене старый ключ и модель отключаются.';
    }

    const settings = user.settings || {};
    const apiBase = user.apiBaseUrl || apiBaseUrl || 'не задан';
    const currentChat = activeChat(user);
    const maxTokens = currentTokenLimit(user);
    return [
      'Настройки TG Nexus',
      'Провайдер: ' + currentProviderName(user),
      'API: ' + apiBase,
      'Модель: ' + currentUserModel(user),
      'Лимит ответа: ' + maxTokens + ' токенов',
      'Время ожидания ответа: ' + currentRequestTimeout(user) + ' секунд',
      'Рассуждения: ' + (reasoningLabels[settings.reasoning || 'auto'] || 'Авто'),
      'Инструкция: ' + (settings.systemPrompt ? 'пользовательская' : 'по умолчанию'),
      'Интернет-поиск: ' + (settings.internetSearch === true ? 'включён' : 'выключен'),
      'Песочница: ' + (settings.sandbox === true ? 'разрешена в Mini App' : 'выключена'),
      'История синхронизируется с Mini App при открытии и сохранении.',
      'Часть параметров можно менять кнопками ниже; полный набор доступен в Mini App.'
    ].join('\n');
  }

  function settingsKeyboard(user, view = 'main') {
    if (view === 'timeout') {
      const current = currentRequestTimeout(user);
      const choices = [10, 30, 60, 120, 180, 300, 600, 1800, 3600, 7200];
      const rows = [];
      for (let i = 0; i < choices.length; i += 3) {
        rows.push(choices.slice(i, i + 3).map((value) => ({
          text: (value === current ? '✓ ' : '') + value + ' с',
          callback_data: 'tn:timeout:' + value
        })));
      }
      rows.push([{ text: '✍️ Ввести своё значение', callback_data: 'tn:timeout:custom' }]);
      rows.push([{ text: '← Назад', callback_data: 'tn:back' }]);
      return { inline_keyboard: rows };
    }
    if (view === 'timeout-input') return { inline_keyboard: [[{ text: '← Назад', callback_data: 'tn:back' }]] };
    if (view === 'tokens') {
      const current = currentTokenLimit(user);
      const rows = [];
      for (let i = 0; i < tokenPresets.length; i += 3) {
        rows.push(tokenPresets.slice(i, i + 3).map((value) => ({
          text: (value === current ? '✓ ' : '') + value.toLocaleString('ru-RU'),
          callback_data: 'tn:t:' + value
        })));
      }
      rows.push([{ text: '← Назад', callback_data: 'tn:back' }]);
      return { inline_keyboard: rows };
    }
    if (view === 'reasoning') {
      const current = user.settings && user.settings.reasoning || 'auto';
      const rows = [];
      for (let i = 0; i < reasoningChoices.length; i += 2) {
        rows.push(reasoningChoices.slice(i, i + 2).map((value) => ({
          text: (value === current ? '✓ ' : '') + reasoningLabels[value],
          callback_data: 'tn:r:' + value
        })));
      }
      rows.push([{ text: '← Назад', callback_data: 'tn:back' }]);
      return { inline_keyboard: rows };
    }
    if (view === 'models') {
      const entry = modelChoiceCache.get(String(user.id || ''));
      const models = entry && entry.expiresAt > Date.now() ? entry.models : [];
      const rows = [];
      for (let i = 0; i < models.length; i += 2) {
        rows.push(models.slice(i, i + 2).map((model, offset) => ({
          text: (model === currentUserModel(user) ? '✓ ' : '') + model.slice(0, 40),
          callback_data: 'tn:m:' + (i + offset)
        })));
      }
      rows.push([{ text: '← Назад', callback_data: 'tn:back' }]);
      return { inline_keyboard: rows };
    }
    const providersView = String(view).match(/^providers:(\d+)$/);
    if (providersView) {
      const page = Math.max(0, Math.min(Math.ceil(PROVIDER_CATALOG.length / 10) - 1, Number(providersView[1])));
      const current = currentProvider(user);
      const providers = PROVIDER_CATALOG.slice(page * 10, page * 10 + 10);
      const rows = [];
      for (let i = 0; i < providers.length; i += 2) {
        rows.push(providers.slice(i, i + 2).map((provider) => ({
          text: (current && current.id === provider.id ? '✓ ' : '') + provider.name.slice(0, 35),
          callback_data: 'tn:provider:' + provider.id
        })));
      }
      const navigation = [];
      if (page > 0) navigation.push({ text: '← Предыдущие', callback_data: 'tn:providers:' + (page - 1) });
      if (page < Math.ceil(PROVIDER_CATALOG.length / 10) - 1) navigation.push({ text: 'Следующие →', callback_data: 'tn:providers:' + (page + 1) });
      if (navigation.length) rows.push(navigation);
      rows.push([{ text: '← Назад', callback_data: 'tn:back' }]);
      return { inline_keyboard: rows };
    }

    const settings = user.settings || {};
    const rows = [
      [
        { text: '🌐 Поиск: ' + (settings.internetSearch === true ? 'ВКЛ' : 'ВЫКЛ'), callback_data: 'tn:search' },
        { text: '🧠 Рассуждения', callback_data: 'tn:reason' }
      ],
      [
        { text: '🎛 Лимит ответа', callback_data: 'tn:tokens' },
        { text: '🤖 Модель', callback_data: 'tn:model' }
      ],
      [{ text: '⏱ Тайм-аут: ' + currentRequestTimeout(user) + ' с', callback_data: 'tn:timeout' }],
      [{ text: '🔌 API-провайдер', callback_data: 'tn:providers:0' }],
      [{ text: '↻ Обновить', callback_data: 'tn:refresh' }]
    ];
    const url = getSettingsUrl();
    if (url) rows.push([{ text: 'Открыть все настройки', web_app: { url } }]);
    return { inline_keyboard: rows };
  }

  async function safeAnswerCallback(queryId, text = '') {
    try { await answerCallbackQuery(queryId, text); } catch {}
  }

  async function renderSettingsCallback(query, user, view = 'main', answerText = 'Настройки обновлены.') {
    const message = query && query.message;
    if (!message || !message.chat || !Number.isSafeInteger(Number(message.message_id))) {
      await safeAnswerCallback(query.id, 'Сообщение настроек недоступно. Отправьте /settings ещё раз.');
      return false;
    }
    try {
      await editTelegramMessage(
        message.chat.id,
        message.message_id,
        settingsMessageText(user, view),
        settingsKeyboard(user, view)
      );
    } catch (error) {
      const description = String(error && (error.telegramDescription || error.message) || '');
      if (!/message is not modified/i.test(description)) {
        await safeAnswerCallback(query.id, 'Не удалось обновить панель. Отправьте /settings ещё раз.');
        return false;
      }
    }
    await safeAnswerCallback(query.id, answerText);
    return true;
  }

  async function handleCallbackQuery(query) {
    if (!query || typeof query.id !== 'string' || typeof query.data !== 'string' ||
        !query.data.startsWith('tn:')) return false;

    const message = query.message;
    const userId = query.from && query.from.id;
    if (!message || !message.chat || message.chat.type !== 'private' ||
        userId == null || Number(message.chat.id) !== Number(userId)) {
      await safeAnswerCallback(query.id, 'Эти настройки доступны только в личном чате.');
      return false;
    }
    if (!store.enabled) {
      await safeAnswerCallback(query.id, 'Защищённое хранилище недоступно.');
      return true;
    }

    let user;
    try {
      user = store.getUser(userId);
      user.id = String(userId);
    } catch {
      await safeAnswerCallback(query.id, 'Не удалось открыть хранилище настроек.');
      return true;
    }

    const data = query.data;
    let view = 'main';
    let notice = 'Настройки обновлены.';
    try {
      const providersPageMatch = data.match(/^tn:providers:(\d)$/);
      const providerSelectMatch = data.match(/^tn:provider:([a-z0-9_-]{1,40})$/i);
      if (providersPageMatch) {
        view = 'providers:' + providersPageMatch[1];
        notice = 'Выберите API-провайдера.';
      } else if (providerSelectMatch) {
        const result = changeProvider(user, providerSelectMatch[1].toLowerCase());
        if (!result.ok) {
          await safeAnswerCallback(query.id, 'Неизвестный провайдер. Обновите панель настроек.');
          return true;
        }
        notice = result.changed
          ? 'Провайдер изменён на ' + result.provider.name + '. Добавьте API-ключ и выберите модель.'
          : result.provider.name + ' уже выбран.';
      } else if (data === 'tn:search') {
        const previous = user.settings || {};
        user.settings = { ...previous, internetSearch: previous.internetSearch !== true };
        try { store.save(); } catch (error) { user.settings = previous; throw error; }
        notice = 'Поиск в интернете ' + (user.settings.internetSearch ? 'включён.' : 'выключен.');
      } else if (data === 'tn:reason') {
        view = 'reasoning';
        notice = 'Выберите уровень рассуждений.';
      } else if (data === 'tn:tokens') {
        view = 'tokens';
        notice = 'Выберите лимит ответа.';
      } else if (data === 'tn:timeout') {
        pendingTimeoutInput.delete(String(userId));
        view = 'timeout';
        notice = 'Выберите время ожидания ответа провайдера.';
      } else if (data === 'tn:timeout:custom') {
        pendingTimeoutInput.set(String(userId), { createdAt: Date.now() });
        view = 'timeout-input';
        notice = 'Жду ваше значение в секундах.';
      } else if (data === 'tn:model') {
        if (!user.apiKey) {
          await safeAnswerCallback(query.id, 'Ключ для Telegram-чата не настроен. Откройте полные настройки Mini App.');
          return true;
        }
        const models = await getModels(user.apiKey, user.apiBaseUrl || apiBaseUrl, user);
        const current = currentUserModel(user);
        const choices = [current, ...models.filter((model) => model !== current)].slice(0, 20);
        modelChoiceCache.set(String(userId), { models: choices, expiresAt: Date.now() + 10 * 60_000 });
        while (modelChoiceCache.size > 100) modelChoiceCache.delete(modelChoiceCache.keys().next().value);
        view = 'models';
        notice = 'Выберите модель.';
      } else if (data === 'tn:back' || data === 'tn:refresh') {
        pendingTimeoutInput.delete(String(userId));
        view = 'main';
      } else {
        const reasoningMatch = data.match(/^tn:r:(auto|minimal|low|medium|high|xhigh)$/);
        const tokenMatch = data.match(/^tn:t:(512|1200|2000|4000|8000|16000|32000)$/);
        const timeoutMatch = data.match(/^tn:timeout:(10|30|60|120|180|300|600|1800|3600|7200)$/);
        const modelMatch = data.match(/^tn:m:(\d{1,2})$/);
        if (timeoutMatch) {
          const previous = user.settings || {};
          user.settings = { ...previous, requestTimeoutSeconds: Number(timeoutMatch[1]) };
          try { store.save(); } catch (error) { user.settings = previous; throw error; }
          notice = 'Тайм-аут ответа провайдера: ' + timeoutMatch[1] + ' секунд.';
        } else if (reasoningMatch) {
          const previous = user.settings || {};
          user.settings = { ...previous, reasoning: reasoningMatch[1] };
          try { store.save(); } catch (error) { user.settings = previous; throw error; }
          notice = 'Уровень рассуждений: ' + reasoningLabels[reasoningMatch[1]] + '.';
        } else if (tokenMatch) {
          const previous = user.settings || {};
          user.settings = { ...previous, maxTokens: Number(tokenMatch[1]) };
          try { store.save(); } catch (error) { user.settings = previous; throw error; }
          notice = 'Лимит ответа: ' + tokenMatch[1] + ' токенов.';
        } else if (modelMatch) {
          const entry = modelChoiceCache.get(String(userId));
          const index = Number(modelMatch[1]);
          const model = entry && entry.expiresAt > Date.now() && entry.models[index];
          if (!model) {
            await safeAnswerCallback(query.id, 'Список моделей устарел. Нажмите «Модель» ещё раз.');
            return true;
          }
          const previousModel = user.model;
          const previousExplicit = user.modelExplicit;
          const chat = activeChat(user);
          const previousChatModel = chat && chat.model;
          user.model = model;
          user.modelExplicit = true;
          if (chat) { chat.model = model; chat.updatedAt = Date.now(); }
          try { store.save(); } catch (error) {
            user.model = previousModel;
            user.modelExplicit = previousExplicit;
            if (chat) chat.model = previousChatModel;
            throw error;
          }
          notice = 'Модель выбрана: ' + model;
        } else {
          await safeAnswerCallback(query.id, 'Эта кнопка устарела. Отправьте /settings ещё раз.');
          return true;
        }
      }
      return await renderSettingsCallback(query, user, view, notice);
    } catch {
      await safeAnswerCallback(query.id, 'Не удалось сохранить настройку. Повторите попытку.');
      return true;
    }
  }

  async function sendSettings(chatId, user) {
    user.id = String(user.id || '');
    await sendTelegramMessage(chatId, settingsMessageText(user), {
      reply_markup: settingsKeyboard(user)
    });
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
    const now = Date.now();
    const chat = {
      id: crypto.randomUUID(),
      title: String(title || nextChatTitle(user)).replace(/\s+/g, ' ').trim().slice(0, 100) || nextChatTitle(user),
      model: user.model || defaultModelForUser(user),
      createdAt: now,
      updatedAt: now,
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

  function providerProfile(user, endpoint) {
    const base = normalizeApiBase(endpoint || user.apiBaseUrl || apiBaseUrl);
    const byId = findProviderById(user.apiProviderId);
    const byUrl = findProviderByUrl(base);
    const catalog = byId && normalizeApiBase(byId.url) === base ? byId : byUrl;
    return {
      id: catalog ? catalog.id : (user.apiProviderId || 'custom'),
      url: base,
      protocol: catalog ? (catalog.protocol || 'openai') :
        (['anthropic', 'openai', 'responses'].includes(user.apiProtocol) ? user.apiProtocol : 'openai'),
      authType: catalog ? (catalog.authType || 'bearer') :
        (['bearer', 'key', 'api-key', 'x-api-key'].includes(user.apiAuthType) ? user.apiAuthType : 'bearer'),
      modelsEndpoint: catalog ? catalog.modelsEndpoint !== false : user.modelsEndpoint !== false,
      chatPath: catalog && catalog.chatPath,
      responsesPath: catalog && catalog.responsesPath,
      messagesPath: catalog && catalog.messagesPath,
      modelsPath: catalog && catalog.modelsPath,
      responsesModels: catalog && catalog.responsesModels,
      responsesImages: catalog && catalog.responsesImages,
      notice: catalog && catalog.notice
    };
  }

  async function getModels(apiKey, endpoint = apiBaseUrl, user = {}) {
    const profile = providerProfile(user, endpoint);
    if (!profile.url) throw new Error('Provider endpoint is not configured.');
    const request = PROVIDER_ADAPTERS.modelsRequest(profile, apiKey, false);
    const response = await fetchImpl(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(providerErrorSummary(response.status, extractProviderErrorMessage(payload)));
    }
    const models = PROVIDER_ADAPTERS.extractModels(profile, payload);
    const configured = String(process.env.AI_ALLOWED_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean);
    return [...new Set(models.length ? models : configured)];
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
    // Delete the command immediately so the credential is not retained in Telegram chat history.
    try { await deleteTelegramMessage(message.chat.id, message.message_id); } catch {}

    if (!args || /\s/.test(args) || args.length > 2_048) {
      await sendText(message.chat.id, 'Использование: /key ваш_API_ключ');
      return;
    }
    if (!store.enabled) {
      await sendText(message.chat.id, 'Безопасное хранилище не настроено на сервере. Обратитесь к администратору.');
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
      await sendText(message.chat.id,
        'Ключ сохранён для провайдера ' + currentProviderName(user) + '.\n' +
        'Это ещё не проверка доступа: выполните /test после выбора модели.');
    } catch {
      await sendText(message.chat.id, 'Не удалось безопасно сохранить ключ. Обратитесь к администратору.');
    }
  }

  function listProvidersText(user) {
    const current = currentProvider(user);
    return 'Текущий провайдер: ' + currentProviderName(user) + '.\n' +
      'Выберите командой /provider [ID]:\n' +
      PROVIDER_CATALOG.map((provider) =>
        (current && current.id === provider.id ? '✓ ' : '• ') + provider.id + ' — ' + provider.name
      ).join('\n');
  }

  async function handleProviderCommand(message, user, args) {
    if (!args) {
      await sendText(message.chat.id, listProvidersText(user));
      return;
    }
    const normalized = args.trim().toLowerCase();
    const provider = findProviderById(normalized) ||
      PROVIDER_CATALOG.find((item) => item.name.toLowerCase() === normalized) || null;
    if (!provider) {
      await sendText(message.chat.id, 'Провайдер не найден. Используйте /provider, чтобы увидеть поддерживаемые варианты.');
      return;
    }
    const result = changeProvider(user, provider.id);
    if (!result.ok) {
      await sendText(message.chat.id, 'Не удалось переключить провайдера. Проверьте настройки и повторите.');
      return;
    }
    await sendText(message.chat.id, result.changed
      ? 'Провайдер изменён: ' + provider.name + '.\nСтарый ключ сброшен, чтобы не отправлять его другому сервису.\nТеперь выполните /key [ключ], затем выберите модель командой /model.'
      : provider.name + ' уже выбран. Проверьте или добавьте ключ командой /key, а модель — командой /model.');
  }

  async function handleModelCommand(message, user, args) {
    // An explicit model ID is a manual selection. Do not make it depend on
    // the provider's optional /models catalogue: several APIs omit it or
    // expose a catalogue that is temporarily unavailable.
    if (args) {
      const manualModel = String(args).trim();
      if (!manualModel || manualModel.length > 256 || /\s/.test(manualModel)) {
        await sendText(message.chat.id, 'Укажите один ID модели без пробелов: /model [ID модели].');
        return;
      }

      user.model = manualModel;
      user.modelExplicit = true;
      const manualChat = activeChat(user);
      if (manualChat) {
        manualChat.model = manualModel;
        manualChat.updatedAt = Date.now();
      }
      store.save();
      await sendText(message.chat.id,
        'Модель выбрана вручную: ' + manualModel + '.\n' +
        'Теперь выполните /test, чтобы проверить доступ и совместимость.');
      return;
    }

    if (!user.modelsEndpoint) {
      await sendText(message.chat.id, 'Этот провайдер не публикует совместимый список моделей. Укажите ID вручную: /model [ID модели].');
      return;
    }
    if (!user.apiKey) {
      await sendText(message.chat.id, 'Сначала добавьте API-ключ командой /key.');
      return;
    }

    let models;
    try {
      models = await getModels(user.apiKey, user.apiBaseUrl || apiBaseUrl, user);
    } catch (error) {
      const reason = sanitizeProviderError(error && error.message || '');
      await sendText(message.chat.id,
        'Не удалось получить список моделей. Можно указать ID вручную: /model [ID модели].' +
        (reason ? '\nПричина: ' + reason : ''));
      return;
    }

    await sendModelList(message.chat.id, models, (activeChat(user) || {}).model || user.model);
  }

  function sanitizeProviderError(value) {
    return String(value || '')
      .replace(/Incorrect API key provided:\s*\S+/gi, 'Incorrect API key provided: [секрет скрыт]')
      .replace(/(?:sk-[A-Za-z0-9_-]{8,}|\.storefront\.[A-Za-z0-9_-]{8,}|Bearer\s+\S+|api[_-]?key\s*[:=]\s*\S+)/gi, '[секрет скрыт]')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  function providerErrorSummary(status, detail) {
    const safeDetail = sanitizeProviderError(detail);
    const lead = status === 401 || status === 403 ? 'Провайдер отклонил ключ или не дал доступ.'
      : status === 402 ? 'Провайдер сообщил о недостатке средств или лимита.'
      : status === 404 ? 'Провайдер не нашёл выбранную модель или endpoint.'
      : status === 429 ? 'Провайдер ограничил запрос или временно занят.'
      : status >= 500 ? 'На стороне провайдера произошла серверная ошибка.'
      : 'Провайдер отклонил запрос.';
    return lead + ' HTTP ' + status + (safeDetail ? ': ' + safeDetail : '.');
  }

  function extractProviderErrorMessage(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const error = payload.error;
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    if (typeof payload.message === 'string') return payload.message;
    if (typeof payload.detail === 'string') return payload.detail;
    return '';
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
    const providerBase = normalizeApiBase(user.apiBaseUrl || apiBaseUrl);
    if (!providerBase) throw new Error('Provider endpoint is not configured.');
    const profile = providerProfile(user, providerBase);
    const history = chat.messages.slice(-MAX_MESSAGES_PER_CHAT).map((message) => ({
      role: message.role,
      content: message.content
    }));
    const userSettings = user.settings || {};
    const userPrompt = typeof userSettings.systemPrompt === 'string' && userSettings.systemPrompt.trim()
      ? userSettings.systemPrompt.trim()
      : systemPrompt;
    const formatting = 'Отвечай без таблиц и заголовков #. Используй короткие абзацы, простые списки и жирный шрифт только для важного.';
    const fileOutputInstruction = 'Когда пользователь просит создать или изменить код/файл/проект, выдавай каждый готовый файл отдельным блоком кода с именем файла после языка, например: ' + String.fromCharCode(96).repeat(3) + 'python main.py. Внутри блока должен быть полный текст файла без пропусков. Для многофайлового проекта используй отдельный блок на каждый файл. Не помещай полный код файла в обычный текст.';
    const effectivePrompt = (userPrompt.includes(formatting) ? userPrompt : userPrompt + '\n\n' + formatting) + '\n\n' + fileOutputInstruction;
    const messages = [{ role: 'system', content: effectivePrompt }, ...history];
    const tokenLimit = Math.max(1, Math.min(32_000, Math.round(Number(userSettings.maxTokens) || 1_200)));
    const tools = [];
    if (userSettings.internetSearch === true && profile.protocol === 'openai' && new URL(providerBase).hostname === 'openrouter.ai') {
      tools.push({ type: 'openrouter:web_search', parameters: { max_uses: 3, max_results: 5 } });
    }
    const model = chat.model || user.model || defaultModelForUser(user);
    if (!model || model === 'не выбрана') throw new Error('Модель не выбрана. Выполните /model после добавления ключа.');
    const request = PROVIDER_ADAPTERS.buildModelRequest(profile, {
      apiKey: user.apiKey,
      model,
      messages,
      maxTokens: tokenLimit,
      temperature: userSettings.temperature,
      reasoningEffort: userSettings.reasoning,
      tools,
      maxToolCalls: tools.length ? 5 : 0,
      stream: false
    }, false);
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(currentRequestTimeout(user) * 1000)
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      const error = new Error(providerErrorSummary(response.status, extractProviderErrorMessage(errorPayload)));
      error.status = response.status;
      throw error;
    }
    const payload = PROVIDER_ADAPTERS.normalizePayload(profile, await response.json().catch(() => ({})), request.protocol);
    const answer = extractAssistantText(payload);
    if (!answer) throw new Error('Provider returned an empty response.');
    return answer.slice(0, MAX_MESSAGE_LENGTH);
  }

  async function testProviderConnection(user) {
    if (!user.apiKey) return { ok: false, message: 'API-ключ не сохранён. Сначала выполните /key [ключ].' };
    const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
    const chat = activeChat(user);
    const model = (chat && chat.model) || user.model || defaultModelForUser(user);
    if (!model || model === 'не выбрана') {
      return { ok: false, message: 'Модель не выбрана. Сначала выполните /model и выберите модель.' };
    }
    try {
      const request = PROVIDER_ADAPTERS.buildModelRequest(profile, {
        apiKey: user.apiKey,
        model,
        maxTokens: 512,
        messages: [{ role: 'user', content: 'Reply with TEST_OK only.' }],
        stream: false
      }, false);
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(currentRequestTimeout(user) * 1000)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { ok: false, message: providerErrorSummary(response.status, extractProviderErrorMessage(payload)), status: response.status };
      }
      const normalized = PROVIDER_ADAPTERS.normalizePayload(profile, payload, request.protocol);
      const answer = extractAssistantText(normalized);
      if (!answer) return { ok: false, message: 'Провайдер ответил без текста. Проверьте совместимость выбранной модели.' };
      return { ok: true, model, answer: sanitizeProviderError(answer) };
    } catch (error) {
      const message = sanitizeProviderError(error && error.message || 'Network request failed.');
      return { ok: false, message: /timeout|aborted/i.test(message)
        ? 'Истекло время ожидания ответа провайдера.'
        : 'Не удалось связаться с endpoint провайдера: ' + message };
    }
  }

  async function handleTestCommand(message, user) {
    if (!checkRateLimit(message.from.id)) {
      await sendText(message.chat.id, 'Слишком много запросов. Подождите минуту и повторите.');
      return;
    }
    const provider = currentProviderName(user);
    await sendText(message.chat.id, 'Проверяю реальный запрос к ' + provider + '…');
    const result = await testProviderConnection(user);
    if (!result.ok) {
      await sendText(message.chat.id, 'Проверка не пройдена.\n' + result.message);
      return;
    }
    await sendText(message.chat.id,
      'Подключение работает.\nПровайдер: ' + provider + '\nМодель: ' + result.model + '\nОтвет API: ' + result.answer);
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

    chat.messages.push({ id: crypto.randomUUID(), createdAt: Date.now(), role: 'user', content: text.slice(0, MAX_MESSAGE_LENGTH) });
    chat.updatedAt = Date.now();
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }
    store.save();

    const indicator = await startGenerationIndicator(message.chat.id);
    let answer;
    try {
      answer = await requestAssistant(user, chat);
    } catch (error) {
      const reason = sanitizeProviderError(error && error.message || 'Неизвестная ошибка провайдера.');
      const elapsed = indicator.elapsedSeconds();
      await indicator.finish('Не удалось получить ответ от ИИ за ' + elapsed + ' сек.\nПричина: ' + reason);
      return;
    }

    await indicator.finish();
    chat.messages.push({ id: crypto.randomUUID(), createdAt: Date.now(), role: 'assistant', content: answer });
    chat.updatedAt = Date.now();
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }
    store.save();
    await sendAssistantResponse(message.chat.id, answer, text);
  }

  async function processMessage(message, parsed, text) {
    const chatId = message.chat.id;
    const command = parsed && parsed.name;

    if (command === 'start' || command === 'help') return false;
    if (command === 'cancel') {
      pendingTimeoutInput.delete(String(message.from.id));
      await sendText(chatId, 'Ввод тайм-аута отменён.');
      return true;
    }
    if (command === 'version') {
      await sendText(chatId, 'TG Nexus backend build: 2026-11-21-responses-pro-v3. Astra Pro через Responses API; ручной выбор моделей включён.');
      return true;
    }
    if (command === 'info') {
      await sendText(chatId,
        '/start — показать кнопку мини-приложения\n' +
        '/help — краткая справка\n' +
        '/chat — показать список всех чатов\n' +
        '/add_chat [название] — создать чат и сделать его активным\n' +
        '/chat_equip [название чата] — выбрать существующий чат\n' +
        '/info — список команд\n' +
        '/provider [ID] — выбрать API-провайдера\n' +
        '/key [ключ провайдера] — сохранить API-ключ\n' +
        '/model [название модели] — выбрать модель или показать доступные\n' +
        '/test — проверить реальный запрос к API\n' +
        '/version — показать версию backend\n' +
        '/settings — показать настройки ИИ и открыть Mini App\n' +
        '/cancel — отменить текущий ввод настройки\n\n' +
        'Created tet0r');
      return true;
    }
    if (command === 'key') {
      await handleKeyCommand(message, parsed.args);
      return true;
    }
    if (command && !['chat', 'add_chat', 'chat_equip', 'model', 'settings', 'provider', 'test'].includes(command)) {
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
      const timeoutInputKey = String(message.from.id);
      const pendingTimeout = pendingTimeoutInput.get(timeoutInputKey);
      if (pendingTimeout && !command) {
        if (Date.now() - pendingTimeout.createdAt > 10 * 60_000) {
          pendingTimeoutInput.delete(timeoutInputKey);
          await sendText(chatId, 'Время ввода истекло. Откройте /settings и нажмите «Тайм-аут» снова.');
          return true;
        }
        if (!/^\d{1,4}$/.test(text)) {
          await sendText(chatId, 'Нужно отправить только целое число секунд от 10 до 7200. Например: 900. Для отмены — /cancel.');
          return true;
        }
        const seconds = Number(text);
        if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 7200) {
          await sendText(chatId, 'Значение должно быть от 10 до 7200 секунд. Текущее значение не изменено.');
          return true;
        }
        const previous = user.settings || {};
        user.settings = { ...previous, requestTimeoutSeconds: seconds };
        try { store.save(); } catch (error) { user.settings = previous; throw error; }
        pendingTimeoutInput.delete(timeoutInputKey);
        await sendText(chatId, 'Тайм-аут ответа провайдера установлен: ' + seconds + ' секунд.');
        await sendSettings(chatId, user);
        return true;
      }
      if (pendingTimeout && command) pendingTimeoutInput.delete(timeoutInputKey);
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
      if (command === 'provider') {
        await handleProviderCommand(message, user, parsed.args);
        return true;
      }
      if (command === 'model') {
        await handleModelCommand(message, user, parsed.args);
        return true;
      }
      if (command === 'test') {
        await handleTestCommand(message, user);
        return true;
      }
      if (command === 'settings') {
        await sendSettings(chatId, user);
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
      if (entry.kind === 'document') {
        await rawSendTelegramDocument(entry.chatId, {
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          caption: entry.caption,
          contentBase64: entry.contentBase64
        });
      } else {
        await rawSendTelegramMessage(entry.chatId, entry.text, entry.options || {});
      }
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

  function getSyncState(userId) {
    const user = store.getUser(userId);
    return {
      apiBaseUrl: (user.apiBaseUrlExplicit || user.apiKey) ? (user.apiBaseUrl || apiBaseUrl) : '',
      apiProviderId: findProviderByUrl(user.apiBaseUrl || apiBaseUrl)?.id || 'custom',
      apiProviderName: (findProviderByUrl(user.apiBaseUrl || apiBaseUrl) || {}).name || 'Пользовательский endpoint',
      apiProtocol: (findProviderById(user.apiProviderId) || findProviderByUrl(user.apiBaseUrl || apiBaseUrl) || {}).protocol || user.apiProtocol || 'openai',
      apiAuthType: user.apiAuthType || 'bearer',
      modelsEndpoint: user.modelsEndpoint !== false,
      model: user.modelExplicit ? (user.model || '') : (user.model !== defaultModel ? (user.model || '') : ''),
      apiKey: user.apiKey || '',
      settings: user.settings || {},
      activeChatId: user.activeChatId || null,
      chats: user.chats || [],
      initialized: !!(user.syncInitialized || user.apiKey || user.chats.length || Object.keys(user.settings || {}).length || user.modelExplicit || user.apiBaseUrlExplicit)
    };
  }

  function applySyncState(userId, input = {}) {
    const user = store.getUser(userId);
    let providerChanged = false;
    if (typeof input.apiBaseUrl === 'string') {
      const nextBase = normalizeApiBase(input.apiBaseUrl);
      if (!nextBase) throw new Error('Invalid API endpoint.');
      const previousBase = normalizeApiBase(user.apiBaseUrl || apiBaseUrl);
      if (previousBase !== nextBase) { user.apiKey = ''; providerChanged = true; }
      user.apiBaseUrl = nextBase;
      user.apiProviderId = findProviderByUrl(nextBase)?.id || input.apiProviderId || 'custom';
      user.apiBaseUrlExplicit = true;
    }
    if (input.apiProtocol === 'openai' || input.apiProtocol === 'anthropic' || input.apiProtocol === 'responses') {
      user.apiProtocol = input.apiProtocol;
    }
    if (['bearer', 'key', 'api-key', 'x-api-key'].includes(input.apiAuthType)) {
      if (user.apiAuthType !== input.apiAuthType) { user.apiKey = ''; providerChanged = true; }
      user.apiAuthType = input.apiAuthType;
    }
    if (typeof input.modelsEndpoint === 'boolean') user.modelsEndpoint = input.modelsEndpoint;
    if (typeof input.model === 'string' && input.model.length <= 256 && !/\s/.test(input.model)) {
      if (input.model.trim()) {
        user.model = input.model.trim();
        user.modelExplicit = true;
      } else if (providerChanged) {
        user.model = '';
        user.modelExplicit = true;
        for (const chat of user.chats) {
          if (chat && typeof chat === 'object') chat.model = '';
        }
      }
    }
    if (input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)) {
      const source = input.settings;
      const next = Object.assign({}, user.settings || {});
      if (typeof source.systemPrompt === 'string') next.systemPrompt = source.systemPrompt.slice(0, 20_000);
      if (source.temperature === '' || source.temperature === null) next.temperature = null;
      else if (source.temperature !== undefined && Number.isFinite(Number(source.temperature))) next.temperature = Math.max(0, Math.min(2, Number(source.temperature)));
      if (typeof source.reasoning === 'string' && ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(source.reasoning)) next.reasoning = source.reasoning;
      if (source.balBase === null || source.balBase === '') next.balBase = null;
      else if (source.balBase !== undefined && Number.isFinite(Number(source.balBase))) next.balBase = Math.max(-1_000_000, Math.min(1_000_000, Number(source.balBase)));
      if (source.balUsage !== undefined && Number.isFinite(Number(source.balUsage))) next.balUsage = Math.max(0, Math.min(1_000_000, Number(source.balUsage)));
      if (source.minBal !== undefined && Number.isFinite(Number(source.minBal))) next.minBal = Math.max(0, Math.min(10_000, Number(source.minBal)));
      if (source.maxTokens !== undefined && Number.isFinite(Number(source.maxTokens))) next.maxTokens = Math.max(1, Math.min(32_000, Math.round(Number(source.maxTokens))));
      ['internetSearch', 'sandbox', 'sandboxInternet', 'multiAgent', 'autoMemory', 'askCode', 'balanceCheck'].forEach((key) => {
        if (typeof source[key] === 'boolean') next[key] = source[key];
      });
      if (source.agentCount !== undefined && Number.isFinite(Number(source.agentCount))) next.agentCount = Math.max(1, Math.min(20, Math.round(Number(source.agentCount))));
      if (source.sandboxTimeout !== undefined && Number.isFinite(Number(source.sandboxTimeout))) next.sandboxTimeout = Math.max(1, Math.min(3600, Math.round(Number(source.sandboxTimeout))));
      if (source.requestTimeoutSeconds !== undefined && Number.isFinite(Number(source.requestTimeoutSeconds))) next.requestTimeoutSeconds = Math.max(10, Math.min(7200, Math.round(Number(source.requestTimeoutSeconds))));
      if (source.sumAt !== undefined && Number.isFinite(Number(source.sumAt))) next.sumAt = Math.max(2_000, Math.min(2_000_000, Math.round(Number(source.sumAt))));
      if (source.keep !== undefined && Number.isFinite(Number(source.keep))) next.keep = Math.max(2, Math.min(100, Math.round(Number(source.keep))));
      if (source.pinCap !== undefined && Number.isFinite(Number(source.pinCap))) next.pinCap = Math.max(300, Math.min(100_000, Math.round(Number(source.pinCap))));
      user.settings = next;
    }
    if (Array.isArray(input.chats)) {
      const byId = new Map(user.chats.map((chat) => [String(chat.id), chat]));
      for (const raw of input.chats.slice(0, MAX_CHATS_PER_USER)) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 128) continue;
        const id = raw.id;
        const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim().slice(0, 100) : 'Чат';
        const model = providerChanged ? (user.model || '') :
          (typeof raw.model === 'string' && raw.model.length <= 256 && !/\s/.test(raw.model) ? raw.model : user.model);
        const createdAt = Math.max(0, Math.min(Date.now(), Number(raw.createdAt) || Date.now()));
        const updatedAt = Math.max(createdAt, Math.min(Date.now() + 60_000, Number(raw.updatedAt) || createdAt));
        const incomingMessages = Array.isArray(raw.messages) ? raw.messages.slice(-200) : [];
        const existing = byId.get(id) || { id, title, model, createdAt, updatedAt, messages: [] };
        const messages = new Map();
        for (const item of (existing.messages || [])) {
          if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') continue;
          const key = typeof item.id === 'string' && item.id ? item.id : 'legacy_' + id + '_' + messages.size;
          messages.set(key, { id: key, role: item.role, content: item.content.slice(0, MAX_MESSAGE_LENGTH), createdAt: Number(item.createdAt) || createdAt });
        }
        for (const item of incomingMessages) {
          if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') continue;
          const messageId = typeof item.id === 'string' && item.id.length <= 160 ? item.id : '';
          if (!messageId) continue;
          messages.set(messageId, { id: messageId, role: item.role, content: item.content.slice(0, MAX_MESSAGE_LENGTH), createdAt: Math.max(0, Math.min(Date.now() + 60_000, Number(item.createdAt) || updatedAt)) });
        }
        const incomingIsNewer = updatedAt >= (Number(existing.updatedAt) || 0);
        if (incomingIsNewer) {
          existing.title = title || existing.title;
          existing.model = model || existing.model;
        }
        existing.createdAt = Math.min(existing.createdAt || createdAt, createdAt);
        existing.updatedAt = Math.max(Number(existing.updatedAt) || 0, updatedAt);
        existing.messages = [...messages.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-200);
        byId.set(id, existing);
      }
      user.chats = [...byId.values()].sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)).slice(0, MAX_CHATS_PER_USER);
    }
    if (typeof input.activeChatId === 'string' && user.chats.some((chat) => chat.id === input.activeChatId)) {
      user.activeChatId = input.activeChatId;
    }
    user.apiProviderId = findProviderByUrl(user.apiBaseUrl || apiBaseUrl)?.id || user.apiProviderId || 'custom';
    user.syncInitialized = true;
    store.save();
    return getSyncState(userId);
  }

  async function setApiKey(userId, apiKey, endpoint, apiAuthType, apiProtocol, modelsEndpoint) {
    const user = store.getUser(userId);
    const providerBase = normalizeApiBase(endpoint || user.apiBaseUrl || apiBaseUrl);
    if (!providerBase || typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 2_048 || /\s/.test(apiKey)) {
      throw new Error('Invalid API key or endpoint.');
    }
    const candidate = {
      ...user,
      apiAuthType: ['bearer', 'key', 'api-key', 'x-api-key'].includes(apiAuthType) ? apiAuthType : user.apiAuthType,
      apiProtocol: ['anthropic', 'openai', 'responses'].includes(apiProtocol) ? apiProtocol : user.apiProtocol,
      modelsEndpoint: typeof modelsEndpoint === 'boolean' ? modelsEndpoint : user.modelsEndpoint
    };
    user.apiBaseUrl = providerBase;
    user.apiProviderId = findProviderByUrl(providerBase)?.id || 'custom';
    user.apiBaseUrlExplicit = true;
    user.apiAuthType = candidate.apiAuthType;
    user.apiProtocol = candidate.apiProtocol;
    user.modelsEndpoint = candidate.modelsEndpoint;
    user.apiKey = apiKey;
    store.save();
    return true;
  }

  function clearApiKey(userId) {
    const user = store.getUser(userId);
    user.apiKey = '';
    store.save();
    return true;
  }

  return {
    handleMessage,
    handleCallbackQuery,
    getSyncState,
    applySyncState,
    setApiKey,
    clearApiKey,
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
