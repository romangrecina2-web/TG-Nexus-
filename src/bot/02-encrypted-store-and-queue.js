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