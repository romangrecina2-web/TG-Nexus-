'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const botChat = require('../bot-chat');

const validKey = 'ab'.repeat(32);

test('reports a missing DATABASE_URL', () => {
  assert.match(
    botChat.storageConfigurationIssue(
      { DATABASE_URL: '', DATA_ENCRYPTION_KEY: validKey },
      false
    ),
    /DATABASE_URL/
  );
});

test('reports when DATABASE_URL was set after the backend process started', () => {
  assert.match(
    botChat.storageConfigurationIssue(
      { DATABASE_URL: 'postgresql://example/db', DATA_ENCRYPTION_KEY: validKey },
      false
    ),
    /Перезапустите/
  );
});

test('reports a missing or malformed DATA_ENCRYPTION_KEY', () => {
  assert.match(
    botChat.storageConfigurationIssue(
      { DATABASE_URL: 'postgresql://example/db', DATA_ENCRYPTION_KEY: 'not-a-key' },
      true
    ),
    /DATA_ENCRYPTION_KEY/
  );
});

test('accepts a configured database pool and a 32-byte hexadecimal encryption key', () => {
  assert.equal(
    botChat.storageConfigurationIssue(
      { DATABASE_URL: 'postgresql://example/db', DATA_ENCRYPTION_KEY: validKey },
      true
    ),
    null
  );
});

test('accepts a hexadecimal encryption key with surrounding whitespace', () => {
  assert.equal(
    botChat.storageConfigurationIssue(
      { DATABASE_URL: 'postgresql://example/db', DATA_ENCRYPTION_KEY: '  ' + validKey + '\n' },
      true
    ),
    null
  );
});
