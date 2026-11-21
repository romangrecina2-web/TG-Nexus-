'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../provider-catalog');
const adapters = require('../provider-adapters');

test('catalog contains 30 unique HTTPS provider profiles', () => {
  assert.equal(catalog.length, 30);
  assert.equal(new Set(catalog.map((item) => item.id)).size, 30);
  assert.equal(new Set(catalog.map((item) => item.url)).size, 30);
  for (const provider of catalog) {
    assert.ok(provider.name);
    assert.ok(provider.url.startsWith('https://'), provider.id);
    assert.ok(['openai', 'anthropic'].includes(provider.protocol));
    assert.ok(['bearer', 'key', 'api-key', 'x-api-key'].includes(provider.authType));
  }
});

test('OpenAI-compatible profile builds Chat Completions with Bearer auth', () => {
  const profile = catalog.find((item) => item.id === 'deepseek');
  const request = adapters.buildChatRequest(profile, {
    apiKey: 'deepseek-test-key',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Hello' }],
    maxTokens: 256,
    temperature: 0.2,
    stream: false
  }, false);

  assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer deepseek-test-key');
  assert.equal(request.body.model, 'deepseek-chat');
  assert.equal(request.body.max_tokens, 256);
  assert.equal(request.body.temperature, 0.2);
  assert.equal(request.body.messages[0].content, 'Hello');
});

test('provider-specific authorization headers are applied', () => {
  const clarifai = catalog.find((item) => item.id === 'clarifai');
  const anthropic = catalog.find((item) => item.id === 'anthropic');
  assert.equal(adapters.authHeaders(clarifai, 'pat-test', false).Authorization, 'Key pat-test');
  assert.equal(adapters.authHeaders(anthropic, 'sk-ant-test', false)['x-api-key'], 'sk-ant-test');
  assert.equal(adapters.authHeaders(anthropic, 'sk-ant-test', false)['anthropic-version'], '2023-06-01');
});

test('Anthropic profile builds native Messages API and normalizes its response', () => {
  const profile = catalog.find((item) => item.id === 'anthropic');
  const request = adapters.buildChatRequest(profile, {
    apiKey: 'anthropic-test-key',
    model: 'claude-sonnet-test',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' }
    ],
    maxTokens: 512,
    temperature: 0.4,
    stream: false
  }, false);

  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'anthropic-test-key');
  assert.equal(request.body.system, 'You are helpful.');
  assert.equal(request.body.max_tokens, 512);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'Hello' }]);

  const normalized = adapters.normalizePayload(profile, {
    id: 'msg_test',
    model: 'claude-sonnet-test',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Hello from Claude' }],
    usage: { input_tokens: 5, output_tokens: 3 }
  });
  assert.equal(normalized.choices[0].message.content, 'Hello from Claude');
  assert.equal(normalized.choices[0].finish_reason, 'end_turn');
  assert.equal(normalized.usage.prompt_tokens, 5);
  assert.equal(normalized.usage.completion_tokens, 3);
});

test('Anthropic browser mode adds the provider direct-browser opt-in header', () => {
  const profile = catalog.find((item) => item.id === 'anthropic');
  const browserHeaders = adapters.authHeaders(profile, 'anthropic-test-key', true);
  const serverHeaders = adapters.authHeaders(profile, 'anthropic-test-key', false);

  assert.equal(browserHeaders['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(serverHeaders['anthropic-dangerous-direct-browser-access'], undefined);
});

test('model extraction supports common OpenAI-compatible and Gemini model payloads', () => {
  const openai = catalog.find((item) => item.id === 'openai');
  const gemini = catalog.find((item) => item.id === 'gemini');

  assert.deepEqual(
    adapters.extractModels(openai, { data: [{ id: 'gpt-test' }, { id: 'o-test' }] }),
    ['gpt-test', 'o-test']
  );
  assert.deepEqual(
    adapters.extractModels(gemini, { models: [{ name: 'models/gemini-test' }] }),
    ['gemini-test']
  );
});

test('providers without a model-list endpoint reject discovery but accept manual model IDs', () => {
  const profile = catalog.find((item) => item.id === 'perplexity');
  assert.throws(() => adapters.modelsRequest(profile, 'test-key', false), /does not expose/);

  const request = adapters.buildChatRequest(profile, {
    apiKey: 'test-key',
    model: 'sonar',
    messages: [{ role: 'user', content: 'Hello' }]
  }, false);
  assert.equal(request.url, 'https://api.perplexity.ai/chat/completions');
});

test('Anthropic SSE stream is converted to OpenAI-style chunks', async () => {
  const profile = catalog.find((item) => item.id === 'anthropic');
  const encoder = new TextEncoder();
  const source = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'event: content_block_delta\n' +
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n' +
        'event: message_delta\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
        'event: message_stop\n' +
        'data: {"type":"message_stop"}\n\n'
      ));
      controller.close();
    }
  }));

  const converted = adapters.normalizeStream(source, profile);
  const text = await converted.text();
  assert.match(text, /"content":"Hello"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});
