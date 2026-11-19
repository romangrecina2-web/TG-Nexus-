# Bot storage setup and troubleshooting

This guide applies to the Telegram AI backend in the `snapshot/current-main-before-restore-2026-11-19` code line.

## Required Render variables

Set both variables on the **web service** `tg-shell-bot-api`, not only on the PostgreSQL database resource:

- `DATABASE_URL`: the connection string for the PostgreSQL database. For a database hosted in the same Render region, use its internal connection string.
- `DATA_ENCRYPTION_KEY`: exactly 64 hexadecimal characters (32 random bytes). Generate it with `openssl rand -hex 32`.

The repository's `render.yaml` declares both variables as `sync: false`; this reserves the variable names but does not create a PostgreSQL database or fill in either value. The Blueprint currently defines only the web service. Create or attach the database separately and copy its connection string into the web service's `DATABASE_URL`.

Keep `DATA_ENCRYPTION_KEY` stable and back it up securely. Replacing it after credentials have been encrypted prevents the application from decrypting those existing credentials.

## After changing environment variables

Redeploy or restart the Render web service. The PostgreSQL pool is created when Node.js loads `bot-chat.js`; adding `DATABASE_URL` after that point cannot create a pool inside the already-running process.

## What the error messages mean

- `DATABASE_URL` missing: the backend web service does not have the database connection string.
- PostgreSQL pool not initialized: the process started before `DATABASE_URL` was present; restart or redeploy the web service.
- `DATA_ENCRYPTION_KEY` invalid: provide 64 hexadecimal characters, not an arbitrary password or a 32-character key.
- PostgreSQL connection/query failure: check that the database is available, the connection string belongs to the intended database, and Render logs show no connection rejection.

The backend health endpoint currently confirms only that the HTTP server is running. An `/health` response of `ok: true` does not prove that PostgreSQL storage is ready.

Never paste `DATABASE_URL`, `DATA_ENCRYPTION_KEY`, Telegram bot tokens, or provider API keys into GitHub issues or this chat.
