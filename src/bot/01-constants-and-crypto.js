'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const PROVIDER_ADAPTERS = require('./provider-adapters');
const PROVIDER_CATALOG = require('./provider-catalog');
const MODEL_CATALOG = require('./model-catalog');

const DEFAULT_API_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const MAX_STORED_BYTES = 50 * 1024 * 1024;
const MAX_CHATS_PER_USER = 100;
const MAX_MESSAGES_PER_CHAT = 40;
const MAX_MESSAGE_LENGTH = 50_000;
const TELEGRAM_CHUNK_LENGTH = 3_900;
const MAX_PENDING_UPDATES = 500;
const MAX_PROCESSED_UPDATE_IDS = 10_000;
const MAX_DEAD_LETTERS = 200;
const DEFAULT_WORKER_CONCURRENCY = 3;
const DEFAULT_MAX_UPDATE_ATTEMPTS = 8;

const BOT_COMMANDS = [
  { command: 'start', description: 'Открыть мини-приложение' },
  { command: 'help', description: 'Краткая справка' },
  { command: 'terms', description: 'Условия использования TG Nexus' },
  { command: 'chat', description: 'Показать список чатов' },
  { command: 'add_chat', description: 'Создать чат: /add_chat [название]' },
  { command: 'chat_equip', description: 'Выбрать чат: /chat_equip [название]' },
  { command: 'info', description: 'Показать список команд' },
  { command: 'provider', description: 'Выбрать API-провайдера' },
  { command: 'key', description: 'Добавить или заменить API-ключ' },
  { command: 'model', description: 'Выбрать модель или показать список' },
  { command: 'test', description: 'Проверить реальный запрос к API' },
  { command: 'version', description: 'Показать версию backend' },
  { command: 'settings', description: 'Показать настройки ИИ' },
  { command: 'pro', description: 'Посмотреть тарифы TG Nexus PRO' },
  { command: 'mypro', description: 'Проверить статус PRO' },
  { command: 'promocode', description: 'Активировать промокод' },
  { command: 'paysupport', description: 'Помощь с платежами' },
  { command: 'cancel', description: 'Отменить текущий ввод настройки' }
];

function parseEncryptionKey(value) {
  const raw = String(value || '').trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

  // Render generateValue emits a canonical Base64-encoded 256-bit secret.
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32 && decoded.toString('base64') === raw) return decoded;
  } catch {}
  return null;
}
