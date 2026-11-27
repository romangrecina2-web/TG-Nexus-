'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.BOT_TOKEN = 'unit-test-bot-token-never-used-in-production';
const {
  MAX_INIT_DATA_AGE_SECONDS,
  createRateLimiter,
  createServer,
  isRetryableWebhookError,
  processTelegramUpdate,
  safeFileName,
  validateTelegramInitData
} = require('../server');

function signInitData({ botToken, userId = 123456, authDate }) {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAE-test-query');
  params.set('user', JSON.stringify({ id: userId, is_bot: false, first_name: 'Test' }));

  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => key + '=' + value)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('accepts correctly signed, recent Telegram initData', () => {
  const token = process.env.BOT_TOKEN;
  const now = 1_800_000_000_000;
  const data = signInitData({ botToken: token, authDate: Math.floor(now / 1000) });
  assert.deepEqual(validateTelegramInitData(data, token, now), { id: 123456 });
});

test('rejects modified or incorrectly signed initData', () => {
  const token = process.env.BOT_TOKEN;
  const now = 1_800_000_000_000;
  const data = signInitData({ botToken: token, authDate: Math.floor(now / 1000) });
  assert.equal(validateTelegramInitData(data.replace('123456', '654321'), token, now), null);
});

test('rejects expired and future-dated Telegram initData', () => {
  const token = process.env.BOT_TOKEN;
  const now = 1_800_000_000_000;
  const nowSeconds = Math.floor(now / 1000);
  const expired = signInitData({
    botToken: token,
    authDate: nowSeconds - MAX_INIT_DATA_AGE_SECONDS - 1
  });
  const future = signInitData({ botToken: token, authDate: nowSeconds + 31 });
  assert.equal(validateTelegramInitData(expired, token, now), null);
  assert.equal(validateTelegramInitData(future, token, now), null);
});

test('rejects duplicate fields and oversized initData', () => {
  const token = process.env.BOT_TOKEN;
  const now = 1_800_000_000_000;
  const data = signInitData({ botToken: token, authDate: Math.floor(now / 1000) });
  assert.equal(validateTelegramInitData(data + '&auth_date=1800000000', token, now), null);
  assert.equal(validateTelegramInitData('x='.padEnd(17 * 1024, 'x'), token, now), null);
});

test('rate limiter enforces per-user and global limits and resets its window', () => {
  let now = 10_000;
  const check = createRateLimiter({
    limit: 2,
    globalLimit: 3,
    maxUsers: 5,
    windowMs: 60_000,
    now: () => now
  });

  assert.equal(check(1), true);
  assert.equal(check(1), true);
  assert.equal(check(1), false);
  assert.equal(check(2), true);
  assert.equal(check(3), false);
  now += 60_001;
  assert.equal(check(1), true);
});

test('sanitizes file names and prevents path components', () => {
  assert.equal(safeFileName('../../hello?.js'), 'hello_.js');
  assert.equal(safeFileName('..'), 'code.txt');
});


async function withListeningServer(server, callback) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    return await callback('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function postWebhook(baseUrl, update, secret) {
  const response = await fetch(baseUrl + '/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret
    },
    body: JSON.stringify(update)
  });
  return { status: response.status, body: await response.json() };
}

test('webhook forwards private text messages to the Telegram text bot', async () => {
  const secret = 'webhook-test-secret-32-characters';
  const message = {
    message_id: 55,
    text: '/add_chat',
    chat: { id: 123456, type: 'private' },
    from: { id: 123456, is_bot: false }
  };
  const update = { update_id: 9001, message };
  let received = null;
  const server = createServer({
    webhookDependencies: {
      webhookSecret: secret,
      botChat: {
        enqueueUpdate: async (incomingUpdate) => {
          received = incomingUpdate;
          return { accepted: true, duplicate: false };
        }
      }
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const result = await postWebhook(baseUrl, update, secret);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, queued: true, duplicate: false });
    assert.deepEqual(received, update);
  });
});

test('webhook returns a retryable failure when text-message handling cannot deliver a reply', async () => {
  const secret = 'webhook-test-secret-32-characters';
  const server = createServer({
    webhookDependencies: {
      webhookSecret: secret,
      botChat: {
        enqueueUpdate: async () => {
          const error = new Error('Temporary storage failure');
          error.status = 503;
          throw error;
        }
      }
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const result = await postWebhook(baseUrl, {
      update_id: 9002,
      message: {
        message_id: 56,
        text: '/add_chat',
        chat: { id: 123456, type: 'private' },
        from: { id: 123456, is_bot: false }
      }
    }, secret);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { ok: false, retryable: true });
  });
});

