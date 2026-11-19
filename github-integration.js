'use strict';

const crypto = require('node:crypto');
const botChat = require('./bot-chat');
const pool = botChat.pool;
const API_VERSION = '2026-03-10';
const MAX_TREE_ENTRIES = 500;
const MAX_FILE_BYTES = 512 * 1024;

function config() {
  const c = {
    appId: String(process.env.GITHUB_APP_ID || '').trim(),
    clientId: String(process.env.GITHUB_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GITHUB_CLIENT_SECRET || '').trim(),
    privateKey: String(process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    slug: String(process.env.GITHUB_APP_SLUG || '').trim(),
    callbackUrl: String(process.env.GITHUB_CALLBACK_URL || '').trim()
  };
  if (!c.appId || !c.clientId || !c.clientSecret || !c.privateKey || !c.slug || !c.callbackUrl) {
    throw new Error('GitHub App не настроен: проверьте GITHUB_APP_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_SLUG и GITHUB_CALLBACK_URL.');
  }
  const callback = new URL(c.callbackUrl);
  if (callback.protocol !== 'https:' || callback.pathname !== '/github/callback' || callback.search || callback.hash) {
    throw new Error('GITHUB_CALLBACK_URL должен быть HTTPS-адресом с путём /github/callback без query и hash.');
  }
  if (!/^[A-Za-z0-9-]{1,100}$/.test(c.slug) || !/^[0-9]{1,30}$/.test(c.appId)) {
    throw new Error('Некорректные GITHUB_APP_SLUG или GITHUB_APP_ID.');
  }
  return c;
}

function requirePool() {
  if (!pool) throw new Error('Для GitHub-интеграции нужна DATABASE_URL с PostgreSQL.');
}

async function init() {
  if (!pool) return false;
  await pool.query(
    'CREATE TABLE IF NOT EXISTS github_oauth_states (' +
    'state_hash TEXT PRIMARY KEY, telegram_id BIGINT NOT NULL, code_verifier TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS github_oauth_states_expiry ON github_oauth_states(expires_at);' +
    'CREATE TABLE IF NOT EXISTS github_accounts (' +
    'telegram_id BIGINT PRIMARY KEY, github_user_id BIGINT NOT NULL, github_login TEXT NOT NULL,' +
    'access_token_enc TEXT NOT NULL, refresh_token_enc TEXT, access_expires_at TIMESTAMPTZ,' +
    'refresh_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());'
  );
  return true;
}

function randomToken(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function challenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function beginOAuth(telegramId) {
  requirePool();
  const c = config();
  const state = randomToken(32);
  const verifier = randomToken(48);
  await pool.query('DELETE FROM github_oauth_states WHERE expires_at <= NOW()');
  await pool.query(
    "INSERT INTO github_oauth_states(state_hash,telegram_id,code_verifier,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')",
    [hash(state), String(telegramId), verifier]
  );
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', c.callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

async function githubFetch(path, token, options) {
  const opts = options || {};
  const response = await fetch('https://api.github.com' + path, {
    method: opts.method || 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'x-github-api-version': API_VERSION,
      'content-type': 'application/json',
      'user-agent': 'TG-Shell-GitHub-Integration'
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeout || 20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error('GitHub API (' + response.status + '): ' + String(payload.message || 'ошибка запроса').slice(0, 200));
    err.status = response.status;
    throw err;
  }
  return payload;
}

async function exchangeCode(code, verifier) {
  const c = config();
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: c.clientId, client_secret: c.clientSecret, code: code,
      redirect_uri: c.callbackUrl, code_verifier: verifier
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || !data.access_token) {
    throw new Error('GitHub не завершил авторизацию: ' + String(data.error_description || data.error || 'токен не получен').slice(0, 200));
  }
  return data;
}

async function handleCallback(code, state) {
  requirePool();
  if (typeof code !== 'string' || !/^[A-Za-z0-9._-]{10,300}$/.test(code) ||
      typeof state !== 'string' || !/^[A-Za-z0-9_-]{30,100}$/.test(state)) {
    throw new Error('Некорректный ответ OAuth.');
  }
  const stateRow = await pool.query(
    'DELETE FROM github_oauth_states WHERE state_hash=$1 AND expires_at > NOW() RETURNING telegram_id,code_verifier',
    [hash(state)]
  );
  if (!stateRow.rowCount) throw new Error('Ссылка авторизации истекла или уже использована. Подключите GitHub заново.');
  const token = await exchangeCode(code, stateRow.rows[0].code_verifier);
  const user = await githubFetch('/user', token.access_token);
  if (!Number.isSafeInteger(Number(user.id)) || !/^[A-Za-z0-9-]{1,39}$/.test(String(user.login || ''))) {
    throw new Error('GitHub вернул некорректные данные пользователя.');
  }
  const accessExpires = Number.isFinite(Number(token.expires_in))
    ? new Date(Date.now() + Number(token.expires_in) * 1000) : null;
  const refreshExpires = Number.isFinite(Number(token.refresh_token_expires_in))
    ? new Date(Date.now() + Number(token.refresh_token_expires_in) * 1000) : null;
  await pool.query(
    'INSERT INTO github_accounts(telegram_id,github_user_id,github_login,access_token_enc,refresh_token_enc,access_expires_at,refresh_expires_at,updated_at) ' +
    'VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(telegram_id) DO UPDATE SET ' +
    'github_user_id=EXCLUDED.github_user_id,github_login=EXCLUDED.github_login,access_token_enc=EXCLUDED.access_token_enc,' +
    'refresh_token_enc=EXCLUDED.refresh_token_enc,access_expires_at=EXCLUDED.access_expires_at,' +
    'refresh_expires_at=EXCLUDED.refresh_expires_at,updated_at=NOW()',
    [
      String(stateRow.rows[0].telegram_id), String(user.id), user.login,
      botChat.encrypt(token.access_token),
      token.refresh_token ? botChat.encrypt(token.refresh_token) : null,
      accessExpires, refreshExpires
    ]
  );
  return { telegramId: String(stateRow.rows[0].telegram_id), login: user.login };
}

async function getAccount(telegramId) {
  requirePool();
  const r = await pool.query('SELECT * FROM github_accounts WHERE telegram_id=$1', [String(telegramId)]);
  return r.rows[0] || null;
}

async function getUserToken(telegramId) {
  const account = await getAccount(telegramId);
  if (!account) throw new Error('Сначала подключите GitHub.');
  const expires = account.access_expires_at ? new Date(account.access_expires_at).getTime() : 0;
  if (!expires || expires > Date.now() + 90000) return { account: account, token: botChat.decrypt(account.access_token_enc) };
  if (!account.refresh_token_enc) throw new Error('Срок действия GitHub-токена истёк. Подключите GitHub заново.');
  const refreshTokenExpires = account.refresh_expires_at ? new Date(account.refresh_expires_at).getTime() : 0;
  if (refreshTokenExpires && refreshTokenExpires <= Date.now()) throw new Error('Срок действия GitHub refresh-токена истёк. Подключите GitHub заново.');
  const c = config();
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token',
      refresh_token: botChat.decrypt(account.refresh_token_enc)
    }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || !data.access_token) throw new Error('Не удалось обновить GitHub-токен. Подключите GitHub заново.');
  const accessExpires = Number.isFinite(Number(data.expires_in)) ? new Date(Date.now() + Number(data.expires_in) * 1000) : null;
  const refreshExpires = Number.isFinite(Number(data.refresh_token_expires_in)) ? new Date(Date.now() + Number(data.refresh_token_expires_in) * 1000) : null;
  await pool.query(
    'UPDATE github_accounts SET access_token_enc=$2,refresh_token_enc=$3,access_expires_at=$4,refresh_expires_at=$5,updated_at=NOW() WHERE telegram_id=$1',
    [
      String(telegramId), botChat.encrypt(data.access_token),
      data.refresh_token ? botChat.encrypt(data.refresh_token) : account.refresh_token_enc,
      accessExpires, refreshExpires
    ]
  );
  return { account: account, token: data.access_token };
}

function appJwt() {
  const c = config();
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 480, iss: c.appId })).toString('base64url');
  const input = head + '.' + body;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return input + '.' + signer.sign(c.privateKey, 'base64url');
}

