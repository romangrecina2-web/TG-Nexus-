'use strict';

(function attachProviderAdapters(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TGProviderAdapters = api;
})(typeof window !== 'undefined' ? window :
  (typeof globalThis !== 'undefined' ? globalThis : this), function buildProviderAdapters() {
  function cleanBase(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function authHeaders(profile, apiKey, browserMode) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const scheme = String(profile && profile.authType || 'bearer').toLowerCase();
    if (scheme === 'key') headers.Authorization = 'Key ' + apiKey;
    else if (scheme === 'api-key') headers.Authorization = 'Api-Key ' + apiKey;
    else if (scheme === 'x-api-key') headers['x-api-key'] = apiKey;
    else headers.Authorization = 'Bearer ' + apiKey;

    if (profile && profile.protocol === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (browserMode) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    return headers;
  }

  function toAnthropicContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
        const match = part.image_url.url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
        if (match) {
          parts.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] }
          });
        }
      }
    }
    return parts.length ? parts : '';
  }

  function toAnthropicMessages(messages) {
    const output = [];
    let system = '';
    for (const raw of Array.isArray(messages) ? messages : []) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.role === 'system' || raw.role === 'developer') {
        const text = typeof raw.content === 'string' ? raw.content : '';
        if (text) system += (system ? '\n\n' : '') + text;
        continue;
      }
      if (raw.role === 'tool') {
        output.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: String(raw.tool_call_id || 'unknown'),
            content: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content || '')
          }]
        });
        continue;
      }
      if (raw.role !== 'user' && raw.role !== 'assistant') continue;
      const content = toAnthropicContent(raw.content);
      if (content === '') continue;
      output.push({ role: raw.role, content });
    }
    return { system, messages: output };
  }

  function buildChatRequest(profile, options, browserMode) {
    const base = cleanBase(profile && profile.url);
    if (!base) throw new Error('API endpoint is not configured.');
    const model = String(options && options.model || '').trim();
    if (!model) throw new Error('Select a model before sending a request.');
    const protocol = String(profile && profile.protocol || 'openai');
    const messages = Array.isArray(options && options.messages) ? options.messages : [];
    const maxTokens = Math.max(1, Math.min(1_000_000, Math.round(Number(options && options.maxTokens) || 1200)));
    const headers = authHeaders(profile, options && options.apiKey || '', browserMode);

    if (protocol === 'anthropic') {
      const converted = toAnthropicMessages(messages);
      if (!converted.messages.length) throw new Error('Anthropic needs at least one user or assistant message.');
      const body = {
        model,
        max_tokens: maxTokens,
        messages: converted.messages,
        stream: options && options.stream === true
      };
      if (converted.system) body.system = converted.system;
      const temperature = options && options.temperature;
      if (temperature !== '' && temperature !== null && temperature !== undefined && Number.isFinite(Number(temperature))) {
        body.temperature = Math.max(0, Math.min(1, Number(temperature)));
      }
      return { url: base + '/messages', headers, body, protocol };
    }

    const body = {
      model,
      messages,
      stream: options && options.stream === true
    };
    if (maxTokens) body.max_tokens = maxTokens;
    const temperature = options && options.temperature;
    if (temperature !== '' && temperature !== null && temperature !== undefined && Number.isFinite(Number(temperature))) {
      body.temperature = Math.max(0, Math.min(2, Number(temperature)));
    }
    if (options && options.reasoningEffort && options.reasoningEffort !== 'auto') {
      body.reasoning_effort = options.reasoningEffort;
    }
    if (Array.isArray(options && options.tools) && options.tools.length) body.tools = options.tools;
    if (Number.isInteger(Number(options && options.maxToolCalls)) && Number(options.maxToolCalls) > 0) {
      body.max_tool_calls = Math.min(20, Number(options.maxToolCalls));
    }
    return { url: base + '/chat/completions', headers, body, protocol };
  }

  function normalizePayload(profile, payload) {
    if (!profile || profile.protocol !== 'anthropic') return payload;
    const blocks = Array.isArray(payload && payload.content) ? payload.content : [];
    const text = blocks.filter((part) => part && part.type === 'text')
      .map((part) => String(part.text || '')).join('');
    return {
      id: payload && payload.id,
      model: payload && payload.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: payload && payload.stop_reason || 'stop'
      }],
      usage: {
        prompt_tokens: Number(payload && payload.usage && payload.usage.input_tokens) || 0,
        completion_tokens: Number(payload && payload.usage && payload.usage.output_tokens) || 0
      }
    };
  }

  function normalizeStream(response, profile) {
    if (!profile || profile.protocol !== 'anthropic' || !response || !response.body) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let eventName = '';
    let dataLines = [];
    let finished = false;

    function openAiChunk(delta, finishReason) {
      return 'data: ' + JSON.stringify({
        choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }]
      }) + '\n\n';
    }

    function parseEvent(eventText) {
      const lines = eventText.split(/\r?\n/);
      let name = '';
      const data = [];
      for (const line of lines) {
        if (line.indexOf('event:') === 0) name = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) data.push(line.slice(5).trim());
      }
      if (!data.length) return '';
      let payload;
      try { payload = JSON.parse(data.join('\n')); } catch { return ''; }

      if (name === 'content_block_delta' && payload.delta && payload.delta.type === 'text_delta') {
        return openAiChunk({ content: String(payload.delta.text || '') });
      }
      if (name === 'message_delta') {
        const reason = payload.delta && payload.delta.stop_reason;
        return openAiChunk({}, reason === 'end_turn' ? 'stop' : (reason || null));
      }
      if (name === 'message_stop') {
        finished = true;
        return 'data: [DONE]\n\n';
      }
      if (name === 'error') {
        const message = payload.error && payload.error.message || 'Anthropic stream failed.';
        return 'data: ' + JSON.stringify({ error: { message } }) + '\n\n';
      }
      return '';
    }

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) {
              if (buffer) {
                const tail = parseEvent(buffer);
                if (tail) controller.enqueue(encoder.encode(tail));
              }
              if (!finished) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
            buffer += decoder.decode(item.value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';
            let emitted = false;
            for (const eventText of events) {
              const converted = parseEvent(eventText);
              if (converted) {
                controller.enqueue(encoder.encode(converted));
                emitted = true;
              }
              if (finished) {
                controller.close();
                return;
              }
            }
            if (emitted) return;
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } catch {}
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
    });
  }

  function modelsRequest(profile, apiKey, browserMode) {
    const base = cleanBase(profile && profile.url);
    if (!base) throw new Error('API endpoint is not configured.');
    if (profile && profile.modelsEndpoint === false) {
      throw new Error('This provider does not expose a compatible model-list endpoint. Enter a model ID manually.');
    }
    const suffix = profile && profile.protocol === 'anthropic' ? '/models?limit=100' : '/models';
    return { url: base + suffix, headers: authHeaders(profile, apiKey, browserMode) };
  }

  function extractModels(profile, payload) {
    const source = Array.isArray(payload) ? payload :
      (Array.isArray(payload && payload.data) ? payload.data :
      (Array.isArray(payload && payload.models) ? payload.models : []));
    return [...new Set(source.map((item) => typeof item === 'string' ? item : item && (item.id || item.name))
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => profile && profile.id === 'gemini' ? id.replace(/^models\//, '') : id.trim()))];
  }

  return {
    authHeaders,
    buildChatRequest,
    extractModels,
    modelsRequest,
    normalizePayload,
    normalizeStream,
    toAnthropicMessages
  };
});
