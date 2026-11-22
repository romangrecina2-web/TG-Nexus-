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
