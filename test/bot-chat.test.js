'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BOT_COMMANDS,
  createBotChat,
  createEncryptedStore,
  normalizeApiBase,
  markdownToTelegramHtml,
  splitTelegramHtml,
  splitTelegramText,
  telegramHtmlToPlainText
} = require('../bot-chat');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-bot-'));
}

async function waitFor(predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for asynchronous bot work.');
}

function message(text, userId = 123456, messageId = 1) {
  return {
    message_id: messageId,
    text,
    chat: { id: userId, type: 'private' },
    from: { id: userId, is_bot: false }
  };
}

function callbackQuery(data, userId = 123456, messageId = 500) {
  return {
    id: 'callback-' + messageId + '-' + String(data).replace(/[^a-z0-9]/gi, ''),
    data,
    from: { id: userId, is_bot: false },
    message: { message_id: messageId, chat: { id: userId, type: 'private' } }
  };
}

function makeBot(options = {}) {
  const dir = options.dir || tempDir();
  const sent = [];
  const richMessages = [];
  const documents = [];
  const actions = [];
  const providerCalls = [];
  const events = [];
  const attempts = [];
  const callbackAnswers = [];
  const editedMessages = [];
  const editedRichMessages = [];
  const fetchImpl = options.fetchImpl || (async (url, request) => {
    providerCalls.push({ url, request });
    events.push({ type: 'provider' });
    if (String(url).endsWith('/models')) {
      return {
        ok: options.keyValid !== false,
        status: options.keyValid === false ? 401 : 200,
        json: async () => ({ data: [{ id: 'test/model-a' }, { id: 'test/model-b' }] })
      };
    }
    if (String(url).endsWith('/chat/completions')) {
      const payload = JSON.parse(request.body);
      assert.equal(payload.messages.at(-1).role, 'user');
      if (options.fetchDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.fetchDelayMs));
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: options.answer || 'Ответ ИИ' } }] }) };
    }
    throw new Error('Unexpected URL');
  });
  const bot = createBotChat({
    botToken: 'test-bot-token',
    apiBaseUrl: 'https://provider.example/v1',
    defaultModel: 'test/model-a',
    webAppUrl: options.webAppUrl || 'https://example.com/app',
    encryptionKey: 'ab'.repeat(32),
    dataDir: dir,
    fetchImpl,
    telegramApiCall: options.telegramApiCall,
    proBillingEnabled: options.proBillingEnabled,
    adminIds: options.adminIds,
    sendTelegramRichMessage: async (chatId, richMessage, sendOptions) => {
      const record = {
        chatId,
        richMessage,
        options: sendOptions || {},
        message_id: richMessages.length + 1
      };
      richMessages.push(record);
      events.push({ type: 'rich_send', options: sendOptions || {} });
      if (options.failRichSends) throw new Error('Telegram rich message delivery failed');
      return record;
    },
    sendTelegramDocument: async (chatId, document) => {
      const record = { chatId, ...document, message_id: documents.length + 1 };
      documents.push(record);
      return record;
    },
    sendTelegramMessage: async (chatId, text, sendOptions) => {
      const record = { chatId, text, options: sendOptions || {}, message_id: attempts.length + 1 };
      attempts.push(record);
      events.push({ type: 'send', options: sendOptions || {} });
      if (options.failSends || (options.failSendsOnce && attempts.length === 1)) {
        throw new Error('Telegram delivery failed');
      }
      if (options.rejectHtml && sendOptions && sendOptions.parse_mode === 'HTML') {
        throw new Error("Bad Request: can't parse entities: Unsupported start tag");
      }
      sent.push(record);
      return { message_id: attempts.length };
    },
    deleteTelegramMessage: async (chatId, messageId) => {
      actions.push({ type: 'delete', chatId, messageId });
      events.push({ type: 'delete' });
      if (options.deleteTelegramMessageError) throw new Error('Telegram delete failed');
    },
    answerCallbackQuery: async (callbackQueryId, text) => { callbackAnswers.push({ callbackQueryId, text }); },
    editTelegramMessage: async (chatId, messageId, text, replyMarkup) => {
      editedMessages.push({ chatId, messageId, text, replyMarkup });
    },
    editTelegramRichMessage: async (chatId, messageId, richMessage, replyMarkup) => {
      editedRichMessages.push({ chatId, messageId, richMessage, replyMarkup });
      if (options.failRichEdits) throw new Error('Telegram rich edit failed');
    }
  });
  return { bot, dir, sent, richMessages, documents, attempts, actions, providerCalls, events, callbackAnswers, editedMessages, editedRichMessages };
}

test('API endpoint must be HTTPS and cannot contain credentials or query parameters', () => {
  assert.equal(normalizeApiBase('https://api.example/v1/'), 'https://api.example/v1');
  assert.equal(normalizeApiBase('http://api.example/v1'), null);
  assert.equal(normalizeApiBase('https://user:pass@api.example/v1'), null);
  assert.equal(normalizeApiBase('https://api.example/v1?key=x'), null);
});

test('encrypted storage accepts the Base64 256-bit secret generated by Render', () => {
  const dir = tempDir();
  const generatedSecret = require('node:crypto').randomBytes(32).toString('base64');
  const store = createEncryptedStore({ dataDir: dir, encryptionKey: generatedSecret });
  assert.equal(store.enabled, true);
  store.getUser(99).apiKey = 'secret';
  store.save();
  assert.equal(createEncryptedStore({ dataDir: dir, encryptionKey: generatedSecret }).getUser(99).apiKey, 'secret');
});

test('encrypted storage survives reload and does not expose API keys in plaintext', () => {
  const dir = tempDir();
  const key = 'cd'.repeat(32);
  const first = createEncryptedStore({ dataDir: dir, encryptionKey: key, defaultModel: 'model-a' });
  const user = first.getUser(77);
  user.apiKey = 'sk-secret-test-key';
  user.chats.push({ id: 'chat-1', title: 'Shared privately', model: 'model-a', messages: [] });
  user.activeChatId = 'chat-1';
  first.save();

  const encryptedFile = fs.readFileSync(first.filePath, 'utf8');
  assert.equal(encryptedFile.includes('sk-secret-test-key'), false);
  assert.equal(encryptedFile.includes('Shared privately'), false);

  const second = createEncryptedStore({ dataDir: dir, encryptionKey: key, defaultModel: 'model-a' });
  assert.equal(second.getUser(77).apiKey, 'sk-secret-test-key');
  assert.equal(second.getUser(77).chats[0].title, 'Shared privately');
});

test('/KEY deletes the credential message and stores the key without pretending it was verified', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/KEY sk-valid-key', 123456, 91));
  assert.deepEqual(ctx.actions, [{ type: 'delete', chatId: 123456, messageId: 91 }]);
  assert.equal(ctx.providerCalls.length, 0);
  assert.deepEqual(ctx.events.slice(0, 2).map((event) => event.type), ['delete', 'send']);
  assert.match(ctx.sent[0].text, /Ключ сохранён для провайдера/);
  assert.match(ctx.sent[0].text, /\/test/);
  assert.equal(ctx.bot.store.getUser(123456).apiKey, 'sk-valid-key');
  const stored = fs.readFileSync(ctx.bot.store.filePath, 'utf8');
  assert.equal(stored.includes('sk-valid-key'), false);
});

test('/test performs a real completion request and reports upstream authentication failures', async () => {
  const ctx = makeBot({
    fetchImpl: async (url, request) => {
      assert.equal(String(url), 'https://provider.example/v1/chat/completions');
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'test/model-a');
      return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API key' } }) };
    }
  });
  const user = ctx.bot.store.getUser(123456);
  user.apiKey = 'bad-key';
  user.model = 'test/model-a';
  user.modelExplicit = true;
  ctx.bot.store.save();
  await ctx.bot.handleMessage(message('/test', 123456, 92));
  assert.match(ctx.sent.at(-1).text, /HTTP 401/);
  assert.match(ctx.sent.at(-1).text, /отклонил ключ/);
  assert.equal(ctx.sent.at(-1).text.includes('bad-key'), false);
});

test('/test uses Responses API and pro reasoning for the direct OpenAI Astra Pro alias', async () => {
  const calls = [];
  const ctx = makeBot({
    fetchImpl: async (url, request) => {
      calls.push({ url: String(url), request });
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'gpt-6.2-astra');
      assert.deepEqual(body.reasoning, { mode: 'pro', effort: 'medium' });
      assert.equal(body.max_output_tokens, 512);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'resp_test',
          model: 'gpt-6.2-astra',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'TEST_OK' }]
          }]
        })
      };
    }
  });
  const user = ctx.bot.store.getUser(123456);
  user.apiBaseUrl = 'https://api.openai.com/v1';
  user.apiProtocol = 'openai';
  user.apiAuthType = 'bearer';
  user.apiKey = 'valid-openai-test-key';
  user.model = 'openai/gpt-6.2-astra-pro';
  user.modelExplicit = true;
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('/test'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer valid-openai-test-key');
  assert.match(ctx.sent.at(-1).text, /Подключение работает/);
  assert.match(ctx.sent.at(-1).text, /TEST_OK/);
  assert.match(ctx.sent.at(-1).text, /openai\/gpt-6\.2-astra-pro/);
});

test('/test redacts masked API key fragments returned by the provider', async () => {
  const ctx = makeBot({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        error: {
          message: 'Incorrect API key provided: .storefr****************6e9b. You can find your API key at the dashboard.'
        }
      })
    })
  });
  const user = ctx.bot.store.getUser(123456);
  user.apiKey = 'invalid-test-key';
  user.model = 'test/model-a';
  user.modelExplicit = true;
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('/test'));
  const reply = ctx.sent.at(-1).text;
  assert.match(reply, /HTTP 401/);
  assert.match(reply, /секрет скрыт/);
  assert.doesNotMatch(reply, /storefr|6e9b|\*{4,}/i);
});

test('/add_chat creates numbered names and /CHAT_EQUIP switches chats case-insensitively', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/add_chat'));
  await ctx.bot.handleMessage(message('/ADD_CHAT Проект'));
  let user = ctx.bot.store.getUser(123456);
  assert.deepEqual(user.chats.map((x) => x.title), ['Проект', 'Чат 1']);
  assert.equal(user.activeChatId, user.chats[0].id);

  await ctx.bot.handleMessage(message('/CHAT_EQUIP чат 1'));
  user = ctx.bot.store.getUser(123456);
  assert.equal(user.activeChatId, user.chats[1].id);
  assert.match(ctx.sent.at(-1).text, /Чат 1/);
});

test('/chat reports empty state and /chat_equip reports an error with the chat list', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/chat'));
  assert.match(ctx.sent.at(-1).text, /Чатов пока нет/);
  await ctx.bot.handleMessage(message('/chat_equip missing'));
  assert.match(ctx.sent.at(-2).text, /не найден/);
  assert.match(ctx.sent.at(-1).text, /Чатов пока нет/);
});

test('/version identifies the deployed Telegram backend build', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/version'));
  assert.equal(ctx.sent.at(-1).text, 'В1 Release');
});

test('/model keeps manual ID selection and opens the shared model catalogue without dumping the ID list', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('/model openai/gpt-6.2-astra-pro'));

  const user = ctx.bot.store.getUser(123456);
  assert.equal(user.model, 'openai/gpt-6.2-astra-pro');
  assert.equal(user.modelExplicit, true);
  assert.equal(ctx.providerCalls.length, 0);
  assert.match(ctx.sent.at(-1).text, /Модель выбрана вручную/);

  await ctx.bot.handleMessage(message('/model'));
  const prompt = ctx.sent.at(-1);
  assert.equal(ctx.providerCalls.length, 0);
  assert.match(prompt.text, /общем каталоге/);
  assert.equal(prompt.options.reply_markup.inline_keyboard[0][0].callback_data, 'tn:model');

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model', 123456, prompt.message_id));
  assert.ok(ctx.editedRichMessages.some((item) =>
    item.richMessage.blocks.some((block) => block.type === 'heading' && block.text === 'Выбор ИИ')));
});

