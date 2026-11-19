# Security policy

## Security boundary

TG Shell is a browser application. It does not have a trusted server-side session for AI-provider API keys. The Telegram bot backend is a separate service and accepts file-send requests only after validating signed Telegram Mini App initData.

## Protections implemented

- The active AI-provider key is stored in this browser's localStorage for convenience and synced to the backend only through verified Telegram initData. The backend stores an AES-256-GCM encrypted copy. This means same-origin scripts and browser extensions with page access may read the local key. Do not use untrusted extensions or shared browser profiles; rotate the key if compromise is suspected.
- The backend validates Telegram's HMAC signature, rejects duplicate fields, caps initData at 16 KiB, and accepts signatures no older than one hour.
- Per-user requests are limited to 20 per minute, with a process-wide limit and a bounded, periodically cleaned limiter map.
- Request bodies, file sizes, HTTP headers, webhook secrets, and outbound Telegram requests have explicit limits and timeouts.
- Backend responses include no-sniff, no-referrer, frame denial, restrictive CSP, and permissions-policy headers.
- The frontend sends a restrictive CSP. JavaScript execution runs in a separate sandboxed document with an opaque origin, no same-origin permission, a dedicated MessageChannel, and a separate CSP profile for network-off and network-on modes.
- The sandbox blocks common alternate network APIs, browser storage, workers, popups, WebRTC, and credentialed/redirected fetches.

## Important limitations

- A browser-only app cannot protect a key from malware, browser extensions with broad permissions, or code execution that already has same-origin access. Do not use a high-value API key in a compromised browser profile. Rotate a key immediately if it may have leaked.
- The sandbox network-on mode is an opt-in convenience boundary, not a server-grade network firewall. Browser code can only fetch HTTPS resources that pass browser CORS, and it has request/response limits. The client cannot reliably resolve and validate every DNS answer before connecting, so do not run untrusted code with network access when private-network isolation is a hard requirement.
- CORS is not authentication. The backend authorization check is Telegram's signed initData; the CORS allowlist is an additional browser-origin restriction.
- The one-hour initData window is a replay window. Rate limits reduce abuse but do not turn Telegram initData into a per-request nonce.
- The backend rate limiter is in-memory and applies per running instance. A multi-instance production deployment should use a shared store such as Redis and platform-level request limiting.
- GitHub Pages cannot set all response headers. The frontend uses a CSP meta policy, but a custom hosting layer with configurable HTTP headers is stronger.
- GitHub uses an App with only `Contents: Read-only` and `Metadata: Read-only`; installation tokens are requested with read-only permissions. OAuth access and refresh tokens are encrypted at rest. Never commit GitHub private keys, OAuth client secrets, BOT_TOKEN, WEBHOOK_SECRET, provider API keys, or `.env` files. Keep GitHub App installation restricted to only the repositories needed.

## Deployment checklist

1. Set BOT_TOKEN only in the backend hosting provider's secret/environment settings.
2. Keep WEB_APP_URL and ALLOWED_ORIGINS on the intended HTTPS origin.
3. Keep Render and GitHub accounts protected with passkeys or two-factor authentication.
4. Enable branch protection for main, require the security workflow, and restrict who can push or deploy.
5. Rotate bot/provider credentials if they were ever committed or pasted into public issues/logs.
6. Review docs/SECURITY-UPDATE-2026-11-19.md and run npm test before deployment.

## Reporting

Do not publish working credentials or personal Telegram data in an issue. Report suspected vulnerabilities privately to the repository owner.
