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
      settings: getEffectiveUserSettings(userId, user.settings || {}),
      plan: getPlanInfo(userId),
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
    if (input.activeChatId === null) {
      user.activeChatId = null;
    } else if (typeof input.activeChatId === 'string' && user.chats.some((chat) => chat.id === input.activeChatId)) {
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