test('/model can be selected when the model catalogue is unavailable, and /test checks the selected ID', async () => {
  const calls = [];
  const ctx = makeBot({
    fetchImpl: async (url, request) => {
      calls.push({ url: String(url), request });
      if (String(url).endsWith('/models')) {
        return { ok: false, status: 503, json: async () => ({ error: { message: 'Catalogue temporarily unavailable' } }) };
      }
      if (String(url).endsWith('/chat/completions')) {
        const body = JSON.parse(request.body);
        assert.equal(body.model, 'openai/gpt-6.2-astra-pro');
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'TEST_OK' } }] }) };
      }
      throw new Error('Unexpected URL');
    }
  });
  const user = ctx.bot.store.getUser(123456);
  user.apiKey = 'valid-key';
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('/model openai/gpt-6.2-astra-pro'));
  assert.equal(user.model, 'openai/gpt-6.2-astra-pro');
  assert.equal(calls.length, 0);

  await ctx.bot.handleMessage(message('/test'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example/v1/chat/completions');
  assert.match(ctx.sent.at(-1).text, /Подключение работает/);
  assert.match(ctx.sent.at(-1).text, /TEST_OK/);
});

test('Telegram bot uses native Anthropic Messages API with the provider authentication header', async () => {
  const calls = [];
  const ctx = makeBot({
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      if (String(url).includes('/models?limit=100')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-sonnet-test' }] }) };
      }
      if (String(url).endsWith('/messages')) {
        const body = JSON.parse(request.body);
        assert.equal(body.model, 'claude-sonnet-test');
        assert.equal(body.system.includes('Отвечай без таблиц'), true);
        assert.equal(body.messages.at(-1).role, 'user');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'msg_test',
            model: 'claude-sonnet-test',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Ответ от Anthropic' }],
            usage: { input_tokens: 10, output_tokens: 7 }
          })
        };
      }
      throw new Error('Unexpected URL: ' + url);
    }
  });

  const user = ctx.bot.store.getUser(123456);
  user.model = 'claude-sonnet-test';
  user.modelExplicit = true;
  await ctx.bot.setApiKey(
    123456,
    'anthropic-test-key',
    'https://api.anthropic.com/v1',
    'x-api-key',
    'anthropic',
    true
  );
  await ctx.bot.handleMessage(message('Привет, Anthropic!'));

  assert.equal(ctx.bot.store.getUser(123456).apiProtocol, 'anthropic');
  assert.equal(ctx.bot.store.getUser(123456).apiAuthType, 'x-api-key');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].request.headers['x-api-key'], 'anthropic-test-key');
  assert.equal(calls[0].request.headers['anthropic-version'], '2023-06-01');
  assert.ok(ctx.richMessages.at(-1).richMessage.markdown.startsWith('Ответ от Anthropic'));
});

test('code generation requests send named source files as Telegram documents', async () => {
  const tick = String.fromCharCode(96).repeat(3);
  const answer = 'Готовый скрипт ниже.\n\n' + tick + 'python main.py\nprint("hello from file")\n' + tick + '\n\nЗапустите файл командой python main.py.';
  const ctx = makeBot({ answer });
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Создай Python-скрипт и сохрани код в файл.'));
  assert.equal(ctx.documents.length, 1);
  assert.equal(ctx.documents[0].fileName, 'main.py');
  assert.match(Buffer.from(ctx.documents[0].contentBase64, 'base64').toString('utf8'), /print\("hello from file"\)/);
  assert.equal(ctx.documents[0].caption, 'Файл с кодом: main.py');
  assert.ok(ctx.richMessages.some((item) => item.richMessage.markdown.includes('Готовый скрипт ниже.')));
  assert.ok(ctx.richMessages.some((item) => item.richMessage.markdown.includes('Запустите файл')));
  assert.ok(!ctx.sent.some((item) => item.text.includes('print("hello from file")')));
  const prompt = JSON.parse(ctx.providerCalls.at(-1).request.body).messages[0].content;
  assert.match(prompt, /каждый готовый файл отдельным блоком кода/);
});

test('format conversion requests deliver HTML documents even when the model labels the code fence as CSS', async () => {
  const tick = String.fromCharCode(96).repeat(3);
  const answer = 'Готово.\n\n' + tick + 'css\n<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"></head><body><h1>HTML_OK</h1></body></html>\n' + tick;
  const ctx = makeBot({ answer });
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Теперь в розширение HTML'));

  assert.equal(ctx.documents.length, 1);
  assert.equal(ctx.documents[0].fileName, 'index.html');
  assert.equal(ctx.documents[0].mimeType, 'text/html; charset=utf-8');
  const fileContent = Buffer.from(ctx.documents[0].contentBase64, 'base64').toString('utf8');
  assert.match(fileContent, /<!doctype html>/i);
  assert.match(fileContent, /HTML_OK/);
  assert.equal(ctx.richMessages.some((item) => item.richMessage.markdown.includes('<!doctype html>')), false);
});

test('an explicit target extension replaces a conflicting generated filename extension', async () => {
  const tick = String.fromCharCode(96).repeat(3);
  const html = '<!doctype html>\n<html><body><h1>Converted</h1></body></html>';
  const answer = 'Файл подготовлен.\n\n' + tick + 'css app.css\n' + html + '\n' + tick;
  const ctx = makeBot({ answer });
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Сделаешь файл с расширением .html?'));

  assert.equal(ctx.documents.length, 1);
  assert.equal(ctx.documents[0].fileName, 'app.html');
  const fileContent = Buffer.from(ctx.documents[0].contentBase64, 'base64').toString('utf8');
  assert.match(fileContent, /Converted/);
});

test('HTML content corrects a model-provided CSS filename even without an explicit conversion request', async () => {
  const tick = String.fromCharCode(96).repeat(3);
  const answer = 'Файл готов.\n\n' + tick + 'css app.css\n<!doctype html>\n<html><body><h1>HTML_CONTENT</h1></body></html>\n' + tick;
  const ctx = makeBot({ answer });
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Создай простую HTML-страницу и отправь файлом.'));

  assert.equal(ctx.documents.length, 1);
  assert.equal(ctx.documents[0].fileName, 'app.html');
  assert.equal(ctx.documents[0].mimeType, 'text/html; charset=utf-8');
  assert.match(Buffer.from(ctx.documents[0].contentBase64, 'base64').toString('utf8'), /HTML_CONTENT/);
});

test('code examples in explanatory replies stay inline and do not become files', async () => {
  const tick = String.fromCharCode(96).repeat(3);
  const answer = 'Пример: ' + tick + 'js\nconsole.log(2)\n' + tick;
  const ctx = makeBot({ answer });
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Объясни, что делает пример кода.'));
  assert.equal(ctx.documents.length, 0);
  assert.ok(ctx.richMessages.some((item) => item.richMessage.markdown.includes('console.log(2)')));
});

test('normal chat messages use Responses API for direct OpenAI Astra Pro', async () => {
  const calls = [];
  const ctx = makeBot({
    fetchImpl: async (url, request) => {
      calls.push({ url: String(url), request });
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'gpt-6.2-astra');
      assert.deepEqual(body.reasoning, { mode: 'pro', effort: 'medium' });
      assert.ok(body.input.some((item) => item.role === 'user' && item.content === 'Review this patch.'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'resp_chat_test',
          model: 'gpt-6.2-astra',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'NORMAL_CHAT_OK' }]
          }]
        })
      };
    }
  });
  const user = ctx.bot.store.getUser(123456);
  user.apiBaseUrl = 'https://api.openai.com/v1';
  user.apiProtocol = 'openai';
  user.apiAuthType = 'bearer';
  user.apiKey = 'valid-openai-test-key';
  user.model = 'openai/gpt-6.2-astra-pro';
  user.modelExplicit = true;
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('Review this patch.'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.match(ctx.richMessages.at(-1).richMessage.markdown, /NORMAL_CHAT_OK/);
});

test('normal messages create a chat automatically and send the AI response', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Привет, бот!'));
  const user = ctx.bot.store.getUser(123456);
  assert.equal(user.chats.length, 1);
  assert.equal(user.chats[0].title, 'Чат 1');
  assert.deepEqual(user.chats[0].messages.map((x) => x.role), ['user', 'assistant']);
  assert.match(ctx.richMessages.at(-1).richMessage.markdown, /^Ответ ИИ/);
  assert.match(ctx.richMessages.at(-1).richMessage.markdown, /<tg-button-row align="center">/);
  assert.match(ctx.richMessages.at(-1).richMessage.markdown, /<tg-button type="callback_data" style="success" data="regen:/);
  assert.ok(ctx.sent.some((item) => item.text === 'Генерируем ответ... (0 сек.)'));
  const indicator = ctx.sent.find((item) => item.text === 'Генерируем ответ... (0 сек.)');
  assert.ok(ctx.actions.some((item) => item.type === 'delete' && item.messageId === indicator.message_id));
  const completion = JSON.parse(ctx.providerCalls.at(-1).request.body);
  assert.match(completion.messages[0].content, /Отвечай без таблиц и заголовков #/);
});

test('provider errors fall back to a plain-text status when Rich message delivery fails', async () => {
  const ctx = makeBot({
    fetchImpl: async () => { throw new Error('Upstream request timed out'); },
    failRichSends: true,
    failRichEdits: true,
    deleteTelegramMessageError: true
  });
  const user = ctx.bot.store.getUser(123456);
  user.apiKey = 'valid-key';
  user.model = 'test/model-a';
  user.modelExplicit = true;
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('Привет'));

  const indicator = ctx.sent.find((item) => item.text === 'Генерируем ответ... (0 сек.)');
  assert.ok(indicator, 'the generation indicator should have been sent');
  assert.ok(ctx.editedMessages.some((item) =>
    item.messageId === indicator.message_id &&
    item.text.includes('Не удалось получить ответ от ИИ') &&
    item.text.includes('Upstream request timed out')
  ), 'a plain-text failure should replace the generation indicator');
  assert.equal(ctx.bot.store.getUser(123456).chats[0].messages.filter((item) => item.role === 'assistant').length, 0);
});

test('generation indicator updates its elapsed seconds and is removed after completion', async () => {
  const ctx = makeBot({ fetchDelayMs: 2_300 });
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Подожди пару секунд.'));
  const progressEdits = ctx.editedMessages.filter((item) => /^Генерируем ответ\.\.\. \(\d+ сек\.\)$/.test(item.text));
  assert.ok(progressEdits.length >= 1);
  assert.ok(progressEdits.some((item) => Number(item.text.match(/\((\d+) сек\.\)/)[1]) >= 1));
  assert.match(ctx.richMessages.at(-1).richMessage.markdown, /^Ответ ИИ/);
});

test('Telegram send failures propagate instead of being silently swallowed', async () => {
  const ctx = makeBot({ failSends: true });
  await assert.rejects(ctx.bot.handleMessage(message('/add_chat')), /Telegram delivery failed/);
  assert.equal(ctx.bot.store.getUser(123456).chats.length, 1);
});

test('missing API key asks the user to call /key and still creates an active chat', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('Проверь это сообщение'));
  assert.match(ctx.sent.at(-1).text, /\/key/);
  assert.equal(ctx.bot.store.getUser(123456).chats.length, 1);
});

test('/info ends with the requested signature', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/INFO'));
  assert.ok(ctx.sent.at(-1).text.trimEnd().endsWith('Created tet0r'));
  assert.ok(ctx.sent.at(-1).text.includes('/start'));
  assert.ok(ctx.sent.at(-1).text.includes('/help'));
});

test('long Telegram responses are split below the message-size limit', () => {
  const chunks = splitTelegramText('абв '.repeat(4_000));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 3_900));
  assert.equal(chunks.join('').replace(/\s/g, '').length, ('абв '.repeat(4_000)).replace(/\s/g, '').length);
  const emojiChunks = splitTelegramText('😀'.repeat(4_500));
  assert.ok(emojiChunks.every((chunk) => chunk.length <= 3_900));
  assert.equal(emojiChunks.join(''), '😀'.repeat(4_500));
});



