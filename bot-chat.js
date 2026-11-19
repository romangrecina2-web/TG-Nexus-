'use strict';

// Persistent Telegram AI chat storage. Requires DATABASE_URL and DATA_ENCRYPTION_KEY.
// API keys are encrypted at rest with AES-256-GCM. Never log credentials or message bodies.

const crypto = require('node:crypto');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    })
  : null;

function encryptionKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new Error('DATA_ENCRYPTION_KEY must be a 32-byte hexadecimal key.');
  }
  return Buffer.from(raw, 'hex');
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

function decrypt(value) {
  const [iv, tag, data] = String(value || '').split('.');
  if (!iv || !tag || !data) throw new Error('Invalid encrypted value.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

async function init() {
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_users (
      telegram_id BIGINT PRIMARY KEY,
      api_base TEXT NOT NULL,
      api_key_enc TEXT NOT NULL,
      active_model TEXT NOT NULL,
      models JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bot_chats (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES bot_users(telegram_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sleeping','stopped')),
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS bot_chats_user_updated ON bot_chats(telegram_id, updated_at DESC);
  `);
  return true;
}

function requirePool() {
  if (!pool) throw new Error('Чат с ИИ пока не настроен: серверу нужна постоянная база PostgreSQL.');
}

async function saveSettings(userId, apiBase, apiKey, model) {
  requirePool();
  const u = new URL(apiBase);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) {
    throw new Error('API URL должен быть HTTPS без логина, пароля и параметров.');
  }
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 4096) {
    throw new Error('Некорректный API-ключ.');
  }
  if (typeof model !== 'string' || !/^[^\s]{1,200}$/.test(model)) {
    throw new Error('Некорректный ID модели.');
  }
  await pool.query(
    `INSERT INTO bot_users(telegram_id,api_base,api_key_enc,active_model,models)
     VALUES($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT(telegram_id) DO UPDATE SET api_base=EXCLUDED.api_base,
       api_key_enc=EXCLUDED.api_key_enc, active_model=EXCLUDED.active_model,
       models=(SELECT CASE WHEN bot_users.models ? EXCLUDED.active_model
         THEN bot_users.models ELSE bot_users.models || jsonb_build_array(EXCLUDED.active_model) END),
       updated_at=NOW()`,
    [String(userId), u.origin + u.pathname.replace(/\/+$/, ''), encrypt(apiKey), model, JSON.stringify([model])]
  );
}

async function getUser(userId) {
  requirePool();
  const r = await pool.query('SELECT * FROM bot_users WHERE telegram_id=$1', [String(userId)]);
  if (!r.rowCount) return null;
  return { ...r.rows[0], api_key: decrypt(r.rows[0].api_key_enc) };
}

async function getActiveChat(userId) {
  const r = await pool.query(
    `SELECT * FROM bot_chats WHERE telegram_id=$1 AND status IN ('active','sleeping')
     ORDER BY updated_at DESC LIMIT 1`, [String(userId)]
  );
  return r.rows[0] || null;
}

async function createChat(userId) {
  const previous = await getActiveChat(userId);
  if (previous) await pool.query("UPDATE bot_chats SET status='stopped' WHERE id=$1", [previous.id]);
  const r = await pool.query(
    "INSERT INTO bot_chats(telegram_id,status,messages) VALUES($1,'active','[]'::jsonb) RETURNING *",
    [String(userId)]
  );
  return r.rows[0];
}

async function sendTelegram(method, payload) {
  const token = process.env.BOT_TOKEN || '';
  if (!token) throw new Error('BOT_TOKEN is not configured.');
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram API error.');
  return result.result;
}

async function reply(chatId, text) {
  const chunks = String(text || '').match(/[\s\S]{1,3900}/g) || [''];
  for (const chunk of chunks) await sendTelegram('sendMessage', { chat_id: chatId, text: chunk });
}

async function callModel(user, messages) {
  const response = await fetch(user.api_base.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + user.api_key },
    body: JSON.stringify({ model: user.active_model, messages }),
    signal: AbortSignal.timeout(120_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || 'Ошибка API провайдера: HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  const answer = data.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('Провайдер вернул пустой ответ.');
  return answer.trim();
}

async function handleUpdate(update) {
  const message = update && update.message;
  if (!message || !message.chat || message.chat.type !== 'private' ||
      !message.from || message.chat.id !== message.from.id || typeof message.text !== 'string') return false;

  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();
  if (!text) return false;

  if (/^\/start(?:@\w+)?$/i.test(text)) {
    await reply(chatId, 'Привет! Откройте Mini App, добавьте API URL, ключ и модель в настройках, затем используйте /chat.\n\nКоманды: /chat, /new, /stop, /model_info, /model <ID>.');
    return true;
  }
  if (/^\/(chat|new)(?:@\w+)?$/i.test(text)) {
    const user = await getUser(userId);
    if (!user) {
      await reply(chatId, 'Сначала откройте Mini App и сохраните API URL, API-ключ и модель в настройках.');
      return true;
    }
    await createChat(userId);
    await reply(chatId, 'Новый диалог создан. Можете отправлять сообщения.');
    return true;
  }
  if (/^\/stop(?:@\w+)?$/i.test(text)) {
    const active = await getActiveChat(userId);
    if (active) await pool.query("UPDATE bot_chats SET status='stopped' WHERE id=$1", [active.id]);
    await reply(chatId, 'Диалог остановлен. История сохранена.');
    return true;
  }
  if (/^\/model_info(?:@\w+)?$/i.test(text)) {
    const user = await getUser(userId);
    if (!user) {
      await reply(chatId, 'Сначала настройте API в Mini App.');
      return true;
    }
    await reply(chatId, 'Сохранённые модели:\n' + (user.models || []).map((m, i) =>
      (m === user.active_model ? '✓ ' : '') + (i + 1) + '. ' + m
    ).join('\n') + '\n\nВыбор: /model <ID>');
    return true;
  }
  const modelMatch = text.match(/^\/model(?:@\w+)?(?:\s+|-)([^\s]+)$/i);
  if (modelMatch) {
    const model = modelMatch[1].trim();
    if (!/^[^\s]{1,200}$/.test(model)) {
      await reply(chatId, 'Укажите ID модели: /model provider/model');
      return true;
    }
    const user = await getUser(userId);
    if (!user) {
      await reply(chatId, 'Сначала настройте API в Mini App.');
      return true;
    }
    const models = Array.isArray(user.models) ? user.models : [];
    if (!models.includes(model)) models.push(model);
    await pool.query('UPDATE bot_users SET active_model=$2, models=$3::jsonb, updated_at=NOW() WHERE telegram_id=$1',
      [String(userId), model, JSON.stringify(models)]);
    await reply(chatId, 'Активная модель: ' + model + '.');
    return true;
  }

  const user = await getUser(userId);
  if (!user) {
    await reply(chatId, 'Сначала откройте Mini App и сохраните API URL, ключ и модель.');
    return true;
  }
  let chat = await getActiveChat(userId);
  if (!chat || chat.status === 'stopped') {
    await reply(chatId, 'Активного диалога нет. Отправьте /chat или /new.');
    return true;
  }

  const history = Array.isArray(chat.messages) ? chat.messages.slice(-30) : [];
  history.push({ role: 'user', content: text });
  try {
    const answer = await callModel(user, history);
    history.push({ role: 'assistant', content: answer });
    await pool.query("UPDATE bot_chats SET messages=$2::jsonb, status='active', updated_at=NOW() WHERE id=$1",
      [chat.id, JSON.stringify(history)]);
    await reply(chatId, answer);
    // The chat's transcript remains durable. Only its active runtime state sleeps after one minute.
    const chatIdForTimer = chat.id;
    const timer = setTimeout(() => {
      pool.query("UPDATE bot_chats SET status='sleeping' WHERE id=$1 AND status='active' AND updated_at < NOW() - INTERVAL '60 seconds'",
        [chatIdForTimer]).catch(() => {});
    }, 60_000);
    if (timer.unref) timer.unref();
  } catch (error) {
    await reply(chatId, 'Не удалось получить ответ от ИИ: ' + String(error.message || 'ошибка API').slice(0, 500));
  }
  return true;
}

module.exports = { init, handleUpdate, saveSettings, pool };
