'use strict';

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function normalizeModel(raw, providerId = 'custom') {
  const item = typeof raw === 'string' ? { id: raw } :
    (raw && typeof raw === 'object' ? raw : {});
  const id = String(item.id || item.name || item.model || '').trim().replace(/^models\//, '');
  if (!id || id.length > 256) return null;

  const architecture = item.architecture && typeof item.architecture === 'object'
    ? item.architecture : {};
  const topProvider = item.top_provider && typeof item.top_provider === 'object'
    ? item.top_provider : {};
  const pricing = item.pricing && typeof item.pricing === 'object' ? item.pricing : {};
  const supportedParameters = cleanList(item.supported_parameters || item.supportedParameters);
  const inputModalities = cleanList(architecture.input_modalities || item.input_modalities || item.inputModalities);
  const outputModalities = cleanList(architecture.output_modalities || item.output_modalities || item.outputModalities);
  const promptPrice = numberOrNull(pricing.prompt);
  const completionPrice = numberOrNull(pricing.completion);
  const contextLength = numberOrNull(item.context_length ?? item.contextLength ??
    item.inputTokenLimit ?? item.max_input_tokens ?? item.maxInputTokens);
  const maxOutputTokens = numberOrNull(topProvider.max_completion_tokens ??
    item.max_completion_tokens ?? item.max_output_tokens ?? item.outputTokenLimit ?? item.maxOutputTokens);
  const throughput = numberOrNull(item.throughput ?? item.tokens_per_second ??
    item.tokensPerSecond ?? item.speed_tokens_per_second);
  const latency = numberOrNull(item.latency ?? item.time_to_first_token ??
    item.timeToFirstToken);

  const supportsReasoning = item.supports_reasoning === true || item.reasoning === true ||
    supportedParameters.some((value) => value.includes('reasoning'));
  const supportsTools = supportedParameters.some((value) =>
    ['tools', 'tool_choice', 'function_call', 'functions'].includes(value));
  const isFree = promptPrice === 0 && completionPrice === 0;

  return {
    id,
    name: String(item.name || item.displayName || item.display_name || id).trim().slice(0, 160),
    description: String(item.description || '').trim().slice(0, 1200),
    providerId: String(providerId || 'custom'),
    contextLength,
    maxOutputTokens,
    promptPrice,
    completionPrice,
    inputModalities,
    outputModalities,
    supportedParameters,
    throughput,
    latency,
    isFree,
    supportsReasoning,
    supportsTools,
    created: numberOrNull(item.created)
  };
}

function filterModels(models, filters = {}) {
  const query = String(filters.query || '').trim().toLocaleLowerCase();
  const list = Array.isArray(models) ? models : [];
  return list.filter((model) => {
    if (!model) return false;
    if (query && ![model.id, model.name, model.description].some((value) =>
      String(value || '').toLocaleLowerCase().includes(query))) return false;
    if (filters.free === true && model.isFree !== true) return false;
    if (Number(filters.minContext) > 0 &&
        !(Number.isFinite(model.contextLength) && model.contextLength >= Number(filters.minContext))) return false;
    if (filters.image === true && !model.inputModalities.includes('image')) return false;
    if (filters.file === true && !model.inputModalities.includes('file')) return false;
    if (filters.audio === true && !model.inputModalities.includes('audio')) return false;
    if (filters.reasoning === true && model.supportsReasoning !== true) return false;
    if (filters.tools === true && model.supportsTools !== true) return false;
    return true;
  });
}

function sortModels(models, sort = 'popular') {
  const list = (Array.isArray(models) ? models : []).slice();
  const knownLast = (a, b, field, direction = 1) => {
    const av = Number.isFinite(a[field]) ? a[field] : null;
    const bv = Number.isFinite(b[field]) ? b[field] : null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * direction;
  };
  if (sort === 'context') return list.sort((a, b) => knownLast(a, b, 'contextLength', -1));
  if (sort === 'speed') return list.sort((a, b) => knownLast(a, b, 'throughput', -1));
  if (sort === 'price') {
    return list.sort((a, b) => {
      const aPrice = Number.isFinite(a.promptPrice) && Number.isFinite(a.completionPrice)
        ? a.promptPrice + a.completionPrice : null;
      const bPrice = Number.isFinite(b.promptPrice) && Number.isFinite(b.completionPrice)
        ? b.promptPrice + b.completionPrice : null;
      if (aPrice === null && bPrice === null) return 0;
      if (aPrice === null) return 1;
      if (bPrice === null) return -1;
      return aPrice - bPrice;
    });
  }
  return list;
}

function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return 'Нет данных';
  return Math.round(value).toLocaleString('ru-RU');
}

function formatPricePerMillion(value) {
  if (!Number.isFinite(value)) return 'Нет данных';
  const scaled = value * 1_000_000;
  if (scaled === 0) return '$0';
  if (scaled < 0.01) return '$' + scaled.toFixed(5);
  if (scaled < 1) return '$' + scaled.toFixed(3);
  return '$' + scaled.toFixed(2);
}

function getTags(model) {
  const tags = [];
  if (model.isFree === true) tags.push('Бесплатная');
  if (Number.isFinite(model.contextLength) && model.contextLength >= 100_000) tags.push('Глубокий контекст');
  if (model.supportsReasoning) tags.push('Рассуждения');
  if (model.inputModalities.includes('image')) tags.push('Изображения');
  if (model.inputModalities.includes('file')) tags.push('Файлы');
  if (model.inputModalities.includes('audio')) tags.push('Аудио');
  if (model.supportsTools) tags.push('Инструменты');
  return tags;
}

module.exports = {
  filterModels,
  formatPricePerMillion,
  formatTokens,
  getTags,
  normalizeModel,
  sortModels
};
