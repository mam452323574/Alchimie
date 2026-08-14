const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryDatabaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alchimie-security-hardening-'));
process.env.DB_PATH = path.join(temporaryDatabaseRoot, 'forum.sqlite3');

const botShieldModule = require('../middleware/bot-shield');
const { inspectContainer } = require('../middleware/input-guard');
const { cleanBody, formatPostBody, formatPrivateMessageBody } = require('../utils/sanitize');
const { formatBio } = require('../utils/profile');

const projectRoot = path.join(__dirname, '..');

test.after(() => {
  botShieldModule.close();
  try { require('../db/database').close(); } catch (_error) { /* déjà fermé */ }
  fs.rmSync(temporaryDatabaseRoot, { recursive: true, force: true });
});

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    status(code) { this.statusCode = code; return this; },
    set(name, value) {
      if (typeof name === 'object') Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    },
    type(value) { this.headers['Content-Type'] = value; return this; },
    send(value = '') { this.body = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

function request(target, ip = '203.0.113.9') {
  return { originalUrl: target, url: target, path: target.split('?')[0], ip, socket: {} };
}

function testFingerprint(req) {
  return crypto.createHash('sha256').update(req.ip).digest('hex').slice(0, 16);
}

test('Bot Shield recognizes high-confidence probes without flagging normal forum paths', () => {
  assert.equal(botShieldModule.classifySuspiciousPath('/wp-login.php'), 'suspicious_extension');
  assert.equal(botShieldModule.classifySuspiciousPath('/index.php/scanner'), 'suspicious_extension');
  assert.equal(botShieldModule.classifySuspiciousPath('/.git/config'), 'hidden_repository');
  assert.equal(botShieldModule.classifySuspiciousPath('/%252e%252e/etc/passwd'), 'path_traversal');
  assert.equal(botShieldModule.classifySuspiciousPath('/f/comment-installer-wordpress'), null);
  assert.equal(botShieldModule.classifySuspiciousPath('/f/cheval'), null);
  assert.equal(botShieldModule.classifySuspiciousPath('/t/42?q=%3Cscript%3E'), null);
});

test('Bot Shield escalates repeated probes, exposes only a pseudonym and supports manual unban', () => {
  let currentTime = Date.parse('2026-08-14T12:00:00Z');
  const logged = [];
  const shield = botShieldModule.createBotShield({
    now: () => currentTime,
    cleanupIntervalMs: 0,
    maxStrikes: 3,
    logSecurityEvent: (_req, event) => logged.push(event),
    sourceFingerprint: testFingerprint,
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = responseRecorder();
    shield(request(`/wp-admin/probe-${attempt}`), res, () => assert.fail('probe must not reach routes'));
    assert.equal(res.statusCode, 404);
    currentTime += 1000;
  }
  const blocked = responseRecorder();
  shield(request('/phpmyadmin/index.php'), blocked, () => assert.fail('probe must not reach routes'));
  assert.equal(blocked.statusCode, 403);
  assert.equal(shield.getStats().activeBans, 1);
  assert.equal(shield.getStats().totalProbes, 3);
  assert.ok(logged.some((event) => event.type === 'bot_ban'));

  const [source] = shield.getSourceDetails();
  assert.match(source.sourceHash, /^[a-f0-9]{16}$/);
  assert.equal(Object.hasOwn(source, 'ip'), false);
  assert.equal(shield.unbanSource(source.sourceHash), true);

  let passed = false;
  shield(request('/f/blabla'), responseRecorder(), () => { passed = true; });
  assert.equal(passed, true);
  shield.close();
});

test('Bot Shield keeps realtime presence outside flood counting', () => {
  const shield = botShieldModule.createBotShield({
    cleanupIntervalMs: 0,
    floodWarning: 60,
    floodBan: 90,
    logSecurityEvent: () => {},
    sourceFingerprint: testFingerprint,
  });
  let passed = 0;
  for (let index = 0; index < 120; index += 1) {
    shield(request('/presence'), responseRecorder(), () => { passed += 1; });
  }
  assert.equal(passed, 120);
  assert.equal(shield.getStats().totalFloodBans, 0);
  shield.close();
});

test('input guard rejects parameter pollution and injection-shaped keys but accepts forum text', () => {
  assert.equal(inspectContainer({ q: "O'Brien parle de <script>" }, 'query'), null);
  assert.equal(inspectContainer({ body: 'texte', page: '1' }, 'body'), null);
  assert.deepEqual(inspectContainer({ role: ['admin', 'member'] }, 'body'), {
    location: 'body', reason: 'ambiguous_parameter',
  });
  assert.deepEqual(inspectContainer({ '$where': '1' }, 'query'), {
    location: 'query', reason: 'parameter_name',
  });
  assert.deepEqual(inspectContainer({ constructor: 'polluted' }, 'body'), {
    location: 'body', reason: 'parameter_name',
  });
});

test('rich text renderers neutralize XSS payloads and tracking embeds', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg><animate onbegin=alert(1) attributeName=x></animate></svg>',
    '[img]javascript:alert(1)[/img]',
    '[color=#fff;background:url(javascript:alert(1))]test[/color]',
    'https://example.test/" onmouseover="alert(1)',
  ];
  for (const payload of payloads) {
    const output = formatPostBody(payload);
    assert.doesNotMatch(output, /<script|<svg|<[^>]+\son[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*javascript:/i);
  }
  assert.equal(cleanBody('<b>bonjour</b><script>alert(1)</script>'), 'bonjour');
  assert.doesNotMatch(formatBio('<img src=x onerror=alert(1)>'), /<img|<[^>]+\sonerror\s*=/i);

  const privateOutput = formatPrivateMessageBody('[img]https://tracking.example/pixel.png[/img]');
  assert.doesNotMatch(privateOutput, /<img/i);
  assert.match(privateOutput, /rel="noopener noreferrer nofollow ugc"/);
});

test('raw EJS output is limited to includes and reviewed sanitizer outputs', () => {
  const allowed = [
    /<%-\s*include\(/,
    /<%-\s*formatPostBody\(/,
    /<%-\s*formatPrivateMessageBody\(/,
    /<%-\s*formattedBio\s*\|\|/,
  ];
  const violations = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.ejs')) {
        fs.readFileSync(absolute, 'utf8').split(/\r?\n/).forEach((line, index) => {
          if (line.includes('<%-') && !allowed.some((pattern) => pattern.test(line))) {
            violations.push(`${path.relative(projectRoot, absolute)}:${index + 1}`);
          }
        });
      }
    }
  };
  visit(path.join(projectRoot, 'views'));
  assert.deepEqual(violations, []);
});

test('route SQL never interpolates request data into a statement string', () => {
  const routeDirectory = path.join(projectRoot, 'routes');
  const violations = [];
  for (const file of fs.readdirSync(routeDirectory).filter((name) => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(routeDirectory, file), 'utf8');
    if (/db\.(?:prepare|exec)\s*\(\s*`[^`]*\$\{\s*req\./.test(source)) violations.push(file);
  }
  assert.deepEqual(violations, []);
});
