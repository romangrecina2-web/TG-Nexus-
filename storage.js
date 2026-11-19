'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: true } : undefined,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    })
  : null;

let ready = false;

function requirePool() {
  if (!pool || !ready) {
    const error = new Error('Постоянная база данных не настроена. Добавьте DATABASE_URL в переменные окружения backend.');
    error.status = 503;
    throw error;
  }
  return pool;
}

function encryptionKey() {
  const value = String(process.env.APP_ENCRYPTION_KEY || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, 'hex');
  else {
    try { key = Buffer.from(value, 'base64'); } catch { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) {
    const error = new Error('APP_ENCRYPTION_KEY должен содержать 32 случайных байта в Base64 или 64 hex-символа.');
    error.status = 503;
    throw error;
  }
  return key;
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptSecret(value) {
  if (!value) return '';
  const parts = String(value).split('.');
  if (parts.length !== 3) throw new Error('Сохранённый секрет имеет неверный формат.');
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const data = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function initStorage() {
  if (!pool) return false;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tg_user_settings (
      user_id BIGINT PRIMARY KEY,
      api_base TEXT NOT NULL DEFAULT '',
      api_key_enc TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      github_installation_id BIGINT,
      selected_repo TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tg_user_models (
      user_id BIGINT NOT NULL,
      model TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, model)
    );
    CREATE TABLE IF NOT EXISTS tg_chat_sessions (
      session_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'sleeping', 'stopped')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tg_chat_sessions_user_activity
      ON tg_chat_sessions (user_id, last_activity DESC);
    CREATE TABLE IF NOT EXISTS tg_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES tg_chat_sessions(session_id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tg_chat_messages_session_id ON tg_chat_messages (session_id, id);
    CREATE TABLE IF NOT EXISTS tg_updates (
      update_id BIGINT PRIMARY KEY,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tg_updates_queue ON tg_updates (status, created_at);
  `);
  ready = true;
  return true;
}

async function getUserSettings(userId) {
  const db = requirePool();
  const result = await db.query(
    'SELECT user_id, api_base, api_key_enc, model, github_installation_id, selected_repo FROM tg_user_settings WHERE user_id = $1',
    [String(userId)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: String(row.user_id),
    apiBase: row.api_base,
    apiKey: decryptSecret(row.api_key_enc),
    model: row.model,
    githubInstallationId: row.github_installation_id ? String(row.github_installation_id) : '',
    selectedRepo: row.selected_repo || ''
  };
}

async function saveUserSettings(userId, values) {
  const db = requirePool();
  const apiBase = String(values.apiBase || '');
  const apiKey = String(values.apiKey || '');
  const model = String(values.model || '');
  const encrypted = apiKey ? encryptSecret(apiKey) : '';
  await db.query(`
    INSERT INTO tg_user_settings (user_id, api_base, api_key_enc, model)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id) DO UPDATE SET
      api_base = EXCLUDED.api_base,
      api_key_enc = EXCLUDED.api_key_enc,
      model = EXCLUDED.model,
      updated_at = NOW()
  `, [String(userId), apiBase, encrypted, model]);
  if (model) await addModel(userId, model);
  if (Array.isArray(values.models)) {
    for (const savedModel of values.models.slice(0, 100)) {
      const value = String(savedModel || '').trim();
      if (value && value.length <= 200 && !/\\s/.test(value)) await addModel(userId, value);
    }
  }
}

async function addModel(userId, model) {
  const db = requirePool();
  await db.query(
    'INSERT INTO tg_user_models (user_id, model) VALUES ($1, $2) ON CONFLICT (user_id, model) DO NOTHING',
    [String(userId), String(model)]
  );
}

async function listModels(userId) {
  const db = requirePool();
  const result = await db.query(
    'SELECT model FROM tg_user_models WHERE user_id = $1 ORDER BY created_at ASC, model ASC LIMIT 100',
    [String(userId)]
  );
  return result.rows.map((row) => row.model);
}

async function setUserModel(userId, model) {
  const db = requirePool();
  await db.query(
    `INSERT INTO tg_user_settings (user_id, model)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET model = EXCLUDED.model, updated_at = NOW()`,
    [String(userId), String(model)]
  );
  await addModel(userId, model);
}

async function createSession(userId) {
  const db = requirePool();
  const sessionId = crypto.randomUUID();
  await db.query(
    "UPDATE tg_chat_sessions SET status = 'sleeping', updated_at = NOW() WHERE user_id = $1 AND status = 'active'",
    [String(userId)]
  );
  await db.query(
    "INSERT INTO tg_chat_sessions (session_id, user_id, status) VALUES ($1, $2, 'active')",
    [sessionId, String(userId)]
  );
  return sessionId;
}

async function getOrCreateSession(userId) {
  const db = requirePool();
  const result = await db.query(
    "SELECT session_id, last_activity FROM tg_chat_sessions WHERE user_id = $1 AND status <> 'stopped' ORDER BY last_activity DESC LIMIT 1",
    [String(userId)]
  );
  if (!result.rows[0]) return createSession(userId);
  const row = result.rows[0];
  const idleMs = Date.now() - new Date(row.last_activity).getTime();
  await db.query(
    "UPDATE tg_chat_sessions SET status = $2, updated_at = NOW() WHERE session_id = $1",
    [row.session_id, idleMs >= 60_000 ? 'sleeping' : 'active']
  );
  return row.session_id;
}

async function touchSession(sessionId, userId) {
  const db = requirePool();
  const result = await db.query(
    "UPDATE tg_chat_sessions SET status = 'active', last_activity = date_trunc('milliseconds', NOW()), updated_at = NOW() WHERE session_id = $1 AND user_id = $2 RETURNING last_activity",
    [sessionId, String(userId)]
  );
  return result.rows[0] ? result.rows[0].last_activity : null;
}

async function sleepSession(sessionId, userId, expectedLastActivity) {
  const db = requirePool();
  await db.query(
    "UPDATE tg_chat_sessions SET status = 'sleeping', updated_at = NOW() WHERE session_id = $1 AND user_id = $2 AND status = 'active' AND last_activity = $3",
    [sessionId, String(userId), expectedLastActivity]
  );
}

async function stopSession(userId) {
  const db = requirePool();
  const result = await db.query(
    "UPDATE tg_chat_sessions SET status = 'stopped', updated_at = NOW() WHERE user_id = $1 AND status <> 'stopped' RETURNING session_id",
    [String(userId)]
  );
  return result.rowCount > 0;
}

async function appendMessage(sessionId, userId, role, content) {
  const db = requirePool();
  await db.query(
    'INSERT INTO tg_chat_messages (session_id, user_id, role, content) VALUES ($1, $2, $3, $4)',
    [sessionId, String(userId), role, String(content)]
  );
}

async function getRecentMessages(sessionId, limit = 24) {
  const db = requirePool();
  const result = await db.query(
    'SELECT role, content FROM (SELECT id, role, content FROM tg_chat_messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2) m ORDER BY id ASC',
    [sessionId, Math.max(2, Math.min(40, Number(limit) || 24))]
  );
  return result.rows;
}

async function setGitHubInstallation(userId, installationId) {
  const db = requirePool();
  await db.query(
    `INSERT INTO tg_user_settings (user_id, github_installation_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET github_installation_id = EXCLUDED.github_installation_id, selected_repo = '', updated_at = NOW()`,
    [String(userId), String(installationId)]
  );
}

async function setSelectedRepo(userId, fullName) {
  const db = requirePool();
  await db.query(
    `INSERT INTO tg_user_settings (user_id, selected_repo)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET selected_repo = EXCLUDED.selected_repo, updated_at = NOW()`,
    [String(userId), String(fullName)]
  );
}

async function enqueueUpdate(update) {
  const db = requirePool();
  await db.query(
    'INSERT INTO tg_updates (update_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (update_id) DO NOTHING',
    [String(update.update_id), JSON.stringify(update)]
  );
}

async function claimNextUpdate() {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      "SELECT update_id, payload FROM tg_updates WHERE status = 'pending' OR (status = 'processing' AND updated_at < NOW() - INTERVAL '3 minutes') ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1"
    );
    if (!found.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const row = found.rows[0];
    await client.query(
      "UPDATE tg_updates SET status = 'processing', attempts = attempts + 1, updated_at = NOW() WHERE update_id = $1",
      [String(row.update_id)]
    );
    await client.query('COMMIT');
    return { updateId: String(row.update_id), payload: row.payload };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function finishUpdate(updateId, failed = false) {
  const db = requirePool();
  await db.query(
    'UPDATE tg_updates SET status = $2, updated_at = NOW() WHERE update_id = $1',
    [String(updateId), failed ? 'failed' : 'done']
  );
}

async function retryUpdate(updateId) {
  const db = requirePool();
  await db.query(
    "UPDATE tg_updates SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, updated_at = NOW() WHERE update_id = $1",
    [String(updateId)]
  );
}

module.exports = {
  addModel,
  appendMessage,
  claimNextUpdate,
  createSession,
  decryptSecret,
  encryptSecret,
  enqueueUpdate,
  finishUpdate,
  getOrCreateSession,
  getRecentMessages,
  getUserSettings,
  initStorage,
  listModels,
  requirePool,
  retryUpdate,
  saveUserSettings,
  setGitHubInstallation,
  setSelectedRepo,
  setUserModel,
  sleepSession,
  stopSession,
  touchSession
};
