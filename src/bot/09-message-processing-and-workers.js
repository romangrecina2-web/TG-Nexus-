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

    chat.messages.push({ id: crypto.randomUUID(), createdAt: Date.now(), role: 'user', content: text.slice(0, MAX_MESSAGE_LENGTH) });
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
      await indicator.finish('Не удалось получить ответ от ИИ за ' + elapsed + ' сек.\nПричина: ' + reason);
      return;
    }

    await indicator.finish();
    chat.messages.push({ id: crypto.randomUUID(), createdAt: Date.now(), role: 'assistant', content: answer });
    chat.updatedAt = Date.now();
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }
    store.save();
    await sendAssistantResponse(message.chat.id, answer, text);
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
      const modelSearchPending = pendingModelCatalogSearches.has(inputKey);
      pendingModelCatalogSearches.delete(inputKey);
      if (promptPending) {
        const previousPending = user.pendingSystemPromptInput;
        delete user.pendingSystemPromptInput;
        try { store.save(); } catch (error) {
          user.pendingSystemPromptInput = previousPending;
          throw error;
        }
      }
      pendingTimeoutInput.delete(inputKey);
      const notice = promptPending
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
        '/model [название модели] — выбрать модель или показать доступные\n' +
        '/test — проверить реальный запрос к API\n' +
        '/version — показать версию backend\n' +
        '/settings — показать настройки ИИ и открыть Mini App\n' +
        '/cancel — отменить текущий ввод настройки\n\n' +
        'Created tet0r');
      return true;
    }
    if (command === 'key') {
      await handleKeyCommand(message, parsed.args);
      return true;
    }
    if (command && !['chat', 'add_chat', 'chat_equip', 'model', 'settings', 'provider', 'test'].includes(command)) {
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
        await sendSettings(chatId, user);
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
        await sendSettings(chatId, user);
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
        await sendSettings(chatId, user);
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
