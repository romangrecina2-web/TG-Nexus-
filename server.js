'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const botChat = require('./bot-chat');\nlet botStorageReady = Promise.resolve(false);

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://romangrecina2-web.github.io/TG-test-/';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = Number(process.env.PORT || 10000);

const MAX_TELEGRAM_FILE_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = MAX_TELEGRAM_FILE_BYTES + 2 * 1024 * 1024;
const MAX_INIT_DATA_BYTES = 16 * 1024;
const MAX_INIT_DATA_AGE_SECONDS = 60 * 60;

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
  throw new Error('WEBHOOK_SECRET must be 32-256 URL-safe characters.');
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

async function telegramApi(method, payload) {
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.description || ('Telegram API error: HTTP ' + response.status));
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

  const text = 'На данный момент бот находится в разработке. Нажмите на мини-приложение, чтобы начать пользоваться.';
  await telegramApi('sendMessage', {
    chat_id: message.chat.id,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: 'Открыть мини-приложение', web_app: { url: WEB_APP_URL } }
      ]]
    }
  });
}

async function handleWebhook(req, res) {
  if (!safeEqualText(req.headers['x-telegram-bot-api-secret-token'], WEBHOOK_SECRET)) {
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

  try {
    const message = update && update.message;
    const text = message && typeof message.text === 'string' ? message.text.trim() : '';
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await handleStart(message);
    } else if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text) &&
               message.chat && message.chat.type === 'private') {
      await telegramApi('sendMessage', {
        chat_id: message.chat.id,
        text: 'Откройте мини-приложение кнопкой внизу чата или кнопкой «Открыть мини-приложение».'
      });
    } else {
      await botChat.handleUpdate(update);
    }
  } catch (error) {
    // Do not log request bodies, Telegram initData, or user file contents.
    console.error('Webhook processing failed.');
  }

  return json(res, 200, { ok: true });
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

async function handleBotSettings(req, res) {
  if (!/^application\\/json(?:\\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return json(res, 415, { ok: false, error: 'Ожидается Content-Type: application/json.' });
  }
  let payload;
  try { payload = parseJson(await readBody(req, 12 * 1024)); }
  catch (error) { return json(res, error.status || 400, { ok: false, error: error.message }); }
  const auth = validateTelegramInitData(payload && payload.initData);
  if (!auth) return json(res, 401, { ok: false, error: 'Не удалось подтвердить сессию Telegram.' });
  try {
    await botChat.saveSettings(auth.id, payload.apiBase, payload.apiKey, payload.model);
    return json(res, 200, { ok: true });
  } catch (error) {
    const status = /DATABASE_URL|DATA_ENCRYPTION_KEY|PostgreSQL/.test(error.message) ? 503 : 400;
    return json(res, status, { ok: false, error: status === 503
      ? 'Хранилище бота не настроено на сервере.' : error.message });
  }
}

async function configureWebhook() {
  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
  if (!BOT_TOKEN || !baseUrl) {
    console.log('Webhook not configured: BOT_TOKEN or public service URL is missing.');
    return;
  }

  let parsedBase;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    console.error('Webhook not configured: invalid public service URL.');
    return;
  }
  if (parsedBase.protocol !== 'https:') {
    console.error('Webhook not configured: public service URL must use HTTPS.');
    return;
  }

  const webhookUrl = new URL('/telegram/webhook', parsedBase).toString();
  try {
    await telegramApi('setWebhook', {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message']
    });
    console.log('Telegram webhook configured.');
  } catch {
    console.error('Could not configure Telegram webhook.');
  }
}

function createServer() {
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

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'telegram-bot-api' });
      }
      if (req.method === 'POST' && url.pathname === '/telegram/webhook') {
        return handleWebhook(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/api/send-code') {
        return handleSendCode(req, res);
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
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Bot API listening on port ' + PORT);
    configureWebhook().catch(() => console.error('Webhook setup failed.'));
  });
}

module.exports = {
  MAX_INIT_DATA_AGE_SECONDS,
  createRateLimiter,
  createServer,
  safeFileName,
  validateTelegramInitData
};
