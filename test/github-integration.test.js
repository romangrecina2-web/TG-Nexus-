'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATA_ENCRYPTION_KEY = '7f'.repeat(32);
const botChat = require('../bot-chat');
const github = require('../github-integration');

test('provider and GitHub tokens encrypt and decrypt with AES-256-GCM', () => {
  const secret = 'unit-test-secret-that-is-not-a-real-credential';
  const encrypted = botChat.encrypt(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(botChat.decrypt(encrypted), secret);
});

test('AES-256-GCM rejects modified ciphertext', () => {
  const encrypted = botChat.encrypt('test-token');
  const parts = encrypted.split('.');
  const bytes = Buffer.from(parts[2], 'base64');
  bytes[0] ^= 1;
  parts[2] = bytes.toString('base64');
  assert.throws(() => botChat.decrypt(parts.join('.')));
});

test('GitHub repository validator accepts normal owner/repository names', () => {
  assert.doesNotThrow(() => github.validateRepo('owner-name', 'project_2'));
  assert.doesNotThrow(() => github.validateRepo('org.example', 'repo.js'));
});

test('GitHub repository validator rejects path traversal and malformed names', () => {
  assert.throws(() => github.validateRepo('../owner', 'repo'));
  assert.throws(() => github.validateRepo('owner', '../secret'));
  assert.throws(() => github.validateRepo('owner/name', 'repo'));
  assert.throws(() => github.validateRepo('', 'repo'));
});

test('GitHub file-reading limit is 512 KiB', () => {
  assert.equal(github.MAX_FILE_BYTES, 512 * 1024);
});