async function appApi(path, jwt, method, body) {
  const response = await fetch('https://api.github.com' + path, {
    method: method || 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + jwt,
      'x-github-api-version': API_VERSION,
      'content-type': 'application/json',
      'user-agent': 'TG-Shell-GitHub-Integration'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('GitHub App API (' + response.status + '): ' + String(data.message || 'ошибка').slice(0, 200));
  return data;
}

async function listInstallations(telegramId) {
  const token = (await getUserToken(telegramId)).token;
  const rows = [];
  for (let page = 1; page <= 5; page++) {
    const data = await githubFetch('/user/installations?per_page=100&page=' + page, token);
    const items = Array.isArray(data.installations) ? data.installations : [];
    rows.push.apply(rows, items);
    if (items.length < 100) break;
  }
  return rows.map(function (item) {
    return {
      id: Number(item.id),
      account: item.account && item.account.login || 'unknown',
      targetType: item.target_type || 'User',
      repositorySelection: item.repository_selection || 'selected',
      permissions: item.permissions || {}
    };
  }).filter(function (item) { return Number.isSafeInteger(item.id) && item.id > 0; });
}

async function installationToken(telegramId, installationId) {
  const installs = await listInstallations(telegramId);
  const installation = installs.find(function (item) { return item.id === Number(installationId); });
  if (!installation) throw new Error('Установка GitHub App недоступна подключённому аккаунту.');
  if (installation.permissions.contents !== 'read' || installation.permissions.metadata !== 'read') {
    throw new Error('В GitHub App нужны только Metadata: Read-only и Contents: Read-only.');
  }
  const c = config();
  const jwt = appJwt();
  const data = await appApi('/app/installations/' + installation.id + '/access_tokens', jwt, 'POST', {
    permissions: { contents: 'read', metadata: 'read' }
  });
  if (!data.token) throw new Error('GitHub не выдал временный токен установки.');
  return data.token;
}

function validateRepo(owner, repo) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(owner) ||
      typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new Error('Некорректное имя репозитория.');
  }
}