test('permanent Telegram 4xx errors are not classified for repeated delivery', () => {
  const permanent = new Error('Forbidden');
  permanent.telegramErrorCode = 403;
  const rateLimited = new Error('Too many requests');
  rateLimited.telegramErrorCode = 429;
  const unavailable = new Error('Gateway timeout');
  unavailable.telegramErrorCode = 504;

  assert.equal(isRetryableWebhookError(permanent), false);
  assert.equal(isRetryableWebhookError(rateLimited), true);
  assert.equal(isRetryableWebhookError(unavailable), true);
});


test('webhook does not acknowledge malformed update IDs', async () => {
  const secret = 'webhook-test-secret-32-characters';
  const server = createServer({
    webhookDependencies: {
      webhookSecret: secret,
      botChat: {
        enqueueUpdate: async () => {
          const error = new Error('Invalid update ID');
          error.status = 400;
          throw error;
        }
      }
    }
  });

  await withListeningServer(server, async (baseUrl) => {
    const result = await postWebhook(baseUrl, { message: { text: 'hello' } }, secret);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: false, retryable: false });
  });
});


async function postSync(baseUrl, payload, origin) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const response = await fetch(baseUrl + '/api/sync', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() };
}

test('sync endpoint authenticates Telegram initData before reading private state', async () => {
  const bot = {
    store: { enabled: true },
    getSyncState() { return { initialized: true, apiKey: '', chats: [], settings: {} }; },
    applySyncState() { throw new Error('must not be called'); }
  };
  const server = createServer({ botChat: bot });

  await withListeningServer(server, async (baseUrl) => {
    const result = await postSync(baseUrl, { action: 'pull', initData: 'user=forged' });
    assert.equal(result.status, 401);
    assert.equal(result.body.ok, false);
  });
});

test('sync endpoint returns only the authenticated user state and accepts valid settings updates', async () => {
  const states = new Map();
  const applied = [];
  const bot = {
    store: { enabled: true },
    getSyncState(userId) {
      return states.get(String(userId)) || {
        initialized: false, apiBaseUrl: '', model: '', apiKey: '',
        settings: {}, activeChatId: null, chats: []
      };
    },
    applySyncState(userId, input) {
      applied.push({ userId, input });
      const current = this.getSyncState(userId);
      states.set(String(userId), {
        ...current,
        ...input,
        initialized: true,
        apiKey: current.apiKey || ''
      });
      return this.getSyncState(userId);
    }
  };
  const server = createServer({ botChat: bot });
  const token = process.env.BOT_TOKEN;
  const now = Date.now();
  const initData = signInitData({ botToken: token, userId: 987654, authDate: Math.floor(now / 1000) });

  await withListeningServer(server, async (baseUrl) => {
    const push = await postSync(baseUrl, {
      action: 'push',
      initData,
      state: {
        apiBaseUrl: 'https://provider.example/v1',
        model: 'provider/model',
        settings: { systemPrompt: 'Private test prompt', maxTokens: 444 },
        activeChatId: 'chat-sync',
        chats: [{ id: 'chat-sync', title: 'Sync test', messages: [] }]
      }
    });
    assert.equal(push.status, 200);
    assert.equal(push.body.ok, true);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].userId, 987654);
    assert.equal(push.body.state.settings.maxTokens, 444);
    assert.equal(push.body.state.chats[0].id, 'chat-sync');

    const pull = await postSync(baseUrl, { action: 'pull', initData });
    assert.equal(pull.status, 200);
    assert.equal(pull.body.state.model, 'provider/model');
    assert.equal(pull.body.state.chats[0].title, 'Sync test');
  });
});

test('successful_payment message updates reach the PRO entitlement handler', async () => {
  const received = [];
  const user = { termsAcceptedVersion: '2026-11-26-v2' };
  const fakeBot = {
    store: {
      enabled: true,
      getUser() { return user; }
    },
    ensureTrial(userId) { assert.equal(userId, 123456); },
    async handleSuccessfulPayment(message) { received.push(message); }
  };
  const paymentMessage = {
    message_id: 12,
    chat: { id: 123456, type: 'private' },
    from: { id: 123456, is_bot: false },
    successful_payment: {
      invoice_payload: 'tgnexuspro1_test',
      currency: 'XTR',
      total_amount: 49,
      telegram_payment_charge_id: 'telegram-charge-server-test'
    }
  };

  await processTelegramUpdate({ update_id: 12, message: paymentMessage }, fakeBot);
  assert.deepEqual(received, [paymentMessage]);
});

