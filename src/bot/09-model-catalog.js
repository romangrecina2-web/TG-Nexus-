const MODEL_CATALOG_PAGE_SIZE = 8;
const MODEL_CATALOG_SESSION_TTL = 5 * 60_000;
const MODEL_CATALOG_SEARCH_TTL = 5 * 60_000;
const MODEL_CATALOG_REQUEST_TIMEOUT_MS = 18_000;
const modelCatalogSessions = new Map();
const pendingModelCatalogSearches = new Map();

function modelCatalogKey(userId) {
  return String(userId);
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
        const absoluteIndex = index + popular.indexOf(model);
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
      modelCatalogButton((f.sort === 'popular' ? '✓ ' : '') + 'Популярность', 'mc:sort:popular'),
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
    modelCatalogBlocksButtons([modelCatalogButton('← Назад к каталогу', 'mc:home')])
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
  return modelCatalogRich(blocks);
}

async function fetchModelCatalogForUser(user, query = '') {
  const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
  if (!profile.url) throw new Error('Адрес API-провайдера не настроен.');
  if (profile.modelsEndpoint === false) {
    throw new Error('Этот провайдер не предоставляет список моделей через API. Можно ввести ID модели вручную.');
  }
  const options = profile.id === 'openrouter'
    ? { query, sort: query ? 'most-popular' : 'most-popular' }
    : {};
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
  pendingModelCatalogSearches.delete(modelCatalogKey(user.id));
  await safeAnswerCallback(query.id, 'Загружаю модели…');
  const message = query && query.message;
  if (!message || !message.chat) return false;
  if (!user.apiKey) {
    await editTelegramMessage(message.chat.id, message.message_id,
      'Для загрузки моделей сначала настройте API-ключ выбранного провайдера в Mini App.',
      { inline_keyboard: [[{ text: '← Назад', callback_data: 'tn:back' }]] });
    return true;
  }
  const profile = providerProfile(user, user.apiBaseUrl || apiBaseUrl);
  if (profile.modelsEndpoint === false) {
    const session = newModelCatalogSession(user, message.chat.id, Number(message.message_id), [], '');
    session.manualOnly = true;
    const rich = modelCatalogRich([
      modelCatalogBlocksHeading('Выбор ИИ', 1),
      modelCatalogBlocksParagraph('Этот провайдер не публикует список моделей через совместимый API. Можно ввести ID модели вручную.'),
      modelCatalogBlocksButtons([modelCatalogButton('Ввести ID модели', 'mc:manual', 'primary')]),
      modelCatalogBlocksButtons([modelCatalogButton('← Назад', 'tn:back')])
    ]);
    await editModelCatalogMessage(session, rich);
    return true;
  }
  try {
    await editTelegramMessage(message.chat.id, message.message_id, 'Получаю каталог от ' + currentProviderName(user) + '…',
      { inline_keyboard: [] });
    const result = await fetchModelCatalogForUser(user, '');
    const session = newModelCatalogSession(user, message.chat.id, Number(message.message_id), result.models, '');
    await editModelCatalogMessage(session, modelCatalogHomeRich(session, user));
    return true;
  } catch (error) {
    await showModelCatalogError(query, error, user);
    return true;
  }
}