async function listRepositories(telegramId, installationId) {
  const token = await installationToken(telegramId, installationId);
  const rows = [];
  for (let page = 1; page <= 5; page++) {
    const data = await githubFetch('/installation/repositories?per_page=100&page=' + page, token);
    const items = Array.isArray(data.repositories) ? data.repositories : [];
    rows.push.apply(rows, items);
    if (items.length < 100) break;
  }
  return rows.map(function (r) {
    return {
      id: Number(r.id), fullName: r.full_name, owner: r.owner && r.owner.login || '',
      name: r.name, private: !!r.private, defaultBranch: r.default_branch || 'main',
      htmlUrl: r.html_url || ''
    };
  }).filter(function (r) { return Number.isSafeInteger(r.id) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r.fullName || ''); });
}

async function findRepo(telegramId, installationId, owner, repo) {
  validateRepo(owner, repo);
  const repos = await listRepositories(telegramId, installationId);
  const found = repos.find(function (r) { return r.fullName.toLowerCase() === (owner + '/' + repo).toLowerCase(); });
  if (!found) throw new Error('Репозиторий не выбран в установке GitHub App.');
  return found;
}

async function listTree(telegramId, installationId, owner, repo) {
  const info = await findRepo(telegramId, installationId, owner, repo);
  const token = await installationToken(telegramId, installationId);
  const base = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
  const commit = await githubFetch(base + '/commits/' + encodeURIComponent(info.defaultBranch), token);
  const treeSha = commit && commit.commit && commit.commit.tree && commit.commit.tree.sha;
  if (!treeSha) throw new Error('GitHub не вернул дерево репозитория.');
  const data = await githubFetch(base + '/git/trees/' + encodeURIComponent(treeSha) + '?recursive=1', token);
  const all = Array.isArray(data.tree) ? data.tree : [];
  const files = all.filter(function (entry) { return entry.type === 'blob'; }).slice(0, MAX_TREE_ENTRIES).map(function (entry) {
    return { path: entry.path, size: Number(entry.size) || 0, tooLarge: Number(entry.size) > MAX_FILE_BYTES };
  });
  return { defaultBranch: info.defaultBranch, files: files, truncated: !!data.truncated || all.length > MAX_TREE_ENTRIES };
}

