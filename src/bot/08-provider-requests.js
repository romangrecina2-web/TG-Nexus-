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
    const userSettings = getEffectiveUserSettings(user.id, user.settings || {});
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
