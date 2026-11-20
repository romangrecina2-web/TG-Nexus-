'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const { createBotChat, BOT_COMMANDS } = require('./bot-chat');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://romangrecina2-web.github.io/TG-test-/';
const configuredWebhookSecret = String(process.env.WEBHOOK_SECRET || '');
if (configuredWebhookSecret && Buffer.byteLength(configuredWebhookSecret, 'utf8') < 32) {
  throw new Error('WEBHOOK_SECRET must contain at least 32 bytes.');
}
// Render-generated secrets may be Base64; hash them into Telegram's URL-safe secret-token alphabet.
const WEBHOOK_SECRET = configuredWebhookSecret
  ? (/^[A-Za-z0-9_-]{32,256}$/.test(configuredWebhookSecret)
    ? configuredWebhookSecret
    : crypto.createHash('sha256').update(configuredWebhookSecret).digest('hex'))
  : crypto.randomBytes(32).toString('hex');
const PORT = Number(process.env.PORT || 10000);

const botChat = createBotChat({
  botToken: BOT_TOKEN,
  apiBaseUrl: process.env.AI_API_BASE_URL,
  defaultModel: process.env.AI_DEFAULT_MODEL,
  encryptionKey: process.env.BOT_DATA_ENCRYPTION_KEY,
  dataDir: process.env.DATA_DIR,
  webAppUrl: WEB_APP_URL
});

const MAX_TELEGRAM_FILE_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = MAX_TELEGRAM_FILE_BYTES + 2 * 1024 * 1024;
const MAX_INIT_DATA_BYTES = 16 * 1024;
const MAX_INIT_DATA_AGE_SECONDS = 60 * 60;

const webhookDiagnostics = {
  configured: false,
  pendingUpdates: null,
  lastTelegramErrorAt: null,
  updatesReceived: 0,
  updatesProcessed: 0,
  processingFailures: 0,
  rejectedRequests: 0,
  lastReceivedAt: null,
  lastProcessedAt: null,
  lastFailureAt: null,
  lastFailureCode: null
};

const webAppUrl = new URL(WEB_APP_URL);
if (webAppUrl.protocol !== 'https:') {
  throw new Error('WEB_APP_URL must use HTTPS.');
}
const webAppOrigin = webAppUrl.origin;

function parseAllowedOrigins(value) {
  return new Set(String(value || webAppOrigin).split(',').map((entry) => {
    const raw = entry.trim();
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.origin !== raw) {
      throw new Error('ALLOWED_ORIGINS must contain exact HTTPS origins without paths or wildcards.');
    }
    return parsed.origin;
  }));
}

const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

if (WEBHOOK_SECRET.length < 32 || WEBHOOK_SECRET.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(WEBHOOK_SECRET)) {
  throw new Error('Normalized WEBHOOK_SECRET must be 32-256 URL-safe characters.');
}

function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cache-control', 'no-store');
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  applySecurityHeaders(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) return false;

  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type');
  res.setHeader('access-control-max-age', '600');
  return true;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = req.headers['content-length'];
    if (declaredLength !== undefined && Number(declaredLength) > maxBytes) {
      const error = new Error('Запрос слишком большой.');
      error.status = 413;
      req.resume();
      reject(error);
      return;
    }

    let size = 0;
    let tooLarge = false;
    let settled = false;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      reject(new Error('Клиент прервал отправку запроса.'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        const error = new Error('Запрос слишком большой.');
        error.status = 413;
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Некорректный JSON.');
    error.status = 400;
    throw error;
  }
}

function validateTelegramInitData(initData, botToken = BOT_TOKEN, nowMs = Date.now()) {
  if (!botToken || typeof initData !== 'string' || !initData ||
      Buffer.byteLength(initData, 'utf8') > MAX_INIT_DATA_BYTES) return null;

  const params = new URLSearchParams(initData);
  const entries = [...params.entries()];
  const seen = new Set();
  for (const [key] of entries) {
    if (seen.has(key)) return null;
    seen.add(key);
  }

  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  if (!Number.isSafeInteger(authDate)) return null;

  const now = Math.floor(nowMs / 1000);
  if (authDate > now + 30 || now - authDate > MAX_INIT_DATA_AGE_SECONDS) return null;

  const dataCheckString = entries
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => key + '=' + value)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const actualHash = Buffer.from(receivedHash, 'hex');

  if (actualHash.length !== expectedHash.length ||
      !crypto.timingSafeEqual(actualHash, expectedHash)) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || '');
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0 || user.is_bot) {
    return null;
  }

  return { id: Number(user.id) };
}

