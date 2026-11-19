# Storage diagnostics patch — 2026-11-19

## Scope

This patch is based on `backup/main-before-server-key-storage-2026-11-19`.
It changes storage initialization and error reporting. It does not change the provider API request flow or GitHub permissions.

## Changes

- Bot-chat PostgreSQL initialization and GitHub PostgreSQL initialization are now independent.
- A failed initialization clears its cached Promise, allowing a later request to retry.
- A module returning `false` is treated as missing persistent storage rather than as successful initialization.
- Telegram webhook commands that do not need persistence (`/start` and `/help`) no longer depend on database initialization.
- Added a `GET /ready` endpoint that initializes bot storage, validates the AES-256 encryption key, and executes `SELECT 1`. The existing `GET /health` remains a liveness check.
- Bot settings errors now include stable machine-readable codes and safe, actionable Russian messages.
- API URL, API key, model, missing database URL, encryption-key format, PostgreSQL authentication, missing database, permission, and connectivity errors are distinguished.
- Server logs include the subsystem, error name, and technical code, but not raw error messages, request bodies, Telegram initData, or provider keys.

## Error codes

| Code | Meaning |
| --- | --- |
| `DATABASE_URL_MISSING` | PostgreSQL connection string is not configured |
| `DATABASE_URL_INVALID` | PostgreSQL connection string is present but malformed |
| `DATA_ENCRYPTION_KEY_INVALID` | AES-256 key is missing or is not a valid 32-byte hex/base64 secret |
| `POSTGRES_AUTH_FAILED` | PostgreSQL rejected the credentials |
| `POSTGRES_DATABASE_MISSING` | Database named in the connection string was not found |
| `POSTGRES_PERMISSION_DENIED` | Database user cannot create/update storage tables |
| `POSTGRES_UNAVAILABLE` | Database connection could not be established |
| `INVALID_API_URL` | Provider API base URL is invalid |
| `INVALID_API_KEY` | Provider key is missing or has invalid length |
| `INVALID_MODEL` | Model ID is invalid |
| `STORAGE_OPERATION_FAILED` | Unclassified storage operation failure; inspect server log code |

## Verification

Run:

```sh
node --check server.js
node --check bot-chat.js
node --check storage-manager.js
npm test
```

Then verify `GET /ready` against the deployed backend and submit a settings save from a Telegram Mini App. A successful `/health` alone does not prove PostgreSQL readiness.
