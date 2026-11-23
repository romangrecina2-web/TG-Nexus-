'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../model-catalog');

test('model catalogue normalizes provider metadata without guessing missing values', () => {
  const model = catalog.normalizeModel({
    id: 'nvidia/nemotron-example',
    name: 'Nemotron Example',
    description: 'Model description from provider.',
    context_length: 1_000_000,
    pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'reasoning']
  }, 'openrouter');

  assert.equal(model.id, 'nvidia/nemotron-example');
  assert.equal(model.contextLength, 1_000_000);
  assert.equal(model.isFree, true);
  assert.equal(model.supportsReasoning, true);
  assert.equal(model.supportsTools, true);
  assert.deepEqual(model.inputModalities, ['text', 'image']);
  assert.equal(model.throughput, null);
});

test('free filter requires both input and output prices to be known and zero', () => {
  const models = [
    catalog.normalizeModel({ id: 'free', pricing: { prompt: '0', completion: '0' } }),
    catalog.normalizeModel({ id: 'paid', pricing: { prompt: '0.000001', completion: '0.000002' } }),
    catalog.normalizeModel({ id: 'unknown' }),
    catalog.normalizeModel({ id: 'half-free', pricing: { prompt: '0', completion: '0.000001' } })
  ];
  assert.deepEqual(catalog.filterModels(models, { free: true }).map((item) => item.id), ['free']);
});

test('model catalogue combines context, modality and reasoning filters', () => {
  const models = [
    catalog.normalizeModel({
      id: 'all-matches', context_length: 1_000_000,
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['reasoning']
    }),
    catalog.normalizeModel({
      id: 'small-context', context_length: 32_000,
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['reasoning']
    }),
    catalog.normalizeModel({
      id: 'no-image', context_length: 1_000_000,
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['reasoning']
    })
  ];

  assert.deepEqual(
    catalog.filterModels(models, { minContext: 1_000_000, image: true, reasoning: true }).map((item) => item.id),
    ['all-matches']
  );
});

test('model catalogue sorting keeps unknown values after known values', () => {
  const models = [
    catalog.normalizeModel({ id: 'unknown' }),
    catalog.normalizeModel({ id: 'small', context_length: 32_000 }),
    catalog.normalizeModel({ id: 'large', context_length: 1_000_000 })
  ];
  assert.deepEqual(catalog.sortModels(models, 'context').map((item) => item.id), [
    'large', 'small', 'unknown'
  ]);
});

test('OpenRouter prices are displayed per million tokens', () => {
  assert.equal(catalog.formatPricePerMillion(0), '$0');
  assert.equal(catalog.formatPricePerMillion(0.000001), '$1.00');
  assert.equal(catalog.formatPricePerMillion(null), 'Нет данных');
});
