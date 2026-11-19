# Security hardening update — 2026-11-19

## Scope

This change hardens the Telegram Mini App frontend, the JavaScript sandbox, and the Node.js Telegram bot backend. It does not claim that a browser application is impossible to compromise.

## Changes

### Frontend and API-key handling

- Provider API keys are held only in the active tab's JavaScript memory.
- Keys are removed from persisted application state, legacy storage migration, and backup import/export paths.
- Changing the API endpoint or selecting a provider preset clears the current key. The user must enter the new provider's key.
- API base URLs must use HTTPS. HTTP is allowed only for localhost development.

### JavaScript sandbox

- Replaced dynamically assembled iframe srcdoc with separate sandbox.html and sandbox-network.html documents.
- The iframe keeps sandbox="allow-scripts" and does not receive allow-same-origin.
- Parent/child communication uses a dedicated MessageChannel; the port is kept in the sandbox bootstrap closure and is not passed to user code.
- Added restrictive child CSP. The network-off page has connect-src 'none'; network-on has connect-src https:.
- Disabled common alternate network paths and worker/popup APIs, and retained the explicit fetch limits.
- The network-on sandbox remains opt-in and is documented as weaker than a server-side egress firewall because a browser cannot reliably validate DNS answers before connecting.

### Backend

- Reduced Telegram initData freshness from 24 hours to one hour.
- Added duplicate-field rejection and a 16 KiB cap before signature processing.
- Preserved HMAC-SHA256 validation and constant-time digest comparison.
- Added bounded per-user rate-limit storage, a process-wide limit, periodic cleanup, and a maximum tracked-user count.
- Added JSON content-type checks, early and streamed body-size limits, request/header timeouts, outbound Telegram API timeouts, and a 50 MiB file-byte check.
- Added security headers to API responses and tightened allowed-origin parsing to exact HTTPS origins.
- Restricted /start responses to private user chats and stopped logging webhook error details.

### Quality checks and documentation

- Added built-in Node test coverage for signed Telegram data, expiry, tampering, duplicate fields, rate limits, and filenames.
- Added a GitHub Actions workflow for syntax checks and tests.
- Added SECURITY.md with deployment guidance and explicit limitations.

## Compatibility notes

- Users must re-enter their provider API key after a page reload and after changing the API endpoint. This is intentional: the key is no longer persisted in browser storage.
- Telegram Mini App data older than one hour is rejected. Reopen the Mini App from the bot to refresh it.
- The sandbox now loads a sibling HTML document. Static hosting must publish sandbox.html and sandbox-network.html alongside index.html.
- The default network-off sandbox remains isolated. Network-on sandbox is not a server-side DNS/IP firewall.

## Verification

Run:

    node --check server.js
    node --check app.js
    node --check sandbox.js
    npm test

Deployment verification still requires a real Render deployment and a Telegram Mini App session. Those external checks are not represented as completed by this code change.
