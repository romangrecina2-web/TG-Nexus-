'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.BOT_TOKEN = 'unit-test-bot-token-never-used-in-production';
const {
  MAX_INIT_DATA_AGE_SECONDS,
  createRateLimiter,
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
