'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:5432/tg_shell_test';
process.env.DATA_ENCRYPTION_KEY = '4c'.repeat(32);

const botChat = require('../bot-chat');

test('getSettings returns only the authenticated provider settings and decrypts its key', async () => {
  const secret = 'server-only-provider-test-key';
  const encrypted = botChat.encrypt(secret);
  const originalQuery = botChat.pool.query;

  botChat.pool.query = async (sql, values) => {
    assert.match(sql, /SELECT \* FROM bot_users WHERE telegram_id=\$1/);
    assert.deepEqual(values, ['123456']);
    return {
      rowCount: 1,
      rows: [{
        telegram_id: '123456',
        api_base: 'https://api.example.test/v1',
        api_key_enc: encrypted,
        active_model: 'vendor/model-test',
        models: ['vendor/model-test', 'vendor/model-2']
      }]
    };
  };

  try {
    const settings = await botChat.getSettings('123456');
    assert.deepEqual(settings, {
      api_base: 'https://api.example.test/v1',
      api_key: secret,
      active_model: 'vendor/model-test',
      models: ['vendor/model-test', 'vendor/model-2']
    });
    assert.equal(Object.hasOwn(settings, 'api_key_enc'), false);
    assert.equal(JSON.stringify(settings).includes(encrypted), false);
  } finally {
    botChat.pool.query = originalQuery;
  }
});

test('getSettings returns null when the Telegram user has no saved provider key', async () => {
  const originalQuery = botChat.pool.query;
  botChat.pool.query = async () => ({ rowCount: 0, rows: [] });
  try {
    assert.equal(await botChat.getSettings('654321'), null);
  } finally {
    botChat.pool.query = originalQuery;
    await botChat.pool.end();
  }
});
