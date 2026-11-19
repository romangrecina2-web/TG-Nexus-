# Server-only persistent provider key storage — 2026-11-19

## Purpose

Remove persistent provider API keys from browser storage. The canonical copy belongs to the backend database and is associated with the authenticated Telegram user ID, not a Google account.

## What changed

- `bot-chat.js` adds `getSettings(userId)`, which reads the user's provider settings from PostgreSQL and decrypts the provider key only when needed.
- `server.js` extends authenticated `POST /api/bot-settings` with `{ action: "get" }`. The route validates signed Telegram Mini App `initData`, applies the existing rate limit, and returns only the authenticated user's API base, key, active model, and saved model IDs.
- `app.js` loads these settings when the Mini App starts. The key is kept in JavaScript memory while the app is open and is no longer written to `localStorage`.
- New or changed keys are saved to the backend. Changing the API base or clearing the key clears the server-side credential.
- A legacy key previously saved as `tg_bot_api_credential` is migrated to PostgreSQL the first time the backend database is available. The old browser entry is removed only after a successful server save/load, so a not-yet-configured backend does not silently destroy the user's only existing copy.

## Storage and security boundary

1. PostgreSQL stores the provider key as AES-256-GCM ciphertext. The encryption key is `DATA_ENCRYPTION_KEY`, stored as a Render secret/environment variable, never in GitHub or frontend code.
2. The database row is keyed by Telegram user ID recovered from cryptographically validated `initData`; the frontend cannot choose another user's ID.
3. The backend returns the decrypted key only to a request authenticated as that Telegram user. HTTPS is required.
4. The Mini App keeps the key in memory so current direct-to-provider browser requests can continue to work. It does not persist the plaintext key to browser storage.
5. This is server-side persistence, not a full server-side proxy. Same-origin JavaScript running while the Mini App is open can still access the active in-memory key. To prevent plaintext keys reaching the browser at all, a separate update would need to proxy every model, chat, model-list, and balance/usage request through the backend.

## Free database recommendation

Use Neon PostgreSQL as the database and Render Free Web Service as the backend host.

- Create a PostgreSQL project at [Neon](https://neon.com/).
- Copy the pooled connection string from the Neon dashboard.
- In Render → backend service → Environment, set `DATABASE_URL` to that connection string.
- Set `DATA_ENCRYPTION_KEY` to 64 hexadecimal characters generated with `openssl rand -hex 32`.
- Keep a secure offline backup of `DATA_ENCRYPTION_KEY`. If it is lost, stored API keys and GitHub OAuth tokens cannot be decrypted.
- Redeploy/restart the Render service so it initializes PostgreSQL.
- Open the Mini App from Telegram. Existing local credentials are migrated automatically after the backend reports a successful save.

At the currently published limits, Neon Free includes 1 GB storage per project, 100 CU-hours per project per month, and 5 GB project network transfer; compute scales to zero after inactivity. These limits can change, so check [Neon's free-plan quotas](https://neon.com/docs/introduction/limits). Render's free PostgreSQL databases expire after 30 days and are not appropriate as the only persistent store for this project; see [Render's free-instance limits](https://render.com/docs/free#free-postgres).

## Important distinction

Browser `localStorage` is scoped to the website origin in that browser profile; it is not a Google Drive file or a key stored in the user's Google account. The change nevertheless removes the API key from persistent browser storage and makes PostgreSQL the canonical store.

## Manual acceptance checklist

- [ ] Configure Neon `DATABASE_URL` in Render.
- [ ] Configure and back up `DATA_ENCRYPTION_KEY`.
- [ ] Redeploy backend and verify `/health`.
- [ ] Open Mini App from Telegram and confirm the saved provider is loaded without re-entering the key.
- [ ] Close and reopen Mini App; confirm the key is loaded again from the backend.
- [ ] Check browser storage: `tg_bot_api_credential` is absent after successful migration.
- [ ] Change API provider/base; confirm the old server-side credential is cleared and the new provider requires a new key.
- [ ] Confirm one Telegram user cannot load another user's settings.
- [ ] Confirm AI chat and model selection still work through the selected provider.