function createRateLimiter(options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const globalLimit = Number.isInteger(options.globalLimit) ? options.globalLimit : 300;
  const windowMs = Number.isInteger(options.windowMs) ? options.windowMs : 60_000;
  const maxUsers = Number.isInteger(options.maxUsers) ? options.maxUsers : 10_000;
  const clock = typeof options.now === 'function' ? options.now : Date.now;

  const users = new Map();
  let globalStartedAt = clock();
  let globalCount = 0;
  let lastSweepAt = globalStartedAt;

  return function checkRateLimit(userId) {
    const now = clock();

    if (now - globalStartedAt >= windowMs) {
      globalStartedAt = now;
      globalCount = 0;
    }
    if (globalCount >= globalLimit) return false;

    if (now - lastSweepAt >= windowMs) {
      for (const [id, bucket] of users) {
        if (now - bucket.lastSeen > windowMs * 3) users.delete(id);
      }
      lastSweepAt = now;
    }

    const id = String(userId);
    let bucket = users.get(id);

    if (!bucket) {
      if (users.size >= maxUsers) return false;
      bucket = { startedAt: now, count: 0, lastSeen: now };
    } else if (now - bucket.startedAt >= windowMs) {
      bucket.startedAt = now;
      bucket.count = 0;
    }

    if (bucket.count >= limit) return false;

    bucket.count += 1;
    bucket.lastSeen = now;
    users.set(id, bucket);
    globalCount += 1;
    return true;
  };
}

const checkRateLimit = createRateLimiter();
const checkSyncRateLimit = createRateLimiter({ limit: 120, globalLimit: 1_000 });

function safeFileName(value) {
  let name = String(value || 'code.txt').split(/[\\/]/).pop();
  name = name.replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 120);
  if (!name || name === '.' || name === '..') name = 'code.txt';
  return name;
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isRetryableWebhookError(error) {
  const code = Number(error && (error.telegramErrorCode || error.status));
  if (!Number.isInteger(code) || code <= 0) return true;
  return code === 408 || code === 425 || code === 429 || code >= 500;
}

async function telegramApi(method, payload) {
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    const error = new Error(result.description || ('Telegram API error: HTTP ' + response.status));
    error.telegramErrorCode = Number(result.error_code) || response.status;
    error.retryAfterSeconds = Number(result.parameters && result.parameters.retry_after) || 0;
    throw error;
  }
  return result.result;
}

async function sendCodeToBot(userId, fileName, code) {
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_TELEGRAM_FILE_BYTES) {
    const error = new Error('Telegram Bot API принимает документы размером до 50 МБ. Этот файл больше.');
    error.status = 413;
    throw error;
  }
  if (!bytes) {
    const error = new Error('Нельзя отправить пустой файл.');
    error.status = 400;
    throw error;
  }

  const form = new FormData();
  form.set('chat_id', String(userId));
  form.set('caption', 'Файл с кодом из мини-приложения: ' + fileName);
  form.set(
    'document',
    new Blob([code], { type: 'text/plain; charset=utf-8' }),
    fileName
  );

  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendDocument', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.description || ('Не удалось отправить файл: HTTP ' + response.status));
  }
  return { messageId: result.result.message_id, bytes };
}

async function handleStart(message) {
  if (!message || !message.chat || message.chat.type !== 'private' ||
      !message.from || message.chat.id !== message.from.id) return;
  const text = 'Привет! Можно общаться с ИИ прямо в этом чате или открыть мини-приложение кнопкой ниже.';
  await botChat.sendMessage(message.chat.id, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Открыть мини-приложение', web_app: { url: WEB_APP_URL } }
      ]]
    }
  });
}

