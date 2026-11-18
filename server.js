'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://romangrecina2-web.github.io/TG-test-/';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = Number(process.env.PORT || 10000);
const MAX_TELEGRAM_FILE_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = MAX_TELEGRAM_FILE_BYTES + 1024 * 1024;
const RATE_LIMIT = new Map();

const webAppOrigin = new URL(WEB_APP_URL).origin;
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || webAppOrigin).split(',').map((x) => x.trim()).filter(Boolean)
);

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'Content-Type');
    res.setHeader('access-control-max-age', '600');
    return true;
  }
  return !origin;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
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
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('Запрос слишком большой.');
        error.status = 413;
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', reject);
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

function validateTelegramInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  if (!Number.isFinite(authDate)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 30 || now - authDate > 24 * 60 * 60) return null;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
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
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0 || user.is_bot) return null;

  return { id: Number(user.id) };
}

async function telegramApi(method, payload) {
  const response = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.description || ('Telegram API error: HTTP ' + response.status));
  }
  return result.result;
}

function safeFileName(value) {
  let name = String(value || 'code.txt').split(/[\\/]/).pop();
  name = name.replace(/[^\p{L}\p{N}._ -]/gu, '_').trim().slice(0, 120);
  if (!name || name === '.' || name === '..') name = 'code.txt';
  return name;
}

function checkRateLimit(userId) {
  const now = Date.now();
  const previous = (RATE_LIMIT.get(userId) || []).filter((time) => now - time < 60_000);
  if (previous.length >= 20) return false;
  previous.push(now);
  RATE_LIMIT.set(userId, previous);
  return true;
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
    body: form
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.description || ('Не удалось отправить файл: HTTP ' + response.status));
  }
  return { messageId: result.result.message_id, bytes };
}

async function handleStart(message) {
  const chatId = message.chat && message.chat.id;
  if (!chatId) return;

  const text = 'На данный момент бот находится в разработке. Нажмите на мини-приложение, чтобы начать пользоваться.';
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: 'Открыть мини-приложение', web_app: { url: WEB_APP_URL } }
      ]]
    }
  });
}

async function handleWebhook(req, res) {
  if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) {
    return json(res, 403, { ok: false });
  }

  let update;
  try {
    update = parseJson(await readBody(req, 1024 * 1024));
  } catch (error) {
    return json(res, error.status || 400, { ok: false });
  }

  try {
    const message = update.message;
    const text = message && typeof message.text === 'string' ? message.text.trim() : '';
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await handleStart(message);
    } else if (/^\/help(?:@\w+)?(?:\s|$)/i.test(text)) {
      await telegramApi('sendMessage', {
        chat_id: message.chat.id,
        text: 'Откройте мини-приложение кнопкой внизу чата или кнопкой «Открыть мини-приложение».'
      });
    }
  } catch (error) {
    // Do not include message contents or user data in logs.
    console.error('Webhook processing error:', error.message);
  }

  return json(res, 200, { ok: true });
}

async function handleSendCode(req, res) {
  if (!BOT_TOKEN) return json(res, 503, { ok: false, error: 'На сервере не настроен BOT_TOKEN.' });

  let payload;
  try {
    payload = parseJson(await readBody(req, MAX_JSON_BYTES));
  } catch (error) {
    return json(res, error.status || 400, { ok: false, error: error.message });
  }

  const auth = validateTelegramInitData(payload.initData);
  if (!auth) return json(res, 401, { ok: false, error: 'Не удалось подтвердить сессию Telegram. Закройте и заново откройте мини-приложение из чата с ботом.' });
  if (!checkRateLimit(auth.id)) {
    return json(res, 429, { ok: false, error: 'Слишком много отправок подряд. Попробуйте через минуту.' });
  }
  if (typeof payload.code !== 'string') return json(res, 400, { ok: false, error: 'В запросе отсутствует содержимое файла.' });

  const fileName = safeFileName(payload.fileName);
  try {
    const result = await sendCodeToBot(auth.id, fileName, payload.code);
    return json(res, 200, { ok: true, fileName, size: result.bytes, messageId: result.messageId });
  } catch (error) {
    return json(res, error.status || 502, { ok: false, error: error.message || 'Ошибка Telegram Bot API.' });
  }
}

async function configureWebhook() {
  const baseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
  if (!BOT_TOKEN || !baseUrl) {
    console.log('Webhook not configured: set BOT_TOKEN and deploy with PUBLIC_BASE_URL/RENDER_EXTERNAL_URL.');
    return;
  }
  const webhookUrl = new URL('/telegram/webhook', baseUrl).toString();
  try {
    await telegramApi('setWebhook', {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message']
    });
    console.log('Telegram webhook configured.');
  } catch (error) {
    console.error('Could not configure Telegram webhook:', error.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const corsOk = applyCors(req, res);
    if (!corsOk) return json(res, 403, { ok: false, error: 'Origin is not allowed.' });
    if (req.method === 'OPTIONS') {
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
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Bot API listening on port ' + PORT);
  configureWebhook().catch((error) => console.error('Webhook setup failed:', error.message));
});