test('Markdown inline bold, italic, inline code and fenced code become safe Telegram HTML', () => {
  const tick = String.fromCharCode(96);
  assert.equal(
    markdownToTelegramHtml('**жирный** *курсив* _ещё_ и ' + tick + 'код' + tick),
    '<b>жирный</b> <i>курсив</i> <i>ещё</i> и <code>код</code>'
  );
  assert.equal(
    markdownToTelegramHtml(tick.repeat(3) + 'js\nconst value = "<tag>";\n' + tick.repeat(3)),
    '<pre><code>const value = "&lt;tag&gt;";</code></pre>'
  );
});

test('Markdown headings, bullets, horizontal rules and links are rendered cleanly', () => {
  assert.equal(
    markdownToTelegramHtml('# Заголовок\n- первый\n* второй\n---\n[сайт](https://example.com/?a=1&b=2)'),
    '<b>Заголовок</b>\n• первый\n• второй\n<a href="https://example.com/?a=1&amp;b=2">сайт</a>'
  );
});

test('Markdown tables become readable bullet rows with column labels', () => {
  assert.equal(
    markdownToTelegramHtml('| Имя | Значение |\n| --- | --- |\n| alpha | 10 |\n| beta | 20 |'),
    '• <b>Имя:</b> alpha · <b>Значение:</b> 10\n• <b>Имя:</b> beta · <b>Значение:</b> 20'
  );
});

test('malformed Markdown stays readable and raw HTML is escaped', () => {
  const tick = String.fromCharCode(96);
  assert.equal(
    markdownToTelegramHtml('Незакрыто **жирное и ' + tick + 'код <tag> &'),
    'Незакрыто **жирное и ' + tick + 'код &lt;tag&gt; &amp;'
  );
  assert.equal(markdownToTelegramHtml('<b>не HTML</b>'), '&lt;b&gt;не HTML&lt;/b&gt;');
});

test('HTML chunks stay within the limit and keep every tag balanced, including code blocks', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const markdown = 'Перед блоком\n\n' + fence + '\n' +
    'строка <значение> 😀 '.repeat(100) + '\n' + fence + '\nПосле блока';
  const chunks = splitTelegramHtml(markdownToTelegramHtml(markdown), 180);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.html.length <= 180);
    const stack = [];
    for (const match of chunk.html.matchAll(/<\/?(b|i|code|pre|a)(?:\s+href="[^"]*")?\s*>/g)) {
      if (match[0].startsWith('</')) {
        assert.equal(stack.pop(), match[1].toLowerCase());
      } else {
        stack.push(match[1].toLowerCase());
      }
    }
    assert.deepEqual(stack, []);
  }
  assert.ok(chunks.map((chunk) => chunk.text).join('').includes('<значение>'));
});

test('assistant answers are sent as Rich Markdown with the regenerate button inside the message', async () => {
  const ctx = makeBot({ answer: '**Привет**\n# Заголовок', rejectHtml: true });
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Скажи привет'));
  const richMessage = ctx.richMessages.at(-1).richMessage;
  assert.match(richMessage.markdown, /^\*\*Привет\*\*\n# Заголовок/);
  assert.match(richMessage.markdown, /<tg-button-row align="center">/);
  assert.match(richMessage.markdown, /data="regen:[0-9a-f-]{36}"/);
  assert.equal(ctx.attempts.some((attempt) => attempt.options.parse_mode === 'HTML'), false);
});

test('registered Telegram command names are lowercase and retain /start and /help', () => {
  assert.ok(BOT_COMMANDS.some((item) => item.command === 'start'));
  assert.ok(BOT_COMMANDS.some((item) => item.command === 'help'));
  assert.ok(BOT_COMMANDS.every((item) => item.command === item.command.toLowerCase()));
});


test('encrypted storage keeps a recoverable previous snapshot', () => {
  const dir = tempDir();
  const key = 'ef'.repeat(32);
  const first = createEncryptedStore({ dataDir: dir, encryptionKey: key });
  first.getUser(123).apiKey = 'first-value';
  first.save();
  first.getUser(123).apiKey = 'second-value';
  first.save();

  fs.writeFileSync(first.filePath, 'corrupted-primary-file', 'utf8');
  const recovered = createEncryptedStore({ dataDir: dir, encryptionKey: key });
  assert.equal(recovered.getUser(123).apiKey, 'first-value');
  assert.equal(recovered.getQueueStats().recoveredFromBackup, true);
});

test('Telegram update queue persists, deduplicates, and recovers processing jobs', () => {
  const dir = tempDir();
  const key = 'bc'.repeat(32);
  const update = {
    update_id: 5001,
    message: { text: '/add_chat', chat: { id: 123 }, from: { id: 123 } }
  };
  const first = createEncryptedStore({ dataDir: dir, encryptionKey: key });
  assert.equal(first.enqueueUpdate(update).accepted, true);
  assert.equal(first.enqueueUpdate(update).duplicate, true);

  const claimed = first.claimNextUpdate();
  assert.equal(claimed.updateId, 5001);
  first.appendOutbox(5001, { chatId: 123, text: 'confirmation' });

  const afterRestart = createEncryptedStore({ dataDir: dir, encryptionKey: key });
  assert.equal(afterRestart.getQueueStats().processing, 1);
  afterRestart.recoverProcessingUpdates();
  const recoveredJob = afterRestart.claimNextUpdate();
  assert.equal(recoveredJob.updateId, 5001);
  assert.equal(afterRestart.getOutboxState(5001).pending.length, 1);

  afterRestart.markOutboxDelivered(5001, 0);
  afterRestart.completeUpdate(5001);
  assert.equal(afterRestart.getQueueStats().total, 0);
  assert.equal(afterRestart.enqueueUpdate(update).duplicate, true);
});

test('queue preserves per-user order while allowing a different user to proceed', () => {
  const store = createEncryptedStore({ dataDir: tempDir(), encryptionKey: 'ab'.repeat(32) });
  const makeUpdate = (updateId, userId) => ({
    update_id: updateId,
    message: { text: '/add_chat', chat: { id: userId }, from: { id: userId } }
  });
  store.enqueueUpdate(makeUpdate(1, 111));
  store.enqueueUpdate(makeUpdate(2, 111));
  store.enqueueUpdate(makeUpdate(3, 222));

  const first = store.claimNextUpdate();
  const second = store.claimNextUpdate([first.userKey]);
  assert.equal(first.updateId, 1);
  assert.equal(second.updateId, 3);
});

test('worker retries only failed Telegram delivery and does not repeat command side effects', async () => {
  const ctx = makeBot({ failSendsOnce: true });
  assert.equal(ctx.bot.startUpdateWorker(async (update) => ctx.bot.handleMessage(update.message), {
    concurrency: 2,
    maxAttempts: 3
  }), true);

  const update = {
    update_id: 7001,
    message: message('/add_chat', 123456, 7001)
  };
  ctx.bot.enqueueUpdate(update);
  await waitFor(() => ctx.bot.getWorkerStats().total === 0);

  assert.equal(ctx.bot.store.getUser(123456).chats.length, 1);
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].text, /Создан и выбран чат/);
  assert.equal(ctx.bot.getWorkerStats().deadLettered, 0);
  assert.equal(await ctx.bot.stopUpdateWorker({ timeoutMs: 1_000 }), true);
});

test('worker preserves the order of messages from the same user with concurrent workers', async () => {
  const ctx = makeBot();
  ctx.bot.startUpdateWorker(async (update) => ctx.bot.handleMessage(update.message), {
    concurrency: 3,
    maxAttempts: 3
  });
  ctx.bot.enqueueUpdate({ update_id: 7101, message: message('/add_chat', 123456, 7101) });
  ctx.bot.enqueueUpdate({ update_id: 7102, message: message('/add_chat', 123456, 7102) });

  await waitFor(() => ctx.bot.getWorkerStats().total === 0);
  assert.deepEqual(ctx.bot.store.getUser(123456).chats.map((chat) => chat.title), ['Чат 2', 'Чат 1']);
  await ctx.bot.stopUpdateWorker({ timeoutMs: 1_000 });
});


test('queued assistant output is delivered as a rich message with its in-message button', async () => {
  const ctx = makeBot({ answer: '**Привет**\n# Заголовок', rejectHtml: true });
  await ctx.bot.handleMessage(message('/key valid-key'));
  ctx.bot.startUpdateWorker(async (update) => ctx.bot.handleMessage(update.message), {
    concurrency: 1,
    maxAttempts: 3
  });
  ctx.bot.enqueueUpdate({
    update_id: 7201,
    message: message('Скажи привет', 123456, 7201)
  });

  await waitFor(() => ctx.bot.getWorkerStats().total === 0);
  const richMessage = ctx.richMessages.at(-1).richMessage;
  assert.match(richMessage.markdown, /^\*\*Привет\*\*\n# Заголовок/);
  assert.match(richMessage.markdown, /<tg-button-row align="center">/);
  assert.equal(ctx.bot.getWorkerStats().deadLettered, 0);
  await ctx.bot.stopUpdateWorker({ timeoutMs: 1_000 });
});


test('synced state merges text history into the encrypted Telegram chat store', async () => {
  const ctx = makeBot();
  const entitled = ctx.bot.store.getUser(7654321);
  entitled.pro = { expiresAt: Date.now() + 60 * 60_000, payments: [{ id: 'test' }], promoRedemptions: [] };
  ctx.bot.store.save();
  const userId = 7654321;
  const now = Date.now();
  const state = ctx.bot.applySyncState(userId, {
    apiBaseUrl: 'https://provider.example/v1',
    model: 'test/model-b',
    settings: { systemPrompt: 'Custom instructions', maxTokens: 777, temperature: 0.3, reasoning: 'high', balBase: 12.5, minBal: 25, requestTimeoutSeconds: 240 },
    activeChatId: 'mini-app-chat',
    chats: [{
      id: 'mini-app-chat',
      title: 'Чат из Mini App',
      model: 'test/model-b',
      createdAt: now,
      updatedAt: now,
      messages: [{ id: 'mini-user-message', role: 'user', content: 'Сообщение из Mini App', createdAt: now }]
    }]
  });

  assert.equal(state.initialized, true);
  assert.equal(state.activeChatId, 'mini-app-chat');
  assert.equal(state.apiBaseUrl, 'https://provider.example/v1');
  assert.equal(state.settings.maxTokens, 777);
  assert.equal(state.settings.reasoning, 'high');
  assert.equal(state.settings.balBase, 12.5);
  assert.equal(state.settings.minBal, 25);
  assert.equal(state.settings.requestTimeoutSeconds, 240);
  assert.equal(state.chats[0].messages[0].id, 'mini-user-message');

  await ctx.bot.setApiKey(userId, 'valid-key', 'https://provider.example/v1');
  await ctx.bot.handleMessage(message('Продолжение из Telegram', userId));
  const stored = ctx.bot.getSyncState(userId);
  const chat = stored.chats.find((item) => item.id === 'mini-app-chat');
  assert.ok(chat);
  assert.ok(chat.messages.some((item) => item.id === 'mini-user-message'));
  assert.ok(chat.messages.some((item) => item.content === 'Продолжение из Telegram'));
  assert.ok(chat.messages.some((item) => item.role === 'assistant' && item.content === 'Ответ ИИ'));
});

test('Mini App sync can clear the previously active chat when starting a new chat', async () => {
  const ctx = makeBot();
  const userId = 7654322;
  const now = Date.now();

  ctx.bot.applySyncState(userId, {
    chats: [{
      id: 'chat-one',
      title: 'Чат 1',
      model: 'test/model',
      createdAt: now,
      updatedAt: now,
      messages: []
    }],
    activeChatId: 'chat-one'
  });
  assert.equal(ctx.bot.getSyncState(userId).activeChatId, 'chat-one');

  const cleared = ctx.bot.applySyncState(userId, {
    chats: [{
      id: 'chat-one',
      title: 'Чат 1',
      model: 'test/model',
      createdAt: now,
      updatedAt: now,
      messages: []
    }],
    activeChatId: null
  });

  assert.equal(cleared.activeChatId, null);
  assert.equal(cleared.chats.some((chat) => chat.id === 'chat-one'), true);
});

test('Telegram settings command renders a compact rich panel with interactive controls and the Mini App deep link', async () => {
  const ctx = makeBot({ webAppUrl: 'https://example.com/app' });
  await ctx.bot.handleMessage(message('/settings'));
  const sent = ctx.sent.at(-1);
  assert.match(sent.text, /Настройки TG Nexus/);
  assert.match(sent.text, /Лимит ответа: 1200 токенов/);
  assert.match(sent.text, /Время ожидания ответа: 120 секунд/);
  assert.match(sent.text, /API: provider\.example\/v1/);
  assert.match(sent.text, /API-ключ: не добавлен/);
  assert.doesNotMatch(sent.text, /https:\/\//);

  const rows = sent.options.reply_markup.inline_keyboard;
  const callbacks = rows.flat().map((button) => button.callback_data).filter(Boolean);
  for (const callback of ['tn:search', 'tn:sandbox', 'tn:reason', 'tn:tokens', 'tn:timeout', 'tn:prompt', 'tn:model', 'tn:providers:0', 'tn:refresh']) {
    assert.ok(callbacks.includes(callback), 'missing settings callback: ' + callback);
  }
  const modelButton = rows.flat().find((button) => button.callback_data === 'tn:model');
  assert.equal(modelButton.text, '🤖 Модель');
  assert.equal(rows.flat().find((button) => button.callback_data === 'tn:search').style, 'danger');
  assert.equal(rows.flat().find((button) => button.callback_data === 'tn:sandbox').style, 'danger');
  const webAppButton = rows.flat().find((button) => button.web_app);
  assert.equal(webAppButton.text, 'Открыть все настройки');
  assert.equal(webAppButton.web_app.url, 'https://example.com/app?open=settings');

  const edited = ctx.editedRichMessages.at(-1);
  assert.ok(edited, 'settings should be upgraded to a rich message');
  assert.equal(edited.replyMarkup.inline_keyboard[0].length, 1);
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].text, '↻ Обновить');
  assert.equal(edited.replyMarkup.inline_keyboard[0][0].callback_data, 'tn:refresh');
  assert.equal(edited.replyMarkup.inline_keyboard[1].length, 1);
  assert.deepEqual(edited.replyMarkup.inline_keyboard[1][0].web_app, webAppButton.web_app);
  const blocks = edited.richMessage.blocks;
  assert.ok(blocks.some((block) => block.type === 'heading' && block.text === 'Настройки TG Nexus'));
  assert.ok(blocks.some((block) => block.type === 'heading' && block.text === 'Подключение'));
  assert.ok(blocks.some((block) => block.type === 'paragraph' && block.text === 'API: provider.example/v1'));
  assert.ok(blocks.some((block) => block.type === 'heading' && block.text === 'Параметры ответа'));
  assert.ok(blocks.some((block) => block.type === 'heading' && block.text === 'Инструменты'));
  const richCallbacks = blocks.filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons.map((button) => button.callback_data).filter(Boolean));
  assert.ok(richCallbacks.includes('tn:model'));
  assert.ok(richCallbacks.includes('tn:search'));
  assert.ok(richCallbacks.includes('tn:sandbox'));
  const initialToggles = blocks.filter((block) => block.type === 'buttons').flatMap((block) => block.buttons);
  assert.equal(initialToggles.find((button) => button.callback_data === 'tn:search').style, 'danger');
  assert.equal(initialToggles.find((button) => button.callback_data === 'tn:sandbox').style, 'danger');
  assert.equal(richCallbacks.includes('tn:refresh'), false);
});

