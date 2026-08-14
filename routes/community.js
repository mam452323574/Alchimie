const express = require('express');
const db = require('../db/database');
const { getServiceStatus } = require('../utils/service-status');
const { requireAuth } = require('../middleware/auth');
const { moderationActionLabel, formatModerationDetails } = require('../utils/moderation');
const { hasModerationAccess } = require('../middleware/moderation-access');
const { canAccessBlackTopics } = require('../utils/points');

const router = express.Router();
const MODERATION_LOGS_PER_PAGE = 20;

function publicModerationResource(log, canSeeBlackTopics) {
  const details = String(log.details || '');
  const postMatch = details.match(/message(?: initial)?\s+#(\d+)/i);
  if (postMatch) {
    const post = db.prepare(
      `SELECT posts.id, posts.thread_id
       FROM posts JOIN threads ON threads.id = posts.thread_id
       WHERE posts.id = ? AND posts.deleted_at IS NULL AND threads.deleted_at IS NULL
         AND (? = 1 OR threads.is_black = 0)`
    ).get(Number(postMatch[1]), canSeeBlackTopics ? 1 : 0);
    if (!post) return null;
    const position = db.prepare(
      `SELECT COUNT(*) AS c FROM posts
       WHERE thread_id = ? AND deleted_at IS NULL AND id <= ?`
    ).get(post.thread_id, post.id).c;
    return {
      href: `/t/${post.thread_id}?page=${Math.max(1, Math.ceil(position / 20))}#post-${post.id}`,
      label: `Voir le message #${post.id}`,
    };
  }

  const threadMatch = details.match(/sujet\s+#(\d+)/i);
  if (!threadMatch) return null;
  const thread = db.prepare(
    'SELECT id FROM threads WHERE id = ? AND deleted_at IS NULL AND (? = 1 OR is_black = 0)'
  ).get(Number(threadMatch[1]), canSeeBlackTopics ? 1 : 0);
  return thread ? { href: `/t/${thread.id}`, label: `Voir le sujet #${thread.id}` } : null;
}

function targetsRestrictedBlackTopic(log, canSeeBlackTopics) {
  if (canSeeBlackTopics) return false;
  const details = String(log.details || '');
  const postMatch = details.match(/message(?: initial)?\s+#(\d+)/i);
  if (postMatch) {
    return Boolean(db.prepare(
      `SELECT 1 FROM posts JOIN threads ON threads.id = posts.thread_id
       WHERE posts.id = ? AND threads.is_black = 1`
    ).get(Number(postMatch[1])));
  }
  const threadMatch = details.match(/sujet\s+#(\d+)/i);
  return Boolean(threadMatch && db.prepare(
    'SELECT 1 FROM threads WHERE id = ? AND is_black = 1'
  ).get(Number(threadMatch[1])));
}

function moderationLogTone(action) {
  if (/_restored$/.test(action) || action === 'sanction_revoked') return 'restored';
  if (/_deleted$/.test(action) || ['user_banned', 'user_excluded', 'user_eradicated'].includes(action)) return 'restricted';
  return 'standard';
}

router.get('/etat-du-service', (req, res) => {
  let databaseAvailable = true;
  try { db.prepare('SELECT 1 AS ok').get(); } catch (_error) { databaseAvailable = false; }
  const service = getServiceStatus();
  const publicComponentState = service.status === 'maintenance'
    ? 'maintenance'
    : (service.status === 'degraded' ? 'degraded' : 'operational');
  res.render('status', {
    pageTitle: 'État du service',
    service,
    components: [
      { name: 'Forum et topics', state: publicComponentState },
      { name: 'Comptes et authentification', state: databaseAvailable ? publicComponentState : 'unavailable' },
      { name: 'Messagerie privée', state: databaseAvailable ? publicComponentState : 'unavailable' },
      { name: 'Base de données', state: databaseAvailable ? 'operational' : 'unavailable' },
    ],
    checkedAt: new Date().toLocaleString('fr-FR'),
  });
});

router.get('/cgu', (req, res) => {
  res.render('legal', {
    pageTitle: 'Conditions Générales d’Utilisation',
  });
});

router.get('/moderation', (req, res) => {
  const canSeeBlackTopics = canAccessBlackTopics(req.user) || hasModerationAccess(req);
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const total = db.prepare('SELECT COUNT(*) AS c FROM moderation_logs').get().c;
  const totalPages = Math.max(1, Math.ceil(total / MODERATION_LOGS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const logs = db.prepare(
    `SELECT moderation_logs.*, actor.username AS actor_name, actor.role AS actor_role,
      target.username AS target_name, target.role AS target_role
     FROM moderation_logs
     LEFT JOIN users actor ON actor.id = moderation_logs.actor_id
     LEFT JOIN users target ON target.id = moderation_logs.target_user_id
     ORDER BY moderation_logs.id DESC LIMIT ? OFFSET ?`
  ).all(MODERATION_LOGS_PER_PAGE, (safePage - 1) * MODERATION_LOGS_PER_PAGE).map((log) => {
    const restrictedBlackTopic = targetsRestrictedBlackTopic(log, canSeeBlackTopics);
    return {
      ...log,
      target_name: restrictedBlackTopic ? null : log.target_name,
      target_role: restrictedBlackTopic ? null : log.target_role,
      actionLabel: moderationActionLabel(log.action),
      formattedDetails: restrictedBlackTopic
        ? 'Action concernant un topic noir réservé aux membres de rang Bronze ou supérieur.'
        : formatModerationDetails(log.action, log.details),
      resource: restrictedBlackTopic ? null : publicModerationResource(log, canSeeBlackTopics),
      tone: moderationLogTone(log.action),
    };
  });
  res.render('moderation-history', { logs, page: safePage, totalPages, total });
});

router.get('/mes-messages', requireAuth, (req, res) => {
  const perPage = 20;
  const blackFilter = canAccessBlackTopics(req.user) ? '' : 'AND threads.is_black = 0';
  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM posts
     JOIN threads ON threads.id = posts.thread_id
     WHERE posts.user_id = ? AND posts.deleted_at IS NULL AND threads.deleted_at IS NULL ${blackFilter}`
  ).get(req.user.id).c;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const page = Math.min(requestedPage, totalPages);
  const messages = db.prepare(
    `SELECT posts.id, posts.body, posts.created_at, posts.edited_at,
      threads.id AS thread_id, threads.title AS thread_title,
      forums.name AS forum_name, forums.slug AS forum_slug,
      (SELECT COUNT(*) FROM posts previous
       WHERE previous.thread_id = posts.thread_id
         AND previous.deleted_at IS NULL AND previous.id <= posts.id) AS position_in_thread
     FROM posts
     JOIN threads ON threads.id = posts.thread_id
     JOIN forums ON forums.id = threads.forum_id
     WHERE posts.user_id = ? AND posts.deleted_at IS NULL AND threads.deleted_at IS NULL ${blackFilter}
     ORDER BY posts.id DESC LIMIT ? OFFSET ?`
  ).all(req.user.id, perPage, (page - 1) * perPage).map((message) => ({
    ...message,
    threadPage: Math.max(1, Math.ceil(message.position_in_thread / 20)),
  }));
  res.render('my-messages', {
    pageTitle: 'Mes messages', messages, total, page, totalPages,
  });
});

router.get('/statistiques', (req, res) => {
  const periods = { week: 7, month: 30, year: 365 };
  const period = periods[req.query.periode] ? req.query.periode : 'week';
  const days = periods[period];
  const startModifier = `-${days - 1} days`;
  const timeline = db.prepare(
    `WITH RECURSIVE dates(day) AS (
       SELECT date('now', ?)
       UNION ALL SELECT date(day, '+1 day') FROM dates WHERE day < date('now')
     )
     SELECT day,
       (SELECT COUNT(*) FROM posts
        JOIN threads post_threads ON post_threads.id = posts.thread_id
        WHERE date(posts.created_at) = day AND posts.deleted_at IS NULL AND post_threads.deleted_at IS NULL) AS posts,
       (SELECT COUNT(*) FROM threads WHERE date(created_at) = day AND deleted_at IS NULL) AS threads,
       (SELECT COUNT(*) FROM users WHERE date(created_at) = day) AS users
     FROM dates`
  ).all(startModifier);
  const totals = timeline.reduce((result, day) => ({
    posts: result.posts + day.posts,
    threads: result.threads + day.threads,
    users: result.users + day.users,
  }), { posts: 0, threads: 0, users: 0 });
  const maximum = Math.max(1, ...timeline.flatMap((day) => [day.posts, day.threads, day.users]));
  const todayUsers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE date(created_at) = date('now')").get().c;
  res.render('stats', { period, timeline, totals, maximum, todayUsers });
});

module.exports = router;
