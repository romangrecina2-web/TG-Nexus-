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
  splitTelegramText
} = require('../bot-chat');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-test-bot-'));
}

function message(text, userId = 123456, messageId = 1) {
  return {
    message_id: messageId,
    text,
    chat: { id: userId, type: 'private' },
    from: { id: userId, is_bot: false }
  };
}

function makeBot(options = {}) {
  const dir = options.dir || tempDir();
  const sent = [];
  const actions = [];
  const providerCalls = [];
  const events = [];
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
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: options.answer || 'Ответ ИИ' } }] }) };
    }
    throw new Error('Unexpected URL');
  });
  const bot = createBotChat({
    botToken: 'test-bot-token',
    apiBaseUrl: 'https://provider.example/v1',
    defaultModel: 'test/model-a',
    encryptionKey: 'ab'.repeat(32),
    dataDir: dir,
    fetchImpl,
    sendTelegramMessage: async (chatId, text) => { sent.push({ chatId, text }); events.push({ type: 'send' }); },
    deleteTelegramMessage: async (chatId, messageId) => { actions.push({ type: 'delete', chatId, messageId }); events.push({ type: 'delete' }); }
  });
  return { bot, dir, sent, actions, providerCalls, events };
}

test('API endpoint must be HTTPS and cannot contain credentials or query parameters', () => {
  assert.equal(normalizeApiBase('https://api.example/v1/'), 'https://api.example/v1');
  assert.equal(normalizeApiBase('http://api.example/v1'), null);
  assert.equal(normalizeApiBase('https://user:pass@api.example/v1'), null);
  assert.equal(normalizeApiBase('https://api.example/v1?key=x'), null);
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

test('/KEY removes the message before validating and stores only a working key', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/KEY sk-valid-key', 123456, 91));
  assert.deepEqual(ctx.actions, [{ type: 'delete', chatId: 123456, messageId: 91 }]);
  assert.equal(ctx.providerCalls.length, 1);
  assert.equal(ctx.providerCalls[0].url, 'https://provider.example/v1/models');
  assert.deepEqual(ctx.events.slice(0, 3).map((event) => event.type), ['delete', 'provider', 'send']);
  assert.deepEqual(ctx.sent.map((x) => x.text), ['Удачно изменено']);
  assert.equal(ctx.bot.store.getUser(123456).apiKey, 'sk-valid-key');
  const stored = fs.readFileSync(ctx.bot.store.filePath, 'utf8');
  assert.equal(stored.includes('sk-valid-key'), false);
});

test('invalid /key reports the required error and does not replace the saved key', async () => {
  const ctx = makeBot({ keyValid: false });
  const user = ctx.bot.store.getUser(123456);
  user.apiKey = 'old-working-key';
  ctx.bot.store.save();
  await ctx.bot.handleMessage(message('/key invalid-key', 123456, 92));
  assert.deepEqual(ctx.sent.map((x) => x.text), ['Неудачно, проверьте ключ и повторите попытку']);
  assert.equal(ctx.bot.store.getUser(123456).apiKey, 'old-working-key');
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

test('/model selects an available model and lists choices for a missing model', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('/model test/model-b'));
  assert.equal(ctx.bot.store.getUser(123456).model, 'test/model-b');
  assert.equal(ctx.sent.at(-1).text, 'Модель выбрана: test/model-b');
  await ctx.bot.handleMessage(message('/model missing-model'));
  assert.match(ctx.sent.at(-2).text, /такой модели нет/);
  assert.match(ctx.sent.at(-1).text, /test\/model-a/);
});

test('normal messages create a chat automatically and send the AI response', async () => {
  const ctx = makeBot();
  await ctx.bot.handleMessage(message('/key valid-key'));
  await ctx.bot.handleMessage(message('Привет, бот!'));
  const user = ctx.bot.store.getUser(123456);
  assert.equal(user.chats.length, 1);
  assert.equal(user.chats[0].title, 'Чат 1');
  assert.deepEqual(user.chats[0].messages.map((x) => x.role), ['user', 'assistant']);
  assert.equal(ctx.sent.at(-1).text, 'Ответ ИИ');
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


test('registered Telegram command names are lowercase and retain /start and /help', () => {
  assert.ok(BOT_COMMANDS.some((item) => item.command === 'start'));
  assert.ok(BOT_COMMANDS.some((item) => item.command === 'help'));
  assert.ok(BOT_COMMANDS.every((item) => item.command === item.command.toLowerCase()));
});
