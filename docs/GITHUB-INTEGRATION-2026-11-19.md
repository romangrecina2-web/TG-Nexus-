# GitHub App integration — 2026-11-19

## Goal

Connect a Telegram Mini App user to GitHub and allow the AI to inspect selected repository files. This iteration is deliberately read-only.

## Architecture

- **server.js** exposes authenticated POST endpoints under /api/github/* and a public OAuth callback at /github/callback.
- **github-integration.js** implements GitHub App OAuth, token refresh, installation lookup, repository listing, file-tree listing, and file reading.
- **bot-chat.js** provides AES-256-GCM helpers shared by provider-key storage and GitHub token storage.
- **app.js** provides the GitHub connection and repository/file selection UI.
- **index.html** contains the GitHub controls.
- **github_accounts** stores the linked GitHub account and encrypted access/refresh tokens.
- **github_oauth_states** stores a SHA-256 hash of a one-time OAuth state, the Telegram user ID, a PKCE verifier, and a 10-minute expiry.

## Authentication flow

1. Mini App sends signed Telegram.WebApp.initData to POST /api/github/connect.
2. Backend validates initData using the Telegram bot token, creates a random state and PKCE verifier, stores only the state hash, and returns a GitHub authorization URL.
3. GitHub redirects to GITHUB_CALLBACK_URL.
4. Backend atomically consumes the unexpired state, exchanges the authorization code, verifies the GitHub account via GET /user, and stores encrypted tokens against the Telegram ID recovered from the state row.
5. The UI can request /api/github/status; no GitHub token is returned to the browser.

## Permissions and repository access

Create a GitHub App with repository permissions:
- Metadata: Read-only
- Contents: Read-only

Do not grant Contents write. The App must be installed on the desired user or organization account and on the repositories that should be visible.

For repository reads, the backend:
- lists installations visible to the authenticated GitHub App user;
- verifies that the installation belongs to that user's linked GitHub account;
- creates an installation access token requesting only contents: read and metadata: read;
- verifies the requested repository is in that installation;
- reads the default branch tree and selected file contents.

Installation tokens are short-lived and are not persisted. No GitHub token is sent to frontend JavaScript.

## Implemented endpoints

All endpoints except the OAuth callback require a POST body containing a currently valid initData value.

| Endpoint | Purpose |
| --- | --- |
| POST /api/github/connect | Start OAuth and return authorization URL |
| POST /api/github/status | Return linked account, visible installations, and App install URL |
| POST /api/github/disconnect | Remove linked account, encrypted tokens, and pending OAuth states |
| POST /api/github/repositories | List repositories for an installation |
| POST /api/github/tree | List files in repository default branch |
| POST /api/github/file | Read one selected text file |
| GET /github/callback | Complete OAuth and redirect back to Mini App URL |

Unknown /api/github/* routes return 404.

## Limits

- At most 500 file entries are shown from the recursive Git tree response.
- One file can be at most 512 KiB.
- The Mini App allows up to five selected repository files per prompt.
- Directories, files returned as non-file content, and binary content containing NUL bytes are rejected.
- Tree listing currently targets the repository's default branch. An alternate branch selector is not exposed yet.

## Storage and privacy

- Provider API keys and GitHub OAuth access/refresh tokens are encrypted using AES-256-GCM with DATA_ENCRYPTION_KEY.
- Provider API keys are stored persistently only in PostgreSQL and are loaded into Mini App memory after Telegram `initData` verification. The application does not write the provider key to `localStorage`; a one-time migration moves legacy local credentials to the server after the database is available.
- The key is still visible to same-origin JavaScript while the Mini App is open because model requests are currently made directly by the browser. Keeping plaintext keys completely off the client requires a later backend proxy for provider requests.
- Telegram chat messages are stored in PostgreSQL JSONB and are **not encrypted at rest by this implementation**. Database-level encryption, access controls, backups, and retention policies remain the hosting/database operator's responsibility.
- OAuth state hashes and account tokens are not returned to the browser.
- Disconnecting GitHub deletes the linked account and pending OAuth states from the application database. It does not uninstall the GitHub App from GitHub; the user must manage installation/revocation in GitHub as well.

## Explicitly not implemented

- Writing or deleting repository files.
- Creating branches or commits, pushing, opening pull requests, or modifying issues.
- Running GitHub Actions.
- Automatically scanning every file in a repository.
- Indexing or retaining repository file contents on the backend after a read request.

Any future write operation must have its own permission design and explicit per-action user approval. Do not infer write approval from the current read-only connection.

## Required Render environment variables

Existing:
- BOT_TOKEN
- WEB_APP_URL
- ALLOWED_ORIGINS
- DATABASE_URL
- DATA_ENCRYPTION_KEY

GitHub App:
- GITHUB_APP_ID
- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET
- GITHUB_APP_PRIVATE_KEY
- GITHUB_APP_SLUG
- GITHUB_CALLBACK_URL

GITHUB_CALLBACK_URL must exactly equal the callback URL configured in the GitHub App and must use HTTPS with path /github/callback.

## Tests

Automated unit tests cover:
- AES-256-GCM encryption/decryption round-trip;
- ciphertext tamper rejection;
- repository owner/name validation;
- the 512 KiB file limit;
- existing Telegram initData validation, rate limiting, and filename sanitization.

The Node test workflow is configured to run npm test on pull requests and pushes to main or this feature branch.

Syntax compilation checks passed for server.js, bot-chat.js, github-integration.js, app.js, and the new GitHub integration test. This does not prove real PostgreSQL connectivity or a successful external OAuth flow.

## Manual acceptance checklist before deployment

1. Set up a persistent PostgreSQL database and add DATABASE_URL.
2. Generate DATA_ENCRYPTION_KEY with openssl rand -hex 32; keep a secure backup.
3. Create the GitHub App with only Metadata read and Contents read permissions.
4. Set the exact callback URL and all six GITHUB_* values in Render.
5. Deploy the backend and check /health.
6. Open Mini App, connect GitHub, authorize the app, and install it on a test repository.
7. Verify the test repository appears, load its tree, and attach one small text file to an AI prompt.
8. Confirm private repositories not granted to the installation are not listed.
9. Confirm no write controls or write endpoints exist in this release.
10. Run the CI workflow and verify its conclusion before marking the PR ready for review.