async function processTelegramUpdate(update, targetBot = botChat) {
  const callbackQuery = update && update.callback_query;
  if (callbackQuery) {
    if (targetBot && typeof targetBot.handleCallbackQuery === 'function') {
      await targetBot.handleCallbackQuery(callbackQuery);
    }
    return;
  }
  const message = update && update.message;
  if (!message) return;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    await handleStart(message);
    return;
  }
  if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text) &&
      message.chat && message.chat.type === 'private') {
    await targetBot.sendMessage(message.chat.id,
      'Пишите сообщение прямо сюда, чтобы общаться с ИИ. Команды и управление чатами: /info. Мини-приложение открывается кнопкой ниже.');
    return;
  }
  await targetBot.handleMessage(message);
}

async function handleWebhook(req, res, dependencies = {}) {
  const webhookSecret = dependencies.webhookSecret || WEBHOOK_SECRET;
  const textBot = dependencies.botChat || botChat;
  if (!safeEqualText(req.headers['x-telegram-bot-api-secret-token'], webhookSecret)) {
    webhookDiagnostics.rejectedRequests += 1;
    return json(res, 403, { ok: false });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return json(res, 415, { ok: false });
  }

  let update;
  try {
    update = parseJson(await readBody(req, 1024 * 1024));
  } catch (error) {
    return json(res, error.status || 400, { ok: false });
  }

  webhookDiagnostics.updatesReceived += 1;
  webhookDiagnostics.lastReceivedAt = new Date().toISOString();
  try {
    if (!textBot || typeof textBot.enqueueUpdate !== 'function') {
      const error = new Error('Telegram update queue is unavailable.');
      error.status = 503;
      throw error;
    }
    const result = await textBot.enqueueUpdate(update);
    webhookDiagnostics.updatesProcessed += 1;
    webhookDiagnostics.lastProcessedAt = new Date().toISOString();
    return json(res, 200, {
      ok: true,
      queued: Boolean(result && result.accepted),
      duplicate: Boolean(result && result.duplicate)
    });
  } catch (error) {
    // Never log message text, chat/user IDs, API keys, webhook secrets, or request bodies.
    const code = Number(error && (error.telegramErrorCode || error.status)) || null;
    webhookDiagnostics.processingFailures += 1;
    webhookDiagnostics.lastFailureAt = new Date().toISOString();
    webhookDiagnostics.lastFailureCode = code;
    const updateId = update && Number.isSafeInteger(update.update_id) ? update.update_id : null;
    const errorName = error && typeof error.name === 'string' ? error.name : 'Error';
    console.error('Webhook enqueue failed.', { updateId, errorName, telegramErrorCode: code });
    const retryable = isRetryableWebhookError(error);
    return json(res, retryable ? 503 : 200, { ok: false, retryable });
  }
}
async function handleSync(req, res, bot = botChat) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return json(res, 415, { ok: false, error: 'Ожидается Content-Type: application/json.' });
  }

  let payload;
  try {
    payload = parseJson(await readBody(req, 4 * 1024 * 1024));
  } catch (error) {
    return json(res, error.status || 400, { ok: false, error: error.status === 413 ? 'Данные синхронизации слишком большие.' : 'Некорректный JSON.' });
  }

  const auth = validateTelegramInitData(payload && payload.initData);
  if (!auth) {
    return json(res, 401, { ok: false, error: 'Не удалось подтвердить сессию Telegram. Перезапустите Mini App из чата с ботом.' });
  }
  if (!checkSyncRateLimit(auth.id)) {
    return json(res, 429, { ok: false, error: 'Слишком часто выполняется синхронизация. Подождите минуту.' });
  }
  if (!bot || !bot.store || !bot.store.enabled ||
      typeof bot.getSyncState !== 'function' || typeof bot.applySyncState !== 'function') {
    return json(res, 503, { ok: false, error: 'Защищённое хранилище синхронизации пока недоступно.' });
  }

  try {
    if (payload.action === 'pull') {
      const state = bot.getSyncState(auth.id);
      return json(res, 200, { ok: true, state });
    }

    if (payload.action !== 'push' || !payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) {
      return json(res, 400, { ok: false, error: 'Неизвестное действие синхронизации.' });
    }

    const state = payload.state;
    const before = bot.getSyncState(auth.id);
    const allowed = {
      apiBaseUrl: state.apiBaseUrl,
      model: state.model,
      settings: state.settings,
      chats: state.chats,
      activeChatId: state.activeChatId
    };
    bot.applySyncState(auth.id, allowed);
    const afterApply = bot.getSyncState(auth.id);

    if (state.clearApiKey === true) {
      bot.clearApiKey(auth.id);
    } else if (typeof state.apiKey === 'string' && state.apiKey.trim() &&
               state.apiKey !== afterApply.apiKey) {
      const providerBase = typeof state.apiBaseUrl === 'string' ? state.apiBaseUrl : before.apiBaseUrl;
      const saved = await bot.setApiKey(auth.id, state.apiKey, providerBase);
      if (!saved) return json(res, 400, { ok: false, error: 'API-ключ не прошёл проверку провайдера.' });
    }

    const updated = bot.getSyncState(auth.id);
    return json(res, 200, { ok: true, state: updated });
  } catch (error) {
    const message = String(error && error.message || '');
    const status = /validation failed|Invalid API endpoint|Invalid API key/i.test(message) ? 400 : 500;
    return json(res, status, {
      ok: false,
      error: status === 400 ? 'Проверьте адрес API и ключ провайдера.' : 'Не удалось сохранить настройки синхронизации.'
    });
  }
}

