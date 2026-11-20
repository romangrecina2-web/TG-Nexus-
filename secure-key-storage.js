'use strict';

(function attachSecureKeyStorage(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TGShellSecureKeyStorage = api;
})(typeof window !== 'undefined' ? window :
  (typeof globalThis !== 'undefined' ? globalThis : this), function createSecureKeyStorageModule() {
  const STORAGE_KEY = 'tg_shell_provider_key_v1';

  function normalizeApiBase(apiBase) {
    return String(apiBase || '').trim().replace(/\\/+$/, '');
  }

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

    async function readProviders() {
      const result = await invoke('getItem', [STORAGE_KEY], false);
      const raw = result.value;
      if (raw == null || raw === '') return { providers: {}, canBeRestored: result.canBeRestored };

      let record;
      try {
        record = JSON.parse(String(raw));
      } catch {
        throw new Error('Saved API keys have an invalid format.');
      }

      // Migrate the previous single-provider record without discarding its key.
      if (record && record.version === 1 &&
          typeof record.apiBase === 'string' &&
          typeof record.key === 'string' && record.key.trim()) {
        const apiBase = normalizeApiBase(record.apiBase);
        return {
          providers: { [apiBase]: { key: record.key, savedAt: Number(record.savedAt) || Date.now() } },
          canBeRestored: result.canBeRestored
        };
      }

      if (!record || record.version !== 2 ||
          !record.providers || typeof record.providers !== 'object' ||
          Array.isArray(record.providers)) {
        throw new Error('Saved API keys have an invalid format.');
      }

      const providers = {};
      Object.keys(record.providers).slice(0, 32).forEach((rawBase) => {
        const entry = record.providers[rawBase];
        const apiBase = normalizeApiBase(rawBase);
        if (!apiBase || !entry || typeof entry.key !== 'string' || !entry.key.trim()) return;
        providers[apiBase] = {
          key: entry.key,
          savedAt: Number(entry.savedAt) || Date.now()
        };
      });
      return { providers, canBeRestored: result.canBeRestored };
    }

    async function load(apiBase) {
      if (!isAvailable()) {
        return { supported: false, found: false, matches: false, key: '' };
      }
      const requestedBase = normalizeApiBase(apiBase);
      if (!requestedBase) throw new Error('An API address is required.');
      const stored = await readProviders();
      const entry = stored.providers[requestedBase];
      return {
        supported: true,
        found: Object.keys(stored.providers).length > 0,
        matches: !!entry,
        key: entry ? entry.key : '',
        canBeRestored: stored.canBeRestored
      };
    }

    async function save(apiBase, apiKey) {
      if (!isAvailable()) throw new Error('Telegram SecureStorage is not available in this client.');
      const normalizedBase = normalizeApiBase(apiBase);
      const normalizedKey = String(apiKey || '').trim();
      if (!normalizedBase || !normalizedKey) throw new Error('An API address and key are required.');
      if (normalizedKey.length > 8_192) throw new Error('The API key is too long to store safely.');

      const stored = await readProviders();
      stored.providers[normalizedBase] = { key: normalizedKey, savedAt: Date.now() };
      await invoke('setItem', [STORAGE_KEY, JSON.stringify({
        version: 2,
        providers: stored.providers,
        updatedAt: Date.now()
      })], true);
      return true;
    }

    async function remove(apiBase) {
      if (!isAvailable()) return false;
      if (apiBase == null || apiBase === '') {
        await invoke('removeItem', [STORAGE_KEY], true);
        return true;
      }

      const normalizedBase = normalizeApiBase(apiBase);
      if (!normalizedBase) throw new Error('An API address is required.');
      const stored = await readProviders();
      if (!stored.providers[normalizedBase]) return false;
      delete stored.providers[normalizedBase];
      if (!Object.keys(stored.providers).length) {
        await invoke('removeItem', [STORAGE_KEY], true);
      } else {
        await invoke('setItem', [STORAGE_KEY, JSON.stringify({
          version: 2,
          providers: stored.providers,
          updatedAt: Date.now()
        })], true);
      }
      return true;
    }

    return { isAvailable, load, save, remove };
  }

  return { STORAGE_KEY, create };
});
