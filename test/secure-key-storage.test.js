'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, STORAGE_KEY } = require('../secure-key-storage');

function makeWebApp(version = '9.0') {
  const values = new Map();
  const secureStorage = {
    getItem(key, callback) {
      callback(null, values.has(key) ? values.get(key) : null, false);
    },
    setItem(key, value, callback) {
      values.set(key, value);
      callback(null, true);
    },
    removeItem(key, callback) {
      const existed = values.delete(key);
      callback(null, existed);
    }
  };
  return {
    SecureStorage: secureStorage,
    isVersionAtLeast(required) {
      const actual = version.split('.').map(Number);
      const target = required.split('.').map(Number);
      return actual[0] > target[0] || (actual[0] === target[0] && actual[1] >= target[1]);
    },
    values
  };
}

test('SecureStorage adapter stores and restores a key for the matching API endpoint', async () => {
  const webApp = makeWebApp();
  const storage = create(webApp);
  assert.equal(storage.isAvailable(), true);

  await storage.save('https://api.example/v1/', 'provider-secret');
  // A fresh adapter represents a Mini App page reload on the same Telegram device.
  const afterReload = create(webApp);
  const result = await afterReload.load('https://api.example/v1');

  assert.deepEqual(
    { supported: result.supported, found: result.found, matches: result.matches, key: result.key },
    { supported: true, found: true, matches: true, key: 'provider-secret' }
  );
  assert.equal(webApp.values.has(STORAGE_KEY), true);
});

test('SecureStorage keeps independent keys for multiple provider endpoints', async () => {
  const webApp = makeWebApp();
  const storage = create(webApp);

  await storage.save('https://provider-a.example/v1', 'secret-a');
  await storage.save('https://provider-b.example/v1/', 'secret-b');

  const providerA = await storage.load('https://provider-a.example/v1/');
  const providerB = await storage.load('https://provider-b.example/v1');

  assert.equal(providerA.key, 'secret-a');
  assert.equal(providerB.key, 'secret-b');
  assert.equal(JSON.parse(webApp.values.get(STORAGE_KEY)).version, 2);
});

test('SecureStorage removes one provider key without deleting the others', async () => {
  const webApp = makeWebApp();
  const storage = create(webApp);
  await storage.save('https://provider-a.example/v1', 'secret-a');
  await storage.save('https://provider-b.example/v1', 'secret-b');

  assert.equal(await storage.remove('https://provider-a.example/v1'), true);
  assert.equal((await storage.load('https://provider-a.example/v1')).matches, false);
  assert.equal((await storage.load('https://provider-b.example/v1')).key, 'secret-b');
});

test('SecureStorage migrates the legacy single-provider record on the next save', async () => {
  const webApp = makeWebApp();
  webApp.values.set(STORAGE_KEY, JSON.stringify({
    version: 1,
    apiBase: 'https://legacy.example/v1',
    key: 'legacy-secret',
    savedAt: 123
  }));
  const storage = create(webApp);

  assert.equal((await storage.load('https://legacy.example/v1')).key, 'legacy-secret');
  await storage.save('https://new.example/v1', 'new-secret');

  const stored = JSON.parse(webApp.values.get(STORAGE_KEY));
  assert.equal(stored.version, 2);
  assert.equal(stored.providers['https://legacy.example/v1'].key, 'legacy-secret');
  assert.equal(stored.providers['https://new.example/v1'].key, 'new-secret');
});

test('SecureStorage does not return a saved key for a different provider endpoint', async () => {
  const storage = create(makeWebApp());
  await storage.save('https://provider-a.example/v1', 'secret-a');

  const result = await storage.load('https://provider-b.example/v1');
  assert.equal(result.found, true);
  assert.equal(result.matches, false);
  assert.equal(result.key, '');
});

test('SecureStorage removes the saved key when requested', async () => {
  const webApp = makeWebApp();
  const storage = create(webApp);
  await storage.save('https://api.example/v1', 'secret');
  assert.equal(await storage.remove(), true);

  const result = await storage.load('https://api.example/v1');
  assert.equal(result.found, false);
  assert.equal(result.key, '');
});

test('SecureStorage reports unsupported Telegram clients without falling back to insecure storage', async () => {
  const storage = create(makeWebApp('8.9'));
  assert.equal(storage.isAvailable(), false);
  assert.deepEqual(await storage.load('https://api.example/v1'), {
    supported: false,
    found: false,
    matches: false,
    key: ''
  });
  await assert.rejects(
    storage.save('https://api.example/v1', 'secret'),
    /not available/
  );
});

test('SecureStorage rejects malformed saved credentials', async () => {
  const webApp = makeWebApp();
  webApp.values.set(STORAGE_KEY, JSON.stringify({ version: 1, apiBase: 'https://api.example/v1' }));
  const storage = create(webApp);
  await assert.rejects(storage.load('https://api.example/v1'), /invalid format/);
});
