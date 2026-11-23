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

  function apiUrl(base, path, fallback) {
    const suffix = String(path || fallback || '').trim();
    if (!suffix) throw new Error('API route is not configured.');
    return cleanBase(base) + (suffix.startsWith('/') ? suffix : '/' + suffix);
  }

  function hasImageInput(messages) {
    return (Array.isArray(messages) ? messages : []).some((message) => {
      if (!message || !Array.isArray(message.content)) return false;
      return message.content.some((part) => part && (
        part.type === 'image_url' || part.type === 'input_image'
      ));
    });
  }

  function supportsResponsesModel(profile, model) {
    const patterns = Array.isArray(profile && profile.responsesModels) ? profile.responsesModels : [];
    const id = String(model || '').trim();
    return patterns.some((pattern) => {
      const value = String(pattern || '').trim();
      if (!value) return false;
      return value.endsWith('*') ? id.startsWith(value.slice(0, -1)) : id === value;
    });
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
      return { url: apiUrl(base, profile.messagesPath, '/messages'), headers, body, protocol };
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
    return { url: apiUrl(base, profile.chatPath, '/chat/completions'), headers, body, protocol };
  }

  function isOpenAiAstraProModel(profile, model) {
    const normalizedModel = String(model || '').trim().toLowerCase();
    if (!/^(?:openai\/)?gpt-6\.2-astra-pro$/.test(normalizedModel)) return false;

    let hostname = '';
    try { hostname = new URL(cleanBase(profile && profile.url)).hostname.toLowerCase(); } catch {}
    return !!profile && profile.protocol !== 'anthropic' &&
      (String(profile.id || '').toLowerCase() === 'openai' || hostname === 'api.openai.com');
  }

  function toResponsesContent(content, role) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    const isUser = role === 'user';
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        parts.push({ type: 'input_text', text: part.text });
        continue;
      }
      if (part.type === 'input_text' && typeof part.text === 'string') {
        parts.push({ type: 'input_text', text: part.text });
        continue;
      }
      if ((part.type === 'image_url' || part.type === 'input_image') && isUser) {
        const imageUrl = part.image_url && typeof part.image_url === 'object'
          ? part.image_url.url : part.image_url;
        const url = typeof imageUrl === 'string' ? imageUrl :
          (typeof part.url === 'string' ? part.url : '');
        if (!url) throw new Error('Responses API image input is missing its URL.');
        const image = { type: 'input_image', image_url: url };
        const detail = part.image_url && typeof part.image_url === 'object'
          ? part.image_url.detail : part.detail;
        if (detail) image.detail = detail;
        parts.push(image);
        continue;
      }
      throw new Error('Unsupported message content type for the Responses API: ' + String(part.type || 'unknown'));
    }
    if (!parts.length) return '';
    if (parts.every((part) => part.type === 'input_text')) {
      return parts.map((part) => part.text).join('');
    }
    return parts;
  }

  function toResponsesInput(messages) {
    const input = [];
    const instructions = [];
    for (const raw of Array.isArray(messages) ? messages : []) {
      if (!raw || typeof raw !== 'object') continue;
      const role = String(raw.role || '');
      if (role === 'system' || role === 'developer') {
        if (typeof raw.content === 'string' && raw.content.trim()) {
          instructions.push(raw.content);
        }
        continue;
      }
      if (role === 'tool') {
        const callId = String(raw.tool_call_id || '');
        if (!callId) throw new Error('A tool result is missing its tool_call_id.');
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content == null ? '' : raw.content)
        });
        continue;
      }
      if (role !== 'user' && role !== 'assistant') continue;

      const content = toResponsesContent(raw.content, role);
      if (content !== '') input.push({ role, content });

      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      for (const call of calls) {
        if (!call || !call.function || !call.function.name) continue;
        const callId = String(call.id || call.call_id || '');
        if (!callId) throw new Error('A function call is missing its call ID.');
        input.push({
          type: 'function_call',
          call_id: callId,
          name: String(call.function.name),
          arguments: typeof call.function.arguments === 'string'
            ? call.function.arguments : JSON.stringify(call.function.arguments || {})
        });
      }

      if (raw.function_call && raw.function_call.name) {
        const callId = String(raw.tool_call_id || raw.id || '');
        if (!callId) throw new Error('A legacy function call is missing its call ID.');
        input.push({
          type: 'function_call',
          call_id: callId,
          name: String(raw.function_call.name),
          arguments: typeof raw.function_call.arguments === 'string'
            ? raw.function_call.arguments : JSON.stringify(raw.function_call.arguments || {})
        });
      }
    }
    if (!input.some((item) => item.type === 'function_call_output' || item.role === 'user')) {
      throw new Error('Responses API needs at least one user message.');
    }
    return { input, instructions: instructions.join('\n\n') };
  }

  function toResponsesTools(tools) {
    const result = [];
    for (const tool of Array.isArray(tools) ? tools : []) {
      if (!tool || typeof tool !== 'object') continue;
      if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
        const fn = tool.function;
        if (typeof fn.name !== 'string' || !fn.name.trim()) {
          throw new Error('A Responses API function tool needs a name.');
        }
        const converted = {
          type: 'function',
          name: fn.name,
          parameters: fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters : { type: 'object', properties: {} }
        };
        if (typeof fn.description === 'string' && fn.description) converted.description = fn.description;
        if (typeof fn.strict === 'boolean') converted.strict = fn.strict;
        result.push(converted);
        continue;
      }
      if (['web_search', 'web_search_preview', 'file_search', 'code_interpreter'].includes(tool.type)) {
        result.push(tool);
        continue;
      }
      throw new Error('Unsupported tool type for the Responses API: ' + String(tool.type || 'unknown'));
    }
    return result;
  }

  function isDirectOpenAiProfile(profile) {
    if (!profile || profile.protocol === 'anthropic') return false;
    if (profile.protocol === 'responses' || String(profile.id || '').toLowerCase() === 'openai') return true;
    try {
      return new URL(cleanBase(profile.url)).hostname.toLowerCase() === 'api.openai.com';
    } catch {
      return false;
    }
  }

  function isReasoningModel(model) {
    return /^(?:o[134](?:-|$)|gpt-(?:5|6)(?:[.-]|$))/i.test(String(model || '').trim());
  }

  function buildResponsesRequest(profile, options, browserMode) {
    const base = cleanBase(profile && profile.url);
    if (!base) throw new Error('API endpoint is not configured.');
    if (!profile || profile.protocol === 'anthropic') {
      throw new Error('The Responses API adapter cannot be used with an Anthropic endpoint.');
    }
    const selectedModel = String(options && options.model || '').trim();
    if (!selectedModel) throw new Error('Select a model before sending a request.');

    const proAlias = isOpenAiAstraProModel(profile, selectedModel);
    const model = proAlias ? 'gpt-6.2-astra' : selectedModel;
    const converted = toResponsesInput(options && options.messages);
    const maxTokens = Math.max(1, Math.min(128_000,
      Math.round(Number(options && options.maxTokens) || 1200)));
    const body = {
      model,
      input: converted.input,
      max_output_tokens: maxTokens,
      stream: options && options.stream === true
    };
    if (converted.instructions) body.instructions = converted.instructions;

    const tools = toResponsesTools(options && options.tools);
    if (tools.length) body.tools = tools;
    if (Number.isInteger(Number(options && options.maxToolCalls)) && Number(options.maxToolCalls) > 0) {
      body.max_tool_calls = Math.min(20, Number(options.maxToolCalls));
    }
    if (options && options.toolChoice) body.tool_choice = options.toolChoice;
    if (options && options.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = options.parallelToolCalls !== false;
    }

    const solarReasoningModel = /^(?:solar-pro4|solar-mini4)(?:-|$)/i.test(model);
    const reasoningModel = isReasoningModel(model) || proAlias || solarReasoningModel;
    const requestedEffort = String(options && options.reasoningEffort || 'auto').toLowerCase();
    if (proAlias || (reasoningModel && requestedEffort !== 'auto')) {
      const supportedEfforts = solarReasoningModel ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['minimal', 'low', 'medium', 'high', 'xhigh'];
      const defaultEffort = proAlias && requestedEffort === 'auto' ? 'medium' : requestedEffort;
      const effort = supportedEfforts.includes(defaultEffort) ? defaultEffort : 'medium';
      body.reasoning = proAlias ? { mode: 'pro', effort } : { effort };
    }

    const temperature = options && options.temperature;
    if (!reasoningModel && temperature !== '' && temperature !== null &&
        temperature !== undefined && Number.isFinite(Number(temperature))) {
      body.temperature = Math.max(0, Math.min(2, Number(temperature)));
    }

    return {
      url: apiUrl(base, profile.responsesPath, '/responses'),
      headers: authHeaders(profile, options && options.apiKey || '', browserMode),
      body,
      protocol: 'responses'
    };
  }

  function buildModelRequest(profile, options, browserMode) {
    const model = String(options && options.model || '').trim();
    const useResponses = isDirectOpenAiProfile(profile) || supportsResponsesModel(profile, model);
    const images = hasImageInput(options && options.messages);
    const responseImagesUnsupported = profile && profile.responsesImages === false;
    if (useResponses && (!images || !responseImagesUnsupported)) {
      return buildResponsesRequest(profile, options, browserMode);
    }
    return buildChatRequest(profile, options, browserMode);
  }

    function normalizeResponsesPayload(payload) {
    const output = Array.isArray(payload && payload.output) ? payload.output : [];
    const parts = [];
    const toolCalls = [];
    for (const item of output) {
      if (!item) continue;
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
          else if (part && part.type === 'refusal' && typeof part.refusal === 'string') parts.push(part.refusal);
        }
      } else if (item.type === 'function_call' && item.name) {
        toolCalls.push({
          id: String(item.call_id || item.id || ''),
          type: 'function',
          function: {
            name: String(item.name),
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
          }
        });
      }
    }
    let text = parts.join('');
    if (!text && typeof payload.output_text === 'string') text = payload.output_text;
    const inputTokens = Number(payload && payload.usage && payload.usage.input_tokens) || 0;
    const outputTokens = Number(payload && payload.usage && payload.usage.output_tokens) || 0;
    return {
      id: payload && payload.id,
      model: payload && payload.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop'
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      }
    };
  }

    function normalizePayload(profile, payload, requestProtocol) {
    if (requestProtocol === 'responses') return normalizeResponsesPayload(payload);
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

  function normalizeResponsesStream(response) {
    if (!response || !response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let finished = false;
    const toolsByItem = new Map();
    const toolsByCall = new Map();
    const tools = [];

    function chunk(delta, finishReason) {
      return 'data: ' + JSON.stringify({
        choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }]
      }) + '\n\n';
    }

    function ensureTool(item) {
      const itemId = String(item && item.id || '');
      const callId = String(item && (item.call_id || item.id) || '');
      const existing = (itemId && toolsByItem.get(itemId)) || (callId && toolsByCall.get(callId));
      if (existing) {
        if (item && item.name && !existing.name) existing.name = String(item.name);
        return { entry: existing, emitted: '' };
      }
      const entry = {
        index: tools.length,
        itemId,
        callId,
        name: String(item && item.name || ''),
        arguments: ''
      };
      tools.push(entry);
      if (itemId) toolsByItem.set(itemId, entry);
      if (callId) toolsByCall.set(callId, entry);
      const delta = {
        tool_calls: [{
          index: entry.index,
          id: entry.callId,
          type: 'function',
          function: { name: entry.name, arguments: '' }
        }]
      };
      return { entry, emitted: chunk(delta) };
    }

    function parseEvent(eventText) {
      const lines = eventText.split(/\r?\n/);
      let eventName = '';
      const dataLines = [];
      for (const line of lines) {
        if (line.indexOf('event:') === 0) eventName = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) return '';
      const raw = dataLines.join('\n');
      if (raw === '[DONE]') {
        finished = true;
        return 'data: [DONE]\n\n';
      }
      let payload;
      try { payload = JSON.parse(raw); } catch { return ''; }
      const type = eventName || String(payload && payload.type || '');
      if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
        return chunk({ content: payload.delta });
      }
      if ((type === 'response.reasoning_text.delta' ||
           type === 'response.reasoning_summary_text.delta') && typeof payload.delta === 'string') {
        return chunk({ reasoning_content: payload.delta });
      }
      if (type === 'response.refusal.delta' && typeof payload.delta === 'string') {
        return chunk({ content: payload.delta });
      }
      if (type === 'response.output_item.added' && payload.item && payload.item.type === 'function_call') {
        return ensureTool(payload.item).emitted;
      }
      if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
        let entry = payload.item_id && toolsByItem.get(String(payload.item_id));
        if (!entry) {
          const ensured = ensureTool({
            id: payload.item_id || payload.call_id,
            call_id: payload.call_id,
            name: payload.name
          });
          entry = ensured.entry;
          if (ensured.emitted) {
            entry.arguments += payload.delta;
            return ensured.emitted + chunk({
              tool_calls: [{ index: entry.index, function: { arguments: payload.delta } }]
            });
          }
        }
        entry.arguments += payload.delta;
        return chunk({
          tool_calls: [{ index: entry.index, function: { arguments: payload.delta } }]
        });
      }
      if (type === 'response.output_item.done' && payload.item && payload.item.type === 'function_call') {
        const ensured = ensureTool(payload.item);
        const fullArguments = typeof payload.item.arguments === 'string'
          ? payload.item.arguments : JSON.stringify(payload.item.arguments || {});
        const missing = fullArguments.slice(ensured.entry.arguments.length);
        ensured.entry.arguments = fullArguments;
        return ensured.emitted + (missing ? chunk({
          tool_calls: [{ index: ensured.entry.index, function: { arguments: missing } }]
        }) : '');
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        const finalResponse = payload.response || {};
        let finalOutput = '';
        for (const item of Array.isArray(finalResponse.output) ? finalResponse.output : []) {
          if (!item || item.type !== 'function_call') continue;
          const ensured = ensureTool(item);
          if (ensured.emitted) finalOutput += ensured.emitted;
          const fullArguments = typeof item.arguments === 'string'
            ? item.arguments : JSON.stringify(item.arguments || {});
          const missing = fullArguments.slice(ensured.entry.arguments.length);
          ensured.entry.arguments = fullArguments;
          if (missing) finalOutput += chunk({
            tool_calls: [{ index: ensured.entry.index, function: { arguments: missing } }]
          });
        }
        finished = true;
        const reason = type === 'response.incomplete' ? 'length' :
          (tools.length ? 'tool_calls' : 'stop');
        return finalOutput + chunk({}, reason) + 'data: [DONE]\n\n';
      }
      if (type === 'response.failed' || type === 'error') {
        finished = true;
        const error = payload.error || payload.response && payload.response.error || {};
        const message = error.message || payload.message || 'Responses API request failed.';
        return 'data: ' + JSON.stringify({ error: { message: String(message) } }) +
          '\n\n' + 'data: [DONE]\n\n';
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
                buffer = '';
              }
              if (!finished) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
            buffer += decoder.decode(item.value, { stream: true });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';
            let output = '';
            for (const eventText of events) {
              const converted = parseEvent(eventText);
              if (converted) output += converted;
              if (finished) break;
            }
            if (output) {
              controller.enqueue(encoder.encode(output));
              if (finished) {
                controller.close();
                return;
              }
              return;
            }
            if (finished) {
              controller.close();
              return;
            }
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

  function normalizeStream(response, profile, requestProtocol) {
    if (requestProtocol === 'responses') return normalizeResponsesStream(response);
    if (!profile || profile.protocol !== 'anthropic' || !response || !response.body) return response;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
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

    function modelsRequest(profile, apiKey, browserMode, catalogOptions = {}) {
    const base = cleanBase(profile && profile.url);
    if (!base) throw new Error('API endpoint is not configured.');
    if (profile && profile.modelsEndpoint === false) {
      throw new Error('This provider does not expose a compatible model-list endpoint. Enter a model ID manually.');
    }
    const suffix = profile && profile.modelsPath
      ? profile.modelsPath
      : (profile && profile.protocol === 'anthropic' ? '/models?limit=100' : '/models');
    const url = new URL(apiUrl(base, suffix, '/models'));
    if (profile && profile.id === 'openrouter' && catalogOptions && typeof catalogOptions === 'object') {
      if (catalogOptions.query) url.searchParams.set('q', String(catalogOptions.query).slice(0, 100));
      if (catalogOptions.sort && ['most-popular', 'pricing-low-to-high', 'context-high-to-low',
        'throughput-high-to-low', 'latency-low-to-high', 'newest'].includes(catalogOptions.sort)) {
        url.searchParams.set('sort', catalogOptions.sort);
      }
    }
    return { url: url.toString(), headers: authHeaders(profile, apiKey, browserMode) };
  }

  function extractModelRecords(profile, payload) {
    const source = Array.isArray(payload) ? payload :
      (Array.isArray(payload && payload.data) ? payload.data :
      (Array.isArray(payload && payload.models) ? payload.models : []));
    const records = [];
    const seen = new Set();
    for (const raw of source) {
      const rawId = typeof raw === 'string' ? raw : raw && (raw.id || raw.name || raw.model);
      if (typeof rawId !== 'string' || !rawId.trim()) continue;
      const id = profile && profile.id === 'gemini'
        ? rawId.trim().replace(/^models\//, '')
        : rawId.trim();
      if (!id || id.length > 256 || seen.has(id)) continue;
      seen.add(id);
      if (typeof raw === 'string') records.push({ id });
      else records.push({ ...raw, id });
    }
    return records;
  }

  function extractModels(profile, payload) {
    return extractModelRecords(profile, payload).map((item) => item.id);
  }

  function modelDetailsRequest(profile, apiKey, model, browserMode) {
    if (!profile || profile.id !== 'openrouter') {
      throw new Error('This provider has no standard single-model details endpoint.');
    }
    const id = String(model || '').trim();
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1 || id.indexOf('/', slash + 1) !== -1) {
      throw new Error('The model ID cannot be used for a details lookup.');
    }
    const author = id.slice(0, slash);
    const slug = id.slice(slash + 1);
    if (!/^[a-z0-9._-]{1,80}$/i.test(author) || !/^[a-z0-9._:-]{1,180}$/i.test(slug)) {
      throw new Error('The model ID contains unsupported characters.');
    }
    const base = cleanBase(profile.url);
    const url = apiUrl(base, '/model/' + encodeURIComponent(author) + '/' + encodeURIComponent(slug));
    return { url, headers: authHeaders(profile, apiKey, browserMode) };
  }

  return {
    authHeaders,
    buildChatRequest,
    buildModelRequest,
    buildResponsesRequest,
    extractModels,
    extractModelRecords,
    modelDetailsRequest,
    isDirectOpenAiProfile,
    normalizeResponsesPayload,
    toResponsesInput,
    toResponsesTools,
    isOpenAiAstraProModel,
    modelsRequest,
    normalizePayload,
    normalizeStream,
    toAnthropicMessages
  };
});
