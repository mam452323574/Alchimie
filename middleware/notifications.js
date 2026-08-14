const db = require('../db/database');
const { needsPageChrome } = require('../utils/request');
const { canAccessBlackTopics } = require('../utils/points');

function loadNotifications(req, res, next) {
  res.locals.recentNotifications = [];
  res.locals.unreadNotifications = 0;
  if (!req.user || !needsPageChrome(req)) return next();
  const canSeeBlackTopics = canAccessBlackTopics(req.user) ? 1 : 0;

  res.locals.unreadNotifications = db.prepare(
    `SELECT COUNT(*) AS c FROM notifications
     JOIN threads ON threads.id = notifications.thread_id
     JOIN posts notified_post ON notified_post.id = notifications.post_id
     WHERE notifications.user_id = ? AND notifications.is_read = 0
       AND threads.deleted_at IS NULL AND notified_post.deleted_at IS NULL
       AND (? = 1 OR threads.is_black = 0)`
  ).get(req.user.id, canSeeBlackTopics).c;
  res.locals.recentNotifications = db.prepare(
    `SELECT notifications.*, actor.username AS actor_name, actor.role AS actor_role,
      actor.avatar_url AS actor_avatar_url, actor.avatar_color AS actor_avatar_color,
      (SELECT CASE WHEN active.is_eradication = 1 THEN 'eradication' ELSE active.type END
       FROM sanctions active WHERE active.user_id = actor.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS actor_active_sanction,
      (SELECT active.ends_at FROM sanctions active
       WHERE active.user_id = actor.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS actor_sanction_ends_at,
      threads.title AS thread_title,
      CAST(((SELECT COUNT(*) FROM posts position
        WHERE position.thread_id = notifications.thread_id
          AND position.deleted_at IS NULL
          AND position.id <= notifications.post_id) + 19) / 20 AS INTEGER) AS thread_page
     FROM notifications
     JOIN users actor ON actor.id = notifications.actor_id
     JOIN threads ON threads.id = notifications.thread_id
     JOIN posts notified_post ON notified_post.id = notifications.post_id
     WHERE notifications.user_id = ?
       AND threads.deleted_at IS NULL AND notified_post.deleted_at IS NULL
       AND (? = 1 OR threads.is_black = 0)
     ORDER BY notifications.id DESC LIMIT 8`
  ).all(req.user.id, canSeeBlackTopics);
  next();
}

module.exports = { loadNotifications };
