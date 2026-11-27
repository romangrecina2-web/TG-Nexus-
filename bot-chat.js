/* AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
 * Source: src/bot/*.js
 * Rebuild with: npm run build
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const PROVIDER_ADAPTERS = require('./provider-adapters');
const PROVIDER_CATALOG = require('./provider-catalog');
const MODEL_CATALOG = require('./model-catalog');

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
  { command: 'pro', description: 'Посмотреть тарифы TG Nexus PRO' },
  { command: 'mypro', description: 'Проверить статус PRO' },
  { command: 'promocode', description: 'Активировать промокод' },
  { command: 'paysupport', description: 'Помощь с платежами' },
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
    if (!decoded.promocodes || typeof decoded.promocodes !== 'object' || Array.isArray(decoded.promocodes)) decoded.promocodes = {};
    if (!Array.isArray(decoded.adminLogs)) decoded.adminLogs = [];
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
      deadLetterUpdates: [],
      promocodes: {},
      adminLogs: []
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
      kind: message.kind === 'document' ? 'document' :
        (message.kind === 'rich_message' ? 'rich_message' : 'message'),
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
    } else if (entry.kind === 'rich_message') {
      if (!message.richMessage || typeof message.richMessage !== 'object' ||
          Array.isArray(message.richMessage)) {
        throw new TypeError('A valid Telegram Rich Message is required.');
      }
      entry.richMessage = message.richMessage;
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


  function adminUserSnapshot(userId, raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const pro = raw.pro && typeof raw.pro === 'object' && !Array.isArray(raw.pro) ? raw.pro : {};
    const expiresAt = Math.max(0, Number(pro.expiresAt) || 0);
    const trialExpiresAt = Math.max(0, Number(pro.trialExpiresAt) || 0);
    const payments = Array.isArray(pro.payments) ? pro.payments : [];
    const promoRedemptions = Array.isArray(pro.promoRedemptions) ? pro.promoRedemptions : [];
    return {
      id: String(userId),
      hasApiKey: typeof raw.apiKey === 'string' && raw.apiKey.length > 0,
      providerId: String(raw.apiProviderId || 'custom').slice(0, 40),
      model: String(raw.model || '').slice(0, 100),
      chatCount: Array.isArray(raw.chats) ? raw.chats.length : 0,
      termsAccepted: typeof raw.termsAcceptedVersion === 'string' && raw.termsAcceptedVersion.length > 0,
      proExpiresAt: expiresAt,
      proActive: expiresAt > now,
      remainingDays: expiresAt > now ? Math.ceil((expiresAt - now) / 86_400_000) : 0,
      trialActive: expiresAt > now && trialExpiresAt > now && payments.length === 0 && promoRedemptions.length === 0,
      paymentCount: payments.length,
      promoRedemptionCount: promoRedemptions.length
    };
  }

  function getAdminOverview(now = Date.now()) {
    const current = load();
    const users = Object.entries(current.users);
    let activePro = 0;
    let activeTrials = 0;
    for (const [id, raw] of users) {
      const item = adminUserSnapshot(id, raw, now);
      if (!item) continue;
      if (item.proActive) activePro += 1;
      if (item.trialActive) activeTrials += 1;
    }
    const promoCodes = Object.values(current.promocodes);
    return {
      totalUsers: users.length,
      activePro,
      activeTrials,
      promoCodes: promoCodes.length,
      enabledPromoCodes: promoCodes.filter((item) => item && item.enabled === true).length,
      queue: getQueueStats()
    };
  }

  function getAdminUser(userId, now = Date.now()) {
    const current = load();
    const id = String(userId);
    if (!Object.prototype.hasOwnProperty.call(current.users, id)) return null;
    return adminUserSnapshot(id, current.users[id], now);
  }

  function listAdminUsers(options = {}) {
    const current = load();
    const now = Number(options.now) || Date.now();
    const pageSize = Math.max(1, Math.min(20, Math.round(Number(options.pageSize) || 8)));
    const page = Math.max(0, Math.round(Number(options.page) || 0));
    const query = String(options.query || '').trim();
    let users = Object.entries(current.users)
      .map(([id, raw]) => adminUserSnapshot(id, raw, now))
      .filter(Boolean);
    if (query) users = users.filter((item) => item.id.includes(query));
    if (options.onlyPro === true) users = users.filter((item) => item.proActive);
    users.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    const total = users.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, pageCount - 1);
    return {
      users: users.slice(safePage * pageSize, (safePage + 1) * pageSize),
      total,
      page: safePage,
      pageSize,
      pageCount,
      hasPrevious: safePage > 0,
      hasNext: safePage + 1 < pageCount
    };
  }

  function appendAdminLog(entry = {}) {
    const current = load();
    if (!Array.isArray(current.adminLogs)) current.adminLogs = [];
    const record = {
      at: Date.now(),
      actorId: String(entry.actorId || '').slice(0, 32),
      action: String(entry.action || 'unknown').slice(0, 48),
      targetId: entry.targetId == null ? '' : String(entry.targetId).slice(0, 32),
      summary: String(entry.summary || '').replace(/[\r\n\t]+/g, ' ').slice(0, 180)
    };
    current.adminLogs.push(record);
    if (current.adminLogs.length > 300) {
      current.adminLogs.splice(0, current.adminLogs.length - 300);
    }
    save();
    return { ...record };
  }

  function listAdminLogs(limit = 10) {
    const current = load();
    const safeLimit = Math.max(1, Math.min(50, Math.round(Number(limit) || 10)));
    return (Array.isArray(current.adminLogs) ? current.adminLogs : [])
      .slice(-safeLimit).reverse().map((item) => ({
        at: Number(item.at) || 0,
        actorId: String(item.actorId || ''),
        action: String(item.action || ''),
        targetId: String(item.targetId || ''),
        summary: String(item.summary || '')
      }));
  }

  function createPromoCode(code, details = {}) {
    const normalized = String(code || '').trim().toUpperCase();
    const days = Math.round(Number(details.days));
    const maxUses = Math.round(Number(details.maxUses));
    if (!/^[A-Z0-9_-]{4,32}$/.test(normalized)) return { ok: false, reason: 'invalid_code' };
    if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: 'invalid_days' };
    if (!Number.isInteger(maxUses) || maxUses < 0 || maxUses > 100000) return { ok: false, reason: 'invalid_limit' };
    const current = load();
    if (current.promocodes[normalized]) return { ok: false, reason: 'exists' };
    current.promocodes[normalized] = {
      days, maxUses, enabled: true, createdAt: Number(details.createdAt) || Date.now(),
      createdBy: String(details.createdBy || ''), redemptions: []
    };
    try { save(); } catch (error) { delete current.promocodes[normalized]; throw error; }
    return { ok: true, code: normalized, days, maxUses };
  }

  function disablePromoCode(code) {
    const normalized = String(code || '').trim().toUpperCase();
    const promo = load().promocodes[normalized];
    if (!promo) return false;
    const previous = promo.enabled;
    const previousDisabledAt = promo.disabledAt;
    promo.enabled = false;
    promo.disabledAt = Date.now();
    try { save(); } catch (error) {
      promo.enabled = previous;
      if (previousDisabledAt === undefined) delete promo.disabledAt;
      else promo.disabledAt = previousDisabledAt;
      throw error;
    }
    return true;
  }

  function listPromoCodes() {
    const records = load().promocodes;
    return Object.keys(records).sort().map((code) => ({
      code, days: Number(records[code].days) || 0, maxUses: Number(records[code].maxUses) || 0,
      enabled: records[code].enabled === true,
      uses: Array.isArray(records[code].redemptions) ? records[code].redemptions.length : 0,
      createdAt: Number(records[code].createdAt) || 0
    }));
  }

  function redeemPromoCode(code, userId, now = Date.now()) {
    const normalized = String(code || '').trim().toUpperCase();
    const current = load();
    const promo = current.promocodes[normalized];
    if (!promo) return { ok: false, reason: 'not_found' };
    if (promo.enabled !== true) return { ok: false, reason: 'disabled' };
    const days = Number(promo.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, reason: 'invalid' };
    if (Number(promo.expiresAt) > 0 && Number(promo.expiresAt) <= now) {
      promo.enabled = false; save(); return { ok: false, reason: 'expired' };
    }
    if (!Array.isArray(promo.redemptions)) promo.redemptions = [];
    const id = String(userId);
    if (promo.redemptions.some((item) => item && String(item.userId) === id)) {
      return { ok: false, reason: 'already_used' };
    }
    const maxUses = Math.max(0, Number(promo.maxUses) || 0);
    if (maxUses > 0 && promo.redemptions.length >= maxUses) return { ok: false, reason: 'limit' };
    const user = getUser(id);
    if (!user.pro || typeof user.pro !== 'object' || Array.isArray(user.pro)) user.pro = {};
    if (!Array.isArray(user.pro.promoRedemptions)) user.pro.promoRedemptions = [];
    const previousPro = JSON.parse(JSON.stringify(user.pro));
    const previousRedemptions = promo.redemptions.slice();
    const currentExpiry = Math.max(now, Number(user.pro.expiresAt) || 0);
    user.pro.expiresAt = currentExpiry + days * 24 * 60 * 60 * 1000;
    user.pro.promoRedemptions.push({ code: normalized, redeemedAt: now, days });
    promo.redemptions.push({ userId: id, redeemedAt: now });
    try { save(); } catch (error) {
      user.pro = previousPro; promo.redemptions = previousRedemptions; throw error;
    }
    return { ok: true, code: normalized, days, expiresAt: user.pro.expiresAt };
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
    getQueueStats,
    getAdminOverview,
    getAdminUser,
    listAdminUsers,
    appendAdminLog,
    listAdminLogs,
    createPromoCode,
    disablePromoCode,
    listPromoCodes,
    redeemPromoCode
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
  const rawSendTelegramRichMessage = options.sendTelegramRichMessage || defaultSendTelegramRichMessage;
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

  async function sendTelegramRichMessage(chatId, richMessage, sendOptions = {}) {
    const context = updateContext.getStore();
    if (!context || !Number.isSafeInteger(context.updateId)) {
      return rawSendTelegramRichMessage(chatId, richMessage, sendOptions);
    }
    const queued = store.appendOutbox(context.updateId, {
      chatId,
      kind: 'rich_message',
      richMessage,
      options: sendOptions
    });
    let sent;
    try {
      sent = await rawSendTelegramRichMessage(chatId, richMessage, sendOptions);
    } catch (error) {
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

  async function telegramRequest(method, payload, requestOptions = {}) {
    if (typeof options.telegramApiCall === 'function') {
      return options.telegramApiCall(method, payload, requestOptions);
    }
    if (!botToken) throw new Error('Telegram bot token is not configured.');
    const timeoutMs = Math.max(1_000, Math.min(15_000, Number(requestOptions.timeoutMs) || 15_000));
    const response = await fetchImpl('https://api.telegram.org/bot' + botToken + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
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

  async function defaultSendTelegramRichMessage(chatId, richMessage, sendOptions = {}) {
    return telegramRequest('sendRichMessage', {
      chat_id: chatId,
      rich_message: richMessage,
      ...sendOptions
    });
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
  const editTelegramRichMessage = options.editTelegramRichMessage || ((chatId, messageId, richMessage, replyMarkup) =>
    telegramRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      rich_message: richMessage,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
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

  function escapeAssistantRichButtonTags(value) {
    return String(value == null ? '' : value).replace(/<\/?tg-button(?:-row)?\b[^>]*>/gi, (tag) =>
      tag.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  }

  function buildAssistantRichMessage(text, requestId, buttonText) {
    const safeText = escapeAssistantRichButtonTags(text).trim() || ' ';
    const id = String(requestId || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { markdown: safeText };

    const label = buttonText === '🔄 Повторить запрос'
      ? '🔄 Повторить запрос'
      : '🔄 Перегенерировать ответ';
    return {
      markdown: safeText + '\n\n' +
        '<tg-button-row align="center"><tg-button type="callback_data" style="success" data="regen:' +
        id + '">' + label + '</tg-button></tg-button-row>'
    };
  }

  function splitAssistantRichMarkdown(value, maxLength = 30_000) {
    let remaining = String(value == null ? '' : value).trim();
    if (!remaining) return [' '];
    const chunks = [];
    while (remaining.length > maxLength) {
      let cut = remaining.lastIndexOf('\n\n', maxLength);
      if (cut < Math.floor(maxLength * 0.6)) cut = remaining.lastIndexOf('\n', maxLength);
      if (cut < Math.floor(maxLength * 0.6)) cut = remaining.lastIndexOf(' ', maxLength);
      if (cut < 1) cut = maxLength;
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks.length ? chunks : [' '];
  }

  async function sendAssistantText(chatId, text, requestId, buttonText) {
    const chunks = splitAssistantRichMarkdown(text);
    let lastSent = null;
    for (let index = 0; index < chunks.length; index += 1) {
      const isLast = index === chunks.length - 1;
      lastSent = await sendTelegramRichMessage(
        chatId,
        buildAssistantRichMessage(chunks[index], isLast ? requestId : null, buttonText)
      );
    }
    return lastSent;
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
    const editStatus = async (text, replyMarkup) => {
      if (!messageId) return false;
      try {
        await editTelegramMessage(chatId, messageId, text, replyMarkup);
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
      },
      async finishRich(richMessage) {
        stopped = true;
        clearInterval(timer);
        await editInFlight;
        const seconds = elapsedSeconds();
        if (!messageId) {
          await sendTelegramRichMessage(chatId, richMessage);
          return seconds;
        }
        try {
          await editTelegramRichMessage(chatId, messageId, richMessage);
        } catch {
          try { await deleteTelegramMessage(chatId, messageId); } catch {}
          await sendTelegramRichMessage(chatId, richMessage);
        }
        return seconds;
      }
    };
  }

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

  async function sendAssistantResponse(chatId, answer, requestText, requestId) {
    const segments = splitAssistantFiles(answer, requestText);
    if (!segments || !segments.some((segment) => segment.type === 'file')) {
      return sendAssistantText(chatId, answer, requestId);
    }
    const files = segments.filter((segment) => segment.type === 'file');
    if (files.length > 5) {
      await sendAssistantText(
        chatId,
        'Ответ содержит слишком много файлов (' + files.length + '). Максимум за одно сообщение — 5 файлов. Попросите ИИ разделить проект на части.',
        requestId
      );
      return null;
    }
    let lastSent = null;
    const finalSegment = segments[segments.length - 1];
    let fileDeliveryFailed = false;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const isLast = index === segments.length - 1;
      if (segment.type === 'text') {
        lastSent = await sendAssistantText(chatId, segment.value, isLast ? requestId : null);
        continue;
      }
      const size = Buffer.byteLength(segment.content, 'utf8');
      if (!size || size > 2 * 1024 * 1024) {
        fileDeliveryFailed = true;
        await sendText(chatId, 'Файл «' + segment.name + '» не отправлен: пустой или превышает лимит 2 МБ.');
        continue;
      }
      lastSent = await sendTelegramDocument(chatId, {
        fileName: segment.name,
        mimeType: codeFileMimeType(segment.language),
        caption: 'Файл с кодом: ' + segment.name,
        content: segment.content
      });
    }
    if (requestId && finalSegment && finalSegment.type === 'file') {
      lastSent = await sendAssistantText(
        chatId,
        fileDeliveryFailed ? 'Не удалось прикрепить один или несколько файлов.' : 'Файлы с ответом прикреплены выше.',
        requestId
      );
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

  const REQUIRED_TERMS_VERSION = '2026-11-26-v2';
const TERMS_SUPPORT_URL = 'https://t.me/TG_Nexus_official';
const pendingAdminInput = new Map();

function getTermsAcceptedAppUrl() {
  const value = String(options.webAppUrl || process.env.WEB_APP_URL || '');
  try {
    const target = new URL(value);
    return target.protocol === 'https:' ? target.toString() : '';
  } catch {
    return '';
  }
}

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

  function updatePendingSystemPromptInput(user, pending) {
    const existed = Object.prototype.hasOwnProperty.call(user, 'pendingSystemPromptInput');
    const previous = user.pendingSystemPromptInput;
    if (pending) user.pendingSystemPromptInput = { createdAt: Date.now() };
    else delete user.pendingSystemPromptInput;
    try {
      store.save();
    } catch (error) {
      if (existed) user.pendingSystemPromptInput = previous;
      else delete user.pendingSystemPromptInput;
      throw error;
    }
  }

  function settingsApiEndpointLabel(user) {
    try {
      const endpoint = new URL(user.apiBaseUrl || apiBaseUrl);
      const value = endpoint.host + endpoint.pathname.replace(/\/+$/, '');
      return value.length > 76 ? value.slice(0, 73) + '…' : value;
    } catch {
      return 'не задан';
    }
  }

  function settingsMessageText(user, view = 'main') {
    if (view === 'system-prompt') {
      const prompt = String(user.settings && user.settings.systemPrompt || '').trim();
      if (!prompt || prompt === systemPrompt) return 'Инструкция ИИ\n\nСейчас используется стандартная инструкция, заданная на сервере.\nВы можете задать собственную или оставить стандартную.';
      return 'Инструкция ИИ\n\nПользовательская инструкция активна (' + prompt.length + ' символов).\n\n' +
        prompt.slice(0, 600) + (prompt.length > 600 ? '…' : '') + '\n\nДля изменения нажмите кнопку ниже.';
    }
    if (view === 'system-prompt-input') {
      return 'Отправьте одним сообщением новую инструкцию для ИИ. Можно использовать несколько строк.\n\n' +
        'Максимум — ' + MAX_SYSTEM_PROMPT_LENGTH + ' символов. Это значение будет применяться ко всем новым запросам в Telegram и синхронизироваться с Mini App.\n\n' +
        'Для отмены отправьте /cancel. Чтобы вернуть стандартную инструкцию, используйте кнопку «Сбросить» в предыдущем меню.';
    }
    if (view === 'sandbox-confirm') {
      return 'Включить JavaScript-песочницу в Mini App?\n\n' +
        'ИИ сможет запускать JavaScript в изолированном iframe браузера. Код не получает доступ к файлам, хранилищу или API-ключу.\n\n' +
        'Сетевой доступ останется выключенным и включается отдельно. Выполнение кода может расходовать ресурсы устройства.\n\n' +
        'Разрешить запуск?';
    }
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
    const customPrompt = typeof settings.systemPrompt === 'string' &&
      settings.systemPrompt.trim() && settings.systemPrompt !== systemPrompt;
    return [
      '⚙️ Настройки TG Nexus',
      '',
      'Подключение',
      'Провайдер: ' + currentProviderName(user),
      'API: ' + settingsApiEndpointLabel(user),
      'Модель: ' + currentUserModel(user),
      'API-ключ: ' + (user.apiKey ? 'сохранён' : 'не добавлен'),
      '',
      'Параметры ответа',
      'Рассуждения: ' + (reasoningLabels[settings.reasoning || 'auto'] || 'Авто'),
      'Лимит ответа: ' + currentTokenLimit(user) + ' токенов',
      'Время ожидания ответа: ' + currentRequestTimeout(user) + ' секунд',
      'Инструкция: ' + (customPrompt ? 'пользовательская' : 'по умолчанию'),
      '',
      'Инструменты',
      'Интернет-поиск: ' + (settings.internetSearch === true ? 'включён' : 'выключен'),
      'Песочница: ' + (settings.sandbox === true ? 'включена в Mini App' : 'выключена')
    ].join('\n');
  }

  function settingsRichMessage(user) {
    const settings = user.settings || {};
    const customPrompt = typeof settings.systemPrompt === 'string' &&
      settings.systemPrompt.trim() && settings.systemPrompt !== systemPrompt;
    const model = currentUserModel(user);
    const modelLabel = model.length > 76 ? model.slice(0, 73) + '…' : model;
    const searchEnabled = settings.internetSearch === true;
    const sandboxEnabled = settings.sandbox === true;
    const blocks = [
      modelCatalogBlocksHeading('Настройки TG Nexus', 1),
      modelCatalogBlocksHeading('Подключение', 2),
      modelCatalogBlocksParagraph('Провайдер: ' + currentProviderName(user)),
      modelCatalogBlocksParagraph('API: ' + settingsApiEndpointLabel(user)),
      modelCatalogBlocksParagraph('Модель: ' + modelLabel),
      modelCatalogBlocksParagraph('API-ключ: ' + (user.apiKey ? 'сохранён' : 'не добавлен')),
      modelCatalogBlocksHeading('Параметры ответа', 2),
      modelCatalogBlocksParagraph(
        'Рассуждения: ' + (reasoningLabels[settings.reasoning || 'auto'] || 'Авто') +
        ' · Лимит: ' + currentTokenLimit(user).toLocaleString('ru-RU') +
        ' токенов · Тайм-аут: ' + currentRequestTimeout(user) + ' с'
      ),
      modelCatalogBlocksParagraph('Инструкция: ' + (customPrompt ? 'пользовательская' : 'по умолчанию')),
      modelCatalogBlocksHeading('Инструменты', 2),
      modelCatalogBlocksParagraph(
        'Интернет-поиск: ' + (searchEnabled ? 'включён' : 'выключен') +
        ' · Песочница: ' + (sandboxEnabled ? 'включена' : 'выключена')
      ),
      modelCatalogBlocksButtons([
        modelCatalogButton('🤖 Модель', 'tn:model', 'primary'),
        modelCatalogButton('🔌 Провайдер', 'tn:providers:0')
      ]),
      modelCatalogBlocksButtons([
        modelCatalogButton('🧠 Рассуждения', 'tn:reason'),
        modelCatalogButton('🎛 Лимит ответа', 'tn:tokens')
      ]),
      modelCatalogBlocksButtons([
        modelCatalogButton('⏱ Тайм-аут', 'tn:timeout'),
        modelCatalogButton('📝 Инструкция', 'tn:prompt')
      ]),
      modelCatalogBlocksButtons([
        modelCatalogButton('🌐 Поиск: ' + (searchEnabled ? 'ВКЛ' : 'ВЫКЛ'), 'tn:search', searchEnabled ? 'success' : 'danger'),
        modelCatalogButton('🧪 Песочница: ' + (sandboxEnabled ? 'ВКЛ' : 'ВЫКЛ'), 'tn:sandbox', sandboxEnabled ? 'success' : 'danger')
      ])
    ];
    if (isBillingAdmin(user.id)) {
      blocks.push(modelCatalogBlocksButtons([
        modelCatalogButton('🛡️ Админ-панель', 'admin:home', 'primary')
      ]));
    }
    return modelCatalogRich(blocks);
  }


  function isSettingsSelectionView(view) {
    return view === 'tokens' || view === 'timeout' || view === 'reasoning' ||
      /^providers:\d+$/.test(String(view));
  }

  function settingsSelectionRichMessage(user, view) {
    const settings = user.settings || {};
    const blocks = [modelCatalogBlocksHeading('Настройки TG Nexus', 1)];

    const appendRows = (items, perRow, createButton) => {
      for (let index = 0; index < items.length; index += perRow) {
        blocks.push(modelCatalogBlocksButtons(
          items.slice(index, index + perRow).map(createButton)
        ));
      }
    };

    const appendBack = () => blocks.push(modelCatalogBlocksButtons([
      modelCatalogButton('← Назад к настройкам', 'tn:back')
    ]));

    if (view === 'timeout') {
      const current = currentRequestTimeout(user);
      const choices = [10, 30, 60, 120, 180, 300, 600, 1800, 3600, 7200];
      blocks.push(
        modelCatalogBlocksHeading('Параметры ответа', 2),
        modelCatalogBlocksParagraph('Время ожидания ответа провайдера'),
        modelCatalogBlocksParagraph('Текущее значение: ' + current + ' секунд'),
        modelCatalogBlocksHeading('Выберите новое значение', 3)
      );
      appendRows(choices, 3, (value) => modelCatalogButton(
        (value === current ? '✓ ' : '') + value + ' с',
        'tn:timeout:' + value,
        value === current ? 'success' : undefined
      ));
      blocks.push(modelCatalogBlocksButtons([
        modelCatalogButton('✍️ Ввести своё значение', 'tn:timeout:custom')
      ]));
      appendBack();
    } else if (view === 'tokens') {
      const current = currentTokenLimit(user);
      blocks.push(
        modelCatalogBlocksHeading('Параметры ответа', 2),
        modelCatalogBlocksParagraph('Лимит ответа'),
        modelCatalogBlocksParagraph('Текущее значение: ' + current.toLocaleString('ru-RU') + ' токенов'),
        modelCatalogBlocksHeading('Выберите лимит', 3)
      );
      appendRows(tokenPresets, 3, (value) => modelCatalogButton(
        (value === current ? '✓ ' : '') + value.toLocaleString('ru-RU'),
        'tn:t:' + value,
        value === current ? 'success' : undefined
      ));
      appendBack();
    } else if (view === 'reasoning') {
      const current = settings.reasoning || 'auto';
      blocks.push(
        modelCatalogBlocksHeading('Параметры ответа', 2),
        modelCatalogBlocksParagraph('Уровень рассуждений'),
        modelCatalogBlocksParagraph('Текущее значение: ' + (reasoningLabels[current] || 'Авто')),
        modelCatalogBlocksHeading('Выберите уровень', 3)
      );
      appendRows(reasoningChoices, 2, (value) => modelCatalogButton(
        (value === current ? '✓ ' : '') + reasoningLabels[value],
        'tn:r:' + value,
        value === current ? 'success' : undefined
      ));
      appendBack();
    } else {
      const match = String(view).match(/^providers:(\d+)$/);
      const pageCount = Math.max(1, Math.ceil(PROVIDER_CATALOG.length / 10));
      const page = Math.max(0, Math.min(pageCount - 1, Number(match && match[1]) || 0));
      const current = currentProvider(user);
      const providers = PROVIDER_CATALOG.slice(page * 10, page * 10 + 10);
      blocks.push(
        modelCatalogBlocksHeading('Подключение', 2),
        modelCatalogBlocksParagraph('Текущий провайдер: ' + currentProviderName(user)),
        modelCatalogBlocksParagraph('Выберите API-провайдера · Страница ' + (page + 1) + ' из ' + pageCount),
        modelCatalogBlocksHeading('Доступные провайдеры', 3)
      );
      appendRows(providers, 2, (provider) => {
        const selected = current && current.id === provider.id;
        return modelCatalogButton(
          (selected ? '✓ ' : '') + provider.name,
          'tn:provider:' + provider.id,
          selected ? 'success' : undefined
        );
      });
      const navigation = [];
      if (page > 0) navigation.push(modelCatalogButton('← Предыдущие', 'tn:providers:' + (page - 1)));
      if (page + 1 < pageCount) navigation.push(modelCatalogButton('Следующие →', 'tn:providers:' + (page + 1)));
      if (navigation.length) blocks.push(modelCatalogBlocksButtons(navigation));
      blocks.push(modelCatalogBlocksParagraph('При смене провайдера прежний API-ключ и модель могут быть сброшены.'));
      appendBack();
    }

    return modelCatalogRich(blocks);
  }

  function settingsKeyboard(user, view = 'main') {
    if (view === 'system-prompt') {
      return {
        inline_keyboard: [
          [{ text: '✍️ Изменить инструкцию', callback_data: 'tn:prompt:edit' }],
          [{ text: '♻️ Сбросить к стандартной', callback_data: 'tn:prompt:reset' }],
          [{ text: '← Назад', callback_data: 'tn:back' }]
        ]
      };
    }
    if (view === 'system-prompt-input') {
      return { inline_keyboard: [[{ text: '← Назад', callback_data: 'tn:back' }]] };
    }
    if (view === 'sandbox-confirm') {
      return {
        inline_keyboard: [
          [{ text: '✅ Разрешить песочницу', callback_data: 'tn:sandbox:confirm' }],
          [{ text: 'Отмена', callback_data: 'tn:sandbox:cancel' }]
        ]
      };
    }
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
        { text: '🤖 Модель', callback_data: 'tn:model' },
        { text: '🔌 Провайдер', callback_data: 'tn:providers:0' }
      ],
      [
        { text: '🧠 Рассуждения', callback_data: 'tn:reason' },
        { text: '🎛 Лимит ответа', callback_data: 'tn:tokens' }
      ],
      [
        { text: '⏱ Тайм-аут: ' + currentRequestTimeout(user) + ' с', callback_data: 'tn:timeout' },
        { text: '📝 Инструкция', callback_data: 'tn:prompt' }
      ],
      [
        { text: '🌐 Поиск: ' + (settings.internetSearch === true ? 'ВКЛ' : 'ВЫКЛ'), callback_data: 'tn:search', style: settings.internetSearch === true ? 'success' : 'danger' },
        { text: '🧪 Песочница: ' + (settings.sandbox === true ? 'ВКЛ' : 'ВЫКЛ'), callback_data: 'tn:sandbox', style: settings.sandbox === true ? 'success' : 'danger' }
      ],
      [{ text: '↻ Обновить', callback_data: 'tn:refresh' }]
    ];
    if (isBillingAdmin(user.id)) rows.push([{ text: '🛡️ Админ-панель', callback_data: 'admin:home' }]);
    const url = getSettingsUrl();
    if (url) rows.push([{ text: 'Открыть все настройки', web_app: { url } }]);
    return { inline_keyboard: rows };
  }

  function settingsMainReplyMarkup() {
    const rows = [[{ text: '↻ Обновить', callback_data: 'tn:refresh' }]];
    const url = getSettingsUrl();
    if (url) rows.push([{ text: 'Открыть все настройки', web_app: { url } }]);
    return { inline_keyboard: rows };
  }

  async function safeAnswerCallback(queryId, text = '') {
    try { await answerCallbackQuery(queryId, text); } catch {}
  }


  function adminFormatDate(timestamp) {
    const value = Number(timestamp) || 0;
    return value > 0 ? new Date(value).toLocaleString('ru-RU', {
      dateStyle: 'medium', timeStyle: 'short'
    }) : 'не указана';
  }

  function buildAdminPanel(userId, view = 'home', page = 0, targetId = '') {
    const homeButton = { text: '← Админ-панель', callback_data: 'admin:home' };
    const settingsButton = { text: '← Настройки', callback_data: 'tn:back' };
    const rows = [];
    let text = 'TG Nexus · Админ-панель';

    if (view === 'home') {
      const stats = store.getAdminOverview();
      const queue = stats.queue || {};
      const worker = getWorkerStats();
      text = [
        '🛡 TG NEXUS · АДМИН-ПАНЕЛЬ',
        '',
        'Пользователи: ' + stats.totalUsers,
        'Активные PRO: ' + stats.activePro,
        'Из них пробный период: ' + stats.activeTrials,
        'Промокоды: ' + stats.enabledPromoCodes + '/' + stats.promoCodes + ' активны',
        '',
        'Очередь: ' + (queue.pending || 0) + ' ожидают · ' +
          (queue.processing || 0) + ' обрабатываются',
        'Воркеры: ' + (worker.running ? 'работают' : 'остановлены')
      ].join('\n');
      rows.push([
        { text: '👥 Пользователи', callback_data: 'admin:users:0' },
        { text: '💎 Подписки', callback_data: 'admin:subs:0' }
      ]);
      rows.push([
        { text: '🎟 Промокоды', callback_data: 'admin:promos' },
        { text: '⚙️ Система', callback_data: 'admin:system' }
      ]);
      rows.push([{ text: '📋 Журнал действий', callback_data: 'admin:logs' }]);
      rows.push([settingsButton]);
    } else if (view === 'users' || view === 'subs') {
      const onlyPro = view === 'subs';
      const result = store.listAdminUsers({ page, pageSize: 8, onlyPro });
      text = (onlyPro ? '💎 АКТИВНЫЕ PRO-ПОДПИСКИ' : '👥 ПОЛЬЗОВАТЕЛИ') +
        '\nВсего: ' + result.total + '\nСтраница: ' + (result.page + 1) + '/' + result.pageCount;
      if (!result.users.length) text += '\n\nСписок пока пуст.';
      for (const item of result.users) {
        const status = item.proActive
          ? 'PRO до ' + adminFormatDate(item.proExpiresAt)
          : (item.hasApiKey ? 'API подключён' : 'без API-ключа');
        text += '\n\n' + item.id + ' · ' + status + ' · чатов: ' + item.chatCount;
        rows.push([{ text: '👤 ' + item.id + (item.proActive ? ' · PRO' : ''), callback_data: 'admin:user:' + item.id }]);
      }
      if (!onlyPro) rows.push([{ text: '🔎 Найти по Telegram ID', callback_data: 'admin:users:search' }]);
      const navigation = [];
      if (result.hasPrevious) navigation.push({ text: '← Назад', callback_data: 'admin:' + (onlyPro ? 'subs:' : 'users:') + (result.page - 1) });
      if (result.hasNext) navigation.push({ text: 'Далее →', callback_data: 'admin:' + (onlyPro ? 'subs:' : 'users:') + (result.page + 1) });
      if (navigation.length) rows.push(navigation);
      rows.push([homeButton]);
    } else if (view === 'user') {
      const item = store.getAdminUser(targetId);
      if (!item) {
        text = 'Пользователь ' + targetId + ' не найден.';
        rows.push([{ text: '← К пользователям', callback_data: 'admin:users:0' }], [homeButton]);
      } else {
        text = [
          '👤 ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ',
          '',
          'Telegram ID: ' + item.id,
          'PRO: ' + (item.proActive ? 'активен' : 'не активен'),
          'Действует до: ' + adminFormatDate(item.proExpiresAt),
          'Осталось дней: ' + item.remainingDays,
          'Пробный период: ' + (item.trialActive ? 'да' : 'нет'),
          'Платежей: ' + item.paymentCount,
          'Активаций промокодов: ' + item.promoRedemptionCount,
          '',
          'API-ключ: ' + (item.hasApiKey ? 'сохранён' : 'не добавлен'),
          'Провайдер: ' + item.providerId,
          'Модель: ' + (item.model || 'не выбрана'),
          'Чатов: ' + item.chatCount,
          'Условия приняты: ' + (item.termsAccepted ? 'да' : 'нет')
        ].join('\n');
        rows.push([
          { text: '+7 дней PRO', callback_data: 'admin:userpro:' + item.id + ':7' },
          { text: '+30 дней PRO', callback_data: 'admin:userpro:' + item.id + ':30' }
        ]);
        rows.push([{ text: 'Отозвать PRO', callback_data: 'admin:userpro:' + item.id + ':revoke' }]);
        rows.push([{ text: '← К пользователям', callback_data: 'admin:users:0' }, homeButton]);
      }
    } else if (view === 'promos') {
      const list = store.listPromoCodes().slice(-12).reverse();
      text = '🎟 ПРОМОКОДЫ\nВсего: ' + store.listPromoCodes().length;
      if (!list.length) text += '\n\nПромокодов пока нет.';
      for (const promo of list) {
        text += '\n\n' + promo.code + ' · +' + promo.days + ' дн. · ' +
          (promo.enabled ? 'активен' : 'отключён') + ' · ' +
          promo.uses + '/' + (promo.maxUses || '∞');
        if (promo.enabled) rows.push([{ text: 'Отключить ' + promo.code, callback_data: 'admin:promo:off:' + promo.code }]);
      }
      rows.push([{ text: '➕ Создать промокод', callback_data: 'admin:promo:new' }]);
      rows.push([homeButton]);
    } else if (view === 'system') {
      const queue = store.getQueueStats();
      const worker = getWorkerStats();
      text = [
        '⚙️ СОСТОЯНИЕ СИСТЕМЫ',
        '',
        'Зашифрованное хранилище: ' + (store.enabled ? 'доступно' : 'недоступно'),
        'Время работы процесса: ' + Math.floor(process.uptime() / 60) + ' мин.',
        'Telegram worker: ' + (worker.running ? 'работает' : 'остановлен'),
        'Активных worker: ' + worker.activeWorkers + '/' + worker.concurrency,
        'Очередь: ' + queue.total + '/' + queue.capacity,
        'Ожидают: ' + queue.pending,
        'Обрабатываются: ' + queue.processing,
        'Отложенные ошибки: ' + queue.deadLettered,
        'Старейшая задача: ' + Math.round((queue.oldestPendingAgeMs || 0) / 1000) + ' сек.',
        'Восстановлено из резервной копии: ' + (queue.recoveredFromBackup ? 'да' : 'нет')
      ].join('\n');
      rows.push([{ text: '↻ Обновить', callback_data: 'admin:system' }], [homeButton]);
    } else if (view === 'logs') {
      const logs = store.listAdminLogs(15);
      text = '📋 ЖУРНАЛ ДЕЙСТВИЙ\nПоследние записи: ' + logs.length;
      if (!logs.length) text += '\n\nДействий пока нет.';
      for (const entry of logs) {
        text += '\n\n' + adminFormatDate(entry.at) + '\n' +
          entry.action + (entry.targetId ? ' · пользователь ' + entry.targetId : '') +
          '\n' + entry.summary + '\nАдминистратор: ' + (entry.actorId || 'неизвестен');
      }
      rows.push([{ text: '↻ Обновить', callback_data: 'admin:logs' }], [homeButton]);
    } else if (view === 'input-promo') {
      text = '➕ СОЗДАНИЕ ПРОМОКОДА\n\nОтправьте одним сообщением: CODE DAYS MAX_USES\nНапример: NEXUS7 7 10\n\nMAX_USES = 0 означает без ограничения. Для отмены нажмите кнопку ниже или отправьте /cancel.';
      rows.push([{ text: 'Отмена', callback_data: 'admin:input:cancel' }]);
    } else if (view === 'input-search') {
      text = '🔎 ПОИСК ПОЛЬЗОВАТЕЛЯ\n\nОтправьте Telegram ID пользователя. Поиск выполняется только по точному числовому ID.';
      rows.push([{ text: 'Отмена', callback_data: 'admin:input:cancel' }]);
    } else {
      text = 'Раздел не найден.';
      rows.push([homeButton]);
    }

    return { text, replyMarkup: { inline_keyboard: rows } };
  }

  async function sendAdminPanel(chatId, userId, view = 'home', page = 0, targetId = '') {
    if (!isBillingAdmin(userId)) return false;
    const panel = buildAdminPanel(userId, view, page, targetId);
    await sendTelegramMessage(chatId, panel.text, { reply_markup: panel.replyMarkup });
    return true;
  }

  async function renderAdminPanel(query, userId, view = 'home', page = 0, targetId = '', notice = 'Админ-панель обновлена.') {
    const message = query && query.message;
    if (!message || !message.chat || !Number.isSafeInteger(Number(message.message_id))) {
      await safeAnswerCallback(query.id, 'Сообщение панели недоступно. Откройте настройки ещё раз.');
      return false;
    }
    const panel = buildAdminPanel(userId, view, page, targetId);
    try {
      await editTelegramMessage(message.chat.id, message.message_id, panel.text, panel.replyMarkup);
    } catch (error) {
      const description = String(error && (error.telegramDescription || error.message) || '');
      if (!/message is not modified/i.test(description)) {
        await safeAnswerCallback(query.id, 'Не удалось обновить админ-панель.');
        return false;
      }
    }
    await safeAnswerCallback(query.id, notice);
    return true;
  }

  async function handleAdminCallback(query, userId, data) {
    if (!isBillingAdmin(userId)) {
      await safeAnswerCallback(query.id, 'Доступ запрещён.');
      return true;
    }
    if (data === 'admin:home') return renderAdminPanel(query, userId, 'home');
    if (data === 'admin:users:search') {
      pendingAdminInput.set(String(userId), { type: 'user_search', createdAt: Date.now() });
      return renderAdminPanel(query, userId, 'input-search', 0, '', 'Отправьте Telegram ID.');
    }
    if (data === 'admin:promo:new') {
      pendingAdminInput.set(String(userId), { type: 'promo_create', createdAt: Date.now() });
      return renderAdminPanel(query, userId, 'input-promo', 0, '', 'Отправьте параметры промокода.');
    }
    if (data === 'admin:input:cancel') {
      pendingAdminInput.delete(String(userId));
      return renderAdminPanel(query, userId, 'home', 0, '', 'Ввод отменён.');
    }
    const pageMatch = data.match(/^admin:(users|subs):(\d{1,4})$/);
    if (pageMatch) return renderAdminPanel(query, userId, pageMatch[1], Number(pageMatch[2]));
    if (data === 'admin:promos') return renderAdminPanel(query, userId, 'promos');
    if (data === 'admin:system') return renderAdminPanel(query, userId, 'system');
    if (data === 'admin:logs') return renderAdminPanel(query, userId, 'logs');
    const userMatch = data.match(/^admin:user:(\d{1,24})$/);
    if (userMatch) return renderAdminPanel(query, userId, 'user', 0, userMatch[1]);

    const proMatch = data.match(/^admin:userpro:(\d{1,24}):(7|30|revoke)$/);
    if (proMatch) {
      const targetId = proMatch[1];
      const action = proMatch[2];
      if (!store.getAdminUser(targetId)) {
        await safeAnswerCallback(query.id, 'Пользователь не найден.');
        return true;
      }
      const target = store.getUser(targetId);
      const previous = target.pro ? JSON.parse(JSON.stringify(target.pro)) : null;
      const pro = normalizeProState(target);
      const now = Date.now();
      if (action === 'revoke') {
        pro.expiresAt = 0;
        pro.revokedAt = now;
      } else {
        pro.expiresAt = Math.max(now, Number(pro.expiresAt) || 0) + Number(action) * 86_400_000;
      }
      try {
        store.save();
        store.appendAdminLog({
          actorId: userId,
          action: action === 'revoke' ? 'pro_revoke' : 'pro_grant',
          targetId,
          summary: action === 'revoke' ? 'PRO-доступ отозван' : 'Выдано +' + action + ' дней PRO'
        });
      } catch {
        if (previous) target.pro = previous;
        else delete target.pro;
        await safeAnswerCallback(query.id, 'Не удалось сохранить изменение подписки.');
        return true;
      }
      return renderAdminPanel(query, userId, 'user', 0, targetId,
        action === 'revoke' ? 'PRO-доступ отозван.' : 'PRO продлён на ' + action + ' дней.');
    }

    const promoMatch = data.match(/^admin:promo:off:([A-Z0-9_-]{4,32})$/);
    if (promoMatch) {
      const code = promoMatch[1];
      const disabled = store.disablePromoCode(code);
      if (disabled) {
        store.appendAdminLog({ actorId: userId, action: 'promo_disable', summary: 'Отключён промокод ' + code });
      }
      return renderAdminPanel(query, userId, 'promos', 0, '', disabled ? 'Промокод отключён.' : 'Промокод не найден.');
    }

    await safeAnswerCallback(query.id, 'Эта кнопка админ-панели устарела.');
    return true;
  }


  async function renderSettingsCallback(query, user, view = 'main', answerText = 'Настройки обновлены.') {
    const message = query && query.message;
    if (!message || !message.chat || !Number.isSafeInteger(Number(message.message_id))) {
      await safeAnswerCallback(query.id, 'Сообщение настроек недоступно. Отправьте /settings ещё раз.');
      return false;
    }
    try {
      if (view === 'main') {
        await editTelegramRichMessage(
          message.chat.id,
          message.message_id,
          settingsRichMessage(user),
          settingsMainReplyMarkup()
        );
      } else if (isSettingsSelectionView(view)) {
        await editTelegramRichMessage(
          message.chat.id,
          message.message_id,
          settingsSelectionRichMessage(user, view),
          settingsMainReplyMarkup()
        );
      } else {
        await editTelegramMessage(
          message.chat.id,
          message.message_id,
          settingsMessageText(user, view),
          settingsKeyboard(user, view)
        );
      }
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
        (!query.data.startsWith('tn:') && !query.data.startsWith('mc:') &&
         !query.data.startsWith('terms:') && !query.data.startsWith('pro:') &&
         !query.data.startsWith('regen:') && !query.data.startsWith('admin:'))) return false;

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
    const termsMatch = data.match(/^terms:(accept|decline):([A-Za-z0-9._-]{1,40})$/);
    if (data.startsWith('terms:')) {
      if (!termsMatch || termsMatch[2] !== REQUIRED_TERMS_VERSION) {
        await safeAnswerCallback(query.id, 'This consent button is outdated. Send /start to get the current version.');
        return true;
      }
      if (termsMatch[1] === 'decline') {
        await safeAnswerCallback(query.id, 'You declined the current terms.');
        await sendTelegramMessage(message.chat.id,
          'Access to TG Nexus is not enabled because the Terms of Service and Privacy Policy were declined. You can review them and send /start again.');
        return true;
      }

      const previousVersion = user.termsAcceptedVersion;
      const previousAcceptedAt = user.termsAcceptedAt;
      user.termsAcceptedVersion = REQUIRED_TERMS_VERSION;
      if (previousVersion !== REQUIRED_TERMS_VERSION || !previousAcceptedAt) {
        user.termsAcceptedAt = new Date().toISOString();
      }
      try {
        store.save();
      } catch {
        if (previousVersion === undefined) delete user.termsAcceptedVersion;
        else user.termsAcceptedVersion = previousVersion;
        if (previousAcceptedAt === undefined) delete user.termsAcceptedAt;
        else user.termsAcceptedAt = previousAcceptedAt;
        await safeAnswerCallback(query.id, 'Could not save your acceptance. Please try again.');
        return true;
      }

      try { ensureProTrial(userId); } catch {
        await safeAnswerCallback(query.id, 'Terms saved, but the free PRO trial could not be activated yet. Send /pro to retry.');
        return true;
      }
      await safeAnswerCallback(query.id, 'Acceptance saved. Your 12-day PRO trial is active.');
      const rows = [];
      const appUrl = getTermsAcceptedAppUrl();
      if (appUrl) rows.push([{ text: 'Open TG Nexus', web_app: { url: appUrl } }]);
      rows.push([{ text: '📩 Support: Nexus Telegram Channel', url: TERMS_SUPPORT_URL }]);
      await sendTelegramMessage(message.chat.id, [
        '<b>Terms accepted!</b>',
        '',
        'Welcome to TG Nexus. Your acceptance has been saved.',
        '',
        `📩 Support: <a href="${TERMS_SUPPORT_URL}">Nexus Telegram Channel</a>`,
        '',
        '<b>Created by Mr tet0r</b>'
      ].join('\n'), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: rows }
      });
      return true;
    }

    let view = 'main';
    let notice = 'Настройки обновлены.';
    try {
      if (data.startsWith('admin:')) return await handleAdminCallback(query, userId, data);
      if (data.startsWith('regen:')) return await handleRegenerateCallback(query, user, data);
      if (data.startsWith('pro:')) return await handleProCallback(query, user);
      if (data.startsWith('mc:')) {
        return await handleModelCatalogCallback(query, user, data);
      }
      if (data === 'tn:model') {
        return await openModelCatalog(query, user);
      }
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
        if (result.changed) clearModelCatalogState(user, true, userId);
        notice = result.changed
          ? 'Провайдер изменён на ' + result.provider.name + '. Добавьте API-ключ и выберите модель.'
          : result.provider.name + ' уже выбран.';
      } else if (data === 'tn:prompt') {
        pendingTimeoutInput.delete(String(userId));
        if (Object.prototype.hasOwnProperty.call(user, 'pendingSystemPromptInput')) {
          updatePendingSystemPromptInput(user, false);
        }
        view = 'system-prompt';
        notice = 'Настройки инструкции ИИ.';
      } else if (data === 'tn:prompt:edit') {
        pendingTimeoutInput.delete(String(userId));
        updatePendingSystemPromptInput(user, true);
        view = 'system-prompt-input';
        notice = 'Отправьте новую инструкцию одним сообщением.';
      } else if (data === 'tn:prompt:reset') {
        const previous = user.settings || {};
        const hadPending = Object.prototype.hasOwnProperty.call(user, 'pendingSystemPromptInput');
        const previousPending = user.pendingSystemPromptInput;
        user.settings = { ...previous, systemPrompt };
        delete user.pendingSystemPromptInput;
        try { store.save(); } catch (error) {
          user.settings = previous;
          if (hadPending) user.pendingSystemPromptInput = previousPending;
          throw error;
        }
        pendingTimeoutInput.delete(String(userId));
        view = 'system-prompt';
        notice = 'Стандартная инструкция восстановлена.';
      } else if (data === 'tn:sandbox') {
        if (user.settings && user.settings.sandbox === true) {
          const previous = user.settings;
          user.settings = { ...previous, sandbox: false, sandboxInternet: false };
          try { store.save(); } catch (error) { user.settings = previous; throw error; }
          notice = 'Песочница отключена. Сетевой доступ также выключен.';
        } else {
          view = 'sandbox-confirm';
          notice = 'Подтвердите включение JavaScript-песочницы.';
        }
      } else if (data === 'tn:sandbox:confirm') {
        const previous = user.settings || {};
        user.settings = { ...previous, sandbox: true, sandboxInternet: false };
        try { store.save(); } catch (error) { user.settings = previous; throw error; }
        notice = 'Песочница разрешена в Mini App. Сетевой доступ остаётся выключенным.';
      } else if (data === 'tn:sandbox:cancel') {
        view = 'main';
        notice = 'Включение песочницы отменено.';
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
      } else if (data === 'tn:back' || data === 'tn:refresh') {
        pendingTimeoutInput.delete(String(userId));
        clearModelCatalogState(user, true, userId);
        if (Object.prototype.hasOwnProperty.call(user, 'pendingSystemPromptInput')) {
          updatePendingSystemPromptInput(user, false);
        }
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

  async function sendSettings(chatId, user, userId) {
    user.id = String(userId == null ? (user.id || '') : userId);
    const sent = await sendTelegramMessage(chatId, settingsMessageText(user), {
      reply_markup: settingsKeyboard(user)
    });
    const messageId = sent && Number(sent.message_id);
    if (Number.isSafeInteger(messageId)) {
      try {
        await editTelegramRichMessage(
          chatId,
          messageId,
          settingsRichMessage(user),
          settingsMainReplyMarkup()
        );
      } catch {
        // Keep the compact text version and its keyboard if rich messages are unavailable.
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

      clearModelCatalogState(user, true);
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

    await sendTelegramMessage(message.chat.id,
      'Выбор модели теперь находится в общем каталоге. Откройте его кнопкой ниже. ' +
      'Для ручного выбора по ID используйте /model [ID модели].',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Открыть каталог моделей', callback_data: 'tn:model' }
          ]]
        }
      });
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

const TG_NEXUS_PRO_DAY_MS = 24 * 60 * 60 * 1000;
const TG_NEXUS_PRO_TRIAL_DAYS = 12;
const TG_NEXUS_PRO_PLANS = Object.freeze({
  7: { days: 7, stars: 49 },
  14: { days: 14, stars: 89 },
  21: { days: 21, stars: 119 },
  30: { days: 30, stars: 149 }
});
const TG_NEXUS_BILLING_SUPPORT_URL = 'https://t.me/TG_Nexus_official';
const proCheckoutReservations = new Map();

function normalizeProState(user) {
  if (!user.pro || typeof user.pro !== 'object' || Array.isArray(user.pro)) user.pro = {};
  const pro = user.pro;
  if (!Number.isFinite(Number(pro.expiresAt))) pro.expiresAt = 0;
  if (!Array.isArray(pro.payments)) pro.payments = [];
  if (!Array.isArray(pro.promoRedemptions)) pro.promoRedemptions = [];
  if (!Array.isArray(user.pendingStarPayments)) user.pendingStarPayments = [];
  return pro;
}

function isProBillingEnabled() {
  if (typeof options.proBillingEnabled === 'boolean') return options.proBillingEnabled;
  return String(process.env.PRO_BILLING_ENABLED || '').trim().toLowerCase() === 'true';
}

function ensureProTrial(userId, now = Date.now()) {
  const user = store.getUser(userId);
  const pro = normalizeProState(user);
  if (Number(pro.trialStartedAt) > 0) return getProStatus(userId, now);
  const previous = {
    trialStartedAt: pro.trialStartedAt,
    trialExpiresAt: pro.trialExpiresAt,
    expiresAt: pro.expiresAt
  };
  pro.trialStartedAt = now;
  pro.trialExpiresAt = now + TG_NEXUS_PRO_TRIAL_DAYS * TG_NEXUS_PRO_DAY_MS;
  pro.expiresAt = Math.max(now, Number(pro.expiresAt) || 0) +
    TG_NEXUS_PRO_TRIAL_DAYS * TG_NEXUS_PRO_DAY_MS;
  try {
    store.save();
  } catch (error) {
    if (previous.trialStartedAt === undefined) delete pro.trialStartedAt;
    else pro.trialStartedAt = previous.trialStartedAt;
    if (previous.trialExpiresAt === undefined) delete pro.trialExpiresAt;
    else pro.trialExpiresAt = previous.trialExpiresAt;
    if (previous.expiresAt === undefined) delete pro.expiresAt;
    else pro.expiresAt = previous.expiresAt;
    throw error;
  }
  return getProStatus(userId, now);
}

function getProStatus(userId, now = Date.now()) {
  const user = store.getUser(userId);
  const pro = normalizeProState(user);
  const expiresAt = Math.max(0, Number(pro.expiresAt) || 0);
  const trialExpiresAt = Math.max(0, Number(pro.trialExpiresAt) || 0);
  const payments = pro.payments;
  const promoRedemptions = pro.promoRedemptions;
  const active = expiresAt > now;
  const trialActive = active && trialExpiresAt > now &&
    payments.length === 0 && promoRedemptions.length === 0;
  return {
    active,
    expiresAt,
    remainingDays: active ? Math.ceil((expiresAt - now) / TG_NEXUS_PRO_DAY_MS) : 0,
    trialStartedAt: Number(pro.trialStartedAt) || 0,
    trialExpiresAt,
    trialActive,
    hasPaidPayments: payments.length > 0,
    hasPromoRedemptions: promoRedemptions.length > 0
  };
}

function formatProDate(timestamp) {
  if (!Number.isFinite(Number(timestamp)) || Number(timestamp) <= 0) return 'не указана';
  return new Date(Number(timestamp)).toLocaleString('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function isBillingAdmin(userId) {
  const configured = String(options.adminIds == null ? (process.env.BOT_ADMIN_IDS || '') : options.adminIds);
  return configured.split(',').map((item) => item.trim()).filter(Boolean)
    .includes(String(userId));
}

async function sendProMenu(chatId, userId) {
  const status = getProStatus(userId);
  const lines = [
    '<b>TG Nexus PRO</b>',
    '',
    'Бесплатный пробный период: 12 дней на один Telegram-аккаунт.',
    status.active
      ? 'Доступ активен: до ' + formatProDate(status.expiresAt) +
        ' (ещё ' + status.remainingDays + ' дн.).'
      : 'Активного PRO-доступа сейчас нет.',
    '',
    'Тарифы:',
    '• 7 дней — 49 ⭐',
    '• 14 дней — 89 ⭐',
    '• 21 день — 119 ⭐',
    '• 30 дней — 149 ⭐',
    '',
    'Покупки разовые: автоматического списания нет.',
    'Новые дни добавляются к текущему сроку доступа.',
    'Расходы на API-провайдеров оплачиваются отдельно.'
  ];
  const optionsForMenu = { parse_mode: 'HTML' };
  if (isProBillingEnabled()) {
    optionsForMenu.reply_markup = {
      inline_keyboard: [
        [
          { text: '7 дней · 49 ⭐', callback_data: 'pro:buy:7' },
          { text: '14 дней · 89 ⭐', callback_data: 'pro:buy:14' }
        ],
        [
          { text: '21 день · 119 ⭐', callback_data: 'pro:buy:21' },
          { text: '30 дней · 149 ⭐', callback_data: 'pro:buy:30' }
        ]
      ]
    };
  } else {
    lines.push('', 'Оплата пока отключена и не принимает Stars.');
  }
  await sendTelegramMessage(chatId, lines.join('\n'), optionsForMenu);
}

async function sendProStatus(chatId, userId) {
  const status = getProStatus(userId);
  const user = store.getUser(userId);
  const pro = normalizeProState(user);
  const lines = ['<b>Ваш TG Nexus PRO</b>', ''];
  if (status.active) {
    lines.push('Статус: активен', 'Действует до: ' + formatProDate(status.expiresAt),
      'Осталось: ' + status.remainingDays + ' дн.');
    if (status.trialActive) lines.push('Это ваш бесплатный 12-дневный период.');
  } else {
    lines.push('Статус: не активен', 'Используйте /pro, чтобы посмотреть тарифы.');
  }
  if (pro.payments.length) {
    lines.push('', '<b>Последние покупки:</b>');
    pro.payments.slice(-5).reverse().forEach((payment) => {
      lines.push('• ' + payment.days + ' дн. · ' + payment.amount + ' ⭐ · ' +
        formatProDate(payment.paidAt));
    });
  }
  if (pro.promoRedemptions.length) {
    lines.push('', 'Активировано промокодов: ' + pro.promoRedemptions.length + '.');
  }
  await sendTelegramMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function createProInvoice(chatId, userId, days) {
  const plan = TG_NEXUS_PRO_PLANS[Number(days)];
  if (!plan) throw new Error('Unknown PRO plan.');
  if (!isProBillingEnabled()) throw new Error('PRO billing is not enabled.');

  const user = store.getUser(userId);
  normalizeProState(user);
  const now = Date.now();
  user.pendingStarPayments = user.pendingStarPayments
    .filter((item) => item && Number(item.expiresAt) > now)
    .slice(-10);
  const payload = 'tgnexuspro1_' + crypto.randomBytes(18).toString('hex');
  user.pendingStarPayments.push({
    payload,
    days: plan.days,
    amount: plan.stars,
    currency: 'XTR',
    createdAt: now,
    expiresAt: now + 24 * 60 * 60 * 1000
  });
  store.save();

  try {
    await telegramRequest('sendInvoice', {
      chat_id: chatId,
      title: 'TG Nexus PRO',
      description: 'Доступ к TG Nexus PRO на ' + plan.days + ' дней.',
      payload,
      currency: 'XTR',
      prices: [{ label: 'TG Nexus PRO · ' + plan.days + ' дней', amount: plan.stars }]
    });
  } catch (error) {
    user.pendingStarPayments = user.pendingStarPayments.filter((item) => item.payload !== payload);
    store.save();
    throw error;
  }
  return { payload, days: plan.days, amount: plan.stars };
}

async function handleProCallback(query, user) {
  const match = String(query.data || '').match(/^pro:buy:(7|14|21|30)$/);
  if (!match) {
    await safeAnswerCallback(query.id, 'Эта кнопка тарифа устарела. Откройте /pro ещё раз.');
    return true;
  }
  if (!isProBillingEnabled()) {
    await safeAnswerCallback(query.id, 'Оплата пока отключена.');
    return true;
  }
  try {
    await createProInvoice(query.message.chat.id, query.from.id, Number(match[1]));
    await safeAnswerCallback(query.id, 'Счёт отправлен. Завершите оплату в Telegram.');
  } catch {
    await safeAnswerCallback(query.id, 'Не удалось создать счёт. Попробуйте позже или обратитесь в /paysupport.');
  }
  return true;
}

async function handlePreCheckoutQuery(query) {
  const queryId = String(query && query.id || '');
  const userId = query && query.from && query.from.id;
  const payload = String(query && query.invoice_payload || '');
  let valid = false;
  let user = null;
  let pending = null;
  let errorMessage = 'Счёт недействителен или устарел. Откройте /pro и создайте новый.';

  if (queryId && userId != null && payload && isProBillingEnabled()) {
    user = store.getUser(userId);
    normalizeProState(user);
    pending = user.pendingStarPayments.find((item) => item && item.payload === payload) || null;
    const now = Date.now();
    const reserved = proCheckoutReservations.get(String(userId));
    const reservedStillActive = reserved && reserved.expiresAt > now;
    const termsAccepted = user.termsAcceptedVersion === REQUIRED_TERMS_VERSION;
    const fresh = pending && Number(pending.expiresAt) > now;
    const correctAmount = pending && query.currency === 'XTR' &&
      Number(query.total_amount) === Number(pending.amount);
    const notReservedForAnotherInvoice = !reservedStillActive || reserved.payload === payload;

    valid = Boolean(termsAccepted && fresh && correctAmount && notReservedForAnotherInvoice);
    if (!termsAccepted) errorMessage = 'Сначала примите актуальные Terms of Service через /start.';
    else if (reservedStillActive && reserved.payload !== payload) {
      errorMessage = 'У вас уже есть оплата в процессе. Завершите её или попробуйте позже.';
    } else if (fresh && !correctAmount) errorMessage = 'Сумма счёта не совпадает с тарифом.';
  } else if (!isProBillingEnabled()) {
    errorMessage = 'Оплата TG Nexus PRO временно отключена.';
  }

  await telegramRequest('answerPreCheckoutQuery', {
    pre_checkout_query_id: queryId,
    ok: valid,
    ...(!valid ? { error_message: errorMessage } : {})
  }, { timeoutMs: 8_000 });

  if (valid) {
    proCheckoutReservations.set(String(userId), {
      payload,
      expiresAt: Date.now() + 15 * 60 * 1000
    });
  }
  return valid;
}

async function handleSuccessfulPayment(message) {
  const userId = message && message.from && message.from.id;
  const chatId = message && message.chat && message.chat.id;
  const payment = message && message.successful_payment;
  if (userId == null || chatId == null || !payment) return false;

  const user = store.getUser(userId);
  const pro = normalizeProState(user);
  const chargeId = String(payment.telegram_payment_charge_id || '');
  const alreadyApplied = chargeId && pro.payments.some((item) =>
    item && item.telegramPaymentChargeId === chargeId);
  if (alreadyApplied) {
    await sendText(chatId, 'Эта оплата уже была учтена. Статус: /mypro');
    return true;
  }

  const payload = String(payment.invoice_payload || '');
  const pendingIndex = user.pendingStarPayments.findIndex((item) =>
    item && item.payload === payload);
  const pending = pendingIndex >= 0 ? user.pendingStarPayments[pendingIndex] : null;
  if (!pending || payment.currency !== 'XTR' ||
      Number(payment.total_amount) !== Number(pending.amount) || !chargeId) {
    await sendText(chatId,
      'Платёж получен, но не удалось сопоставить его с тарифом. Не оплачивайте повторно; обратитесь в /paysupport.');
    return true;
  }

  const now = Date.now();
  const previousExpiry = Number(pro.expiresAt) || 0;
  const previousPayments = pro.payments.slice();
  const previousPending = user.pendingStarPayments.slice();
  const baseExpiry = Math.max(now, previousExpiry);
  const nextExpiry = baseExpiry + Number(pending.days) * TG_NEXUS_PRO_DAY_MS;
  pro.expiresAt = nextExpiry;
  pro.payments.push({
    telegramPaymentChargeId: chargeId,
    amount: Number(pending.amount),
    currency: 'XTR',
    days: Number(pending.days),
    paidAt: now,
    expiresAt: nextExpiry
  });
  if (pro.payments.length > 100) pro.payments.splice(0, pro.payments.length - 100);
  user.pendingStarPayments = [];
  try {
    store.save();
  } catch (error) {
    pro.expiresAt = previousExpiry;
    pro.payments = previousPayments;
    user.pendingStarPayments = previousPending;
    throw error;
  }
  proCheckoutReservations.delete(String(userId));

  await sendText(chatId, [
    'TG Nexus PRO активирован!',
    'Добавлено: ' + pending.days + ' дней.',
    'Доступ действует до: ' + formatProDate(nextExpiry),
    'Текущий статус: /mypro'
  ].join('\n'));
  return true;
}

async function handlePromoCreateCommand(chatId, userId, args) {
  if (!isBillingAdmin(userId)) {
    await sendText(chatId, 'Эта команда доступна только администратору.');
    return true;
  }
  const parts = String(args || '').trim().split(/\s+/);
  const code = parts[0] || '';
  const days = Number(parts[1]);
  const maxUses = parts[2] === undefined ? 1 : Number(parts[2]);
  const result = store.createPromoCode(code, { days, maxUses, createdBy: userId });
  if (!result.ok) {
    const messages = {
      invalid_code: 'Код: 4–32 символа A–Z, 0–9, _ или -.',
      invalid_days: 'Количество дней должно быть от 1 до 365.',
      invalid_limit: 'Лимит должен быть от 0 до 100000; 0 означает без лимита.',
      exists: 'Такой промокод уже существует.'
    };
    await sendText(chatId, messages[result.reason] || 'Не удалось создать промокод.');
    return true;
  }
  await sendText(chatId, 'Промокод ' + result.code + ' создан: ' + result.days +
    ' дней, использований: ' + (result.maxUses === 0 ? 'без лимита' : result.maxUses) + '.');
  return true;
}

async function handlePromoDisableCommand(chatId, userId, args) {
  if (!isBillingAdmin(userId)) {
    await sendText(chatId, 'Эта команда доступна только администратору.');
    return true;
  }
  const code = String(args || '').trim();
  if (!code) {
    await sendText(chatId, 'Использование: /promo_disable CODE');
    return true;
  }
  await sendText(chatId, store.disablePromoCode(code)
    ? 'Промокод отключён.'
    : 'Промокод не найден.');
  return true;
}

async function handlePromoListCommand(chatId, userId) {
  if (!isBillingAdmin(userId)) {
    await sendText(chatId, 'Эта команда доступна только администратору.');
    return true;
  }
  const list = store.listPromoCodes().slice(-30);
  if (!list.length) {
    await sendText(chatId, 'Промокодов пока нет.');
    return true;
  }
  await sendText(chatId, list.map((item) =>
    item.code + ' — ' + item.days + ' дн. · ' +
    (item.enabled ? 'активен' : 'отключён') + ' · ' +
    item.uses + '/' + (item.maxUses || '∞')
  ).join('\n'));
  return true;
}

  const pendingRegenerationRequests = new Set();

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

    const userMessage = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      role: 'user',
      content: text.slice(0, MAX_MESSAGE_LENGTH)
    };
    chat.messages.push(userMessage);
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
      await indicator.finishRich(buildAssistantRichMessage(
        'Не удалось получить ответ от ИИ за ' + elapsed + ' сек.\nПричина: ' + reason,
        userMessage.id,
        '🔄 Повторить запрос'
      ));
      return;
    }

    await indicator.finish();
    chat.messages.push({ id: crypto.randomUUID(), createdAt: Date.now(), role: 'assistant', content: answer });
    chat.updatedAt = Date.now();
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }
    store.save();
    await sendAssistantResponse(message.chat.id, answer, text, userMessage.id);
  }

  async function handleRegenerateCallback(query, user, data) {
    const match = String(data || '').match(/^regen:([0-9a-f-]{36})$/i);
    const message = query && query.message;
    const userId = query && query.from && query.from.id;
    if (!match || !message || !message.chat || userId == null) {
      await safeAnswerCallback(query.id, 'Эта кнопка устарела. Отправьте новый запрос.');
      return true;
    }

    const requestId = match[1];
    const lockKey = String(userId) + ':' + requestId;
    if (pendingRegenerationRequests.has(lockKey)) {
      await safeAnswerCallback(query.id, 'Этот ответ уже перегенерируется.');
      return true;
    }

    let targetChat = null;
    let promptIndex = -1;
    for (const candidate of Array.isArray(user.chats) ? user.chats : []) {
      if (!candidate || !Array.isArray(candidate.messages)) continue;
      const index = candidate.messages.findIndex((item) =>
        item && item.id === requestId && item.role === 'user');
      if (index >= 0) {
        targetChat = candidate;
        promptIndex = index;
        break;
      }
    }
    if (!targetChat || promptIndex < 0) {
      await safeAnswerCallback(query.id, 'Исходный запрос больше не найден. Отправьте его ещё раз.');
      return true;
    }
    if (!user.apiKey) {
      await safeAnswerCallback(query.id, 'API-ключ не настроен. Добавьте его командой /key.');
      return true;
    }
    if (!checkRateLimit(userId)) {
      await safeAnswerCallback(query.id, 'Слишком много запросов. Подождите минуту и повторите.');
      return true;
    }

    pendingRegenerationRequests.add(lockKey);
    try {
      await safeAnswerCallback(query.id, 'Перегенерирую ответ…');
      const indicator = await startGenerationIndicator(message.chat.id);
      const promptMessage = targetChat.messages[promptIndex];
      let answer;
      try {
        const requestChat = {
          ...targetChat,
          messages: targetChat.messages.slice(0, promptIndex + 1)
        };
        answer = await requestAssistant(user, requestChat);
      } catch (error) {
        const reason = sanitizeProviderError(error && error.message || 'Неизвестная ошибка провайдера.');
        await indicator.finishRich(buildAssistantRichMessage(
          'Не удалось перегенерировать ответ за ' + indicator.elapsedSeconds() +
            ' сек.\nПричина: ' + reason,
          requestId,
          '🔄 Повторить запрос'
        ));
        return true;
      }

      const assistantIndex = promptIndex + 1;
      const existingAssistant = targetChat.messages[assistantIndex] &&
        targetChat.messages[assistantIndex].role === 'assistant'
        ? targetChat.messages[assistantIndex]
        : null;
      const previousUpdatedAt = targetChat.updatedAt;
      const previousAssistant = existingAssistant
        ? { content: existingAssistant.content, createdAt: existingAssistant.createdAt }
        : null;
      let assistantMessage = existingAssistant;
      try {
        if (assistantMessage) {
          assistantMessage.content = answer;
          assistantMessage.createdAt = Date.now();
        } else {
          assistantMessage = {
            id: crypto.randomUUID(),
            createdAt: Date.now(),
            role: 'assistant',
            content: answer
          };
          targetChat.messages.splice(assistantIndex, 0, assistantMessage);
        }
        targetChat.updatedAt = Date.now();
        if (targetChat.messages.length > MAX_MESSAGES_PER_CHAT) {
          targetChat.messages.splice(0, targetChat.messages.length - MAX_MESSAGES_PER_CHAT);
        }
        store.save();
      } catch (error) {
        if (existingAssistant && previousAssistant) {
          existingAssistant.content = previousAssistant.content;
          existingAssistant.createdAt = previousAssistant.createdAt;
        } else if (!existingAssistant && assistantMessage) {
          const insertedIndex = targetChat.messages.indexOf(assistantMessage);
          if (insertedIndex >= 0) targetChat.messages.splice(insertedIndex, 1);
        }
        targetChat.updatedAt = previousUpdatedAt;
        await indicator.finishRich(buildAssistantRichMessage(
          'Ответ получен, но не удалось сохранить его в историю. Повторите попытку.',
          requestId,
          '🔄 Повторить запрос'
        ));
        return true;
      }

      await indicator.finish();
      const messageId = Number(message.message_id);
      if (!isCodeArtifactRequest(promptMessage.content) &&
          splitAssistantRichMarkdown(answer).length === 1 &&
          Number.isSafeInteger(messageId)) {
        try {
          await editTelegramRichMessage(
            message.chat.id,
            messageId,
            buildAssistantRichMessage(answer, requestId)
          );
          return true;
        } catch (error) {
          const description = String(error && (error.telegramDescription || error.message) || '');
          if (/message is not modified/i.test(description)) return true;
        }
      }

      if (Number.isSafeInteger(messageId)) {
        try {
          await editTelegramRichMessage(message.chat.id, messageId, {
            markdown: 'Новая версия ответа сформирована и отправлена ниже.'
          });
        } catch {}
      }
      await sendAssistantResponse(message.chat.id, answer, promptMessage.content, requestId);
      return true;
    } finally {
      pendingRegenerationRequests.delete(lockKey);
    }
  }

  async function processMessage(message, parsed, text) {
    const chatId = message.chat.id;
    const command = parsed && parsed.name;

    if (command === 'start' || command === 'help') return false;
    if (command === 'cancel') {
      const inputKey = String(message.from.id);
      let user = null;
      if (store.enabled) {
        try { user = store.getUser(message.from.id); } catch {}
      }
      const promptPending = !!(user && user.pendingSystemPromptInput);
      const timeoutPending = pendingTimeoutInput.has(inputKey);
      const modelSearchPending = pendingModelCatalogSearches.has(inputKey) ||
        !!(user && user.pendingModelCatalogSearch);
      const adminInputPending = pendingAdminInput.has(inputKey);
      if (adminInputPending) pendingAdminInput.delete(inputKey);
      pendingModelCatalogSearches.delete(inputKey);
      const previousPrompt = user && user.pendingSystemPromptInput;
      const previousModelSearch = user && user.pendingModelCatalogSearch;
      if (user && promptPending) delete user.pendingSystemPromptInput;
      if (user && modelSearchPending) delete user.pendingModelCatalogSearch;
      if (user && (promptPending || modelSearchPending)) {
        try { store.save(); } catch (error) {
          if (promptPending) user.pendingSystemPromptInput = previousPrompt;
          if (modelSearchPending) user.pendingModelCatalogSearch = previousModelSearch;
          if (modelSearchPending) pendingModelCatalogSearches.set(inputKey, previousModelSearch);
          throw error;
        }
      }
      pendingTimeoutInput.delete(inputKey);
      const notice = adminInputPending
        ? 'Ввод админ-панели отменён.'
        : promptPending
        ? 'Ввод инструкции ИИ отменён.'
        : timeoutPending
          ? 'Ввод тайм-аута отменён.'
          : modelSearchPending
            ? 'Поиск модели отменён.'
            : 'Сейчас нет активного ввода настройки.';
      await sendText(chatId, notice);
      return true;
    }
    if (command === 'version') {
      await sendText(chatId, 'В1 Release');
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
        '/model [ID модели] — выбрать вручную; без аргумента открыть каталог\n' +
        '/test — проверить реальный запрос к API\n' +
        '/version — показать версию backend\n' +
        '/settings — показать настройки ИИ и открыть Mini App\n' +
        '/pro — тарифы TG Nexus PRO\n' +
        '/mypro — статус и срок PRO\n' +
        '/promocode CODE — активировать промокод\n' +
        '/paysupport — помощь с платежами\n' +
        '/cancel — отменить текущий ввод настройки\n\n' +
        'Created tet0r');
      return true;
    }
    if (command === 'key') {
      await handleKeyCommand(message, parsed.args);
      return true;
    }
    if (command && !['chat', 'add_chat', 'chat_equip', 'model', 'settings', 'provider', 'test',
      'pro', 'mypro', 'promocode', 'paysupport', 'promo_create', 'promo_disable', 'promo_list'].includes(command)) {
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

      const pendingAdmin = pendingAdminInput.get(String(message.from.id));
      if (pendingAdmin) {
        if (!isBillingAdmin(message.from.id)) {
          pendingAdminInput.delete(String(message.from.id));
          await sendText(chatId, 'Доступ к этому действию отозван.');
          return true;
        }
        if (!Number.isFinite(Number(pendingAdmin.createdAt)) ||
            Date.now() - Number(pendingAdmin.createdAt) > 10 * 60_000) {
          pendingAdminInput.delete(String(message.from.id));
          await sendText(chatId, 'Время ввода истекло. Откройте админ-панель снова.');
          return true;
        }
        if (command) {
          pendingAdminInput.delete(String(message.from.id));
        } else if (pendingAdmin.type === 'promo_create') {
          const parts = text.trim().split(/\s+/);
          const code = parts[0] || '';
          const days = Number(parts[1]);
          const maxUses = parts[2] === undefined ? 1 : Number(parts[2]);
          const result = store.createPromoCode(code, {
            days, maxUses, createdBy: message.from.id
          });
          if (!result.ok) {
            const errors = {
              invalid_code: 'Код должен содержать 4–32 символа A–Z, 0–9, _ или -.',
              invalid_days: 'Срок должен быть целым числом от 1 до 365 дней.',
              invalid_limit: 'Лимит должен быть от 0 до 100000. Ноль означает без лимита.',
              exists: 'Такой промокод уже существует.'
            };
            await sendText(chatId, errors[result.reason] || 'Не удалось создать промокод.');
            return true;
          }
          pendingAdminInput.delete(String(message.from.id));
          store.appendAdminLog({
            actorId: message.from.id,
            action: 'promo_create',
            summary: 'Создан промокод ' + result.code + ' на ' + result.days + ' дн.'
          });
          await sendAdminPanel(chatId, message.from.id, 'promos');
          return true;
        } else if (pendingAdmin.type === 'user_search') {
          const targetId = text.trim();
          if (!/^\d{1,24}$/.test(targetId)) {
            await sendText(chatId, 'Telegram ID должен содержать только цифры. Повторите ввод или отправьте /cancel.');
            return true;
          }
          pendingAdminInput.delete(String(message.from.id));
          if (!store.getAdminUser(targetId)) {
            await sendText(chatId, 'Пользователь не найден.');
            await sendAdminPanel(chatId, message.from.id, 'users', 0);
            return true;
          }
          await sendAdminPanel(chatId, message.from.id, 'user', 0, targetId);
          return true;
        }
      }
      if (command === 'pro') { await sendProMenu(chatId, message.from.id); return true; }
      if (command === 'mypro') { await sendProStatus(chatId, message.from.id); return true; }
      if (command === 'promocode') {
        if (!parsed.args) { await sendText(chatId, 'Использование: /promocode CODE'); return true; }
        const result = store.redeemPromoCode(parsed.args, message.from.id);
        const response = {
          not_found: 'Промокод не найден.', disabled: 'Промокод отключён.',
          expired: 'Срок действия промокода истёк.', already_used: 'Вы уже активировали этот промокод.',
          limit: 'Лимит активаций промокода исчерпан.', invalid: 'Промокод имеет некорректные настройки.'
        };
        await sendText(chatId, result.ok
          ? 'Промокод активирован: +' + result.days + ' дней PRO. Доступ до ' + formatProDate(result.expiresAt) + '.'
          : (response[result.reason] || 'Не удалось активировать промокод.'));
        return true;
      }
      if (command === 'paysupport') {
        await sendText(chatId, 'Помощь с платежами TG Nexus: ' + TG_NEXUS_BILLING_SUPPORT_URL +
          '\nНе отправляйте API-ключи или пароли. Для проверки платежа приложите чек Telegram и дату покупки.');
        return true;
      }
      if (command === 'promo_create') return await handlePromoCreateCommand(chatId, message.from.id, parsed.args);
      if (command === 'promo_disable') return await handlePromoDisableCommand(chatId, message.from.id, parsed.args);
      if (command === 'promo_list') return await handlePromoListCommand(chatId, message.from.id);
      if (!command && await handlePendingModelCatalogReply(message, user, text)) return true;
      const timeoutInputKey = String(message.from.id);
      const pendingPrompt = user.pendingSystemPromptInput;
      if (pendingPrompt && !command) {
        const createdAt = Number(pendingPrompt.createdAt);
        if (!Number.isFinite(createdAt) || createdAt <= 0 || Date.now() - createdAt > 10 * 60_000) {
          delete user.pendingSystemPromptInput;
          try { store.save(); } catch (error) {
            user.pendingSystemPromptInput = pendingPrompt;
            throw error;
          }
          await sendText(chatId, 'Время ввода истекло. Откройте /settings и нажмите «Инструкция ИИ» снова.');
          return true;
        }
        if (text.length > MAX_SYSTEM_PROMPT_LENGTH) {
          await sendText(chatId, 'Инструкция слишком длинная. Максимум — ' + MAX_SYSTEM_PROMPT_LENGTH +
            ' символов. Отправьте сокращённый вариант или /cancel.');
          return true;
        }
        const previous = user.settings || {};
        user.settings = { ...previous, systemPrompt: text };
        delete user.pendingSystemPromptInput;
        try { store.save(); } catch (error) {
          user.settings = previous;
          user.pendingSystemPromptInput = pendingPrompt;
          throw error;
        }
        await sendText(chatId, 'Инструкция ИИ сохранена (' + text.length + ' символов).');
        await sendSettings(chatId, user, message.from.id);
        return true;
      }
      if (pendingPrompt && command) {
        delete user.pendingSystemPromptInput;
        try { store.save(); } catch (error) {
          user.pendingSystemPromptInput = pendingPrompt;
          throw error;
        }
      }
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
        await sendSettings(chatId, user, message.from.id);
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
        await sendSettings(chatId, user, message.from.id);
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
      } else if (entry.kind === 'rich_message') {
        await rawSendTelegramRichMessage(entry.chatId, entry.richMessage, entry.options || {});
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

  async function sendRichMessage(chatId, richMessage, sendOptions = {}) {
    return sendTelegramRichMessage(chatId, richMessage, sendOptions);
  }

const MODEL_CATALOG_PAGE_SIZE = 8;
const MODEL_CATALOG_SESSION_TTL = 5 * 60_000;
const MODEL_CATALOG_SEARCH_TTL = 5 * 60_000;
const MODEL_CATALOG_REQUEST_TIMEOUT_MS = 18_000;
const modelCatalogSessions = new Map();
const pendingModelCatalogSearches = new Map();

function modelCatalogKey(userId) {
  return String(userId);
}

function looksLikeApiKey(value) {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.length > 2_048 || /\s/.test(candidate)) return false;
  return [
    /^sk-(?:or-v1-|ant-api\d+-|proj-)?[a-z0-9_-]{12,}$/i,
    /^gsk_[a-z0-9_-]{16,}$/i,
    /^AIza[a-z0-9_-]{20,}$/i,
    /^xai-[a-z0-9_-]{16,}$/i,
    /^pplx-[a-z0-9_-]{16,}$/i,
    /^voyage-[a-z0-9_-]{16,}$/i
  ].some((pattern) => pattern.test(candidate));
}

function getModelCatalogSession(userId) {
  const key = modelCatalogKey(userId);
  const session = modelCatalogSessions.get(key);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    modelCatalogSessions.delete(key);
    return null;
  }
  session.expiresAt = Date.now() + MODEL_CATALOG_SESSION_TTL;
  return session;
}

function trimModelCatalogSessions() {
  for (const [key, value] of modelCatalogSessions) {
    if (!value || value.expiresAt <= Date.now()) modelCatalogSessions.delete(key);
  }
  while (modelCatalogSessions.size > 100) {
    modelCatalogSessions.delete(modelCatalogSessions.keys().next().value);
  }
  for (const [key, value] of pendingModelCatalogSearches) {
    if (!value || value.expiresAt <= Date.now()) pendingModelCatalogSearches.delete(key);
  }
  while (pendingModelCatalogSearches.size > 100) {
    pendingModelCatalogSearches.delete(pendingModelCatalogSearches.keys().next().value);
  }
}

function modelProviderFromSession(user, session) {
  const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
  return profile && session && profile.id === session.providerId &&
    normalizeApiBase(profile.url) === session.providerUrl;
}

function normalizeSavedModelCatalogFilters(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const validSorts = ['popular', 'price', 'context', 'speed'];
  return {
    free: source.free === true,
    minContext: [0, 131072, 262144, 1000000].includes(Number(source.minContext))
      ? Number(source.minContext) : 0,
    image: source.image === true,
    file: source.file === true,
    audio: source.audio === true,
    reasoning: source.reasoning === true,
    tools: source.tools === true,
    sort: validSorts.includes(source.sort) ? source.sort : 'popular'
  };
}

function saveModelCatalogState(user, session) {
  const previous = user.modelCatalogState;
  const next = {
    providerId: String(session.providerId || ''),
    providerUrl: String(session.providerUrl || ''),
    chatId: Number(session.chatId),
    messageId: Number(session.messageId),
    query: String(session.query || '').slice(0, 100),
    page: Math.max(0, Math.min(999, Math.round(Number(session.page) || 0))),
    filters: normalizeSavedModelCatalogFilters(session.filters),
    selectedModelId: session.selected && typeof session.selected.id === 'string'
      ? session.selected.id.slice(0, 256) : '',
    manualOnly: session.manualOnly === true,
    expiresAt: Date.now() + MODEL_CATALOG_SESSION_TTL
  };
  user.modelCatalogState = next;
  try {
    store.save();
  } catch (error) {
    if (previous === undefined) delete user.modelCatalogState;
    else user.modelCatalogState = previous;
    throw error;
  }
  session.expiresAt = next.expiresAt;
  return next;
}

function clearModelCatalogState(user, clearPending = true, userId = user.id) {
  const previousState = user.modelCatalogState;
  const previousPending = user.pendingModelCatalogSearch;
  if (previousState !== undefined) delete user.modelCatalogState;
  if (clearPending && previousPending !== undefined) delete user.pendingModelCatalogSearch;
  const key = modelCatalogKey(userId);
  modelCatalogSessions.delete(key);
  if (clearPending) pendingModelCatalogSearches.delete(key);
  if (previousState === undefined && (!clearPending || previousPending === undefined)) return false;
  try {
    store.save();
  } catch (error) {
    if (previousState !== undefined) user.modelCatalogState = previousState;
    if (previousPending !== undefined) user.pendingModelCatalogSearch = previousPending;
    throw error;
  }
  return true;
}

async function restoreModelCatalogSession(user, message, userId = user.id, options = {}) {
  const saved = user && user.modelCatalogState;
  if (!saved || typeof saved !== 'object' || Number(saved.expiresAt) <= Date.now()) {
    if (saved) clearModelCatalogState(user, false, userId);
    return null;
  }
  const messageId = Number(message && message.message_id);
  const chatId = Number(message && message.chat && message.chat.id);
  if (!Number.isSafeInteger(messageId) || !Number.isSafeInteger(chatId) ||
      messageId !== Number(saved.messageId) || chatId !== Number(saved.chatId)) return null;

  const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
  if (!profile || profile.id !== saved.providerId ||
      normalizeApiBase(profile.url) !== saved.providerUrl) return null;

  const filters = normalizeSavedModelCatalogFilters(saved.filters);
  const manualOnly = saved.manualOnly === true || profile.modelsEndpoint === false;
  let models = [];
  const skipFetch = options && options.skipFetch === true;
  if (!manualOnly && !skipFetch) {
    const result = await fetchModelCatalogForUser(user, String(saved.query || '').slice(0, 100), filters.sort);
    models = result.models;
  }
  const session = {
    providerId: profile.id,
    providerUrl: normalizeApiBase(profile.url),
    chatId,
    messageId,
    models,
    visibleModels: [],
    query: String(saved.query || '').slice(0, 100),
    page: Math.max(0, Math.min(999, Math.round(Number(saved.page) || 0))),
    filters,
    selected: null,
    manualOnly,
    expiresAt: Date.now() + MODEL_CATALOG_SESSION_TTL
  };
  if (!skipFetch && saved.selectedModelId && typeof saved.selectedModelId === 'string') {
    const fallback = models.find((item) => item.id === saved.selectedModelId) ||
      MODEL_CATALOG.normalizeModel({ id: saved.selectedModelId }, profile.id);
    session.selected = await fetchModelDetailsForUser(user, saved.selectedModelId, fallback);
  }
  prepareModelCatalogView(session);
  modelCatalogSessions.set(modelCatalogKey(userId), session);
  trimModelCatalogSessions();
  saveModelCatalogState(user, session);
  return session;
}

function prepareModelCatalogView(session) {
  const source = Array.isArray(session.models) ? session.models : [];
  const filtered = MODEL_CATALOG.filterModels(source, {
    query: session.query,
    free: session.filters.free,
    minContext: session.filters.minContext,
    image: session.filters.image,
    file: session.filters.file,
    audio: session.filters.audio,
    reasoning: session.filters.reasoning,
    tools: session.filters.tools
  });
  session.visibleModels = MODEL_CATALOG.sortModels(filtered, session.filters.sort);
  const maxPage = Math.max(0, Math.ceil(session.visibleModels.length / MODEL_CATALOG_PAGE_SIZE) - 1);
  session.page = Math.max(0, Math.min(maxPage, Number(session.page) || 0));
  return session.visibleModels;
}

function modelCatalogButton(text, callbackData, style) {
  const button = { text: String(text).slice(0, 48), callback_data: callbackData };
  if (style) button.style = style;
  return button;
}

function modelCatalogBlocksParagraph(text) {
  return { type: 'paragraph', text: String(text || '') };
}

function modelCatalogBlocksHeading(text, size = 2) {
  return { type: 'heading', text: String(text || ''), size };
}

function modelCatalogBlocksButtons(buttons, align = 'center') {
  return { type: 'buttons', buttons: buttons.slice(0, 8), align };
}

function modelCatalogRich(blocks) {
  return { blocks };
}

function modelCatalogHomeRich(session, user) {
  const models = prepareModelCatalogView(session);
  const providerLabel = currentProviderName(user);
  const popularLabel = session.providerId === 'openrouter' ? 'Популярные модели' : 'Модели провайдера';
  const blocks = [
    modelCatalogBlocksHeading('Выбор ИИ', 1),
    modelCatalogBlocksParagraph('Провайдер: ' + providerLabel),
    modelCatalogBlocksButtons([
      modelCatalogButton('Поиск', 'mc:search', 'primary'),
      modelCatalogButton('Фильтры', 'mc:filters')
    ]),
    modelCatalogBlocksHeading(popularLabel, 2)
  ];

  const popular = models.slice(0, 4);
  if (!popular.length) {
    blocks.push(modelCatalogBlocksParagraph(
      session.query ? 'По запросу ничего не найдено.' : 'Провайдер не вернул модели. Можно попробовать поиск или ввести ID вручную.'
    ));
  } else {
    for (let index = 0; index < popular.length; index += 2) {
      blocks.push(modelCatalogBlocksButtons(popular.slice(index, index + 2).map((model) => {
        const absoluteIndex = popular.indexOf(model);
        const marker = model.id === currentUserModel(user) ? '✓ ' : '';
        return modelCatalogButton(marker + (model.name || model.id), 'mc:model:' + absoluteIndex);
      })));
    }
  }

  if (session.query) {
    blocks.push(modelCatalogBlocksParagraph('Поиск: ' + session.query));
    blocks.push(modelCatalogBlocksButtons([
      modelCatalogButton('Все результаты (' + models.length + ')', 'mc:all'),
      modelCatalogButton('Очистить поиск', 'mc:clear-search')
    ]));
  } else {
    blocks.push(modelCatalogBlocksButtons([
      modelCatalogButton('Все модели (' + models.length + ')', 'mc:all')
    ]));
  }
  if (session.filters.free || session.filters.minContext || session.filters.image ||
      session.filters.file || session.filters.audio || session.filters.reasoning || session.filters.tools) {
    blocks.push(modelCatalogBlocksParagraph('Активны фильтры. Найдено моделей: ' + models.length + '.'));
  }
  blocks.push(modelCatalogBlocksButtons([
    modelCatalogButton('← Настройки', 'tn:back')
  ]));
  blocks.push({ type: 'footer', text: 'Данные получены от API выбранного провайдера. Сведения могут отличаться в зависимости от сервиса.' });
  return modelCatalogRich(blocks);
}

function modelCatalogResultsRich(session, user) {
  const models = prepareModelCatalogView(session);
  const start = session.page * MODEL_CATALOG_PAGE_SIZE;
  const visible = models.slice(start, start + MODEL_CATALOG_PAGE_SIZE);
  const maxPage = Math.max(1, Math.ceil(models.length / MODEL_CATALOG_PAGE_SIZE));
  const blocks = [
    modelCatalogBlocksHeading('Модели', 1),
    modelCatalogBlocksParagraph('Провайдер: ' + currentProviderName(user) +
      ' · Найдено: ' + models.length + (session.query ? ' · Поиск: ' + session.query : ''))
  ];
  if (!visible.length) {
    blocks.push(modelCatalogBlocksParagraph('Нет моделей, соответствующих выбранным условиям.'));
  } else {
    for (let index = 0; index < visible.length; index += 2) {
      blocks.push(modelCatalogBlocksButtons(visible.slice(index, index + 2).map((model) => {
        const absoluteIndex = start + index + visible.slice(index, index + 2).indexOf(model);
        const marker = model.id === currentUserModel(user) ? '✓ ' : '';
        return modelCatalogButton(marker + (model.name || model.id), 'mc:model:' + absoluteIndex);
      })));
    }
  }
  const navigation = [];
  if (session.page > 0) navigation.push(modelCatalogButton('← Назад', 'mc:page:' + (session.page - 1)));
  navigation.push(modelCatalogButton((session.page + 1) + ' / ' + maxPage, 'mc:filters'));
  if (session.page + 1 < maxPage) navigation.push(modelCatalogButton('Далее →', 'mc:page:' + (session.page + 1)));
  if (navigation.length) blocks.push(modelCatalogBlocksButtons(navigation));
  blocks.push(modelCatalogBlocksButtons([
    modelCatalogButton('Поиск', 'mc:search'),
    modelCatalogButton('Фильтры', 'mc:filters'),
    modelCatalogButton('К началу', 'mc:home')
  ]));
  blocks.push(modelCatalogBlocksButtons([modelCatalogButton('← Настройки', 'tn:back')]));
  return modelCatalogRich(blocks);
}

function modelCatalogFiltersRich(session) {
  const f = session.filters;
  const tick = (active) => active ? '✓ ' : '';
  const blocks = [
    modelCatalogBlocksHeading('Фильтры моделей', 1),
    modelCatalogBlocksParagraph('Можно включить несколько фильтров одновременно. Неизвестные характеристики не считаются подтверждёнными.'),
    modelCatalogBlocksButtons([
      modelCatalogButton(tick(f.free) + 'Бесплатные', 'mc:toggle:free', f.free ? 'success' : undefined),
      modelCatalogButton(tick(f.image) + 'Изображения', 'mc:toggle:image', f.image ? 'success' : undefined)
    ]),
    modelCatalogBlocksButtons([
      modelCatalogButton(tick(f.file) + 'Файлы', 'mc:toggle:file', f.file ? 'success' : undefined),
      modelCatalogButton(tick(f.audio) + 'Аудио', 'mc:toggle:audio', f.audio ? 'success' : undefined)
    ]),
    modelCatalogBlocksButtons([
      modelCatalogButton(tick(f.reasoning) + 'Рассуждения', 'mc:toggle:reasoning', f.reasoning ? 'success' : undefined),
      modelCatalogButton(tick(f.tools) + 'Инструменты', 'mc:toggle:tools', f.tools ? 'success' : undefined)
    ]),
    modelCatalogBlocksHeading('Минимальный контекст', 2),
    modelCatalogBlocksButtons([
      modelCatalogButton((f.minContext === 131072 ? '✓ ' : '') + '128K+', 'mc:context:131072', f.minContext === 131072 ? 'success' : undefined),
      modelCatalogButton((f.minContext === 262144 ? '✓ ' : '') + '256K+', 'mc:context:262144', f.minContext === 262144 ? 'success' : undefined),
      modelCatalogButton((f.minContext === 1000000 ? '✓ ' : '') + '1M+', 'mc:context:1000000', f.minContext === 1000000 ? 'success' : undefined)
    ]),
    modelCatalogBlocksHeading('Сортировка', 2),
    modelCatalogBlocksButtons([
      modelCatalogButton((f.sort === 'popular' ? '✓ ' : '') +
        (session.providerId === 'openrouter' ? 'Популярность' : 'Порядок API'), 'mc:sort:popular'),
      modelCatalogButton((f.sort === 'price' ? '✓ ' : '') + 'Цена', 'mc:sort:price')
    ]),
    modelCatalogBlocksButtons([
      modelCatalogButton((f.sort === 'context' ? '✓ ' : '') + 'Контекст', 'mc:sort:context'),
      modelCatalogButton((f.sort === 'speed' ? '✓ ' : '') + 'Скорость', 'mc:sort:speed')
    ]),
    modelCatalogBlocksButtons([
      modelCatalogButton('Сбросить фильтры', 'mc:reset-filters'),
      modelCatalogButton('Показать результаты', 'mc:all', 'primary')
    ]),
    modelCatalogBlocksButtons([
      modelCatalogButton('← Назад к каталогу', 'mc:home'),
      modelCatalogButton('Настройки', 'tn:back')
    ])
  ];
  return modelCatalogRich(blocks);
}

function modelCatalogCardRich(model, user, selected = false, note = '') {
  const tags = MODEL_CATALOG.getTags(model);
  const input = MODEL_CATALOG.formatPricePerMillion(model.promptPrice);
  const output = MODEL_CATALOG.formatPricePerMillion(model.completionPrice);
  const priceText = model.promptPrice !== null && model.completionPrice !== null
    ? input + ' вход · ' + output + ' выход'
    : 'Нет данных';
  const modalities = model.inputModalities.length
    ? model.inputModalities.map((item) => ({
      text: ({ text: 'Текст', image: 'Изображения', audio: 'Аудио', file: 'Файлы', video: 'Видео' })[item] || item
    }).text).join(', ')
    : 'Нет официальных данных';
  const capabilities = [
    modalities,
    model.supportsReasoning ? 'Рассуждения' : '',
    model.supportsTools ? 'Инструменты' : ''
  ].filter(Boolean).join(', ') || 'Нет официальных данных';
  const speed = Number.isFinite(model.throughput) && model.throughput > 0
    ? Math.round(model.throughput).toLocaleString('ru-RU') + ' токенов/с'
    : 'Не измерена';
  const blocks = [
    modelCatalogBlocksHeading(model.name || model.id, 1),
    modelCatalogBlocksParagraph(model.description || 'Описание от API провайдера не предоставлено.'),
    { type: 'table', is_compact: true, cells: [
      [
        { text: 'Контекст\n' + MODEL_CATALOG.formatTokens(model.contextLength) + '\nтокенов' },
        { text: 'Стоимость\n' + priceText + '\nза 1 млн токенов' }
      ],
      [
        { text: 'Скорость\n' + speed },
        { text: 'Возможности\n' + capabilities }
      ]
    ] },
    { type: 'divider' },
    modelCatalogBlocksHeading('Метки', 2),
    modelCatalogBlocksParagraph(tags.length ? tags.join(' · ') : 'Нет подтверждённых меток'),
    { type: 'footer', text: 'Источник: API ' + currentProviderName(user) + ' · Проверено: ' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' }
  ];
  if (note) blocks.push(modelCatalogBlocksParagraph(note));
  if (selected) {
    blocks.push(modelCatalogBlocksButtons([
      modelCatalogButton('✓ Модель выбрана', 'mc:choose', 'success'),
      modelCatalogButton('← Вернуться к каталогу', 'mc:home')
    ]));
  } else {
    blocks.push(modelCatalogBlocksButtons([
      modelCatalogButton('Выбрать модель', 'mc:choose', 'success'),
      modelCatalogButton('← Назад к моделям', 'mc:all')
    ]));
  }
  blocks.push(modelCatalogBlocksButtons([modelCatalogButton('← Настройки', 'tn:back')]));
  return modelCatalogRich(blocks);
}

async function fetchModelCatalogForUser(user, query = '', sort = 'popular') {
  const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
  if (!profile.url) throw new Error('Адрес API-провайдера не настроен.');
  if (profile.modelsEndpoint === false) {
    throw new Error('Этот провайдер не предоставляет список моделей через API. Можно ввести ID модели вручную.');
  }
  const openRouterSort = ({
    popular: 'most-popular',
    price: 'pricing-low-to-high',
    context: 'context-high-to-low',
    speed: 'throughput-high-to-low'
  })[sort] || 'most-popular';
  const options = profile.id === 'openrouter' ? { query, sort: openRouterSort } : {};
  const request = PROVIDER_ADAPTERS.modelsRequest(profile, user.apiKey, false, options);
  const response = await fetchImpl(request.url, {
    method: 'GET',
    headers: request.headers,
    signal: AbortSignal.timeout(MODEL_CATALOG_REQUEST_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(providerErrorSummary(response.status, extractProviderErrorMessage(payload)));
  }
  const records = PROVIDER_ADAPTERS.extractModelRecords(profile, payload);
  const models = records.slice(0, 5_000)
    .map((raw) => MODEL_CATALOG.normalizeModel(raw, profile.id))
    .filter(Boolean);
  if (query && profile.id !== 'openrouter') {
    const needle = query.toLocaleLowerCase();
    return {
      profile,
      models: models.filter((model) =>
        (model.id + ' ' + model.name + ' ' + model.description).toLocaleLowerCase().includes(needle))
    };
  }
  return { profile, models };
}

async function fetchModelDetailsForUser(user, selectedModel, fallbackRecord) {
  const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
  if (profile.id === 'openrouter') {
    try {
      const request = PROVIDER_ADAPTERS.modelDetailsRequest(profile, user.apiKey, selectedModel, false);
      const response = await fetchImpl(request.url, {
        method: 'GET',
        headers: request.headers,
        signal: AbortSignal.timeout(MODEL_CATALOG_REQUEST_TIMEOUT_MS)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(providerErrorSummary(response.status, extractProviderErrorMessage(payload)));
      }
      const raw = payload && payload.data && typeof payload.data === 'object' ? payload.data : payload;
      const normalized = MODEL_CATALOG.normalizeModel(raw, profile.id);
      if (normalized) return normalized;
    } catch (error) {
      if (!fallbackRecord) throw error;
      return fallbackRecord;
    }
  } else {
    try {
      const result = await fetchModelCatalogForUser(user, '');
      const found = result.models.find((item) => item.id === selectedModel);
      if (found) return found;
    } catch (error) {
      if (!fallbackRecord) throw error;
    }
  }
  return fallbackRecord || MODEL_CATALOG.normalizeModel({ id: selectedModel }, profile.id);
}

function newModelCatalogSession(user, chatId, messageId, models, query = '') {
  const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
  const session = {
    providerId: profile.id,
    providerUrl: normalizeApiBase(profile.url),
    chatId,
    messageId,
    models: Array.isArray(models) ? models : [],
    visibleModels: [],
    query: String(query || '').slice(0, 100),
    page: 0,
    filters: {
      free: false, minContext: 0, image: false, file: false, audio: false,
      reasoning: false, tools: false, sort: 'popular'
    },
    selected: null,
    expiresAt: Date.now() + MODEL_CATALOG_SESSION_TTL
  };
  modelCatalogSessions.set(modelCatalogKey(user.id), session);
  trimModelCatalogSessions();
  prepareModelCatalogView(session);
  return session;
}

async function editModelCatalogMessage(session, richMessage) {
  if (!session || !Number.isSafeInteger(Number(session.messageId))) {
    throw new Error('Сообщение каталога недоступно. Откройте выбор модели заново.');
  }
  return editTelegramRichMessage(session.chatId, session.messageId, richMessage, { inline_keyboard: [] });
}

async function showModelCatalogError(query, error, user) {
  const message = query && query.message;
  const text = 'Не удалось загрузить каталог моделей.\nПричина: ' +
    sanitizeProviderError(error && error.message || 'Неизвестная ошибка') +
    '\n\nМожно повторить попытку.';
  if (message && message.chat) {
    try {
      await editTelegramMessage(message.chat.id, message.message_id, text, {
        inline_keyboard: [[{ text: '↻ Повторить', callback_data: 'tn:model' }],
          [{ text: '← Назад', callback_data: 'tn:back' }]]
      });
      return;
    } catch {}
  }
  await safeAnswerCallback(query.id, text.slice(0, 180));
}

async function openModelCatalog(query, user) {
  pendingTimeoutInput.delete(modelCatalogKey(user.id));
  if (Object.prototype.hasOwnProperty.call(user, 'pendingSystemPromptInput')) {
    const previousPrompt = user.pendingSystemPromptInput;
    delete user.pendingSystemPromptInput;
    try { store.save(); } catch (error) {
      user.pendingSystemPromptInput = previousPrompt;
      throw error;
    }
  }
  clearModelCatalogState(user, true);
  await safeAnswerCallback(query.id, 'Загружаю модели…');
  const message = query && query.message;
  if (!message || !message.chat) return false;
  const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
  if (!profile) {
    await editTelegramMessage(message.chat.id, message.message_id,
      'Не удалось определить API-провайдера. Откройте настройки и выберите его ещё раз.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'tn:back' }]] });
    return true;
  }
  if (profile.modelsEndpoint === false) {
    const session = newModelCatalogSession(user, message.chat.id, Number(message.message_id), [], '');
    session.manualOnly = true;
    saveModelCatalogState(user, session);
    const rich = modelCatalogRich([
      modelCatalogBlocksHeading('Выбор ИИ', 1),
      modelCatalogBlocksParagraph('Этот провайдер не публикует список моделей через совместимый API. Можно ввести ID модели вручную.'),
      modelCatalogBlocksButtons([modelCatalogButton('Ввести ID модели', 'mc:manual', 'primary')]),
      modelCatalogBlocksButtons([modelCatalogButton('← Назад', 'tn:back')])
    ]);
    await editModelCatalogMessage(session, rich);
    return true;
  }
  if (!user.apiKey) {
    const session = newModelCatalogSession(user, message.chat.id, Number(message.message_id), [], '');
    saveModelCatalogState(user, session);
    await editModelCatalogMessage(session, modelCatalogRich([
      modelCatalogBlocksHeading('Выбор ИИ', 1),
      modelCatalogBlocksParagraph('Для загрузки списка моделей нужен API-ключ провайдера. Его можно безопасно добавить прямо здесь.'),
      modelCatalogBlocksButtons([modelCatalogButton('Добавить API-ключ', 'mc:key', 'primary')]),
      modelCatalogBlocksButtons([modelCatalogButton('Ввести ID модели вручную', 'mc:manual')]),
      modelCatalogBlocksButtons([modelCatalogButton('← Назад к настройкам', 'tn:back')])
    ]));
    return true;
  }
  try {
    await editTelegramMessage(message.chat.id, message.message_id, 'Получаю каталог от ' + currentProviderName(user) + '…',
      { inline_keyboard: [] });
    const result = await fetchModelCatalogForUser(user, '');
    const session = newModelCatalogSession(user, message.chat.id, Number(message.message_id), result.models, '');
    saveModelCatalogState(user, session);
    await editModelCatalogMessage(session, modelCatalogHomeRich(session, user));
    return true;
  } catch (error) {
    await showModelCatalogError(query, error, user);
    return true;
  }
}

async function requestModelCatalogSearch(message, user, session, mode = 'search', promptOverride = '') {
  saveModelCatalogState(user, session);
  const promptText = promptOverride || (
    mode === 'manual'
      ? 'Отправьте ID модели одним сообщением. Для отмены используйте /cancel.'
      : mode === 'key'
        ? 'Отправьте API-ключ выбранного провайдера ответом на это сообщение. Ключ будет удалён после получения. Для отмены используйте /cancel.'
        : 'Отправьте название или ID модели для поиска. Для отмены используйте /cancel.'
  );
  const prompt = await sendTelegramMessage(message.chat.id, promptText, {
    reply_markup: {
      force_reply: true,
      input_field_placeholder: mode === 'key' ? 'API-ключ' : mode === 'manual' ? 'ID модели' : 'Название или ID модели'
    }
  });
  const pending = {
    mode,
    chatId: Number(message.chat.id),
    promptMessageId: Number(prompt && prompt.message_id),
    menuMessageId: Number(session.messageId),
    createdAt: Date.now(),
    expiresAt: Date.now() + MODEL_CATALOG_SEARCH_TTL
  };
  if (!Number.isSafeInteger(pending.promptMessageId)) {
    throw new Error('Telegram не вернул ID сообщения для поиска.');
  }
  const previous = user.pendingModelCatalogSearch;
  user.pendingModelCatalogSearch = pending;
  try {
    store.save();
  } catch (error) {
    if (previous === undefined) delete user.pendingModelCatalogSearch;
    else user.pendingModelCatalogSearch = previous;
    throw error;
  }
  pendingModelCatalogSearches.set(modelCatalogKey(user.id), pending);
  trimModelCatalogSessions();
}

function selectCatalogModel(user, modelId) {
  const previousModel = user.model;
  const previousExplicit = user.modelExplicit;
  const chat = activeChat(user);
  const previousChatModel = chat && chat.model;
  user.model = modelId;
  user.modelExplicit = true;
  if (chat) {
    chat.model = modelId;
    chat.updatedAt = Date.now();
  }
  try {
    store.save();
  } catch (error) {
    user.model = previousModel;
    user.modelExplicit = previousExplicit;
    if (chat) chat.model = previousChatModel;
    throw error;
  }
}

async function handlePendingModelCatalogReply(message, user, text) {
  const userId = message && message.from && message.from.id;
  const key = modelCatalogKey(userId);
  const pending = pendingModelCatalogSearches.get(key) || user.pendingModelCatalogSearch;
  if (!pending || Number(pending.chatId) !== Number(message.chat.id)) return false;
  const replyId = message && message.reply_to_message && Number(message.reply_to_message.message_id);
  if (!replyId || replyId !== Number(pending.promptMessageId)) return false;

  pendingModelCatalogSearches.delete(key);
  const previousPending = user.pendingModelCatalogSearch;
  delete user.pendingModelCatalogSearch;
  try {
    store.save();
  } catch (error) {
    user.pendingModelCatalogSearch = previousPending;
    pendingModelCatalogSearches.set(key, pending);
    throw error;
  }
  if (pending.expiresAt <= Date.now()) {
    await sendText(message.chat.id, 'Поиск устарел. Откройте /settings и нажмите «Модель» ещё раз.');
    return true;
  }
  let session = getModelCatalogSession(userId);
  if (!session || Number(session.messageId) !== Number(pending.menuMessageId) ||
      !modelProviderFromSession(user, session)) {
    session = await restoreModelCatalogSession(user, {
      message_id: Number(pending.menuMessageId),
      chat: { id: Number(pending.chatId) }
    }, userId, { skipFetch: pending.mode === 'key' });
  }
  if (!session || Number(session.messageId) !== Number(pending.menuMessageId) ||
      !modelProviderFromSession(user, session)) {
    await sendText(message.chat.id, 'Каталог устарел. Откройте выбор модели заново.');
    return true;
  }

  if (pending.mode === 'key') {
    try {
      await deleteTelegramMessage(message.chat.id, message.message_id);
    } catch {
      await sendText(message.chat.id,
        'Telegram не подтвердил удаление сообщения с ключом. Я не сохраняю его. Добавьте ключ через Mini App и повторите открытие каталога.');
      return true;
    }

    const apiKey = String(text || '').trim();
    if (!apiKey || apiKey.length > 2_048 || /\s/.test(apiKey)) {
      await sendText(message.chat.id, 'Ключ должен быть одной строкой длиной до 2048 символов. Нажмите «Добавить ключ» и повторите ввод.');
      await editModelCatalogMessage(session, modelCatalogRich([
        modelCatalogBlocksHeading('Нужен API-ключ', 1),
        modelCatalogBlocksParagraph('Без ключа провайдер не разрешает загружать каталог. Введите ключ через кнопку ниже.'),
        modelCatalogBlocksButtons([modelCatalogButton('Добавить ключ', 'mc:key', 'primary')]),
        modelCatalogBlocksButtons([modelCatalogButton('← Назад', 'tn:back')])
      ]));
      return true;
    }

    const previousKey = user.apiKey;
    user.apiKey = apiKey;
    try {
      store.save();
    } catch (error) {
      user.apiKey = previousKey;
      await sendText(message.chat.id, 'Не удалось безопасно сохранить ключ. Повторите ввод.');
      return true;
    }

    let result;
    try {
      result = await fetchModelCatalogForUser(user, '', session.filters.sort);
    } catch (error) {
      user.apiKey = previousKey;
      try { store.save(); } catch {}
      const reason = sanitizeProviderError(error && error.message || 'ошибка API');
      await editModelCatalogMessage(session, modelCatalogRich([
        modelCatalogBlocksHeading('Не удалось проверить ключ', 1),
        modelCatalogBlocksParagraph(reason),
        modelCatalogBlocksParagraph('Проверьте ключ и повторите ввод. Сообщение с ключом уже удалено.'),
        modelCatalogBlocksButtons([modelCatalogButton('Добавить ключ ещё раз', 'mc:key', 'primary')]),
        modelCatalogBlocksButtons([modelCatalogButton('← Назад', 'tn:back')])
      ]));
      return true;
    }

    session.models = result.models;
    session.query = '';
    session.page = 0;
    session.selected = null;
    session.manualOnly = false;
    prepareModelCatalogView(session);
    saveModelCatalogState(user, session);
    await editModelCatalogMessage(session, modelCatalogHomeRich(session, user));
    return true;
  }

  if (pending.mode === 'manual') {
    const modelId = String(text || '').trim();
    if (looksLikeApiKey(modelId)) {
      try {
        await deleteTelegramMessage(message.chat.id, message.message_id);
      } catch {
        await sendText(message.chat.id,
          'Похоже, вы отправили API-ключ, а не ID модели. Telegram не подтвердил удаление сообщения, поэтому я не буду обрабатывать или сохранять его. Удалите сообщение вручную и повторите ввод через кнопку «Ввести ID модели вручную».');
        return true;
      }

      await requestModelCatalogSearch(
        message,
        user,
        session,
        'manual',
        'Похоже, вы отправили API-ключ, а не ID модели. Мне нужен именно ID модели (обычно в формате provider/model). API-ключ используется отдельно для подключения к провайдеру. Отправьте ID модели ответом на это сообщение.'
      );
      return true;
    }

    if (!modelId || modelId.length > 256 || /\s/.test(modelId)) {
      await sendText(message.chat.id, 'ID модели должен быть одной строкой без пробелов. Повторите ввод через кнопку каталога.');
      return true;
    }
    try {
      const fallback = MODEL_CATALOG.normalizeModel({ id: modelId }, session.providerId);
      session.selected = await fetchModelDetailsForUser(user, modelId, fallback);
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogCardRich(session.selected, user, false));
    } catch (error) {
      await sendText(message.chat.id, 'Не удалось получить данные модели: ' +
        sanitizeProviderError(error && error.message || 'ошибка API'));
    }
    return true;
  }

  const query = String(text || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
  if (!query) {
    await sendText(message.chat.id, 'Пустой поисковый запрос. Нажмите «Поиск» и введите название модели.');
    return true;
  }
  try {
    const result = await fetchModelCatalogForUser(user, query, session.filters.sort);
    session.models = result.models;
    session.query = query;
    session.page = 0;
    session.selected = null;
    prepareModelCatalogView(session);
    saveModelCatalogState(user, session);
    await editModelCatalogMessage(session, modelCatalogResultsRich(session, user));
  } catch (error) {
    await sendText(message.chat.id, 'Не удалось выполнить поиск: ' +
      sanitizeProviderError(error && error.message || 'ошибка API'));
  }
  return true;
}

async function handleModelCatalogCallback(query, user, data) {
  const message = query && query.message;
  if (!message || !message.chat || !Number.isSafeInteger(Number(message.message_id))) {
    await safeAnswerCallback(query.id, 'Сообщение каталога недоступно. Откройте выбор модели заново.');
    return true;
  }

  // Confirm the click immediately; restoring a sleeping server may need a provider request.
  await safeAnswerCallback(query.id, 'Открываю каталог…');
  let session = getModelCatalogSession(user.id);
  if (!session || Number(session.messageId) !== Number(message.message_id) ||
      Number(session.chatId) !== Number(message.chat.id) || !modelProviderFromSession(user, session)) {
    try {
      session = await restoreModelCatalogSession(user, message, user.id, {
        skipFetch: data === 'mc:key'
      });
    } catch (error) {
      await showModelCatalogError(query, error, user);
      return true;
    }
  }
  if (!session || Number(session.messageId) !== Number(message.message_id) ||
      Number(session.chatId) !== Number(message.chat.id) || !modelProviderFromSession(user, session)) {
    await editTelegramMessage(message.chat.id, message.message_id,
      'Каталог устарел. Откройте «Модель» в настройках ещё раз.',
      { inline_keyboard: [[{ text: '↻ Открыть каталог', callback_data: 'tn:model' }]] });
    return true;
  }

  try {
    if (data === 'mc:search' || data === 'mc:manual' || data === 'mc:key') {
      const mode = data === 'mc:key' ? 'key' : (data === 'mc:manual' ? 'manual' : 'search');
      await requestModelCatalogSearch(message, user, session, mode);
      return true;
    }
    if (data === 'mc:filters') {
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    if (data === 'mc:home' || data === 'mc:clear-search') {
      if (data === 'mc:clear-search') {
        session.query = '';
        const result = await fetchModelCatalogForUser(user, '', session.filters.sort);
        session.models = result.models;
      }
      session.page = 0;
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogHomeRich(session, user));
      return true;
    }
    if (data === 'mc:all') {
      session.page = 0;
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogResultsRich(session, user));
      return true;
    }

    const pageMatch = data.match(/^mc:page:(\d{1,3})$/);
    if (pageMatch) {
      session.page = Number(pageMatch[1]);
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogResultsRich(session, user));
      return true;
    }
    const toggleMatch = data.match(/^mc:toggle:(free|image|file|audio|reasoning|tools)$/);
    if (toggleMatch) {
      const key = toggleMatch[1];
      session.filters[key] = !session.filters[key];
      session.page = 0;
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    const contextMatch = data.match(/^mc:context:(0|131072|262144|1000000)$/);
    if (contextMatch) {
      const value = Number(contextMatch[1]);
      session.filters.minContext = session.filters.minContext === value ? 0 : value;
      session.page = 0;
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    const sortMatch = data.match(/^mc:sort:(popular|price|context|speed)$/);
    if (sortMatch) {
      session.filters.sort = sortMatch[1];
      session.page = 0;
      if (session.providerId === 'openrouter') {
        await editModelCatalogMessage(session, modelCatalogRich([
          modelCatalogBlocksHeading('Обновляю порядок моделей…', 1),
          modelCatalogBlocksParagraph('Запрашиваю каталог у OpenRouter.')
        ]));
        const result = await fetchModelCatalogForUser(user, session.query, session.filters.sort);
        session.models = result.models;
      }
      prepareModelCatalogView(session);
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    if (data === 'mc:reset-filters') {
      session.filters = {
        free: false, minContext: 0, image: false, file: false, audio: false,
        reasoning: false, tools: false, sort: 'popular'
      };
      session.page = 0;
      const result = await fetchModelCatalogForUser(user, session.query, 'popular');
      session.models = result.models;
      prepareModelCatalogView(session);
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    const modelMatch = data.match(/^mc:model:(\d{1,4})$/);
    if (modelMatch) {
      const index = Number(modelMatch[1]);
      const models = prepareModelCatalogView(session);
      const chosen = models[index];
      if (!chosen) {
        await safeAnswerCallback(query.id, 'Эта модель больше не находится в списке. Обновите каталог.');
        return true;
      }
      session.selected = chosen;
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogRich([
        modelCatalogBlocksHeading('Получаю информацию о модели…', 1),
        modelCatalogBlocksParagraph(chosen.name || chosen.id),
        modelCatalogBlocksParagraph('Запрашиваю подробности у API ' + currentProviderName(user) + '.')
      ]));
      const details = await fetchModelDetailsForUser(user, chosen.id, chosen);
      session.selected = details;
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogCardRich(details, user, false));
      return true;
    }
    if (data === 'mc:choose') {
      if (!session.selected || !session.selected.id) {
        await safeAnswerCallback(query.id, 'Сначала откройте карточку модели.');
        return true;
      }
      selectCatalogModel(user, session.selected.id);
      saveModelCatalogState(user, session);
      await editModelCatalogMessage(session, modelCatalogCardRich(session.selected, user, true,
        'Модель установлена для текущего чата.'));
      return true;
    }
    await safeAnswerCallback(query.id, 'Эта кнопка устарела. Откройте каталог заново.');
    return true;
  } catch (error) {
    const safe = sanitizeProviderError(error && error.message || 'Ошибка каталога');
    try {
      await editModelCatalogMessage(session, modelCatalogRich([
        modelCatalogBlocksHeading('Не удалось выполнить действие', 1),
        modelCatalogBlocksParagraph(safe),
        modelCatalogBlocksButtons([
          modelCatalogButton('Повторить', 'mc:home', 'primary'),
          modelCatalogButton('Фильтры', 'mc:filters')
        ])
      ]));
    } catch {
      await sendText(message.chat.id, 'Ошибка каталога моделей: ' + safe);
    }
    return true;
  }
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
      pro: getProStatus(userId),
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
    ensureTrial: ensureProTrial,
    getProStatus,
    handlePreCheckoutQuery,
    handleSuccessfulPayment,
    enqueueUpdate,
    startUpdateWorker,
    stopUpdateWorker,
    getWorkerStats,
    sendMessage,
    sendRichMessage,
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
