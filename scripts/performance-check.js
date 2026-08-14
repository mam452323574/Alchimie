process.umask(0o077);
require('dotenv').config({ quiet: true });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

const projectRoot = path.join(__dirname, '..');
let temporaryAuditRoot = '';
const configuredDatabasePath = process.env.DB_PATH || path.join(projectRoot, 'db', 'forum.sqlite3');
if (!fs.existsSync(configuredDatabasePath)) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`Base de production absente : ${configuredDatabasePath}`);
  }
  temporaryAuditRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alchimie-performance-check-'));
  process.env.DB_PATH = path.join(temporaryAuditRoot, 'forum.sqlite3');
}

const db = require('../db/database');

const failures = [];
const pass = (label) => console.log(`OK  ${label}`);
const fail = (label) => { failures.push(label); console.error(`KO  ${label}`); };
const p95BudgetMs = Math.max(1, Number(process.env.DB_P95_BUDGET_MS) || 25);

const forumId = db.prepare('SELECT id FROM forums ORDER BY id LIMIT 1').get()?.id || 1;
const threadId = db.prepare('SELECT id FROM threads ORDER BY id LIMIT 1').get()?.id || 1;
const userId = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || 1;

const checks = [
  {
    name: 'liste des topics',
    statement: db.prepare(
      `SELECT threads.id, threads.title, users.username
       FROM threads JOIN users ON users.id = threads.user_id
       WHERE threads.forum_id = ? AND threads.deleted_at IS NULL
       ORDER BY threads.is_pinned DESC, threads.last_post_at DESC LIMIT 20`
    ),
    params: [forumId],
    explain: db.prepare(
      `EXPLAIN QUERY PLAN SELECT threads.id FROM threads
       WHERE threads.forum_id = ? AND threads.deleted_at IS NULL
       ORDER BY threads.is_pinned DESC, threads.last_post_at DESC LIMIT 20`
    ),
    requiredIndex: 'idx_threads_forum_listing',
  },
  {
    name: 'page de messages',
    statement: db.prepare(
      `SELECT posts.id, posts.body, users.username
       FROM posts JOIN users ON users.id = posts.user_id
       WHERE posts.thread_id = ? AND posts.deleted_at IS NULL
       ORDER BY posts.id ASC LIMIT 20 OFFSET 0`
    ),
    params: [threadId],
    explain: db.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM posts
       WHERE thread_id = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT 20`
    ),
    requiredIndex: 'idx_posts_thread_deleted',
  },
  {
    name: 'anti-spam du membre',
    statement: db.prepare(
      `SELECT created_at FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
    ),
    params: [userId],
    explain: db.prepare(
      `EXPLAIN QUERY PLAN SELECT created_at FROM posts
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
    ),
    requiredIndex: 'idx_posts_user_created',
  },
];

for (const check of checks) {
  const plan = check.explain.all(...check.params).map((row) => row.detail).join(' | ');
  if (plan.includes(check.requiredIndex)) pass(`${check.name} utilise ${check.requiredIndex}`);
  else fail(`${check.name} n'utilise pas ${check.requiredIndex} (${plan})`);

  for (let index = 0; index < 20; index += 1) check.statement.all(...check.params);
  const timings = [];
  for (let index = 0; index < 300; index += 1) {
    const startedAt = performance.now();
    check.statement.all(...check.params);
    timings.push(performance.now() - startedAt);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length * 0.50)];
  const p95 = timings[Math.floor(timings.length * 0.95)];
  console.log(`    p50=${p50.toFixed(3)} ms, p95=${p95.toFixed(3)} ms`);
  if (p95 <= p95BudgetMs) pass(`${check.name} sous le budget p95 de ${p95BudgetMs} ms`);
  else fail(`${check.name} dépasse le budget p95 (${p95.toFixed(3)} ms)`);
}

db.pragma('optimize');
db.close();
if (temporaryAuditRoot) fs.rmSync(temporaryAuditRoot, { recursive: true, force: true });
if (failures.length) {
  console.error(`${failures.length} contrôle(s) de performance en échec.`);
  process.exitCode = 1;
} else console.log('Tous les contrôles de performance sont validés.');
