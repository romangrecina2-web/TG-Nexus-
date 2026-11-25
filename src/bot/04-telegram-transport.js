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

  async function telegramRequest(method, payload) {
    if (!botToken) throw new Error('Telegram bot token is not configured.');
    const response = await fetchImpl('https://api.telegram.org/bot' + botToken + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
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

  async function sendAssistantText(chatId, text) {
    const html = markdownToTelegramHtml(text);
    const chunks = splitTelegramHtml(html);
    for (const chunk of chunks) {
      try {
        await sendTelegramMessage(chatId, chunk.html, { parse_mode: 'HTML' });
      } catch (error) {
        if (!isTelegramHtmlParseError(error)) throw error;
        await sendTelegramMessage(chatId, chunk.text);
      }
    }
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
    const editStatus = async (text) => {
      if (!messageId) return false;
      try {
        await editTelegramMessage(chatId, messageId, text);
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
      }
    };
  }