async function handleSendCode(req, res) {
  if (!BOT_TOKEN) return json(res, 503, { ok: false, error: 'На сервере не настроен BOT_TOKEN.' });

  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return json(res, 415, { ok: false, error: 'Ожидается Content-Type: application/json.' });
  }

  let payload;
  try {
    payload = parseJson(await readBody(req, MAX_JSON_BYTES));
  } catch (error) {
    return json(res, error.status || 400, { ok: false, error: error.message });
  }

  const auth = validateTelegramInitData(payload && payload.initData);
  if (!auth) {
    return json(res, 401, {
      ok: false,
      error: 'Не удалось подтвердить сессию Telegram. Закройте и заново откройте мини-приложение из чата с ботом.'
    });
  }
  if (!checkRateLimit(auth.id)) {
    return json(res, 429, { ok: false, error: 'Слишком много отправок. Попробуйте позже.' });
  }
  if (!payload || typeof payload.code !== 'string') {
    return json(res, 400, { ok: false, error: 'В запросе отсутствует содержимое файла.' });
  }
  if (Buffer.byteLength(payload.code, 'utf8') > MAX_TELEGRAM_FILE_BYTES) {
    return json(res, 413, { ok: false, error: 'Файл превышает лимит 50 МБ.' });
  }

  const fileName = safeFileName(payload.fileName);
  try {
    const result = await sendCodeToBot(auth.id, fileName, payload.code);
    return json(res, 200, {
      ok: true,
      fileName,
      size: result.bytes,
      messageId: result.messageId
    });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    return json(res, status, {
      ok: false,
      error: status === 413 || status === 400
        ? error.message
        : 'Telegram не смог принять файл. Повторите попытку позже.'
    });
  }
}

async function configureWebhook() {
  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
  if (!BOT_TOKEN || !baseUrl) {
    webhookDiagnostics.configured = false;
    console.log('Webhook not configured: BOT_TOKEN or public service URL is missing.');
    return false;
  }

  let parsedBase;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    webhookDiagnostics.configured = false;
    console.error('Webhook not configured: invalid public service URL.');
    return false;
  }
  if (parsedBase.protocol !== 'https:') {
    webhookDiagnostics.configured = false;
    console.error('Webhook not configured: public service URL must use HTTPS.');
    return false;
  }

  const webhookUrl = new URL('/telegram/webhook', parsedBase).toString();
  try {
    await telegramApi('setWebhook', {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query']
    });
    webhookDiagnostics.configured = true;

    try {
      const info = await telegramApi('getWebhookInfo', {});
      webhookDiagnostics.configured = info.url === webhookUrl;
      webhookDiagnostics.pendingUpdates = Number.isSafeInteger(info.pending_update_count)
        ? info.pending_update_count
        : null;
      webhookDiagnostics.lastTelegramErrorAt = Number.isSafeInteger(info.last_error_date)
        ? new Date(info.last_error_date * 1000).toISOString()
        : null;
      if (info.last_error_date) {
        console.warn('Telegram reports a previous webhook delivery error.', {
          lastTelegramErrorAt: webhookDiagnostics.lastTelegramErrorAt
        });
      }
    } catch {
      // setWebhook succeeded; diagnostics must not turn a successful setup into a false failure.
    }

    try {
      await telegramApi('setMyCommands', { commands: BOT_COMMANDS });
    } catch {
      console.error('Could not register Telegram bot commands.');
    }
    console.log('Telegram webhook configured.');
    return webhookDiagnostics.configured;
  } catch (error) {
    webhookDiagnostics.configured = false;
    console.error('Could not configure Telegram webhook.', {
      errorName: error && error.name ? error.name : 'Error',
      telegramErrorCode: Number(error && error.telegramErrorCode) || null
    });
    return false;
  }
}

