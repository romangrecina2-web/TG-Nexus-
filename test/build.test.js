'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('generated runtime bundles match their source fragments', () => {
  const script = path.join(__dirname, '..', 'scripts', 'build.js');
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
});
