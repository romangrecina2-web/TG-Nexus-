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

test('OpenAI GPT-6.2 Astra Pro alias uses Responses API with pro reasoning mode', () => {
  const openai = catalog.find((item) => item.id === 'openai');
  const request = adapters.buildModelRequest(openai, {
    apiKey: 'openai-test-key',
    model: 'openai/gpt-6.2-astra-pro',
    messages: [
      { role: 'system', content: 'Follow the system rules.' },
      { role: 'user', content: 'Review this patch.' },
      { role: 'assistant', content: 'I will inspect it.' },
      { role: 'user', content: 'Now identify the regression.' }
    ],
    maxTokens: 700,
    reasoningEffort: 'xhigh',
    temperature: 0.2
  }, false);

  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.protocol, 'responses');
  assert.equal(request.headers.Authorization, 'Bearer openai-test-key');
  assert.equal(request.body.model, 'gpt-6.2-astra');
  assert.equal(request.body.max_output_tokens, 700);
  assert.deepEqual(request.body.reasoning, { mode: 'pro', effort: 'xhigh' });
  assert.equal(request.body.instructions, 'Follow the system rules.');
  assert.deepEqual(request.body.input, [
    { role: 'user', content: 'Review this patch.' },
    { role: 'assistant', content: 'I will inspect it.' },
    { role: 'user', content: 'Now identify the regression.' }
  ]);
  assert.equal(request.body.temperature, undefined);

  const normalized = adapters.normalizePayload(openai, {
    id: 'resp_test',
    model: 'gpt-6.2-astra',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'The regression is fixed.' }]
    }],
    usage: { input_tokens: 17, output_tokens: 9 }
  }, request.protocol);
  assert.equal(normalized.choices[0].message.content, 'The regression is fixed.');
  assert.equal(normalized.usage.total_tokens, 26);
});

test('OpenRouter keeps its own GPT-6.2 Astra Pro model ID and Chat Completions route', () => {
  const openrouter = catalog.find((item) => item.id === 'openrouter');
  const request = adapters.buildModelRequest(openrouter, {
    apiKey: 'openrouter-test-key',
    model: 'openai/gpt-6.2-astra-pro',
    messages: [{ role: 'user', content: 'Hello' }]
  }, false);

  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.body.model, 'openai/gpt-6.2-astra-pro');
  assert.equal(request.protocol, 'openai');
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


test('direct OpenAI models use Responses API, preserving model IDs and model parameters', () => {
  const openai = catalog.find((item) => item.id === 'openai');
  const request = adapters.buildModelRequest(openai, {
    apiKey: 'openai-test-key',
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' }
    ],
    maxTokens: 333,
    temperature: 0.4,
    reasoningEffort: 'high',
    stream: true
  }, false);

  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.protocol, 'responses');
  assert.equal(request.body.model, 'gpt-5.4');
  assert.equal(request.body.max_output_tokens, 333);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.instructions, 'Be concise.');
  assert.deepEqual(request.body.input, [{ role: 'user', content: 'Hello' }]);
  assert.deepEqual(request.body.reasoning, { effort: 'high' });
  assert.equal(request.body.temperature, undefined);
});

test('Responses request converts image content and prior function call history', () => {
  const openai = catalog.find((item) => item.id === 'openai');
  const request = adapters.buildModelRequest(openai, {
    apiKey: 'openai-test-key',
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: 'Inspect images and use tools carefully.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } }
        ]
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_123',
          type: 'function',
          function: { name: 'sandbox_run_javascript', arguments: '{"code":"1+1"}' }
        }]
      },
      { role: 'tool', tool_call_id: 'call_123', name: 'sandbox_run_javascript', content: '{"status":"ok"}' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'sandbox_run_javascript',
        description: 'Run isolated JavaScript.',
        parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }
      }
    }],
    maxToolCalls: 3
  }, false);

  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(request.body.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe this image.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }
      ]
    },
    {
      type: 'function_call',
      call_id: 'call_123',
      name: 'sandbox_run_javascript',
      arguments: '{"code":"1+1"}'
    },
    { type: 'function_call_output', call_id: 'call_123', output: '{"status":"ok"}' }
  ]);
  assert.deepEqual(request.body.tools, [{
    type: 'function',
    name: 'sandbox_run_javascript',
    description: 'Run isolated JavaScript.',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }
  }]);
  assert.equal(request.body.max_tool_calls, 3);
  assert.equal(request.body.temperature, 0.4);
});

test('Responses payload normalizes text, function calls and token usage', () => {
  const openai = catalog.find((item) => item.id === 'openai');
  const normalized = adapters.normalizePayload(openai, {
    id: 'resp_test',
    model: 'gpt-5.4',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I will run a check.' }]
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'sandbox_run_javascript',
        arguments: '{"code":"1+1"}'
      }
    ],
    usage: { input_tokens: 17, output_tokens: 9 }
  }, 'responses');

  assert.equal(normalized.choices[0].message.content, 'I will run a check.');
  assert.equal(normalized.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(normalized.choices[0].message.tool_calls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'sandbox_run_javascript', arguments: '{"code":"1+1"}' }
  }]);
  assert.deepEqual(normalized.usage, {
    prompt_tokens: 17, completion_tokens: 9, total_tokens: 26
  });
});

test('Responses SSE stream converts text, reasoning and function tool events to Chat Completions chunks', async () => {
  const openai = catalog.find((item) => item.id === 'openai');
  const encoder = new TextEncoder();
  const source = new Response(new ReadableStream({
    start(controller) {
      const events = [
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.reasoning_summary_text.delta', delta: 'Checking.' },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { id: 'fc_item_1', type: 'function_call', call_id: 'call_1', name: 'sandbox_run_javascript', arguments: '' }
        },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', delta: '{"code":"1+1"}' },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { id: 'fc_item_1', type: 'function_call', call_id: 'call_1', name: 'sandbox_run_javascript', arguments: '{"code":"1+1"}' }
        },
        {
          type: 'response.completed',
          response: {
            output: [{
              id: 'fc_item_1', type: 'function_call', call_id: 'call_1',
              name: 'sandbox_run_javascript', arguments: '{"code":"1+1"}'
            }]
          }
        }
      ];
      for (const event of events) {
        controller.enqueue(encoder.encode('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'));
      }
      controller.close();
    }
  }));

  const converted = adapters.normalizeStream(source, openai, 'responses');
  const text = await converted.text();
  assert.match(text, /"content":"Hello"/);
  assert.match(text, /"reasoning_content":"Checking\\."/);
  assert.match(text, /"id":"call_1"/);
  assert.match(text, /"name":"sandbox_run_javascript"/);
  assert.match(text, /"arguments":"\\{\\"code\\":\\"1\\+1\\"\\}"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /data: \[DONE\]/);
});

test('custom OpenAI-compatible providers remain on Chat Completions', () => {
  const request = adapters.buildModelRequest({
    id: 'openrouter',
    url: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    authType: 'bearer'
  }, {
    apiKey: 'openrouter-test-key',
    model: 'openai/gpt-5.4',
    messages: [{ role: 'user', content: 'Hello' }]
  }, false);

  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.protocol, 'openai');
  assert.equal(request.body.model, 'openai/gpt-5.4');
});
