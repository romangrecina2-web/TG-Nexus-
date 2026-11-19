'use strict';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createStorageManager(services) {
  if (!services || !services.botChat || !services.github) {
    throw new TypeError('Both botChat and github storage services are required.');
  }

  const pending = { bot: null, github: null };

  function ensure(kind, service) {
    if (!pending[kind]) {
      let attempt;
      attempt = Promise.resolve()
        .then(() => service.init())
        .then((initialized) => {
          if (initialized === false) {
            throw codedError(
              'DATABASE_URL_MISSING',
              'DATABASE_URL is not configured for persistent storage.'
            );
          }
          return true;
        })
        .catch((error) => {
          // A rejected promise must never poison all future requests.
          if (pending[kind] === attempt) pending[kind] = null;
          throw error;
        });
      pending[kind] = attempt;
    }
    return pending[kind];
  }

  return {
    ensureBotStorage: () => ensure('bot', services.botChat),
    ensureGithubStorage: () => ensure('github', services.github)
  };
}

function describeStorageError(error) {
  const code = String(
    (error && error.code) ||
    (error && error.cause && error.cause.code) ||
    'UNKNOWN'
  );

  const validation = {
    INVALID_API_URL: {
      status: 400,
      code,
      message: 'Некорректный API URL: требуется HTTPS без логина, пароля, query и hash.'
    },
    INVALID_API_KEY: {
      status: 400,
      code,
      message: 'Некорректный API-ключ: допустимая длина от 8 до 4096 символов.'
    },
    INVALID_MODEL: {
      status: 400,
      code,
      message: 'Некорректный ID модели: от 1 до 200 символов без пробелов.'
    }
  };
  if (validation[code]) return validation[code];

  if (code === 'DATABASE_URL_MISSING') {
    return {
      status: 503,
      code,
      message: 'Серверное хранилище не настроено: отсутствует переменная DATABASE_URL.'
    };
  }
  if (code === 'DATA_ENCRYPTION_KEY_INVALID') {
    return {
      status: 503,
      code,
      message: 'Сервер не может шифровать API-ключи: DATA_ENCRYPTION_KEY отсутствует или неверен. Нужен 32-байтовый ключ в hex (64 символа) или base64.'
    };
  }
  if (code === 'ERR_INVALID_URL') {
    return {
      status: 503,
      code: 'DATABASE_URL_INVALID',
      message: 'Переменная DATABASE_URL задана, но содержит некорректный адрес подключения PostgreSQL. Проверьте формат строки подключения.'
    };
  }
  if (code === '28P01') {
    return {
      status: 503,
      code: 'POSTGRES_AUTH_FAILED',
      message: 'PostgreSQL отклонил учётные данные из DATABASE_URL. Проверьте логин и пароль подключения.'
    };
  }
  if (code === '3D000') {
    return {
      status: 503,
      code: 'POSTGRES_DATABASE_MISSING',
      message: 'База данных из DATABASE_URL не найдена. Проверьте имя базы в строке подключения.'
    };
  }
  if (code === '42501') {
    return {
      status: 503,
      code: 'POSTGRES_PERMISSION_DENIED',
      message: 'У пользователя PostgreSQL недостаточно прав для создания или изменения таблиц хранилища.'
    };
  }

  const networkCodes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
    'EHOSTUNREACH', 'EPIPE', '57P01', '57P03', '53300'
  ]);
  if (code.startsWith('08') || networkCodes.has(code)) {
    return {
      status: 503,
      code: 'POSTGRES_UNAVAILABLE',
      message: 'Не удалось подключиться к PostgreSQL. Проверьте доступность базы данных и DATABASE_URL.'
    };
  }

  return {
    status: 503,
    code: 'STORAGE_OPERATION_FAILED',
    message: 'Операция с хранилищем PostgreSQL завершилась ошибкой. Технический код: ' +
      code + '. Подробности записаны в журнал сервера без содержимого API-ключа.'
  };
}

function logStorageError(component, error) {
  const code = String(
    (error && error.code) ||
    (error && error.cause && error.cause.code) ||
    'UNKNOWN'
  );
  const name = String((error && error.name) || 'Error');
  // Never log error.message, request bodies, Telegram initData, or API credentials.
  console.error('[storage] ' + String(component || 'unknown') + ' failed', JSON.stringify({
    name,
    code
  }));
}

module.exports = {
  createStorageManager,
  describeStorageError,
  logStorageError
};
