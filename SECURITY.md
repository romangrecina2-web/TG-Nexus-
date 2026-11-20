# Security policy

## Security boundary

TG Shell is a browser application. The Mini App uses Telegram's signed initData to authenticate with its backend. The Mini App can call an OpenAI-compatible provider directly from the browser, while the Telegram bot uses a per-user API key stored in the backend's encrypted AES-256-GCM store.

## Protections implemented

- Mini App AI-provider keys are saved only after a successful provider test in Telegram SecureStorage when the Telegram client supports it. The local record is bound to the API endpoint and is not stored in localStorage, chat exports, or GitHub. For Telegram-bot access, the key can be sent over HTTPS through `/api/sync` after HMAC validation of Telegram initData; the backend verifies the provider key and stores it in the existing AES-256-GCM encrypted store. A sync pull returns the key only to the same authenticated Telegram user. If local SecureStorage is unavailable, the browser keeps the key in memory only.
- The backend validates Telegram's HMAC signature, rejects duplicate fields, caps initData at 16 KiB, and accepts signatures no older than one hour.
- The `/api/sync` endpoint requires signed Telegram initData, checks the configured browser-origin allowlist, caps request bodies, and rate-limits per-user sync calls. It only reads or changes the authenticated user's encrypted settings and chat data.
- Per-user requests are limited to 20 per minute, with a process-wide limit and a bounded, periodically cleaned limiter map.
- Request bodies, file sizes, HTTP headers, webhook secrets, and outbound Telegram requests have explicit limits and timeouts.
- Telegram updates are written to an encrypted queue, deduplicated by update ID, processed in order per user, and retried with bounded backoff. Replies use an encrypted outbox so a delivery retry does not intentionally repeat the command or paid model call.
- The encrypted file store writes through a temporary file and atomic rename, preserves one previous encrypted snapshot, and can recover from that snapshot if the primary file is corrupt.
- Backend responses include no-sniff, no-referrer, frame denial, restrictive CSP, and permissions-policy headers.
- The frontend sends a restrictive CSP. JavaScript execution runs in a separate sandboxed document with an opaque origin, no same-origin permission, a dedicated MessageChannel, and a separate CSP profile for network-off and network-on modes.
- The sandbox blocks common alternate network APIs, browser storage, workers, popups, WebRTC, and credentialed/redirected fetches.

## Important limitations

- A browser-only app cannot protect a key from malware, browser extensions with broad permissions, or code execution that already has same-origin access. Do not use a high-value API key in a compromised browser profile. Rotate a key immediately if it may have leaked.
- The sandbox network-on mode is an opt-in convenience boundary, not a server-grade network firewall. Browser code can only fetch HTTPS resources that pass browser CORS, and it has request/response limits. The client cannot reliably resolve and validate every DNS answer before connecting, so do not run untrusted code with network access when private-network isolation is a hard requirement.
- CORS is not authentication. The backend authorization check is Telegram's signed initData; the CORS allowlist is an additional browser-origin restriction.
- The one-hour initData window is a replay window. Rate limits reduce abuse but do not turn Telegram initData into a per-request nonce.
- The backend rate limiter is in-memory and applies per running instance. A multi-instance production deployment should use a shared store such as Redis and platform-level request limiting.
- The update queue and encrypted snapshot are stored in the service filesystem. They survive process restarts only when the host preserves that filesystem; Render Free filesystems are ephemeral, so use a persistent disk or external database before relying on this queue for deploy-to-deploy durability. The current Free service configuration does not provision either.
- GitHub Pages cannot set all response headers. The frontend uses a CSP meta policy, but a custom hosting layer with configurable HTTP headers is stronger.
- GitHub repository permissions, branch protection, secret scanning, and deployment secrets must also be configured in GitHub/Render. Never commit BOT_TOKEN, WEBHOOK_SECRET, provider API keys, or .env files.

## Deployment checklist

1. Set BOT_TOKEN only in the backend hosting provider's secret/environment settings.
2. Keep WEB_APP_URL and ALLOWED_ORIGINS on the intended HTTPS origin.
3. Keep Render and GitHub accounts protected with passkeys or two-factor authentication.
4. Enable branch protection for main, require the security workflow, and restrict who can push or deploy.
5. Rotate bot/provider credentials if they were ever committed or pasted into public issues/logs.
6. Review docs/SECURITY-UPDATE-2026-11-19.md and run npm test before deployment.

## Reporting

Do not publish working credentials or personal Telegram data in an issue. Report suspected vulnerabilities privately to the repository owner.
