# Code structure

The application keeps the existing runtime entry points:

- `index.html` loads the generated browser bundle `app.js`.
- `server.js` imports the generated backend module `bot-chat.js`.

Do not edit those two generated files directly. Edit the source fragments below and rebuild them with:

```sh
npm run build
npm test
```

To check whether generated files are current without rewriting them:

```sh
npm run build:check
```

## Browser app: `src/client/`

The fragments are concatenated in filename order into one browser script. They intentionally share the same IIFE scope, so they must not be loaded independently.

| File | Responsibility |
| --- | --- |
| `01-markdown-and-bootstrap.js` | Markdown rendering helpers and application bootstrap |
| `02-state-and-normalization.js` | Default state, chat normalization, local persistence |
| `03-provider-profiles.js` | Provider catalog, profiles, profile switching |
| `04-remote-sync.js` | Server synchronization and conflict merging |
| `05-chat-core-and-api.js` | Chat state, keys, memory, request preparation |
| `06-chat-rendering.js` | Message bubbles, versions, rendering helpers |
| `07-code-transfer-and-message-editing.js` | Code transfer, editing and message actions |
| `08-send-and-error-handling.js` | Sending flow and readable API errors |
| `09-attachments.js` | File selection, validation and attachment handling |
| `10-sandbox-runtime.js` | Sandbox execution and tool orchestration |
| `11-chats-and-settings.js` | Chat management and settings UI |
| `12-wallpaper-storage.js` | Wallpaper persistence and preview |
| `13-context-and-panels.js` | Context summaries, pinned messages, panels and startup |

## Telegram backend: `src/bot/`

These fragments are concatenated in filename order into `bot-chat.js`. They share the module and factory scopes of the original file; do not require or execute individual fragments.

| File | Responsibility |
| --- | --- |
| `01-constants-and-crypto.js` | Constants and encryption-key validation |
| `02-encrypted-store-and-queue.js` | Encrypted persistence, update queue and user store |
| `03-provider-and-markdown-helpers.js` | Provider lookup and Telegram Markdown/HTML conversion |
| `04-telegram-transport.js` | Telegram transport, status updates and progress |
| `05-response-and-file-delivery.js` | Assistant response formatting and generated-file delivery |
| `06-settings-and-callbacks.js` | Settings views, keyboards and callback processing |
| `07-chat-and-provider-commands.js` | Chat, key, provider and model commands |
| `08-provider-requests.js` | Provider request construction and error normalization |
| `09-message-processing-and-workers.js` | Incoming message processing and queued workers |
| `09-model-catalog.js` | Telegram model catalogue, provider search, filters, Rich Message cards and model selection |
| `10-sync-api-and-exports.js` | Mini App sync API and public module exports |

## Existing standalone modules

The provider adapters, provider catalog, secure key storage, server routes and sandbox files remain separate. Their runtime loading order and public interfaces are unchanged by this refactor.
