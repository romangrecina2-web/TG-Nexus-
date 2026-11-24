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
    return modelCatalogRich([
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
    ]);
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

  async function sendSettings(chatId, user) {
    user.id = String(user.id || '');
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
