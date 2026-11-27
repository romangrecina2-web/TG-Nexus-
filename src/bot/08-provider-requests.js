  function sanitizeProviderError(value) {
    return String(value || '')
      .replace(/Incorrect API key provided:\s*\S+/gi, 'Incorrect API key provided: [секрет скрыт]')
      .replace(/(?:sk-[A-Za-z0-9_-]{8,}|\.storefront\.[A-Za-z0-9_-]{8,}|Bearer\s+\S+|api[_-]?key\s*[:=]\s*\S+)/gi, '[секрет скрыт]')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  const providerRequestCooldowns = new Map();
  const DEFAULT_PROVIDER_429_COOLDOWN_SECONDS = 30;

  function readRateLimitHeader(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') {
      try {
        const value = headers.get(name);
        if (value != null) return String(value).trim();
      } catch {}
    }
    if (typeof headers === 'object') {
      const wanted = String(name).toLowerCase();
      const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
      if (key && headers[key] != null) return String(headers[key]).trim();
    }
    return '';
  }

  function parseRetryAfterSeconds(value, now = Date.now()) {
    if (value == null || value === '') return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.max(1, Math.ceil(numeric));
    const date = Date.parse(String(value));
    if (!Number.isFinite(date)) return 0;
    return Math.max(0, Math.ceil((date - now) / 1000));
  }

  function parseRateLimitResetSeconds(value, now = Date.now()) {
    const reset = Number(value);
    if (!Number.isFinite(reset) || reset <= 0) return 0;
    // OpenRouter documents X-RateLimit-Reset as Unix epoch milliseconds.
    // Accept seconds as a defensive fallback for compatible upstream gateways.
    const resetAtMs = reset < 100_000_000_000 ? reset * 1000 : reset;
    return Math.max(0, Math.ceil((resetAtMs - now) / 1000));
  }

  function formatProviderWait(seconds) {
    const safeSeconds = Math.max(1, Math.ceil(Number(seconds) || 1));
    if (safeSeconds < 60) return safeSeconds + ' сек.';
    if (safeSeconds < 3_600) return Math.ceil(safeSeconds / 60) + ' мин.';
    if (safeSeconds < 86_400) return Math.ceil(safeSeconds / 3_600) + ' ч.';
    return Math.ceil(safeSeconds / 86_400) + ' дн.';
  }

  function getProviderRetryAfterSeconds(metadata, responseHeaders) {
    const nestedHeaders = metadata && metadata.headers && typeof metadata.headers === 'object'
      ? metadata.headers
      : null;
    const retryAfter = readRateLimitHeader(responseHeaders, 'retry-after') ||
      readRateLimitHeader(nestedHeaders, 'retry-after') ||
      (metadata && (metadata.retry_after || metadata.retryAfter));
    const retrySeconds = parseRetryAfterSeconds(retryAfter);
    if (retrySeconds > 0) return retrySeconds;

    const reset = readRateLimitHeader(responseHeaders, 'x-ratelimit-reset') ||
      readRateLimitHeader(nestedHeaders, 'x-ratelimit-reset') ||
      (metadata && (metadata.reset_at || metadata.resets_at));
    if (reset) {
      const resetSeconds = parseRateLimitResetSeconds(reset);
      if (resetSeconds > 0) return resetSeconds;
    }
    return 0;
  }

  function providerErrorSummary(status, detail, metadata = {}, retryAfterSeconds = 0) {
    const safeDetail = sanitizeProviderError(detail);
    const limitSource = String(metadata && metadata.limit_source || '').toLowerCase();
    const providerName = sanitizeProviderError(metadata && metadata.provider_name || '');
    let lead;

    if (status === 429) {
      if (limitSource.includes('openrouter_free_tier') && /minute|per_minute/.test(limitSource)) {
        lead = 'OpenRouter достиг минутного лимита запросов к бесплатным моделям.';
      } else if (limitSource.includes('openrouter_free_tier') && /day|daily|per_day/.test(limitSource)) {
        lead = 'OpenRouter достиг суточного лимита запросов к бесплатным моделям.';
      } else if (limitSource.startsWith('upstream_provider') || metadata && metadata.provider_code) {
        lead = 'Поставщик выбранной модели ограничил частоту запросов или временно перегружен.';
      } else if (limitSource.startsWith('openrouter_')) {
        lead = 'OpenRouter ограничил частоту запросов для этого API-ключа или аккаунта.';
      } else {
        lead = 'Сработало ограничение частоты запросов OpenRouter или поставщика модели.';
      }
    } else if (status === 503) {
      lead = 'Сейчас нет доступного сервера выбранной модели у провайдера.';
    } else {
      lead = status === 401 || status === 403 ? 'Провайдер отклонил ключ или не дал доступ.'
        : status === 402 ? 'Провайдер сообщил о недостатке средств или лимита.'
        : status === 404 ? 'Провайдер не нашёл выбранную модель или endpoint.'
        : status >= 500 ? 'На стороне провайдера произошла серверная ошибка.'
        : 'Провайдер отклонил запрос.';
    }

    const parts = [lead];
    if (providerName) parts.push('Поставщик: ' + providerName + '.');
    if (retryAfterSeconds > 0 && (status === 429 || status === 503)) {
      parts.push('Повторите через ' + formatProviderWait(retryAfterSeconds) + '.');
    } else if (status === 429 || status === 503) {
      parts.push('Не отправляйте запрос повторно сразу; подождите и попробуйте позже.');
    }
    parts.push('HTTP ' + status + (safeDetail ? ': ' + safeDetail : '.'));
    return parts.join(' ');
  }

  function extractProviderError(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const choiceError = payload.choices && payload.choices[0] && payload.choices[0].error;
    const error = payload.error || choiceError;
    if (!error) return null;
    if (typeof error === 'string') return { message: error, metadata: {}, code: 0 };
    if (typeof error !== 'object') return null;
    return {
      message: typeof error.message === 'string' ? error.message
        : typeof payload.message === 'string' ? payload.message
          : typeof payload.detail === 'string' ? payload.detail : '',
      metadata: error.metadata && typeof error.metadata === 'object' ? error.metadata : {},
      code: Number(error.code) || 0
    };
  }

  function providerErrorFromResponse(status, payload, responseHeaders) {
    const details = extractProviderError(payload) || { message: extractProviderErrorMessage(payload), metadata: {}, code: 0 };
    const effectiveStatus = Number(status) >= 400 ? Number(status) : Number(details.code) || Number(status);
    const retryHeaderSeconds = getProviderRetryAfterSeconds(details.metadata, responseHeaders);
    const cooldownSeconds = effectiveStatus === 429
      ? Math.min(7 * 86_400, retryHeaderSeconds || DEFAULT_PROVIDER_429_COOLDOWN_SECONDS)
      : effectiveStatus === 503
        ? Math.min(3_600, retryHeaderSeconds || 15)
        : 0;
    return {
      status: effectiveStatus,
      metadata: details.metadata,
      retryAfterSeconds: retryHeaderSeconds,
      cooldownSeconds,
      message: providerErrorSummary(effectiveStatus, details.message, details.metadata, retryHeaderSeconds)
    };
  }

  function providerCooldownKey(user, providerBase, model) {
    let host = '';
    try { host = new URL(providerBase).hostname.toLowerCase(); } catch {}
    return String(user && user.id || '') + ':' + host + ':' + String(model || '');
  }

  function rememberProviderCooldown(user, providerBase, model, seconds) {
    const wait = Math.max(1, Math.min(7 * 86_400, Math.ceil(Number(seconds) || DEFAULT_PROVIDER_429_COOLDOWN_SECONDS)));
    const key = providerCooldownKey(user, providerBase, model);
    const until = Date.now() + wait * 1000;
    const previous = providerRequestCooldowns.get(key) || 0;
    providerRequestCooldowns.set(key, Math.max(previous, until));

    if (providerRequestCooldowns.size > 5_000) {
      const now = Date.now();
      for (const [entryKey, expiresAt] of providerRequestCooldowns) {
        if (expiresAt <= now) providerRequestCooldowns.delete(entryKey);
      }
    }
    return wait;
  }

  function getProviderCooldownMessage(user, providerBase, model) {
    const key = providerCooldownKey(user, providerBase, model);
    const until = providerRequestCooldowns.get(key) || 0;
    const remaining = Math.ceil((until - Date.now()) / 1000);
    if (remaining <= 0) {
      if (until) providerRequestCooldowns.delete(key);
      return '';
    }
    return 'Повторный запрос к этой модели временно приостановлен после ограничения провайдера. Попробуйте через ' +
      formatProviderWait(remaining) + '.';
  }

  function extractProviderErrorMessage(payload) {
    const details = extractProviderError(payload);
    if (details && details.message) return details.message;
    if (!payload || typeof payload !== 'object') return '';
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
    const cooldownMessage = getProviderCooldownMessage(user, providerBase, model);
    if (cooldownMessage) throw new Error(cooldownMessage);
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
    const payload = await response.json().catch(() => ({}));
    const providerFailure = !response.ok || extractProviderError(payload)
      ? providerErrorFromResponse(response.status, payload, response.headers)
      : null;
    if (providerFailure) {
      if (providerFailure.cooldownSeconds > 0) {
        rememberProviderCooldown(user, providerBase, model, providerFailure.cooldownSeconds);
      }
      const error = new Error(providerFailure.message);
      error.status = providerFailure.status;
      error.retryAfterSeconds = providerFailure.retryAfterSeconds;
      error.limitSource = providerFailure.metadata && providerFailure.metadata.limit_source || '';
      throw error;
    }
    const normalizedPayload = PROVIDER_ADAPTERS.normalizePayload(profile, payload, request.protocol);
    const answer = extractAssistantText(normalizedPayload);
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
    const cooldownMessage = getProviderCooldownMessage(user, user.apiBaseUrl || apiBaseUrl, model);
    if (cooldownMessage) return { ok: false, message: cooldownMessage };
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
      const providerFailure = !response.ok || extractProviderError(payload)
        ? providerErrorFromResponse(response.status, payload, response.headers)
        : null;
      if (providerFailure) {
        if (providerFailure.cooldownSeconds > 0) {
          rememberProviderCooldown(user, user.apiBaseUrl || apiBaseUrl, model, providerFailure.cooldownSeconds);
        }
        return { ok: false, message: providerFailure.message, status: providerFailure.status };
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