async function readFile(telegramId, installationId, owner, repo, path, ref) {
  await findRepo(telegramId, installationId, owner, repo);
  if (typeof path !== 'string' || !path || path.length > 500 || path.charAt(0) === '/' ||
      path.split('/').some(function (part) { return !part || part === '.' || part === '..'; })) {
    throw new Error('Некорректный путь к файлу.');
  }
  const token = await installationToken(telegramId, installationId);
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  let endpoint = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/' + encoded;
  if (typeof ref === 'string' && ref.length <= 200) endpoint += '?ref=' + encodeURIComponent(ref);
  const data = await githubFetch(endpoint, token);
  if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
    throw new Error('Выбранный путь не является отдельным файлом.');
  }
  if (Number(data.size) > MAX_FILE_BYTES) throw new Error('Файл превышает лимит 512 КБ.');
  if (data.encoding !== 'base64') throw new Error('GitHub вернул неподдерживаемый формат файла.');
  const content = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
  if (content.indexOf('\u0000') >= 0) throw new Error('Бинарные файлы нельзя прикрепить к текстовому запросу ИИ.');
  return { path: path, name: path.split('/').pop(), content: content, size: Buffer.byteLength(content, 'utf8'), sha: data.sha };
}

async function getStatus(telegramId) {
  const account = await getAccount(telegramId);
  if (!account) return { connected: false, login: '', installations: [], installUrl: '' };
  const installs = await listInstallations(telegramId);
  const c = config();
  return {
    connected: true, login: account.github_login, installations: installs,
    installUrl: 'https://github.com/apps/' + c.slug + '/installations/new'
  };
}

async function disconnect(telegramId) {
  requirePool();
  await pool.query('DELETE FROM github_oauth_states WHERE telegram_id=$1', [String(telegramId)]);
  await pool.query('DELETE FROM github_accounts WHERE telegram_id=$1', [String(telegramId)]);
  return true;
}

module.exports = {
  init: init,
  beginOAuth: beginOAuth,
  handleCallback: handleCallback,
  getStatus: getStatus,
  listRepositories: listRepositories,
  listTree: listTree,
  readFile: readFile,
  disconnect: disconnect,
  config: config,
  MAX_FILE_BYTES: MAX_FILE_BYTES
};

async function init() {
  if (!pool) return false;
  await pool.query(
    'CREATE TABLE IF NOT EXISTS github_oauth_states (' +
    'state_hash TEXT PRIMARY KEY, telegram_id BIGINT NOT NULL, code_verifier TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS github_oauth_states_expiry ON github_oauth_states(expires_at);' +
    'CREATE TABLE IF NOT EXISTS github_accounts (' +
    'telegram_id BIGINT PRIMARY KEY, github_user_id BIGINT NOT NULL, github_login TEXT NOT NULL,' +
    'access_token_enc TEXT NOT NULL, refresh_token_enc TEXT, access_expires_at TIMESTAMPTZ,' +
    'refresh_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());'
  );
  return true;
}
