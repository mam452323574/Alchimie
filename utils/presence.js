const db = require('../db/database');

const ONLINE_WINDOW_SECONDS = 90;
const PRUNE_INTERVAL_MS = 30_000;
const COUNT_CACHE_MS = 2_000;
let lastPruneAt = 0;
let cachedCount = 0;
let countCacheExpiresAt = 0;

function prunePresence(now = Date.now()) {
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  db.prepare(
    `DELETE FROM online_presence
     WHERE last_seen_at < datetime('now', ?)`
  ).run(`-${ONLINE_WINDOW_SECONDS} seconds`);
  lastPruneAt = now;
  countCacheExpiresAt = 0;
}

function getOnlineCount() {
  const now = Date.now();
  prunePresence(now);
  if (now < countCacheExpiresAt) return cachedCount;
  cachedCount = db.prepare(
    `SELECT COUNT(DISTINCT CASE
       WHEN user_id IS NOT NULL THEN 'user:' || user_id
       ELSE 'session:' || session_id
     END) AS count
     FROM online_presence
     WHERE last_seen_at >= datetime('now', ?)`
  ).get(`-${ONLINE_WINDOW_SECONDS} seconds`).count;
  countCacheExpiresAt = now + COUNT_CACHE_MS;
  return cachedCount;
}

function touchPresence(sessionId, userId = null) {
  db.prepare(
    `INSERT INTO online_presence (session_id, user_id, last_seen_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       user_id = excluded.user_id,
       last_seen_at = datetime('now')`
  ).run(sessionId, userId);
  return getOnlineCount();
}

function removePresence(sessionId) {
  if (sessionId) {
    db.prepare('DELETE FROM online_presence WHERE session_id = ?').run(sessionId);
    countCacheExpiresAt = 0;
  }
}

module.exports = { getOnlineCount, touchPresence, removePresence };