test('Telegram settings can edit, apply and reset the AI system prompt', async () => {
  const ctx = makeBot();
  const entitledUser = ctx.bot.store.getUser(123456);
  entitledUser.pro = { expiresAt: Date.now() + 60 * 60_000, trialExpiresAt: 0, payments: [{ id: 'test-payment' }], promoRedemptions: [] };
  ctx.bot.store.save();
  const userId = 123456;
  const prompt = 'Отвечай как наставник по программированию.\\nПоказывай короткие примеры.';
  await ctx.bot.setApiKey(userId, 'valid-key', 'https://provider.example/v1');
  await ctx.bot.handleMessage(message('/settings'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:prompt'));

  let promptButtons = ctx.editedMessages.at(-1).replyMarkup.inline_keyboard.flat();
  assert.ok(promptButtons.some((button) => button.callback_data === 'tn:prompt:edit'));
  assert.ok(promptButtons.some((button) => button.callback_data === 'tn:prompt:reset'));

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:prompt:edit', userId, 501));
  assert.match(ctx.editedMessages.at(-1).text, /3900 символов/);
  await ctx.bot.handleMessage(message(prompt, userId, 502));
  assert.equal(ctx.bot.getSyncState(userId).settings.systemPrompt, prompt);
  assert.match(ctx.sent.at(-1).text, /Инструкция: пользовательская/);

  await ctx.bot.handleMessage(message('Проверь пользовательскую инструкцию', userId, 503));
  let request = JSON.parse(ctx.providerCalls.at(-1).request.body);
  assert.match(request.messages[0].content, /Отвечай как наставник по программированию/);
  assert.match(request.messages[0].content, /Показывай короткие примеры/);

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:prompt:reset', userId, 504));
  assert.equal(ctx.bot.getSyncState(userId).settings.systemPrompt, 'Ты полезный и дружелюбный ИИ-ассистент. Отвечай ясно и по делу, на языке пользователя.\n\nОтвечай без таблиц и заголовков #. Используй короткие абзацы, простые списки и жирный шрифт только для важного.');
  assert.match(ctx.editedMessages.at(-1).text, /стандартная инструкция/i);

  await ctx.bot.handleMessage(message('Проверь стандартную инструкцию', userId, 505));
  request = JSON.parse(ctx.providerCalls.at(-1).request.body);
  assert.doesNotMatch(request.messages[0].content, /Отвечай как наставник по программированию/);
  assert.match(request.messages[0].content, /Ты полезный и дружелюбный ИИ-ассистент/);
});

test('Telegram system prompt input supports cancellation and rejects oversized text', async () => {
  const ctx = makeBot();
  const userId = 123456;
  await ctx.bot.handleMessage(message('/settings'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:prompt'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:prompt:edit', userId, 501));

  await ctx.bot.handleMessage(message('x'.repeat(3_901), userId, 502));
  assert.equal(ctx.bot.getSyncState(userId).settings.systemPrompt, undefined);
  assert.match(ctx.sent.at(-1).text, /Инструкция слишком длинная/);

  await ctx.bot.handleMessage(message('/cancel', userId, 503));
  assert.match(ctx.sent.at(-1).text, /Ввод инструкции ИИ отменён/);
  await ctx.bot.handleMessage(message('Обычное сообщение после отмены', userId, 504));
  assert.notEqual(ctx.bot.getSyncState(userId).settings.systemPrompt, 'Обычное сообщение после отмены');
});


test('pending AI instruction survives a server restart and /cancel only reports real pending input', async () => {
  const first = makeBot();
  const userId = 654321;

  await first.bot.handleMessage(message('/settings', userId, 601));
  await first.bot.handleCallbackQuery(callbackQuery('tn:prompt', userId, 602));
  await first.bot.handleCallbackQuery(callbackQuery('tn:prompt:edit', userId, 603));
  assert.ok(first.bot.store.getUser(userId).pendingSystemPromptInput);

  const restarted = makeBot({ dir: first.dir });
  await restarted.bot.handleMessage(message('Instruction submitted after restart', userId, 604));
  assert.equal(restarted.bot.getSyncState(userId).settings.systemPrompt, 'Instruction submitted after restart');
  assert.equal(restarted.bot.store.getUser(userId).pendingSystemPromptInput, undefined);

  const secondUser = 654322;
  await restarted.bot.handleMessage(message('/settings', secondUser, 605));
  await restarted.bot.handleCallbackQuery(callbackQuery('tn:prompt', secondUser, 606));
  await restarted.bot.handleCallbackQuery(callbackQuery('tn:prompt:edit', secondUser, 607));
  const restartedAgain = makeBot({ dir: first.dir });
  await restartedAgain.bot.handleMessage(message('/cancel', secondUser, 608));
  assert.match(restartedAgain.sent.at(-1).text, /Ввод инструкции ИИ отменён/);
  assert.equal(restartedAgain.bot.store.getUser(secondUser).pendingSystemPromptInput, undefined);

  await restartedAgain.bot.handleMessage(message('/cancel', secondUser, 609));
  assert.match(restartedAgain.sent.at(-1).text, /Сейчас нет активного ввода настройки/);
});

test('Telegram settings buttons toggle internet search and save the state', async () => {
  const ctx = makeBot();
  const entitledUser = ctx.bot.store.getUser(123456);
  entitledUser.pro = { expiresAt: Date.now() + 60 * 60_000, trialExpiresAt: 0, payments: [{ id: 'test-payment' }], promoRedemptions: [] };
  ctx.bot.store.save();
  await ctx.bot.handleMessage(message('/settings'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:search'));
  assert.equal(ctx.bot.getSyncState(123456).settings.internetSearch, true);
  const searchPanel = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(searchPanel.blocks.some((block) =>
    block.type === 'paragraph' && /Интернет-поиск: включён/.test(block.text)));
  let searchButton = searchPanel.blocks.filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons).find((button) => button.callback_data === 'tn:search');
  assert.equal(searchButton.style, 'success');
  assert.equal(ctx.callbackAnswers.at(-1).text, 'Поиск в интернете включён.');

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:search'));
  const disabledSearchPanel = ctx.editedRichMessages.at(-1).richMessage;
  searchButton = disabledSearchPanel.blocks.filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons).find((button) => button.callback_data === 'tn:search');
  assert.equal(searchButton.style, 'danger');
});


test('Telegram sandbox switch requires consent, stays offline by default, persists, and clears network access when disabled', async () => {
  const ctx = makeBot();
  const entitledUser = ctx.bot.store.getUser(123456);
  entitledUser.pro = { expiresAt: Date.now() + 60 * 60_000, trialExpiresAt: 0, payments: [{ id: 'test-payment' }], promoRedemptions: [] };
  ctx.bot.store.save();
  const userId = 123456;
  const seeded = ctx.bot.store.getUser(userId);
  seeded.settings = { sandboxInternet: true };
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('/settings'));
  const initialSandbox = ctx.editedRichMessages.at(-1).richMessage.blocks
    .filter((block) => block.type === 'buttons').flatMap((block) => block.buttons)
    .find((button) => button.callback_data === 'tn:sandbox');
  assert.equal(initialSandbox.style, 'danger');
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:sandbox', userId, 500));

  assert.match(ctx.editedMessages.at(-1).text, /изолированном iframe/);
  const confirmationButtons = ctx.editedMessages.at(-1).replyMarkup.inline_keyboard.flat();
  assert.ok(confirmationButtons.some((button) => button.callback_data === 'tn:sandbox:confirm'));
  assert.ok(confirmationButtons.some((button) => button.callback_data === 'tn:sandbox:cancel'));
  assert.notEqual(ctx.bot.getSyncState(userId).settings.sandbox, true);

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:sandbox:cancel', userId, 500));
  assert.notEqual(ctx.bot.getSyncState(userId).settings.sandbox, true);

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:sandbox', userId, 500));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:sandbox:confirm', userId, 500));
  let settings = ctx.bot.getSyncState(userId).settings;
  assert.equal(settings.sandbox, true);
  assert.equal(settings.sandboxInternet, false);

  const mainPanel = ctx.editedRichMessages.at(-1).richMessage;
  const sandboxButton = mainPanel.blocks.filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons)
    .find((button) => button.callback_data === 'tn:sandbox');
  assert.match(sandboxButton.text, /Песочница: ВКЛ/);
  assert.equal(sandboxButton.style, 'success');

  const restarted = makeBot({ dir: ctx.dir });
  settings = restarted.bot.getSyncState(userId).settings;
  assert.equal(settings.sandbox, true);
  assert.equal(settings.sandboxInternet, false);

  await restarted.bot.handleCallbackQuery(callbackQuery('tn:sandbox', userId, 500));
  settings = restarted.bot.getSyncState(userId).settings;
  assert.equal(settings.sandbox, false);
  assert.equal(settings.sandboxInternet, false);
  assert.match(restarted.callbackAnswers.at(-1).text, /Песочница отключена/);

  const offButton = restarted.editedRichMessages.at(-1).richMessage.blocks
    .filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons)
    .find((button) => button.callback_data === 'tn:sandbox');
  assert.match(offButton.text, /Песочница: ВЫКЛ/);
  assert.equal(offButton.style, 'danger');
});