function scheduleWebhookMaintenance(attempt = 0) {
  const delay = attempt === 0 ? 5_000 : Math.min(5 * 60_000, 5_000 * (2 ** Math.min(attempt, 6)));
  const timer = setTimeout(async () => {
    const ok = await configureWebhook();
    scheduleWebhookMaintenance(ok ? 5 : attempt + 1);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

function createServer(options = {}) {
  const webhookDependencies = options.webhookDependencies || {};
  const server = http.createServer((req, res) => {
    Promise.resolve().then(async () => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname.startsWith('/api/')) {
        const corsOk = applyCors(req, res);
        if (!corsOk) return json(res, 403, { ok: false, error: 'Origin is not allowed.' });
        if (req.method === 'OPTIONS') {
          applySecurityHeaders(res);
          res.writeHead(204);
          return res.end();
        }
      }

      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/health/ready')) {
        const bot = options.botChat || botChat;
        let queue = null;
        let storageReady = Boolean(bot.store && bot.store.enabled);
        if (storageReady && typeof bot.getWorkerStats === 'function') {
          try { queue = bot.getWorkerStats(); } catch { storageReady = false; }
        }
        const configuration = {
          botTokenConfigured: Boolean(BOT_TOKEN),
          encryptedStorageConfigured: Boolean(bot.store && bot.store.enabled),
          providerEndpointConfigured: Boolean(bot.apiBaseUrl)
        };
        const ready = configuration.botTokenConfigured && configuration.encryptedStorageConfigured &&
          storageReady && webhookDiagnostics.configured && Boolean(queue && queue.running);
        const diagnostics = {
          ok: true,
          ready,
          service: 'telegram-bot-api',
          uptimeSeconds: Math.floor(process.uptime()),
          configuration,
          queue,
          telegramWebhook: { ...webhookDiagnostics }
        };
        if (url.pathname === '/health/ready' && !ready) {
          return json(res, 503, { ...diagnostics, ok: false });
        }
        return json(res, 200, diagnostics);
      }
      if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
        return handleWebhook(req, res, webhookDependencies);
      }
      if (req.method === 'POST' && url.pathname === '/api/send-code') {
        return handleSendCode(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        return handleSync(req, res, options.botChat || botChat);
      }
      return json(res, 404, { ok: false, error: 'Not found.' });
    }).catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal server error.' });
      else res.destroy();
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

if (require.main === module) {
  const server = createServer();
  let shuttingDown = false;
  botChat.startUpdateWorker(processTelegramUpdate, {
    concurrency: Number(process.env.UPDATE_WORKER_CONCURRENCY) || 3,
    maxAttempts: Number(process.env.UPDATE_MAX_ATTEMPTS) || 8
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Bot API listening on port ' + PORT);
    configureWebhook().then((ok) => scheduleWebhookMaintenance(ok ? 5 : 0))
      .catch(() => scheduleWebhookMaintenance(0));
  });
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Graceful shutdown started.', { signal });
    server.close();
    const drained = await botChat.stopUpdateWorker({ timeoutMs: 20_000 });
    if (!drained) {
      console.warn('Shutdown deadline reached; unfinished updates will be recovered on next start.');
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 500).unref();
    } else {
      console.log('Graceful shutdown complete.');
    }
  }
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

module.exports = {
  MAX_INIT_DATA_AGE_SECONDS,
  createRateLimiter,
  createServer,
  isRetryableWebhookError,
  processTelegramUpdate,
  safeFileName,
  validateTelegramInitData
};
