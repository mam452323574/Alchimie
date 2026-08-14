const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const session = require('express-session');

function asyncCallback(callback, error, value) {
  if (typeof callback !== 'function') return;
  queueMicrotask(() => callback(error, value));
}

class SQLiteSessionStore extends session.Store {
  constructor({ filename, defaultTtlMs = 24 * 60 * 60 * 1000 } = {}) {
    super();
    if (!filename) throw new Error('Le chemin de la base de sessions est obligatoire.');
    this.defaultTtlMs = defaultTtlMs;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new Database(filename);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('synchronous = FULL');
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('trusted_schema = OFF');
    this.database.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, expired INTEGER NOT NULL, sess TEXT NOT NULL)');
    this.database.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired)');
    this.filename = filename;
    this.hardenPermissions();

    this.statements = {
      get: this.database.prepare('SELECT sess, expired FROM sessions WHERE sid = ?'),
      set: this.database.prepare(`
        INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET expired = excluded.expired, sess = excluded.sess
      `),
      destroy: this.database.prepare('DELETE FROM sessions WHERE sid = ?'),
      clear: this.database.prepare('DELETE FROM sessions'),
      prune: this.database.prepare('DELETE FROM sessions WHERE expired <= ?'),
      length: this.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE expired > ?'),
    };
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), 15 * 60 * 1000);
    this.pruneTimer.unref?.();
  }

  hardenPermissions() {
    for (const file of [this.filename, `${this.filename}-wal`, `${this.filename}-shm`]) {
      try { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); } catch (_error) { /* système sans chmod */ }
    }
  }

  expiration(sessionValue) {
    const expiresAt = sessionValue?.cookie?.expires
      ? new Date(sessionValue.cookie.expires).getTime()
      : Date.now() + this.defaultTtlMs;
    return Number.isFinite(expiresAt) ? expiresAt : Date.now() + this.defaultTtlMs;
  }

  prune() {
    try { this.statements.prune.run(Date.now()); } catch (_error) { /* prochain passage */ }
  }

  get(sid, callback) {
    try {
      const row = this.statements.get.get(sid);
      if (!row || row.expired <= Date.now()) {
        if (row) this.statements.destroy.run(sid);
        return asyncCallback(callback, null, null);
      }
      return asyncCallback(callback, null, JSON.parse(row.sess));
    } catch (error) {
      try { this.statements.destroy.run(sid); } catch (_cleanupError) { /* session illisible */ }
      return asyncCallback(callback, error);
    }
  }

  set(sid, sessionValue, callback) {
    try {
      this.statements.set.run(sid, this.expiration(sessionValue), JSON.stringify(sessionValue));
      this.hardenPermissions();
      return asyncCallback(callback, null);
    } catch (error) {
      return asyncCallback(callback, error);
    }
  }

  touch(sid, sessionValue, callback) {
    return this.set(sid, sessionValue, callback);
  }

  destroy(sid, callback) {
    try {
      this.statements.destroy.run(sid);
      return asyncCallback(callback, null);
    } catch (error) {
      return asyncCallback(callback, error);
    }
  }

  clear(callback) {
    try {
      this.statements.clear.run();
      return asyncCallback(callback, null);
    } catch (error) {
      return asyncCallback(callback, error);
    }
  }

  length(callback) {
    try {
      return asyncCallback(callback, null, this.statements.length.get(Date.now()).count);
    } catch (error) {
      return asyncCallback(callback, error);
    }
  }

  close() {
    clearInterval(this.pruneTimer);
    this.database.pragma('wal_checkpoint(TRUNCATE)');
    this.database.close();
  }
}

module.exports = SQLiteSessionStore;