test('Telegram settings token and reasoning menus render as rich selection cards', async () => {
  const ctx = makeBot();
  const entitledUser = ctx.bot.store.getUser(123456);
  entitledUser.pro = { expiresAt: Date.now() + 60 * 60_000, trialExpiresAt: 0, payments: [{ id: 'test-payment' }], promoRedemptions: [] };
  ctx.bot.store.save();
  await ctx.bot.handleMessage(message('/settings'));

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:tokens'));
  const tokenPanel = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(tokenPanel.blocks.some((block) =>
    block.type === 'heading' && block.text === 'Настройки TG Nexus'));
  assert.ok(tokenPanel.blocks.some((block) =>
    block.type === 'paragraph' && block.text.replace(/\s/g, '').includes('Текущеезначение:1200токенов')));
  const tokenButtons = tokenPanel.blocks.filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons);
  assert.equal(tokenButtons.find((button) => button.callback_data === 'tn:t:1200').style, 'success');

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:t:4000', 123456, 501));
  assert.equal(ctx.bot.getSyncState(123456).settings.maxTokens, 4000);

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:reason', 123456, 501));
  const reasoningSelection = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(reasoningSelection.blocks.some((block) =>
    block.type === 'paragraph' && /Текущее значение: Авто/.test(block.text)));
  const reasoningButtons = reasoningSelection.blocks.filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons);
  assert.equal(reasoningButtons.find((button) => button.callback_data === 'tn:r:auto').style, 'success');

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:r:high', 123456, 501));
  assert.equal(ctx.bot.getSyncState(123456).settings.reasoning, 'high');
  const reasoningPanel = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(reasoningPanel.blocks.some((block) =>
    block.type === 'paragraph' && /Рассуждения: Высокий/.test(block.text)));
});

test('Telegram provider chooser renders providers inside the rich settings card', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/settings'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:providers:0'));

  const panel = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(panel.blocks.some((block) =>
    block.type === 'heading' && block.text === 'Настройки TG Nexus'));
  assert.ok(panel.blocks.some((block) =>
    block.type === 'heading' && block.text === 'Подключение'));
  assert.ok(panel.blocks.some((block) =>
    block.type === 'paragraph' && /Страница 1 из/.test(block.text)));

  const buttons = panel.blocks.filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons);
  assert.ok(buttons.some((button) => button.callback_data === 'tn:provider:openrouter'));
  assert.ok(buttons.some((button) => button.callback_data === 'tn:providers:1'));
  assert.ok(buttons.some((button) => button.callback_data === 'tn:back'));
});

test('Telegram timeout setting selects and persists the provider response wait', async () => {
  const ctx = makeBot();
  const entitledUser = ctx.bot.store.getUser(123456);
  entitledUser.pro = { expiresAt: Date.now() + 60 * 60_000, trialExpiresAt: 0, payments: [{ id: 'test-payment' }], promoRedemptions: [] };
  ctx.bot.store.save();
  await ctx.bot.handleMessage(message('/settings'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:timeout'));
  const timeoutSelectionPanel = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(timeoutSelectionPanel.blocks.some((block) =>
    block.type === 'heading' && block.text === 'Настройки TG Nexus'));
  assert.ok(timeoutSelectionPanel.blocks.some((block) =>
    block.type === 'heading' && block.text === 'Параметры ответа'));
  assert.ok(timeoutSelectionPanel.blocks.some((block) =>
    block.type === 'paragraph' && /Текущее значение: 120 секунд/.test(block.text)));
  const timeoutButtons = timeoutSelectionPanel.blocks
    .filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons);
  assert.ok(timeoutButtons.some((button) => button.callback_data === 'tn:timeout:300'));
  assert.ok(timeoutButtons.some((button) => button.callback_data === 'tn:timeout:7200'));
  assert.ok(timeoutButtons.some((button) => button.callback_data === 'tn:timeout:custom'));
  assert.equal(timeoutButtons.find((button) => button.callback_data === 'tn:timeout:120').style, 'success');
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:timeout:300', 123456, 501));
  assert.equal(ctx.bot.getSyncState(123456).settings.requestTimeoutSeconds, 300);
  const timeoutPanel = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(timeoutPanel.blocks.some((block) =>
    block.type === 'paragraph' && /Тайм-аут: 300 с/.test(block.text)));

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:timeout:custom', 123456, 502));
  assert.match(ctx.editedMessages.at(-1).text, /от 10 до 7200/);
  await ctx.bot.handleMessage(message('7201', 123456, 503));
  assert.equal(ctx.bot.getSyncState(123456).settings.requestTimeoutSeconds, 300);
  assert.match(ctx.sent.at(-1).text, /от 10 до 7200 секунд/);
  await ctx.bot.handleMessage(message('7200', 123456, 504));
  assert.equal(ctx.bot.getSyncState(123456).settings.requestTimeoutSeconds, 7200);
  assert.ok(ctx.sent.some((item) => /Тайм-аут ответа провайдера установлен: 7200/.test(item.text)));
  assert.match(ctx.sent.at(-1).text, /Время ожидания ответа: 7200 секунд/);
});

test('model catalogue offers safe key entry when the encrypted store has no provider key', async () => {
  const first = makeBot();
  const userId = 777123;
  await first.bot.handleMessage(message('/settings', userId, 870));
  await first.bot.handleCallbackQuery(callbackQuery('tn:model', userId, 871));

  let view = first.editedRichMessages.at(-1).richMessage;
  assert.ok(view.blocks.some((block) => block.type === 'heading' && block.text === 'Выбор ИИ'));
  assert.ok(view.blocks.some((block) => block.type === 'buttons' &&
    block.buttons.some((button) => button.callback_data === 'mc:key')));
  assert.equal(first.providerCalls.length, 0);

  await first.bot.handleCallbackQuery(callbackQuery('mc:key', userId, 871));
  const prompt = first.sent.at(-1);
  assert.equal(prompt.options.reply_markup.force_reply, true);
  assert.equal(prompt.options.reply_markup.input_field_placeholder, 'API-ключ');

  const restarted = makeBot({ dir: first.dir });
  const reply = message('valid-provider-key', userId, 872);
  reply.reply_to_message = { message_id: prompt.message_id };
  await restarted.bot.handleMessage(reply);

  const stored = restarted.bot.store.getUser(userId);
  assert.equal(stored.apiKey, 'valid-provider-key');
  assert.equal(stored.pendingModelCatalogSearch, undefined);
  assert.ok(restarted.actions.some((item) => item.type === 'delete' && item.messageId === 872));
  assert.equal(restarted.providerCalls.length, 1);
  assert.ok(restarted.editedRichMessages.at(-1).richMessage.blocks.some((block) =>
    block.type === 'buttons' && block.buttons.some((button) => button.callback_data === 'mc:model:0')));
  assert.equal(stored.chats.length, 0);
});

test('invalid provider key is removed from the user record after catalog authentication fails', async () => {
  const ctx = makeBot({ keyValid: false });
  const userId = 777124;
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model', userId, 881));
  await ctx.bot.handleCallbackQuery(callbackQuery('mc:key', userId, 881));
  const prompt = ctx.sent.at(-1);
  const reply = message('invalid-provider-key', userId, 882);
  reply.reply_to_message = { message_id: prompt.message_id };
  await ctx.bot.handleMessage(reply);

  assert.equal(ctx.bot.store.getUser(userId).apiKey, '');
  assert.ok(ctx.actions.some((item) => item.type === 'delete' && item.messageId === 882));
  assert.ok(ctx.editedRichMessages.at(-1).richMessage.blocks.some((block) =>
    block.type === 'heading' && block.text === 'Не удалось проверить ключ'));
});

test('model catalogue refuses to store a key when Telegram cannot delete its message', async () => {
  const ctx = makeBot({ deleteTelegramMessageError: true });
  const userId = 777125;
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model', userId, 891));
  await ctx.bot.handleCallbackQuery(callbackQuery('mc:key', userId, 891));
  const prompt = ctx.sent.at(-1);
  const reply = message('secret-provider-key', userId, 892);
  reply.reply_to_message = { message_id: prompt.message_id };
  await ctx.bot.handleMessage(reply);

  assert.equal(ctx.bot.store.getUser(userId).apiKey, '');
  assert.match(ctx.sent.at(-1).text, /не сохраняю его/);
  assert.equal(ctx.providerCalls.length, 0);
});

test('/model opens the catalogue prompt even when the provider key is missing', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/model'));
  const sent = ctx.sent.at(-1);
  assert.match(sent.text, /общем каталоге/);
  assert.equal(sent.options.reply_markup.inline_keyboard[0][0].callback_data, 'tn:model');
  assert.equal(ctx.providerCalls.length, 0);
});


