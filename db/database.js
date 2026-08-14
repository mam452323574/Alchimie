process.umask(0o077);

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { hashPasswordSync, passwordValidationError, verifyPasswordSync } = require('../utils/passwords');
const { isPlaceholder } = require('../utils/config');
const { ensureCoreStructure } = require('./core-structure');
const {
  encryptionEnabled, protectEmail, revealEmail, protectPrivateMessage,
} = require('../utils/encryption');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'forum.sqlite3');
fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.pragma('trusted_schema = OFF');
for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); } catch (_error) { /* système sans chmod */ }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT,
  email_lookup_hash TEXT,
  email_verified_at TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  signature TEXT DEFAULT '',
  avatar_color TEXT DEFAULT '#6f91bd',
  avatar_url TEXT DEFAULT '',
  profile_bg_url TEXT DEFAULT '',
  youtube_url TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  session_version INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE,
  email TEXT NOT NULL COLLATE NOCASE,
  email_lookup_hash TEXT,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS forums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  slug TEXT UNIQUE NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  thread_count INTEGER NOT NULL DEFAULT 0,
  post_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forum_id INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  is_black INTEGER NOT NULL DEFAULT 0,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_locked INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  post_count INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id),
  deletion_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_post_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reply_to_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id),
  deletion_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT
);

CREATE TABLE IF NOT EXISTS sanctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('ban', 'exclusion')),
  is_eradication INTEGER NOT NULL DEFAULT 0,
  reason TEXT DEFAULT '',
  starts_at TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at TEXT,
  issued_by INTEGER NOT NULL REFERENCES users(id),
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER UNIQUE NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS poll_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (poll_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'reply' CHECK(type = 'reply'),
  post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thread_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  last_read_post_id INTEGER NOT NULL DEFAULT 0,
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, thread_id)
);

CREATE TABLE IF NOT EXISTS thread_follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, thread_id)
);

CREATE TABLE IF NOT EXISTS online_presence (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS private_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS private_conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES private_conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS private_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES private_conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS uploaded_images (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_name TEXT UNIQUE NOT NULL,
  original_name TEXT NOT NULL DEFAULT 'image',
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'private_pending', 'private')),
  conversation_id INTEGER REFERENCES private_conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical')),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_hash TEXT DEFAULT '',
  path TEXT DEFAULT '',
  method TEXT DEFAULT '',
  status_code INTEGER,
  details TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Les comptes et contenus restent privés et ne sont jamais amorcés ici. En
// revanche, une installation sans aucun forum doit rester navigable : on crée
// uniquement la structure publique minimale, de manière idempotente.
const coreStructure = ensureCoreStructure(db);
if (coreStructure.created) {
  console.log(`[init] Forum principal créé : /f/${coreStructure.forum.slug}`);
}

// Second verrou partagé pour les outils sensibles. La valeur initiale reste
// volontairement simple pour la première connexion et doit être remplacée par
// un développeur depuis le centre de contrôle.
const moderationPasswordSetting = db.prepare(
  "SELECT value FROM site_settings WHERE key = 'moderation_password_hash'"
).get();
if (!moderationPasswordSetting) {
  const initialModerationPassword = process.env.MODERATION_PASSWORD || '1234';
  db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?)').run(
    'moderation_password_hash',
    hashPasswordSync(initialModerationPassword)
  );
}
db.prepare(
  `INSERT OR IGNORE INTO site_settings (key, value) VALUES ('unread_tracking_started_at', datetime('now'))`
).run();
const moderationPasswordHash = db.prepare(
  "SELECT value FROM site_settings WHERE key = 'moderation_password_hash'"
).get()?.value || '';
if (process.env.NODE_ENV === 'production' && verifyPasswordSync('1234', moderationPasswordHash)) {
  throw new Error('Démarrage refusé : le mot de passe initial 1234 du centre de contrôle est encore actif.');
}

// Migrations non destructives pour les installations existantes.
function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}
if (!hasColumn('notifications', 'kind')) {
  db.exec("ALTER TABLE notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply'");
}