async function requestModelCatalogSearch(message, user, session, mode = 'search') {
  const prompt = await sendTelegramMessage(message.chat.id,
    mode === 'manual'
      ? 'Отправьте ID модели одним сообщением. Для отмены используйте /cancel.'
      : 'Отправьте название или ID модели для поиска. Для отмены используйте /cancel.',
    { reply_markup: { force_reply: true, input_field_placeholder: 'Название или ID модели' } });
  pendingModelCatalogSearches.set(modelCatalogKey(user.id), {
    mode,
    chatId: message.chat.id,
    promptMessageId: Number(prompt && prompt.message_id),
    menuMessageId: Number(session.messageId),
    createdAt: Date.now(),
    expiresAt: Date.now() + MODEL_CATALOG_SEARCH_TTL
  });
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
  const key = modelCatalogKey(message && message.from && message.from.id);
  const pending = pendingModelCatalogSearches.get(key);
  if (!pending) return false;
  const replyId = message && message.reply_to_message && Number(message.reply_to_message.message_id);
  if (!replyId || replyId !== pending.promptMessageId) return false;
  pendingModelCatalogSearches.delete(key);
  if (pending.expiresAt <= Date.now()) {
    await sendText(message.chat.id, 'Поиск устарел. Откройте /settings и нажмите «Модель» ещё раз.');
    return true;
  }
  const session = getModelCatalogSession(user.id);
  if (!session || Number(session.messageId) !== pending.menuMessageId ||
      !modelProviderFromSession(user, session)) {
    await sendText(message.chat.id, 'Каталог устарел. Откройте выбор модели заново.');
    return true;
  }

  if (pending.mode === 'manual') {
    const modelId = String(text || '').trim();
    if (!modelId || modelId.length > 256 || /\s/.test(modelId)) {
      await sendText(message.chat.id, 'ID модели должен быть одной строкой без пробелов. Повторите ввод через кнопку каталога.');
      return true;
    }
    try {
      const fallback = MODEL_CATALOG.normalizeModel({ id: modelId }, session.providerId);
      session.selected = await fetchModelDetailsForUser(user, modelId, fallback);
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
    const result = await fetchModelCatalogForUser(user, query);
    session.models = result.models;
    session.query = query;
    session.page = 0;
    session.selected = null;
    session.expiresAt = Date.now() + MODEL_CATALOG_SESSION_TTL;
    prepareModelCatalogView(session);
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
  const session = getModelCatalogSession(user.id);
  if (!session || Number(session.messageId) !== Number(message.message_id) ||
      Number(session.chatId) !== Number(message.chat.id) || !modelProviderFromSession(user, session)) {
    await safeAnswerCallback(query.id, 'Каталог устарел. Откройте «Модель» в настройках ещё раз.');
    return true;
  }

  await safeAnswerCallback(query.id);
  try {
    if (data === 'mc:search' || data === 'mc:manual') {
      await requestModelCatalogSearch(message, user, session, data === 'mc:manual' ? 'manual' : 'search');
      return true;
    }
    if (data === 'mc:filters') {
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    if (data === 'mc:home' || data === 'mc:clear-search') {
      if (data === 'mc:clear-search') {
        session.query = '';
        if (session.providerId === 'openrouter' && session.models.length === 0) {
          const result = await fetchModelCatalogForUser(user, '');
          session.models = result.models;
        }
      }
      session.page = 0;
      await editModelCatalogMessage(session, modelCatalogHomeRich(session, user));
      return true;
    }
    if (data === 'mc:all') {
      session.page = 0;
      await editModelCatalogMessage(session, modelCatalogResultsRich(session, user));
      return true;
    }

    const pageMatch = data.match(/^mc:page:(\d{1,3})$/);
    if (pageMatch) {
      session.page = Number(pageMatch[1]);
      await editModelCatalogMessage(session, modelCatalogResultsRich(session, user));
      return true;
    }
    const toggleMatch = data.match(/^mc:toggle:(free|image|file|audio|reasoning|tools)$/);
    if (toggleMatch) {
      const key = toggleMatch[1];
      session.filters[key] = !session.filters[key];
      session.page = 0;
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    const contextMatch = data.match(/^mc:context:(0|131072|262144|1000000)$/);
    if (contextMatch) {
      const value = Number(contextMatch[1]);
      session.filters.minContext = session.filters.minContext === value ? 0 : value;
      session.page = 0;
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    const sortMatch = data.match(/^mc:sort:(popular|price|context|speed)$/);
    if (sortMatch) {
      session.filters.sort = sortMatch[1];
      session.page = 0;
      await editModelCatalogMessage(session, modelCatalogFiltersRich(session));
      return true;
    }
    if (data === 'mc:reset-filters') {
      session.filters = {
        free: false, minContext: 0, image: false, file: false, audio: false,
        reasoning: false, tools: false, sort: 'popular'
      };
      session.page = 0;
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
      await editModelCatalogMessage(session, modelCatalogRich([
        modelCatalogBlocksHeading('Получаю информацию о модели…', 1),
        modelCatalogBlocksParagraph(chosen.name || chosen.id),
        modelCatalogBlocksParagraph('Запрашиваю подробности у API ' + currentProviderName(user) + '.')
      ]));
      const details = await fetchModelDetailsForUser(user, chosen.id, chosen);
      session.selected = details;
      session.expiresAt = Date.now() + MODEL_CATALOG_SESSION_TTL;
      await editModelCatalogMessage(session, modelCatalogCardRich(details, user, false));
      return true;
    }
    if (data === 'mc:choose') {
      if (!session.selected || !session.selected.id) {
        await safeAnswerCallback(query.id, 'Сначала откройте карточку модели.');
        return true;
      }
      selectCatalogModel(user, session.selected.id);
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
