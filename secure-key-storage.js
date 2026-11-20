'use strict';

(function attachSecureKeyStorage(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TGShellSecureKeyStorage = api;
})(typeof window !== 'undefined' ? window :
  (typeof globalThis !== 'undefined' ? globalThis : this), function createSecureKeyStorageModule() {
  const STORAGE_KEY = 'tg_shell_provider_key_v1';

  function create(webApp) {
    const secureStorage = webApp && webApp.SecureStorage;

    function isAvailable() {
      if (!secureStorage ||
          typeof secureStorage.getItem !== 'function' ||
          typeof secureStorage.setItem !== 'function' ||
          typeof secureStorage.removeItem !== 'function') return false;
      if (typeof webApp.isVersionAtLeast !== 'function') return false;
      try {
        return webApp.isVersionAtLeast('9.0') === true;
      } catch {
        return false;
      }
    }

    function invoke(method, args, expectBoolean) {
      return new Promise((resolve, reject) => {
        if (!isAvailable()) {
          reject(new Error('Telegram SecureStorage is not available in this client.'));
          return;
        }
        let settled = false;
        const callback = (error, value, canBeRestored) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (expectBoolean && value === false) {
            reject(new Error('Telegram SecureStorage did not confirm the operation.'));
            return;
          }
          resolve({ value, canBeRestored: canBeRestored === true });
        };
        try {
          secureStorage[method].apply(secureStorage, args.concat(callback));
        } catch (error) {
          if (!settled) {
            settled = true;
            reject(error);
          }
        }
      });
    }

    async function load(apiBase) {
      if (!isAvailable()) {
        return { supported: false, found: false, matches: false, key: '' };
      }
      const result = await invoke('getItem', [STORAGE_KEY], false);
      const raw = result.value;
      if (raw == null || raw === '') {
        return {
          supported: true,
          found: false,
          matches: false,
          key: '',
          canBeRestored: result.canBeRestored
        };
      }

      let record;
      try {
        record = JSON.parse(String(raw));
      } catch {
        throw new Error('Saved API key has an invalid format.');
      }
      if (!record || record.version !== 1 ||
          typeof record.apiBase !== 'string' ||
          typeof record.key !== 'string' ||
          !record.key.trim()) {
        throw new Error('Saved API key has an invalid format.');
      }

      const requestedBase = String(apiBase || '').replace(/\/+$/, '');
      return {
        supported: true,
        found: true,
        matches: record.apiBase === requestedBase,
        key: record.apiBase === requestedBase ? record.key : '',
        canBeRestored: result.canBeRestored
      };
    }

    async function save(apiBase, apiKey) {
      if (!isAvailable()) throw new Error('Telegram SecureStorage is not available in this client.');
      const normalizedBase = String(apiBase || '').trim().replace(/\/+$/, '');
      const normalizedKey = String(apiKey || '').trim();
      if (!normalizedBase || !normalizedKey) throw new Error('An API address and key are required.');
      if (normalizedKey.length > 8_192) throw new Error('The API key is too long to store safely.');

      const record = JSON.stringify({
        version: 1,
        apiBase: normalizedBase,
        key: normalizedKey,
        savedAt: Date.now()
      });
      await invoke('setItem', [STORAGE_KEY, record], true);
      return true;
    }

    async function remove() {
      if (!isAvailable()) return false;
      await invoke('removeItem', [STORAGE_KEY], true);
      return true;
    }

    return { isAvailable, load, save, remove };
  }

  return { STORAGE_KEY, create };
});