test('model catalogue sends valid Bot API 10.3 rich-message blocks and in-message callback buttons', async () => {
  const dir = tempDir();
  const telegramCalls = [];
  const bot = createBotChat({
    botToken: 'test-bot-token',
    apiBaseUrl: 'https://provider.example/v1',
    defaultModel: 'test/model-a',
    encryptionKey: 'ab'.repeat(32),
    dataDir: dir,
    fetchImpl: async (url, request) => {
      const address = String(url);
      if (address.startsWith('https://api.telegram.org/')) {
        const method = address.slice(address.lastIndexOf('/') + 1);
        const payload = JSON.parse(request.body);
        telegramCalls.push({ method, payload });
        return new Response(JSON.stringify({
          ok: true,
          result: method === 'answerCallbackQuery' ? true : { message_id: 500 }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (address === 'https://provider.example/v1/models') {
        return new Response(JSON.stringify({
          data: [
            { id: 'test/model-a', name: 'Model A', context_length: 128000 },
            { id: 'test/model-b', name: 'Model B', context_length: 256000 }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('Unexpected request: ' + address);
    }
  });
  await bot.setApiKey(123456, 'valid-provider-key', 'https://provider.example/v1');
  await bot.handleCallbackQuery(callbackQuery('tn:model', 123456, 500));

  const edit = telegramCalls.find((item) =>
    item.method === 'editMessageText' && item.payload.rich_message);
  assert.ok(edit, 'catalogue should be sent through editMessageText.rich_message');
  assert.ok(edit.payload.rich_message.blocks.some((block) =>
    block.type === 'heading' && block.text === 'Выбор ИИ'));
  const buttonRows = edit.payload.rich_message.blocks.filter((block) => block.type === 'buttons');
  assert.ok(buttonRows.length >= 2);
  assert.ok(buttonRows.some((block) =>
    block.buttons.some((button) => button.callback_data === 'mc:model:0')));
  assert.deepEqual(edit.payload.reply_markup, { inline_keyboard: [] });
});

test('Telegram model catalogue shows rich model buttons and saves the selected model', async () => {
  const ctx = makeBot();
  await ctx.bot.setApiKey(123456, 'valid-key', 'https://provider.example/v1');
  await ctx.bot.handleMessage(message('/settings'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model'));
  const home = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(home.blocks.some((block) => block.type === 'buttons' &&
    block.buttons.some((button) => button.callback_data === 'mc:model:1')));
  await ctx.bot.handleCallbackQuery(callbackQuery('mc:model:1', 123456, 500));
  assert.ok(ctx.editedRichMessages.at(-1).richMessage.blocks.some((block) =>
    block.type === 'buttons' && block.buttons.some((button) => button.callback_data === 'mc:choose')));
  await ctx.bot.handleCallbackQuery(callbackQuery('mc:choose', 123456, 500));
  assert.equal(ctx.bot.getSyncState(123456).model, 'test/model-b');
});


test('/provider switches endpoint and clears a key and model from the previous provider', async () => {
  const ctx = makeBot();
  const user = ctx.bot.store.getUser(123456);
  user.apiKey = 'old-provider-key';
  user.model = 'old/model';
  user.modelExplicit = true;
  user.chats.push({ id: 'legacy-chat', title: 'Старый чат', model: 'old/model', messages: [] });
  user.activeChatId = 'legacy-chat';
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('/provider groq'));
  const updated = ctx.bot.store.getUser(123456);
  assert.equal(updated.apiBaseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(updated.apiProviderId, 'groq');
  assert.equal(updated.apiAuthType, 'bearer');
  assert.equal(updated.apiProtocol, 'openai');
  assert.equal(updated.apiKey, '');
  assert.equal(updated.model, '');
  assert.equal(updated.chats[0].model, '');
  assert.match(ctx.sent.at(-1).text, /Старый ключ сброшен/);
});

test('provider settings card pages through the catalog and changes endpoint', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/settings'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:providers:0'));
  const selection = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(selection.blocks.some((block) =>
    block.type === 'paragraph' && /Выберите API-провайдера/.test(block.text)));
  const buttons = selection.blocks.filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons);
  assert.ok(buttons.some((button) => button.callback_data === 'tn:provider:openrouter'));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:provider:groq', 123456, 501));
  const user = ctx.bot.store.getUser(123456);
  assert.equal(user.apiBaseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(user.apiKey, '');
  const providerPanel = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(providerPanel.blocks.some((block) =>
    block.type === 'paragraph' && /Провайдер: Groq/.test(block.text)));
});

test('/test succeeds after manual model selection while /model opens the shared catalogue', async () => {
  const ctx = makeBot({ answer: 'TEST_OK' });
  await ctx.bot.handleMessage(message('/provider groq'));
  await ctx.bot.handleMessage(message('/key groq-test-key'));
  await ctx.bot.handleMessage(message('/model'));
  const modelMenu = ctx.sent.at(-1);
  assert.equal(modelMenu.options.reply_markup.inline_keyboard[0][0].callback_data, 'tn:model');
  assert.equal(ctx.providerCalls.some((call) => call.url === 'https://api.groq.com/openai/v1/models'), false);

  await ctx.bot.handleMessage(message('/model test/model-a'));
  await ctx.bot.handleMessage(message('/test'));
  const user = ctx.bot.store.getUser(123456);
  assert.equal(user.apiBaseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(user.model, 'test/model-a');
  assert.ok(ctx.providerCalls.some((call) => call.url === 'https://api.groq.com/openai/v1/chat/completions'));
  assert.equal(ctx.providerCalls.some((call) => call.url === 'https://api.groq.com/openai/v1/models'), false);
  const testRequest = ctx.providerCalls.filter((call) => call.url === 'https://api.groq.com/openai/v1/chat/completions').at(-1);
  assert.equal(JSON.parse(testRequest.request.body).max_tokens, 512);
  assert.match(ctx.sent.at(-1).text, /Подключение работает/);
  assert.match(ctx.sent.at(-1).text, /TEST_OK/);
});

test('Telegram settings callbacks cannot be used from another user identity', async () => {
  const ctx = makeBot();
  await ctx.bot.handleCallbackQuery({
    ...callbackQuery('tn:search'),
    from: { id: 999999, is_bot: false }
  });
  assert.equal(ctx.bot.getSyncState(123456).settings.internetSearch, false);
  assert.equal(ctx.bot.getSyncState(999999).settings.internetSearch, false);
  assert.equal(ctx.editedMessages.length, 0);
});

test('per-user system prompt, token limit, temperature, and OpenRouter web search reach the model request', async () => {
  const ctx = makeBot();
  const entitled = ctx.bot.store.getUser(123456);
  entitled.pro = { expiresAt: Date.now() + 60 * 60_000, payments: [{ id: 'test' }], promoRedemptions: [] };
  ctx.bot.store.save();
  const userId = 123456;
  await ctx.bot.setApiKey(userId, 'valid-key', 'https://openrouter.ai/api/v1');
  ctx.bot.applySyncState(userId, {
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    settings: {
      systemPrompt: 'Use the custom test instruction.',
      maxTokens: 333,
      temperature: 0.4,
      reasoning: 'high',
      internetSearch: true
    }
  });

  await ctx.bot.handleMessage(message('Find current information', userId));
  const request = JSON.parse(ctx.providerCalls.at(-1).request.body);
  assert.equal(request.max_tokens, 333);
  assert.equal(request.temperature, 0.4);
  assert.equal(request.reasoning_effort, 'high');
  assert.match(request.messages[0].content, /Use the custom test instruction/);
  assert.deepEqual(request.tools, [{ type: 'openrouter:web_search', parameters: { max_uses: 3, max_results: 5 } }]);
  assert.equal(request.max_tool_calls, 5);
});


test('model selector opens a rich catalogue and selects a model into the active settings', async () => {
  const ctx = makeBot({
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'test/model-a', name: 'Model A', context_length: 128000,
            pricing: { prompt: '0', completion: '0' },
            architecture: { input_modalities: ['text'] } },
          { id: 'test/model-b', name: 'Model B', context_length: 256000,
            pricing: { prompt: '0.000001', completion: '0.000002' },
            architecture: { input_modalities: ['text', 'image'] } }
        ]
      })
    })
  });
  const user = ctx.bot.store.getUser(123456);
  user.apiKey = 'valid-test-key';
  ctx.bot.store.save();

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model'));
  assert.ok(ctx.editedRichMessages.length >= 1);
  const home = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(home.blocks.some((block) => block.type === 'buttons' &&
    block.buttons.some((button) => button.callback_data === 'mc:model:0')));
  assert.deepEqual(ctx.editedRichMessages.at(-1).replyMarkup, { inline_keyboard: [] });

  await ctx.bot.handleCallbackQuery(callbackQuery('mc:model:0'));
  const card = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(card.blocks.some((block) => block.type === 'table'));
  assert.ok(card.blocks.some((block) => block.type === 'heading' && block.text === 'Model A'));
  assert.ok(card.blocks.some((block) => block.type === 'buttons' &&
    block.buttons.some((button) => button.callback_data === 'mc:choose')));

  await ctx.bot.handleCallbackQuery(callbackQuery('mc:choose'));
  assert.equal(ctx.bot.store.getUser(123456).model, 'test/model-a');
  assert.ok(ctx.editedRichMessages.at(-1).richMessage.blocks.some((block) =>
    block.type === 'paragraph' && block.text.includes('установлена')));
});

test('model catalogue search uses ForceReply and does not forward the search phrase to the AI chat', async () => {
  const ctx = makeBot({
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'test/model-a', name: 'Model A' },
          { id: 'test/model-b', name: 'Model B' }
        ]
      })
    })
  });
  const user = ctx.bot.store.getUser(123456);
  user.apiKey = 'valid-test-key';
  ctx.bot.store.save();

  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model'));
  await ctx.bot.handleCallbackQuery(callbackQuery('mc:search'));
  const prompt = ctx.sent.at(-1);
  assert.equal(prompt.options.reply_markup.force_reply, true);

  const reply = message('Model B', 123456, 91);
  reply.reply_to_message = { message_id: prompt.message_id };
  await ctx.bot.handleMessage(reply);

  const result = ctx.editedRichMessages.at(-1).richMessage;
  assert.ok(result.blocks.some((block) => block.type === 'heading' && block.text === 'Модели'));
  assert.ok(result.blocks.some((block) => block.type === 'buttons' &&
    block.buttons.some((button) => button.text.includes('Model B'))));
  assert.equal(ctx.bot.store.getUser(123456).chats.length, 0);
  assert.equal(ctx.providerCalls.some((call) => String(call.url).endsWith('/chat/completions')), false);
});


test('model catalogue search prompt and small view state survive a backend restart without saving model cards', async () => {
  const userId = 654399;
  const data = {
    data: [
      { id: 'test/model-a', name: 'Model A', description: 'A model', context_length: 128000 },
      { id: 'test/model-b', name: 'Model B', description: 'B model', context_length: 256000 }
    ]
  };
  const first = makeBot({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => data }) });
  await first.bot.setApiKey(userId, 'valid-key', 'https://provider.example/v1');
  await first.bot.handleMessage(message('/settings', userId, 801));
  await first.bot.handleCallbackQuery(callbackQuery('tn:model', userId, 802));
  await first.bot.handleCallbackQuery(callbackQuery('mc:search', userId, 802));

  const beforeRestart = first.bot.store.getUser(userId);
  const promptId = beforeRestart.pendingModelCatalogSearch.promptMessageId;
  assert.ok(beforeRestart.modelCatalogState);
  assert.equal(Object.prototype.hasOwnProperty.call(beforeRestart.modelCatalogState, 'models'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(beforeRestart.modelCatalogState, 'description'), false);

  const restarted = makeBot({
    dir: first.dir,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => data })
  });
  const reply = message('Model B', userId, 803);
  reply.reply_to_message = { message_id: promptId };
  await restarted.bot.handleMessage(reply);

  const result = restarted.editedRichMessages.at(-1).richMessage;
  assert.ok(result.blocks.some((block) => block.type === 'heading' && block.text === 'Модели'));
  assert.ok(result.blocks.some((block) => block.type === 'buttons' &&
    block.buttons.some((button) => button.text.includes('Model B'))));
  const afterRestart = restarted.bot.store.getUser(userId);
  assert.equal(afterRestart.pendingModelCatalogSearch, undefined);
  assert.equal(afterRestart.modelCatalogState.query, 'Model B');
  assert.equal(afterRestart.chats.length, 0);
});

test('model card can be reopened after backend restart by re-fetching provider details', async () => {
  const userId = 654400;
  const data = {
    data: [
      { id: 'test/model-a', name: 'Model A', context_length: 128000 },
      { id: 'test/model-b', name: 'Model B', description: 'B description', context_length: 256000 }
    ]
  };
  const first = makeBot({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => data }) });
  await first.bot.setApiKey(userId, 'valid-key', 'https://provider.example/v1');
  await first.bot.handleMessage(message('/settings', userId, 811));
  await first.bot.handleCallbackQuery(callbackQuery('tn:model', userId, 812));

  const restarted = makeBot({
    dir: first.dir,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => data })
  });
  await restarted.bot.handleCallbackQuery(callbackQuery('mc:model:1', userId, 812));
  const card = restarted.editedRichMessages.at(-1).richMessage;
  assert.ok(card.blocks.some((block) => block.type === 'heading' && block.text === 'Model B'));
  assert.ok(card.blocks.some((block) => block.type === 'paragraph' && block.text === 'B description'));
  assert.equal(restarted.bot.store.getUser(userId).modelCatalogState.selectedModelId, 'test/model-b');
});


test('sendRichMessage sends a Telegram Rich Message with in-message buttons', async () => {
  const ctx = makeBot();
  const richMessage = {
    blocks: [{
      type: 'buttons',
      buttons: [
        { text: 'Accept', callback_data: 'terms:accept:test', style: 'success' },
        { text: 'Decline', callback_data: 'terms:decline:test', style: 'danger' }
      ]
    }]
  };
  await ctx.bot.sendRichMessage(123456, richMessage);
  assert.equal(ctx.richMessages.length, 1);
  assert.deepEqual(ctx.richMessages[0].richMessage, richMessage);
  assert.equal(ctx.events.at(-1).type, 'rich_send');
});

