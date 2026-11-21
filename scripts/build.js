#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targets = [
  { output: 'app.js', sourceDir: 'src/client' },
  { output: 'bot-chat.js', sourceDir: 'src/bot' }
];
const checkOnly = process.argv.includes('--check');

function renderBundle(target) {
  const sourceDirectory = path.join(root, target.sourceDir);
  if (!fs.existsSync(sourceDirectory)) {
    throw new Error('Missing source directory: ' + target.sourceDir);
  }

  const files = fs.readdirSync(sourceDirectory)
    .filter((name) => name.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    throw new Error('No JavaScript fragments found in ' + target.sourceDir);
  }

  const header = [
    '/* AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.',
    ' * Source: ' + target.sourceDir + '/*.js',
    ' * Rebuild with: npm run build',
    ' */',
    ''
  ].join('\n');

  const sections = files.map((name) => {
    const filePath = path.join(sourceDirectory, name);
    return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  });

  return header + sections.join('\n\n') + '\n';
}

let failed = false;
for (const target of targets) {
  const outputPath = path.join(root, target.output);
  const expected = renderBundle(target);

  if (checkOnly) {
    const actual = fs.readFileSync(outputPath, 'utf8');
    if (actual !== expected) {
      console.error(target.output + ' is out of date. Run npm run build.');
      failed = true;
    } else {
      console.log(target.output + ': up to date');
    }
    continue;
  }

  fs.writeFileSync(outputPath, expected, 'utf8');
  console.log('Built ' + target.output);
}

if (failed) process.exitCode = 1;
