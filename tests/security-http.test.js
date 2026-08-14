const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { spawn } = require('child_process');
const sharp = require('sharp');

const projectRoot = path.join(__dirname, '..');

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function csrfFrom(html) {
  const token = html.match(/name="csrf_token" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(token, 'un jeton CSRF doit être rendu');
  return token;
}

function createBrowser(baseUrl, sourceIp) {
  const cookies = new Map();
  function storeCookies(headers) {
    const values = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  return async (pathname, options = {}) => {
    const headers = new Headers(options.headers || {});
    headers.set('X-Forwarded-For', sourceIp);
    if (cookies.size) headers.set('Cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    if (options.method && options.method !== 'GET' && options.method !== 'HEAD' && !headers.has('Origin')) {
      headers.set('Origin', baseUrl);
    }
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers, redirect: 'manual' });
    storeCookies(response.headers);
    return response;
  };
}

test('admin Bot Shield, input guard and hardened upload work through the real HTTP stack', { timeout: 40_000 }, async (context) => {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alchimie-security-http-'));
  const uploadDirectory = path.join(temporaryRoot, 'uploads');
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DB_PATH: path.join(temporaryRoot, 'forum.sqlite3'),
      SESSION_DB_PATH: path.join(temporaryRoot, 'sessions.sqlite3'),
      UPLOAD_DIR: uploadDirectory,
      HOST: '127.0.0.1',
      PORT: String(port),
      SITE_URL: baseUrl,
      NODE_ENV: 'development',
      TRUST_PROXY: 'loopback',
      SESSION_SECRET: 'security-http-session-secret-0123456789abcdefghijklmnopqrstuvwxyz',
      SECURITY_LOG_KEY: '18f4f404eb7f51408eed29106a4d36d5a28e6922c542201fed9a9be32d5f856b',
      DATA_ENCRYPTION_KEY: '7b0a87cc2393d8f42c8cffc4820017a48f039702a380c06438a59ee4b1add54f',
      ADMIN_USERNAME: 'admin',
      ADMIN_EMAIL: 'admin@example.test',
      ADMIN_PASSWORD: 'Local-Only-Admin-Password-987654321',
      MODERATION_PASSWORD: 'Local-Only-Moderation-Password-987654321',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  context.after(async () => {
    await stopServer(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const diagnostics = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;

  const admin = createBrowser(baseUrl, '198.51.100.25');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) assert.fail(`serveur arrêté prématurément\n${diagnostics()}`);
    try {
      const response = await admin('/connexion');
      if (response.status === 200) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (attempt === 99) assert.fail(`serveur indisponible\n${diagnostics()}`);
  }

  let response = await admin('/connexion');
  let token = csrfFrom(await response.text());
  response = await admin('/connexion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf_token: token,
      username: 'admin',
      password: 'Local-Only-Admin-Password-987654321',
    }),
  });
  assert.equal(response.status, 302, diagnostics());

  response = await admin('/admin/connexion?return_to=%2Fadmin%2Fsecurite');
  token = csrfFrom(await response.text());
  response = await admin('/admin/connexion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf_token: token,
      return_to: '/admin/securite',
      password: 'Local-Only-Moderation-Password-987654321',
    }),
  });
  assert.equal(response.status, 302, diagnostics());

  response = await admin('/admin/securite');
  const dashboard = await response.text();
  assert.equal(response.status, 200, diagnostics());
  assert.match(dashboard, /Bot Shield & sécurité/);
  assert.match(dashboard, /Protection temps réel/);
  assert.match(dashboard, />Actif</);
  token = csrfFrom(dashboard);

  const marker = Buffer.from('<script>alert(1)</script>');
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: '#4477aa' },
  }).png().toBuffer();
  response = await admin('/api/images', {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-CSRF-Token': token,
      'X-File-Name': 'preuve.png',
    },
    body: Buffer.concat([png, marker]),
  });
  assert.equal(response.status, 201, diagnostics());
  const upload = await response.json();
  assert.match(upload.url, /^\/media\/[a-f0-9]{48}$/);
  assert.equal(upload.mime, 'image/webp');

  response = await admin(upload.url);
  const stored = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, diagnostics());
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(stored.includes(marker), false);

  response = await admin('/admin/securite?periode=day&periode=week');
  assert.equal(response.status, 400);

  const scanner = createBrowser(baseUrl, '203.0.113.77');
  for (let strike = 1; strike <= 4; strike += 1) {
    response = await scanner(`/wp-admin/probe-${strike}`);
    assert.equal(response.status, 404);
  }
  response = await scanner('/wp-admin/probe-5');
  assert.equal(response.status, 403);
  response = await scanner('/f/blabla');
  assert.equal(response.status, 403);

  response = await admin('/admin/securite');
  assert.equal(response.status, 200, diagnostics());
  assert.match(await response.text(), /1 source bloquée/);
});