test('Telegram callback_query updates reach the bot settings handler', async () => {
  const received = [];
  const fakeBot = {
    store: {
      enabled: true,
      getUser() { return { termsAcceptedVersion: '2026-11-26-v2' }; }
    },
    async handleCallbackQuery(query) { received.push(query); }
  };
  const query = {
    id: 'callback-test',
    data: 'tn:search',
    from: { id: 123456 },
    message: { message_id: 5, chat: { id: 123456, type: 'private' } }
  };
  await processTelegramUpdate({ update_id: 11, callback_query: query }, fakeBot);
  assert.deepEqual(received, [query]);
});

test('sync endpoint blocks browser origins outside the configured Mini App origin', async () => {
  const bot = {
    store: { enabled: true },
    getSyncState() { return { initialized: false, chats: [], settings: {} }; },
    applySyncState() { return {}; }
  };
  const server = createServer({ botChat: bot });

  await withListeningServer(server, async (baseUrl) => {
    const result = await postSync(baseUrl, { action: 'pull', initData: 'forged' }, 'https://malicious.example');
    assert.equal(result.status, 403);
    assert.equal(result.body.ok, false);
  });
});


test('/start embeds document and consent buttons inside one Rich Message', async () => {
  const user = {};
  const sent = [];
  const bot = {
    store: { enabled: true, getUser: () => user },
    async sendRichMessage(chatId, richMessage) { sent.push({ chatId, richMessage }); }
  };
  await processTelegramUpdate({
    message: {
      message_id: 90,
      text: '/start',
      chat: { id: 123456, type: 'private' },
      from: { id: 123456, is_bot: false }
    }
  }, bot);

  assert.equal(sent.length, 1);
  const blocks = sent[0].richMessage.blocks;
  assert.equal(blocks[0].text, 'Welcome to TG Nexus!');
  const buttonRows = blocks.filter((block) => block.type === 'buttons');
  assert.deepEqual(buttonRows[0].buttons.map((button) => button.text), [
    'Terms of Service',
    'Privacy Policy'
  ]);
  assert.match(buttonRows[0].buttons[0].url, /terms\.html$/);
  assert.match(buttonRows[0].buttons[1].url, /privacy\.html$/);
  assert.equal(buttonRows[1].buttons[0].callback_data, 'terms:accept:2026-11-26-v2');
  assert.equal(buttonRows[1].buttons[0].style, 'success');
  assert.equal(buttonRows[2].buttons[0].callback_data, 'terms:decline:2026-11-26-v2');
  assert.equal(buttonRows[2].buttons[0].style, 'danger');
  assert.equal(blocks.find((block) => block.type === 'footer').text, 'Created by Mr tet0r');
  const support = blocks.find((block) => block.type === 'paragraph' &&
    Array.isArray(block.text) && block.text.some((part) => part && part.url));
  assert.equal(support.text.find((part) => part && part.url).url, 'https://t.me/TG_Nexus_official');
});

test('private bot messages remain blocked until the current terms version is accepted', async () => {
  const user = {};
  const sent = [];
  const handled = [];
  const bot = {
    store: { enabled: true, getUser: () => user },
    async sendMessage(chatId, text, options) { sent.push({ chatId, text, options }); },
    async handleMessage(message) { handled.push(message); }
  };
  const message = {
    message_id: 91,
    text: 'Hello',
    chat: { id: 123456, type: 'private' },
    from: { id: 123456, is_bot: false }
  };

  await processTelegramUpdate({ message }, bot);
  assert.equal(handled.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Terms of Service/);

  user.termsAcceptedVersion = '2026-11-26-v2';
  await processTelegramUpdate({ message: { ...message, message_id: 92 } }, bot);
  assert.equal(handled.length, 1);
});


test('unaccepted users are shown the agreement instead of opening old settings callbacks', async () => {
  const user = {};
  const sent = [];
  const handled = [];
  const bot = {
    store: { enabled: true, getUser: () => user },
    async sendMessage(chatId, text, options) { sent.push({ chatId, text, options }); },
    async handleCallbackQuery(query) { handled.push(query); }
  };
  await processTelegramUpdate({
    callback_query: {
      id: 'pre-consent-settings',
      data: 'tn:refresh',
      from: { id: 123456, is_bot: false },
      message: { message_id: 10, chat: { id: 123456, type: 'private' } }
    }
  }, bot);
  assert.equal(handled.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Terms of Service/);
});

test('terms acceptance callbacks are allowed before consent is recorded', async () => {
  const handled = [];
  const bot = {
    async handleCallbackQuery(query) { handled.push(query); }
  };
  const query = {
    id: 'terms-accept',
    data: 'terms:accept:2026-11-26-v2',
    from: { id: 123456 },
    message: { message_id: 11, chat: { id: 123456, type: 'private' } }
  };
  await processTelegramUpdate({ callback_query: query }, bot);
  assert.deepEqual(handled, [query]);
});
