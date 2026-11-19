'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createStorageManager,
  describeStorageError
} = require('../storage-manager');

function service(init) {
  return { init };
}

test('bot storage initializes independently from GitHub storage', async () => {
  let botCalls = 0;
  let githubCalls = 0;
  const manager = createStorageManager({
    botChat: service(async () => { botCalls += 1; return true; }),
    github: service(async () => { githubCalls += 1; return true; })
  });

  await manager.ensureBotStorage();

  assert.equal(botCalls, 1);
  assert.equal(githubCalls, 0);
});

test('concurrent callers share one initialization attempt', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const manager = createStorageManager({
    botChat: service(async () => { calls += 1; await gate; return true; }),
    github: service(async () => true)
  });

  const first = manager.ensureBotStorage();
  const second = manager.ensureBotStorage();
  await Promise.resolve();
  assert.equal(calls, 1);

  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('failed initialization clears the cached promise and can be retried', async () => {
  let calls = 0;
  const manager = createStorageManager({
    botChat: service(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('temporary database failure');
        error.code = 'ECONNRESET';
        throw error;
      }
      return true;
    }),
    github: service(async () => true)
  });

  await assert.rejects(manager.ensureBotStorage(), { code: 'ECONNRESET' });
  assert.equal(await manager.ensureBotStorage(), true);
  assert.equal(calls, 2);
});

test('false initialization result is reported as missing DATABASE_URL and can be retried', async () => {
  let calls = 0;
  const manager = createStorageManager({
    botChat: service(async () => { calls += 1; return calls > 1; }),
    github: service(async () => true)
  });

  await assert.rejects(manager.ensureBotStorage(), { code: 'DATABASE_URL_MISSING' });
  assert.equal(await manager.ensureBotStorage(), true);
  assert.equal(calls, 2);
});

test('GitHub initialization failure does not poison bot storage', async () => {
  const manager = createStorageManager({
    botChat: service(async () => true),
    github: service(async () => { throw new Error('GitHub schema failed'); })
  });

  await assert.rejects(manager.ensureGithubStorage());
  assert.equal(await manager.ensureBotStorage(), true);
});

test('storage errors explain missing configuration without exposing secrets', () => {
  assert.deepEqual(describeStorageError({ code: 'DATABASE_URL_MISSING' }), {
    status: 503,
    code: 'DATABASE_URL_MISSING',
    message: 'Серверное хранилище не настроено: отсутствует переменная DATABASE_URL.'
  });

  const encryption = describeStorageError({ code: 'DATA_ENCRYPTION_KEY_INVALID' });
  assert.equal(encryption.status, 503);
  assert.equal(encryption.code, 'DATA_ENCRYPTION_KEY_INVALID');
  assert.match(encryption.message, /64 шестнадцатеричных символа/);
});

test('PostgreSQL errors are translated into actionable but safe diagnostics', () => {
  assert.equal(describeStorageError({ code: '28P01' }).code, 'POSTGRES_AUTH_FAILED');
  assert.equal(describeStorageError({ code: '3D000' }).code, 'POSTGRES_DATABASE_MISSING');
  assert.equal(describeStorageError({ code: '42501' }).code, 'POSTGRES_PERMISSION_DENIED');
  assert.equal(describeStorageError({ code: 'ECONNREFUSED' }).code, 'POSTGRES_UNAVAILABLE');
});

test('invalid provider settings are client errors, not storage failures', () => {
  assert.equal(describeStorageError({ code: 'INVALID_API_KEY' }).status, 400);
  assert.equal(describeStorageError({ code: 'INVALID_API_URL' }).status, 400);
  assert.equal(describeStorageError({ code: 'INVALID_MODEL' }).status, 400);
  const unknown = describeStorageError({ code: 'XX999' });
  assert.equal(unknown.status, 503);
  assert.match(unknown.message, /XX999/);
});