test('encrypted outbox persists Rich Messages and their buttons across reloads', () => {
  const dir = tempDir();
  const key = 'ef'.repeat(32);
  const first = createEncryptedStore({ dataDir: dir, encryptionKey: key });
  first.enqueueUpdate({
    update_id: 8901,
    message: {
      text: '/start',
      chat: { id: 123456, type: 'private' },
      from: { id: 123456, is_bot: false }
    }
  });
  first.claimNextUpdate();

  const richMessage = {
    blocks: [{
      type: 'buttons',
      buttons: [{ text: 'Accept & Continue', callback_data: 'terms:accept:test', style: 'success' }]
    }]
  };
  first.appendOutbox(8901, { chatId: 123456, kind: 'rich_message', richMessage });

  const restarted = createEncryptedStore({ dataDir: dir, encryptionKey: key });
  const pending = restarted.getOutboxState(8901).pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'rich_message');
  assert.deepEqual(pending[0].richMessage, richMessage);
});


test('model catalogue detects an API key entered where a manual model ID is requested', async () => {
  const ctx = makeBot();
  const userId = 777130;
  await ctx.bot.handleMessage(message('/settings', userId, 929));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model', userId, 930));
  await ctx.bot.handleCallbackQuery(callbackQuery('mc:manual', userId, 930));

  const firstPrompt = ctx.sent.at(-1);
  assert.equal(firstPrompt.options.reply_markup.input_field_placeholder, 'ID модели');
  const accidentalKey = 'sk-or-v1-' + 'a'.repeat(48);
  const reply = message(accidentalKey, userId, 931);
  reply.reply_to_message = { message_id: firstPrompt.message_id };
  const callsBeforeReply = ctx.providerCalls.length;

  await ctx.bot.handleMessage(reply);

  const user = ctx.bot.store.getUser(userId);
  assert.ok(ctx.actions.some((item) => item.type === 'delete' && item.messageId === 931));
  assert.match(ctx.sent.at(-1).text, /API-ключ, а не ID модели/);
  assert.ok(ctx.sent.at(-1).text.includes('provider/model'));
  assert.equal(user.apiKey, '');
  assert.notEqual(user.modelCatalogState.selectedModelId, accidentalKey);
  assert.notEqual(user.model, accidentalKey);
  assert.equal(ctx.providerCalls.length, callsBeforeReply);
  assert.equal(user.pendingModelCatalogSearch.mode, 'manual');
  assert.notEqual(user.pendingModelCatalogSearch.promptMessageId, firstPrompt.message_id);
});

test('model catalogue does not process a key-like value if Telegram cannot delete the message', async () => {
  const ctx = makeBot({ deleteTelegramMessageError: true });
  const userId = 777131;
  await ctx.bot.handleMessage(message('/settings', userId, 939));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model', userId, 940));
  await ctx.bot.handleCallbackQuery(callbackQuery('mc:manual', userId, 940));

  const prompt = ctx.sent.at(-1);
  const accidentalKey = 'sk-or-v1-' + 'b'.repeat(48);
  const reply = message(accidentalKey, userId, 941);
  reply.reply_to_message = { message_id: prompt.message_id };
  const callsBeforeReply = ctx.providerCalls.length;

  await ctx.bot.handleMessage(reply);

  const user = ctx.bot.store.getUser(userId);
  assert.match(ctx.sent.at(-1).text, /не буду обрабатывать или сохранять/);
  assert.equal(user.apiKey, '');
  assert.notEqual(user.modelCatalogState.selectedModelId, accidentalKey);
  assert.notEqual(user.model, accidentalKey);
  assert.equal(user.pendingModelCatalogSearch, undefined);
  assert.equal(ctx.providerCalls.length, callsBeforeReply);
});

test('manual model catalogue entry still accepts a normal provider/model ID', async () => {
  const ctx = makeBot();
  const userId = 777132;
  await ctx.bot.handleMessage(message('/settings', userId, 949));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:model', userId, 950));
  await ctx.bot.handleCallbackQuery(callbackQuery('mc:manual', userId, 950));

  const prompt = ctx.sent.at(-1);
  const reply = message('test/model-a', userId, 951);
  reply.reply_to_message = { message_id: prompt.message_id };

  await ctx.bot.handleMessage(reply);

  assert.equal(ctx.bot.store.getUser(userId).modelCatalogState.selectedModelId, 'test/model-a');
  assert.ok(ctx.editedRichMessages.at(-1).richMessage.blocks.some((block) =>
    block.type === 'heading' && block.text === 'test/model-a'));
});


test('12-day PRO trial is granted once and persists across restarts', () => {
  const ctx = makeBot();
  const userId = 770001;
  const first = ctx.bot.ensureTrial(userId);
  assert.equal(first.trialActive, true);
  assert.equal(first.remainingDays, 12);
  assert.equal(first.expiresAt, first.trialExpiresAt);

  const repeated = ctx.bot.ensureTrial(userId);
  assert.equal(repeated.expiresAt, first.expiresAt);

  const restarted = makeBot({ dir: ctx.dir });
  const afterRestart = restarted.bot.ensureTrial(userId);
  assert.equal(afterRestart.expiresAt, first.expiresAt);
  assert.equal(afterRestart.trialActive, true);
});

test('Telegram Stars invoice is XTR and payment adds purchased days exactly once', async () => {
  const apiCalls = [];
  const ctx = makeBot({
    proBillingEnabled: true,
    telegramApiCall: async (method, payload, requestOptions) => {
      apiCalls.push({ method, payload, requestOptions });
      return method === 'sendInvoice' ? { message_id: 991 } : true;
    }
  });
  const userId = 770002;
  const user = ctx.bot.store.getUser(userId);
  user.termsAcceptedVersion = '2026-11-26-v2';
  ctx.bot.store.save();
  const trial = ctx.bot.ensureTrial(userId);

  await ctx.bot.handleMessage(message('/pro', userId, 9910));
  assert.ok(ctx.sent.at(-1).options.reply_markup.inline_keyboard.flat()
    .some((button) => button.callback_data === 'pro:buy:7'));

  await ctx.bot.handleCallbackQuery(callbackQuery('pro:buy:7', userId, 9911));
  const invoiceCall = apiCalls.find((item) => item.method === 'sendInvoice');
  assert.ok(invoiceCall);
  assert.equal(invoiceCall.payload.currency, 'XTR');
  assert.equal(invoiceCall.payload.prices[0].amount, 49);
  assert.equal(Object.prototype.hasOwnProperty.call(invoiceCall.payload, 'provider_token'), false);

  const pending = ctx.bot.store.getUser(userId).pendingStarPayments[0];
  assert.ok(pending);
  const approved = await ctx.bot.handlePreCheckoutQuery({
    id: 'pre-checkout-770002',
    from: { id: userId },
    invoice_payload: pending.payload,
    currency: 'XTR',
    total_amount: 49
  });
  assert.equal(approved, true);
  assert.equal(apiCalls.at(-1).method, 'answerPreCheckoutQuery');
  assert.equal(apiCalls.at(-1).payload.ok, true);
  assert.equal(apiCalls.at(-1).requestOptions.timeoutMs, 8000);

  const paidMessage = {
    message_id: 9912,
    chat: { id: userId, type: 'private' },
    from: { id: userId, is_bot: false },
    successful_payment: {
      invoice_payload: pending.payload,
      currency: 'XTR',
      total_amount: 49,
      telegram_payment_charge_id: 'telegram-charge-770002'
    }
  };
  await ctx.bot.handleSuccessfulPayment(paidMessage);
  const afterPayment = ctx.bot.getProStatus(userId);
  assert.equal(afterPayment.expiresAt, trial.expiresAt + 7 * 24 * 60 * 60 * 1000);
  assert.equal(ctx.bot.store.getUser(userId).pro.payments.length, 1);

  await ctx.bot.handleSuccessfulPayment(paidMessage);
  assert.equal(ctx.bot.getProStatus(userId).expiresAt, afterPayment.expiresAt);
  assert.equal(ctx.bot.store.getUser(userId).pro.payments.length, 1);
});

test('promo codes grant days once per user and respect the global usage limit', async () => {
  const ctx = makeBot();
  const firstUser = 770003;
  const secondUser = 770004;
  const trial = ctx.bot.ensureTrial(firstUser);
  assert.equal(ctx.bot.store.createPromoCode('WELCOME12', {
    days: 5, maxUses: 1, createdBy: 1
  }).ok, true);

  await ctx.bot.handleMessage(message('/promocode WELCOME12', firstUser, 9920));
  const afterFirst = ctx.bot.getProStatus(firstUser);
  assert.equal(afterFirst.expiresAt, trial.expiresAt + 5 * 24 * 60 * 60 * 1000);

  await ctx.bot.handleMessage(message('/promocode WELCOME12', firstUser, 9921));
  assert.equal(ctx.bot.getProStatus(firstUser).expiresAt, afterFirst.expiresAt);

  await ctx.bot.handleMessage(message('/promocode WELCOME12', secondUser, 9922));
  assert.equal(ctx.bot.getProStatus(secondUser).active, false);
  assert.equal(ctx.bot.store.listPromoCodes()[0].uses, 1);
});


test('AI replies include an inline regenerate button and regenerate the matching request in place', async () => {
  const answers = ['Первый ответ', 'Второй ответ'];
  let requestCount = 0;
  const ctx = makeBot({
    fetchImpl: async (url) => {
      assert.equal(String(url), 'https://provider.example/v1/chat/completions');
      requestCount += 1;
      const answer = answers.shift();
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: answer } }] })
      };
    }
  });
  const userId = 780001;
  const user = ctx.bot.store.getUser(userId);
  user.apiKey = 'valid-test-key';
  user.model = 'test/model-a';
  user.modelExplicit = true;
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('Проверь ответ', userId, 10001));
  const firstReply = ctx.richMessages.at(-1);
  const firstMarkdown = firstReply.richMessage.markdown;
  const callbackData = firstMarkdown.match(/data="(regen:[0-9a-f-]{36})"/i)?.[1];
  assert.ok(firstMarkdown.includes('<tg-button-row align="center">'));
  assert.ok(firstMarkdown.includes('🔄 Перегенерировать ответ'));
  assert.match(callbackData || '', /^regen:[0-9a-f-]{36}$/i);
  assert.equal(requestCount, 1);

  await ctx.bot.handleCallbackQuery(callbackQuery(callbackData, userId, firstReply.message_id));

  const updatedUser = ctx.bot.store.getUser(userId);
  const chat = updatedUser.chats.find((item) => item.messages.some((entry) =>
    entry.role === 'user' && entry.content === 'Проверь ответ'));
  assert.ok(chat);
  assert.equal(chat.messages.find((entry) => entry.role === 'assistant').content, 'Второй ответ');
  assert.equal(requestCount, 2);
  const editedReply = ctx.editedRichMessages.find((item) =>
    item.messageId === firstReply.message_id && item.richMessage.markdown.includes('Второй ответ'));
  assert.ok(editedReply);
  assert.ok(editedReply.richMessage.markdown.includes('<tg-button-row align="center">'));
  assert.ok(editedReply.richMessage.markdown.includes('data="' + callbackData + '"'));
});

test('provider 429 errors identify an upstream limit and suppress immediate retry attempts', async () => {
  let requestCount = 0;
  const ctx = makeBot({
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '45' : null },
        json: async () => ({
          error: {
            code: 429,
            message: 'Rate limit exceeded',
            metadata: {
              error_type: 'rate_limit_exceeded',
              limit_source: 'upstream_provider_shared_pool',
              provider_name: 'NVIDIA',
              provider_code: 'rate_limited'
            }
          }
        })
      };
    }
  });
  const userId = 780002;
  const user = ctx.bot.store.getUser(userId);
  user.apiBaseUrl = 'https://openrouter.ai/api/v1';
  user.apiProtocol = 'openai';
  user.apiKey = 'valid-test-key';
  user.model = 'nvidia/test-model:free';
  user.modelExplicit = true;
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('Повтори если ошибка', userId, 10002));
  const errorMessage = ctx.editedRichMessages.find((item) =>
    item.richMessage.markdown.includes('HTTP 429'));
  assert.ok(errorMessage);
  assert.match(errorMessage.richMessage.markdown, /поставщик выбранной модели ограничил частоту/i);
  assert.match(errorMessage.richMessage.markdown, /NVIDIA/);
  assert.match(errorMessage.richMessage.markdown, /90 сек\./);
  const callbackData = errorMessage.richMessage.markdown.match(/data="(regen:[0-9a-f-]{36})"/i)?.[1];
  assert.match(callbackData || '', /^regen:[0-9a-f-]{36}$/i);

  await ctx.bot.handleCallbackQuery(callbackQuery(callbackData, userId, errorMessage.messageId));

  assert.equal(requestCount, 1, 'the bot must not retry before Retry-After expires');
  assert.ok(ctx.editedRichMessages.some((item) =>
    item.messageId === errorMessage.messageId &&
    item.richMessage.markdown.includes('Повторный запрос к этой модели временно приостановлен')));
});

