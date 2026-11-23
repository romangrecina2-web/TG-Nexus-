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
      'Инструкция: ' + (typeof settings.systemPrompt === 'string' && settings.systemPrompt.trim() && settings.systemPrompt !== systemPrompt ? 'пользовательская' : 'по умолчанию'),
      'Интернет-поиск: ' + (settings.internetSearch === true ? 'включён' : 'выключен'),
      'Песочница: ' + (settings.sandbox === true ? 'разрешена в Mini App' : 'выключена'),
      'Каталог моделей: поиск, популярные модели, фильтры и карточки характеристик.',
      'История синхронизируется с Mini App при открытии и сохранении.',
      'Часть параметров можно менять кнопками ниже; полный набор доступен в Mini App.'
    ].join('\n');
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
      [{ text: '🎛 Лимит ответа', callback_data: 'tn:tokens' }],
      [{ text: '🤖 Каталог моделей', callback_data: 'tn:model' }],
      [{ text: '📝 Инструкция ИИ', callback_data: 'tn:prompt' }],
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
        (!query.data.startsWith('tn:') && !query.data.startsWith('mc:'))) return false;

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

  async function sendSettings(chatId, user) {
    user.id = String(user.id || '');
    await sendTelegramMessage(chatId, settingsMessageText(user), {
      reply_markup: settingsKeyboard(user)
    });
  }
