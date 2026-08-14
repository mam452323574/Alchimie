const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');

async function getAvailablePort() {
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
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForServer(url, child, diagnostics) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Le serveur a quitté prématurément.\n${diagnostics()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_error) {
      // Le port n'écoute pas encore.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Le serveur local n'a pas démarré.\n${diagnostics()}`);
}

test('renders the forum from a completely empty installation', { timeout: 25_000 }, async (context) => {
  const port = await getAvailablePort();
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DB_PATH: ':memory:',
      SESSION_DB_PATH: ':memory:',
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'development',
      SESSION_SECRET: 'local-integration-only-session-secret-0123456789',
      ADMIN_PASSWORD: 'Local-Only-Admin-Password-987654321',
      MODERATION_PASSWORD: 'Local-Only-Moderation-Password-987654321',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  context.after(() => stopServer(child));
  const diagnostics = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
  const baseUrl = `http://127.0.0.1:${port}`;

  await waitForServer(`${baseUrl}/`, child, diagnostics);

  const forumResponse = await fetch(`${baseUrl}/f/blabla`);
  const forumBody = await forumResponse.text();
  assert.equal(forumResponse.status, 200, diagnostics());
  assert.match(forumBody, /<h1>Blabla<\/h1>/);

  const redirectResponse = await fetch(`${baseUrl}/forum?q=bonjour`, { redirect: 'manual' });
  assert.equal(redirectResponse.status, 302, diagnostics());
  assert.equal(redirectResponse.headers.get('location'), '/f/blabla?q=bonjour&scope=title');
});