test('/test distinguishes OpenRouter free-model quota and reads X-RateLimit-Reset', async () => {
  let requestCount = 0;
  const resetAt = Date.now() + 115_000;
  const ctx = makeBot({
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: false,
        status: 429,
        headers: {
          get: (name) => {
            if (name.toLowerCase() === 'x-ratelimit-reset') return String(resetAt);
            if (name.toLowerCase() === 'x-ratelimit-limit') return '20';
            if (name.toLowerCase() === 'x-ratelimit-remaining') return '0';
            return null;
          }
        },
        json: async () => ({
          error: {
            code: 429,
            message: 'Rate limit exceeded',
            metadata: { limit_source: 'openrouter_free_tier_per_minute' }
          }
        })
      };
    }
  });
  const userId = 780003;
  const user = ctx.bot.store.getUser(userId);
  user.apiBaseUrl = 'https://openrouter.ai/api/v1';
  user.apiProtocol = 'openai';
  user.apiKey = 'valid-test-key';
  user.model = 'nvidia/test-model:free';
  user.modelExplicit = true;
  ctx.bot.store.save();

  await ctx.bot.handleMessage(message('/test', userId, 10003));
  assert.equal(requestCount, 1);
  assert.match(ctx.sent.at(-1).text, /OpenRouter достиг минутного лимита запросов к бесплатным моделям/i);
  assert.match(ctx.sent.at(-1).text, /2 мин\./);

  await ctx.bot.handleMessage(message('/test', userId, 10004));
  assert.equal(requestCount, 1, 'the provider test must respect the recorded cooldown');
  assert.match(ctx.sent.at(-1).text, /Повторный запрос к этой модели временно приостановлен/i);
});


test('admin button is shown only to configured administrators in settings', async () => {
  const owner = makeBot({ adminIds: '123456' });
  await owner.bot.handleMessage(message('/settings', 123456, 11001));
  const rich = owner.editedRichMessages.at(-1);
  assert.ok(rich);
  const buttons = rich.richMessage.blocks
    .filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons || []);
  assert.ok(buttons.some((button) => button.callback_data === 'admin:home'));

  const regular = makeBot({ adminIds: '999999' });
  await regular.bot.handleMessage(message('/settings', 123456, 11002));
  const regularRich = regular.editedRichMessages.at(-1);
  const regularButtons = regularRich.richMessage.blocks
    .filter((block) => block.type === 'buttons')
    .flatMap((block) => block.buttons || []);
  assert.equal(regularButtons.some((button) => button.callback_data === 'admin:home'), false);
});

test('admin panel rejects non-admin callback attempts', async () => {
  const ctx = makeBot({ adminIds: '999999' });
  await ctx.bot.handleCallbackQuery(callbackQuery('admin:home', 123456, 11003));
  assert.equal(ctx.editedMessages.length, 0);
  assert.equal(ctx.callbackAnswers.at(-1).text, 'Доступ запрещён.');
});

test('admin panel lists users, grants and revokes PRO, and writes an audit log', async () => {
  const ctx = makeBot({ adminIds: '123456' });
  const target = ctx.bot.store.getUser(222222);
  target.apiKey = 'must-never-be-exposed';
  target.model = 'test/model-a';
  ctx.bot.store.save();

  await ctx.bot.handleCallbackQuery(callbackQuery('admin:home', 123456, 11004));
  assert.match(ctx.editedMessages.at(-1).text, /Пользователи: 2/);

  await ctx.bot.handleCallbackQuery(callbackQuery('admin:users:0', 123456, 11004));
  assert.match(ctx.editedMessages.at(-1).text, /222222/);

  await ctx.bot.handleCallbackQuery(callbackQuery('admin:user:222222', 123456, 11004));
  assert.match(ctx.editedMessages.at(-1).text, /API-ключ: сохранён/);
  assert.equal(ctx.editedMessages.at(-1).text.includes('must-never-be-exposed'), false);

  await ctx.bot.handleCallbackQuery(callbackQuery('admin:userpro:222222:7', 123456, 11004));
  assert.equal(ctx.bot.getProStatus(222222).active, true);
  assert.equal(ctx.bot.store.listAdminLogs(10).some((item) => item.action === 'pro_grant'), true);

  await ctx.bot.handleCallbackQuery(callbackQuery('admin:userpro:222222:revoke', 123456, 11004));
  assert.equal(ctx.bot.getProStatus(222222).active, false);
  assert.equal(ctx.bot.store.listAdminLogs(10).some((item) => item.action === 'pro_revoke'), true);
});

test('admin panel creates and disables promo codes through inline controls', async () => {
  const ctx = makeBot({ adminIds: '123456' });
  await ctx.bot.handleCallbackQuery(callbackQuery('admin:promo:new', 123456, 11005));
  assert.match(ctx.editedMessages.at(-1).text, /CODE DAYS MAX_USES/);

  await ctx.bot.handleMessage(message('NEXUS7 7 3', 123456, 11006));
  assert.equal(ctx.bot.store.listPromoCodes()[0].code, 'NEXUS7');
  assert.equal(ctx.bot.store.listPromoCodes()[0].enabled, true);
  assert.equal(ctx.bot.store.listAdminLogs(10).some((item) => item.action === 'promo_create'), true);

  await ctx.bot.handleCallbackQuery(callbackQuery('admin:promo:off:NEXUS7', 123456, 11007));
  assert.equal(ctx.bot.store.listPromoCodes()[0].enabled, false);
  assert.equal(ctx.bot.store.listAdminLogs(10).some((item) => item.action === 'promo_disable'), true);
});

test('admin user lookup and admin store snapshots never reveal provider API keys or chat content', async () => {
  const ctx = makeBot({ adminIds: '123456' });
  const user = ctx.bot.store.getUser(333333);
  user.apiKey = 'super-secret-key';
  user.chats.push({ id: 'private-chat', title: 'private title', messages: [{ role: 'user', content: 'private prompt' }] });
  ctx.bot.store.save();

  const snapshot = ctx.bot.store.getAdminUser(333333);
  assert.equal(snapshot.id, '333333');
  assert.equal(snapshot.hasApiKey, true);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'apiKey'), false);
  assert.equal(JSON.stringify(snapshot).includes('super-secret-key'), false);
  assert.equal(JSON.stringify(snapshot).includes('private prompt'), false);

  await ctx.bot.handleCallbackQuery(callbackQuery('admin:users:search', 123456, 11008));
  await ctx.bot.handleMessage(message('333333', 123456, 11009));
  assert.match(ctx.sent.at(-1).text, /333333/);
  assert.equal(ctx.sent.at(-1).text.includes('super-secret-key'), false);
});

test('Free plan settings are capped and PRO-only Telegram callbacks are blocked', async () => {
  const ctx = makeBot();
  const userId = 654987;
  const user = ctx.bot.store.getUser(userId);
  user.id = String(userId);
  user.pro = { expiresAt: Date.now() - 1_000, payments: [], promoRedemptions: [] };
  user.settings = {
    maxTokens: 32_000, reasoning: 'high', requestTimeoutSeconds: 7_200,
    systemPrompt: 'x'.repeat(4_000), internetSearch: true, sandbox: true,
    sandboxInternet: true, multiAgent: true, agentCount: 20
  };
  ctx.bot.store.save();
  const state = ctx.bot.getSyncState(userId);
  assert.equal(state.plan.tier, 'free');
  assert.equal(state.settings.maxTokens, 1_200);
  assert.equal(state.settings.reasoning, 'auto');
  assert.equal(state.settings.requestTimeoutSeconds, 120);
  assert.equal(state.settings.systemPrompt.length, 2_000);
  assert.equal(state.settings.internetSearch, false);
  assert.equal(state.settings.sandbox, false);
  assert.equal(state.settings.sandboxInternet, false);
  assert.equal(state.settings.multiAgent, false);
  assert.equal(state.settings.agentCount, 1);
  assert.equal(ctx.bot.store.getUser(userId).settings.maxTokens, 32_000);
  await ctx.bot.handleMessage(message('/settings', userId, 711));

  // Every Premium-only Telegram callback, including stale/forged payloads,
  // must show a Toast and must never mutate the user's settings.
  const premiumCallbacks = [
    'tn:search', 'tn:sandbox', 'tn:sandbox:confirm', 'tn:timeout:custom',
    'tn:t:2000', 'tn:t:4000', 'tn:t:8000', 'tn:t:16000', 'tn:t:32000',
    'tn:timeout:180', 'tn:timeout:300', 'tn:timeout:600',
    'tn:timeout:1800', 'tn:timeout:3600', 'tn:timeout:7200',
    'tn:r:minimal', 'tn:r:low', 'tn:r:medium', 'tn:r:high', 'tn:r:xhigh'
  ];
  const rawSettingsBefore = JSON.parse(JSON.stringify(ctx.bot.store.getUser(userId).settings));
  const sentBefore = ctx.sent.length;
  for (const [index, data] of premiumCallbacks.entries()) {
    await ctx.bot.handleCallbackQuery(callbackQuery(data, userId, 712 + index));
    assert.match(ctx.callbackAnswers.at(-1).text, /Купите TG Nexus PRO/i, data);
    assert.equal(ctx.sent.length, sentBefore, data + ' must not send a new chat message');
    assert.deepEqual(ctx.bot.store.getUser(userId).settings, rawSettingsBefore, data + ' must not mutate settings');
  }
  assert.equal(ctx.bot.getSyncState(userId).settings.internetSearch, false);
});

test('PRO trial and administrators keep all features', async () => {
  const ctx = makeBot({ adminIds: '654988' });
  const trialId = 654987;
  const trialUser = ctx.bot.store.getUser(trialId);
  trialUser.pro = { expiresAt: Date.now() + 300_000, trialExpiresAt: Date.now() + 300_000, payments: [], promoRedemptions: [] };
  trialUser.settings = { maxTokens: 1_200, reasoning: 'auto', requestTimeoutSeconds: 120, internetSearch: false, sandbox: false };
  ctx.bot.store.save();
  const trialState = ctx.bot.getSyncState(trialId);
  assert.equal(trialState.plan.tier, 'pro');
  assert.equal(trialState.settings.maxTokens, 1_200);
  assert.equal(trialState.settings.reasoning, 'auto');
  assert.equal(trialState.settings.requestTimeoutSeconds, 120);
  assert.equal(trialState.settings.internetSearch, false);

  // An active trial must be able to enable and use every advanced bot setting.
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:r:high', trialId, 1966));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:t:32000', trialId, 1967));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:timeout:7200', trialId, 1968));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:search', trialId, 1969));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:sandbox', trialId, 1970));
  await ctx.bot.handleCallbackQuery(callbackQuery('tn:sandbox:confirm', trialId, 1971));
  const updatedTrial = ctx.bot.getSyncState(trialId);
  assert.equal(updatedTrial.settings.maxTokens, 32_000);
  assert.equal(updatedTrial.settings.reasoning, 'high');
  assert.equal(updatedTrial.settings.requestTimeoutSeconds, 7_200);
  assert.equal(updatedTrial.settings.internetSearch, true);
  assert.equal(updatedTrial.settings.sandbox, true);
  assert.doesNotMatch(ctx.callbackAnswers.at(-1).text, /Купите TG Nexus PRO/i);

  const adminState = ctx.bot.getSyncState(654988);
  assert.equal(adminState.plan.tier, 'pro');
  assert.equal(adminState.plan.admin, true);
});