const userMigrations = [
  ['email_verified_at', 'TEXT'],
  ['email_lookup_hash', 'TEXT'],
  ['avatar_url', "TEXT DEFAULT ''"],
  ['profile_bg_url', "TEXT DEFAULT ''"],
  ['youtube_url', "TEXT DEFAULT ''"],
  ['bio', "TEXT DEFAULT ''"],
  ['last_login_at', 'TEXT'],
  ['session_version', 'INTEGER NOT NULL DEFAULT 0'],
];
let pointsColumnAdded = false;
for (const [column, definition] of userMigrations) {
  if (!hasColumn('users', column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
}
if (!hasColumn('users', 'points')) {
  db.exec('ALTER TABLE users ADD COLUMN points INTEGER NOT NULL DEFAULT 0');
  pointsColumnAdded = true;
}
// Une installation existante démarre avec un solde cohérent : +2 par topic
// visible et +1 par réponse visible. Le message initial est inclus dans les
// deux points du topic et n'est donc pas compté une seconde fois.
if (pointsColumnAdded) {
  db.exec(`
    UPDATE users SET points =
      2 * (SELECT COUNT(*) FROM threads
           WHERE threads.user_id = users.id AND threads.deleted_at IS NULL)
      + (SELECT COUNT(*)
         FROM posts
         JOIN threads ON threads.id = posts.thread_id
         WHERE posts.user_id = users.id
           AND posts.deleted_at IS NULL
           AND threads.deleted_at IS NULL
           AND posts.id != (SELECT MIN(first_post.id) FROM posts first_post
                            WHERE first_post.thread_id = posts.thread_id));

    UPDATE users SET avatar_url = ''
    WHERE points < 5000
      AND (lower(avatar_url) LIKE '%.gif'
        OR lower(avatar_url) LIKE '%.gif?%'
        OR lower(avatar_url) LIKE '%.gif#%');
  `);
}
if (!hasColumn('pending_registrations', 'email_lookup_hash')) {
  db.exec('ALTER TABLE pending_registrations ADD COLUMN email_lookup_hash TEXT');
}
if (!hasColumn('posts', 'reply_to_post_id')) {
  db.exec('ALTER TABLE posts ADD COLUMN reply_to_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL');
}
const threadMigrations = [
  ['is_black', 'INTEGER NOT NULL DEFAULT 0'],
  ['deleted_at', 'TEXT'],
  ['deleted_by', 'INTEGER REFERENCES users(id)'],
  ['deletion_reason', "TEXT DEFAULT ''"],
];
for (const [column, definition] of threadMigrations) {
  if (!hasColumn('threads', column)) db.exec(`ALTER TABLE threads ADD COLUMN ${column} ${definition}`);
}
const postMigrations = [
  ['deleted_at', 'TEXT'],
  ['deleted_by', 'INTEGER REFERENCES users(id)'],
  ['deletion_reason', "TEXT DEFAULT ''"],
];
for (const [column, definition] of postMigrations) {
  if (!hasColumn('posts', column)) db.exec(`ALTER TABLE posts ADD COLUMN ${column} ${definition}`);
}
if (!hasColumn('sanctions', 'is_eradication')) {
  db.exec('ALTER TABLE sanctions ADD COLUMN is_eradication INTEGER NOT NULL DEFAULT 0');
}

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
ON users(email COLLATE NOCASE) WHERE email IS NOT NULL AND email != '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lookup_unique
ON users(email_lookup_hash) WHERE email_lookup_hash IS NOT NULL AND email_lookup_hash != '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_username ON pending_registrations(username COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email ON pending_registrations(email COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_lookup ON pending_registrations(email_lookup_hash)
WHERE email_lookup_hash IS NOT NULL AND email_lookup_hash != '';
CREATE INDEX IF NOT EXISTS idx_threads_forum ON threads(forum_id);
CREATE INDEX IF NOT EXISTS idx_threads_forum_deleted ON threads(forum_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_threads_created_at ON threads(created_at);
CREATE INDEX IF NOT EXISTS idx_threads_forum_listing
ON threads(forum_id, deleted_at, is_pinned DESC, last_post_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_forum_visibility
ON threads(forum_id, deleted_at, is_black, is_pinned DESC, last_post_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_threads_user_created ON threads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id);
CREATE INDEX IF NOT EXISTS idx_posts_thread_deleted ON posts(thread_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_thread_listing ON posts(thread_id, deleted_at, id);
CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forums_category ON forums(category_id);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_sanctions_user_active ON sanctions(user_id, revoked_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_moderation_logs_created_at ON moderation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, position);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_listing ON notifications(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_thread_reads_user ON thread_reads(user_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_follows_thread ON thread_follows(thread_id, user_id);
CREATE INDEX IF NOT EXISTS idx_online_presence_last_seen ON online_presence(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_private_members_user ON private_conversation_members(user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_private_messages_conversation ON private_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_private_conversations_updated ON private_conversations(updated_at);
CREATE INDEX IF NOT EXISTS idx_uploaded_images_user_created ON uploaded_images(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_uploaded_images_conversation ON uploaded_images(conversation_id);
CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
CREATE INDEX IF NOT EXISTS idx_security_events_type_created ON security_events(event_type, created_at);
`);
db.pragma('optimize');

// Chiffrement transparent des e-mails et des MP quand une clé applicative est fournie.
// Les anciennes valeurs en clair sont migrées sans changer l'interface du forum.
const migrateSensitiveData = db.transaction(() => {
  const updateUserEmail = db.prepare('UPDATE users SET email = ?, email_lookup_hash = ? WHERE id = ?');
  for (const user of db.prepare("SELECT id, email, email_lookup_hash FROM users WHERE email IS NOT NULL AND email != ''").all()) {
    const plain = revealEmail(user.email);
    const protectedEmail = protectEmail(plain);
    if (user.email !== protectedEmail.encrypted || user.email_lookup_hash !== protectedEmail.lookup) {
      updateUserEmail.run(protectedEmail.encrypted, protectedEmail.lookup, user.id);
    }
  }
  const updatePendingEmail = db.prepare('UPDATE pending_registrations SET email = ?, email_lookup_hash = ? WHERE id = ?');
  for (const pending of db.prepare('SELECT id, email, email_lookup_hash FROM pending_registrations').all()) {
    const plain = revealEmail(pending.email);
    const protectedEmail = protectEmail(plain);
    if (pending.email !== protectedEmail.encrypted || pending.email_lookup_hash !== protectedEmail.lookup) {
      updatePendingEmail.run(protectedEmail.encrypted, protectedEmail.lookup, pending.id);
    }
  }
  if (encryptionEnabled()) {
    const updatePrivateBody = db.prepare('UPDATE private_messages SET body = ? WHERE id = ?');
    for (const message of db.prepare("SELECT id, body FROM private_messages WHERE body NOT LIKE 'enc:v1:%'").all()) {
      updatePrivateBody.run(protectPrivateMessage(message.body), message.id);
    }
  }
});
migrateSensitiveData();

// Création automatique du premier compte privilégié.
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme';
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (process.env.NODE_ENV === 'production' && (isPlaceholder(password) || passwordValidationError(password))) {
    throw new Error('Démarrage refusé : définis un ADMIN_PASSWORD robuste avant de créer le premier compte.');
  }
  const hash = hashPasswordSync(password);
  if (adminEmail) {
    const securedEmail = protectEmail(adminEmail);
    db.prepare(
      `INSERT INTO users (username, password_hash, email, email_lookup_hash, role, email_verified_at)
       VALUES (?, ?, ?, ?, 'developer', datetime('now'))`
    ).run(username, hash, securedEmail.encrypted, securedEmail.lookup);
  } else {
    db.prepare(
      `INSERT INTO users (username, password_hash, role, email_verified_at)
       VALUES (?, ?, 'developer', datetime('now'))`
    ).run(username, hash);
  }
  console.log(`[init] Compte développeur créé : ${username} (pense à changer le mot de passe !)`);
} else {
  const developerCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'developer'").get().c;
  if (developerCount === 0) {
    const firstAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    if (firstAdmin) db.prepare("UPDATE users SET role = 'developer' WHERE id = ?").run(firstAdmin.id);
  }
}

if (process.env.NODE_ENV === 'production') {
  const unsafePrivilegedAccounts = db.prepare(
    `SELECT username FROM users
     WHERE role IN ('moderator','admin','developer')
       AND (email IS NULL OR email = '' OR email_verified_at IS NULL)`
  ).all();
  if (unsafePrivilegedAccounts.length) {
    throw new Error(`Démarrage refusé : compte(s) privilégié(s) sans e-mail validé : ${unsafePrivilegedAccounts.map((user) => user.username).join(', ')}`);
  }
}

module.exports = db;
