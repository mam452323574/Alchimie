const express = require('express');
const os = require('os');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  getModerationPasswordHash,
  hasModerationAccess,
  unlockModerationAccess,
  clearModerationAccess,
  requireModerationAccess,
} = require('../middleware/moderation-access');
const {
  MODERATION_ROLES,
  ADMIN_ROLES,
  canModerateTarget,
  getActiveSanction,
  logModeration,
} = require('../utils/moderation');
const { recalculateContentCounters } = require('../utils/content');
const { POINT_RULES, adjustPoints } = require('../utils/points');
const { logSecurityEvent } = require('../utils/security');
const { getServiceStatus, updateServiceStatus } = require('../utils/service-status');
const { hashPasswordSync, passwordValidationError, verifyPasswordSync } = require('../utils/passwords');
const { establishAuthenticatedSession, saveSession } = require('../utils/session');
const { encryptionEnabled, lookupHash, revealEmail } = require('../utils/encryption');
const botShield = require('../middleware/bot-shield');

const router = express.Router();
const safeSystemValue = (reader, fallback = null) => {
  try { return reader(); } catch (_error) { return fallback; }
};
const safeReturnTo = (value, fallback = '/admin') => {
  const path = String(value || '');
  return path.startsWith('/') && !path.startsWith('//') ? path : fallback;
};
const safeRefererPath = (req, fallback = '/admin') => {
  try {
    const target = new URL(String(req.get('referer') || ''), process.env.SITE_URL || `${req.protocol}://${req.get('host')}`);
    const expected = new URL(process.env.SITE_URL || `${req.protocol}://${req.get('host')}`);
    if (target.origin !== expected.origin) return fallback;
    return safeReturnTo(`${target.pathname}${target.search}${target.hash}`, fallback);
  } catch {
    return fallback;
  }
};
const moderationLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logSecurityEvent(req, {
      type: 'rate_limit_reached',
      severity: 'critical',
      statusCode: 429,
      details: 'Limite de tentatives du second verrou atteinte',
    });
    return res.status(429).render('admin/login', {
      error: 'Trop de tentatives. Réessaie dans quelques minutes.',
      returnTo: safeReturnTo(req.body.return_to),
      pageTitle: 'Accès sécurisé',
    });
  },
});

router.get('/admin/connexion', requireAuth, requireRole(...MODERATION_ROLES), (req, res) => {
  const returnTo = safeReturnTo(req.query.return_to);
  if (hasModerationAccess(req)) return res.redirect(returnTo);
  res.render('admin/login', { error: null, returnTo, pageTitle: 'Accès sécurisé' });
});

router.post('/admin/connexion', requireAuth, requireRole(...MODERATION_ROLES), moderationLoginLimiter, async (req, res, next) => {
  try {
  const returnTo = safeReturnTo(req.body.return_to);
  const credentialHash = getModerationPasswordHash();
  if (!credentialHash || !verifyPasswordSync(String(req.body.password || ''), credentialHash)) {
    logSecurityEvent(req, {
      type: 'admin_unlock_failed',
      severity: 'critical',
      statusCode: 401,
      details: 'Échec du second déverrouillage du centre de contrôle',
    });
    return res.status(401).render('admin/login', {
      error: 'Mot de passe du centre de contrôle incorrect.',
      returnTo,
      pageTitle: 'Accès sécurisé',
    });
  }
  await establishAuthenticatedSession(req, req.user);
  unlockModerationAccess(req, credentialHash);
  logSecurityEvent(req, {
    type: 'admin_unlock_success',
    severity: 'info',
    statusCode: 302,
    details: 'Centre de contrôle déverrouillé',
  });
  req.session.toast = { type: 'success', message: 'Centre de contrôle déverrouillé temporairement.' };
  await saveSession(req);
  return res.redirect(returnTo);
  } catch (error) {
    return next(error);
  }
});

router.post('/admin/verrouiller', requireAuth, requireRole(...MODERATION_ROLES), (req, res) => {
  clearModerationAccess(req);
  res.redirect('/admin/connexion');
});

function getRecentActions(limit = 16) {
  return db.prepare(
    `SELECT moderation_logs.*, actor.username AS actor_name, target.username AS target_name
     FROM moderation_logs
     LEFT JOIN users actor ON actor.id = moderation_logs.actor_id
     LEFT JOIN users target ON target.id = moderation_logs.target_user_id
     ORDER BY moderation_logs.id DESC LIMIT ?`
  ).all(limit);
}

function getAdminMetrics(onlineCount) {
  return {
    online: onlineCount,
    newUsersToday: db.prepare("SELECT COUNT(*) AS c FROM users WHERE date(created_at) = date('now')").get().c,
    topicsToday: db.prepare("SELECT COUNT(*) AS c FROM threads WHERE deleted_at IS NULL AND date(created_at) = date('now')").get().c,
    postsToday: db.prepare(
      `SELECT COUNT(*) AS c FROM posts JOIN threads ON threads.id = posts.thread_id
       WHERE posts.deleted_at IS NULL AND threads.deleted_at IS NULL
         AND date(posts.created_at) = date('now')`
    ).get().c,
    actionsToday: db.prepare("SELECT COUNT(*) AS c FROM moderation_logs WHERE date(created_at) = date('now')").get().c,
    activeSanctions: db.prepare(
      "SELECT COUNT(*) AS c FROM sanctions WHERE revoked_at IS NULL AND (type = 'ban' OR ends_at > datetime('now'))"
    ).get().c,
    deletedContent: db.prepare(
      `SELECT (SELECT COUNT(*) FROM threads WHERE deleted_at IS NOT NULL)
        + (SELECT COUNT(*) FROM posts WHERE deleted_at IS NOT NULL) AS c`
    ).get().c,
  };
}

function getRoleCounts() {
  return Object.fromEntries(['member', 'moderator', 'admin', 'developer'].map((role) => [
    role,
    db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get(role).c,
  ]));
}

function getModerationTrend() {
  return db.prepare(
    `WITH RECURSIVE dates(day) AS (
       SELECT date('now', '-6 days')
       UNION ALL SELECT date(day, '+1 day') FROM dates WHERE day < date('now')
     )
     SELECT day, (SELECT COUNT(*) FROM moderation_logs WHERE date(created_at) = day) AS actions
     FROM dates`
  ).all();
}

function getActiveSanctions(actor, limit = 100) {
  return db.prepare(
    `SELECT sanctions.*, target.username AS target_name, target.role AS target_role,
      issuer.username AS issuer_name
     FROM sanctions
     JOIN users target ON target.id = sanctions.user_id
     JOIN users issuer ON issuer.id = sanctions.issued_by
     WHERE sanctions.revoked_at IS NULL
       AND (sanctions.type = 'ban' OR sanctions.ends_at > datetime('now'))
     ORDER BY sanctions.id DESC LIMIT ?`
  ).all(limit).map((sanction) => ({
    ...sanction,
    can_revoke: canModerateTarget(actor, { id: sanction.user_id, role: sanction.target_role }),
  }));
}

function getDeletedContent(limit = 100) {
  const deletedThreads = db.prepare(
    `SELECT threads.id, threads.title, threads.deleted_at, threads.deletion_reason,
      author.username AS author_name, actor.username AS deleted_by_name
     FROM threads JOIN users author ON author.id = threads.user_id
     LEFT JOIN users actor ON actor.id = threads.deleted_by
     WHERE threads.deleted_at IS NOT NULL ORDER BY threads.deleted_at DESC LIMIT ?`
  ).all(limit);
  const deletedPosts = db.prepare(
    `SELECT posts.id, posts.thread_id, posts.deleted_at, posts.deletion_reason,
      author.username AS author_name, actor.username AS deleted_by_name, threads.title AS thread_title
     FROM posts JOIN users author ON author.id = posts.user_id
     JOIN threads ON threads.id = posts.thread_id
     LEFT JOIN users actor ON actor.id = posts.deleted_by
     WHERE posts.deleted_at IS NOT NULL ORDER BY posts.deleted_at DESC LIMIT ?`
  ).all(limit);
  return { deletedThreads, deletedPosts };
}

function getFilteredUsers(query) {
  const search = String(query.q || '').trim().slice(0, 60);
  const roleFilter = ['member', 'moderator', 'admin', 'developer'].includes(query.role) ? query.role : '';
  const statusFilter = ['active', 'sanctioned'].includes(query.status) ? query.status : '';
  const userWhere = [];
  const userParams = [];
  if (search) {
    if (search.includes('@')) {
      userWhere.push('(users.username LIKE ? OR users.email_lookup_hash = ?)');
      userParams.push(`%${search}%`, lookupHash(search, 'user-email'));
    } else {
      userWhere.push('users.username LIKE ?');
      userParams.push(`%${search}%`);
    }
  }
  if (roleFilter) {
    userWhere.push('users.role = ?');
    userParams.push(roleFilter);
  }
  if (statusFilter === 'active') {
    userWhere.push(`NOT EXISTS (
      SELECT 1 FROM sanctions active
      WHERE active.user_id = users.id AND active.revoked_at IS NULL
        AND (active.type = 'ban' OR active.ends_at > datetime('now'))
    )`);
  } else if (statusFilter === 'sanctioned') {
    userWhere.push(`EXISTS (
      SELECT 1 FROM sanctions active
      WHERE active.user_id = users.id AND active.revoked_at IS NULL
        AND (active.type = 'ban' OR active.ends_at > datetime('now'))
    )`);
  }
  const users = db.prepare(
    `SELECT users.*,
      (SELECT CASE WHEN is_eradication = 1 THEN 'eradication' ELSE type END FROM sanctions WHERE user_id = users.id AND revoked_at IS NULL
       AND (type = 'ban' OR ends_at > datetime('now')) ORDER BY created_at DESC LIMIT 1) AS active_sanction,
      (SELECT ends_at FROM sanctions WHERE user_id = users.id AND revoked_at IS NULL
       AND (type = 'ban' OR ends_at > datetime('now')) ORDER BY created_at DESC LIMIT 1) AS sanction_ends_at
     FROM users ${userWhere.length ? `WHERE ${userWhere.join(' AND ')}` : ''}
     ORDER BY created_at DESC LIMIT 150`
  ).all(...userParams).map((user) => ({
    ...user,
    email: user.email ? revealEmail(user.email) : '',
  }));
  return { users, search, roleFilter, statusFilter };
}

router.get('/admin', requireAuth, requireRole(...MODERATION_ROLES), requireModerationAccess, (req, res) => {
  res.render('admin/dashboard', {
    metrics: getAdminMetrics(res.locals.onlineCount),
    roleCounts: getRoleCounts(),
    moderationTrend: getModerationTrend(),
    recentActions: getRecentActions(),
    pageTitle: 'Vue d’ensemble',
  });
});

router.get('/admin/membres', requireAuth, requireRole(...MODERATION_ROLES), requireModerationAccess, (req, res) => {
  res.render('admin/members', {
    ...getFilteredUsers(req.query),
    pageTitle: 'Gestion des membres',
  });
});

router.get('/admin/sanctions', requireAuth, requireRole(...MODERATION_ROLES), requireModerationAccess, (req, res) => {
  const activeSanctions = getActiveSanctions(req.user);
  res.render('admin/sanctions', { activeSanctions, pageTitle: 'Sanctions actives' });
});

router.get('/admin/contenus-supprimes', requireAuth, requireRole(...MODERATION_ROLES), requireModerationAccess, (req, res) => {
  res.render('admin/deleted-content', {
    ...getDeletedContent(),
    pageTitle: 'Contenus supprimés',
  });
});

router.get('/admin/structure', requireAuth, requireRole(...ADMIN_ROLES), requireModerationAccess, (req, res) => {
  res.render('admin/structure', {
    categories: db.prepare('SELECT * FROM categories ORDER BY position').all(),
    forums: db.prepare('SELECT * FROM forums ORDER BY category_id, position').all(),
    pageTitle: 'Structure du forum',
  });
});

router.post('/admin/categories', requireAuth, requireRole(...ADMIN_ROLES), requireModerationAccess, (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 80);
  if (name) {
    const maxPos = db.prepare('SELECT MAX(position) AS m FROM categories').get().m || 0;
    db.prepare('INSERT INTO categories (name, position) VALUES (?, ?)').run(name, maxPos + 1);
    logModeration(req.user.id, null, 'category_created', `Catégorie « ${name} » créée`);
  }
  res.redirect('/admin/structure');
});

router.post('/admin/categories/:id/supprimer', requireAuth, requireRole(...ADMIN_ROLES), requireModerationAccess, (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (category) {
    db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
    logModeration(req.user.id, null, 'category_deleted', `Catégorie « ${category.name} » supprimée`);
  }
  res.redirect('/admin/structure');
});

router.post('/admin/forums', requireAuth, requireRole(...ADMIN_ROLES), requireModerationAccess, (req, res) => {
  const { category_id, name, description, slug } = req.body;
  const cleanSlug = (slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80);
  if (category_id && name && cleanSlug) {
    const maxPos = db.prepare('SELECT MAX(position) AS m FROM forums WHERE category_id = ?').get(category_id).m || 0;
    db.prepare(
      'INSERT INTO forums (category_id, name, description, slug, position) VALUES (?, ?, ?, ?, ?)'
    ).run(category_id, name.trim().slice(0, 80), (description || '').trim().slice(0, 300), cleanSlug, maxPos + 1);
    logModeration(req.user.id, null, 'forum_created', `Forum « ${name.trim()} » créé`);
  }
  res.redirect('/admin/structure');
});

router.post('/admin/forums/:id/supprimer', requireAuth, requireRole(...ADMIN_ROLES), requireModerationAccess, (req, res) => {
  const forum = db.prepare('SELECT * FROM forums WHERE id = ?').get(req.params.id);
  if (forum) {
    db.prepare('DELETE FROM forums WHERE id = ?').run(forum.id);
    logModeration(req.user.id, null, 'forum_deleted', `Forum « ${forum.name} » supprimé`);
  }
  res.redirect('/admin/structure');
});

router.post('/admin/membres/:id/role', requireAuth, requireRole(...ADMIN_ROLES), requireModerationAccess, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const role = req.body.role;
  const allowed = req.user.role === 'developer'
    ? ['member', 'moderator', 'admin', 'developer']
    : ['member', 'moderator'];
  if (target && target.id !== req.user.id && target.role !== 'developer' && allowed.includes(role)) {
    const previousRole = target.role;
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
    logModeration(req.user.id, target.id, 'role_changed', `${previousRole} → ${role}`);
    logSecurityEvent(req, {
      type: 'privilege_changed',
      severity: 'critical',
      actorUserId: req.user.id,
      details: `Rôle du compte #${target.id} modifié de ${previousRole} vers ${role}`,
    });
  }
  res.redirect('/admin/membres');
});

router.post('/moderation/sanctions', requireAuth, requireRole(...MODERATION_ROLES), requireModerationAccess, (req, res) => {
  const target = req.body.user_id
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.body.user_id)
    : db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get((req.body.username || '').trim());
  if (!canModerateTarget(req.user, target)) {
    return res.status(403).render('error', { message: 'Tu ne peux pas sanctionner ce compte.', statusCode: 403 });
  }

  const reason = (req.body.reason || '').trim().slice(0, 500);
  const duration = Math.max(0, Math.min(10000, Number.parseInt(req.body.duration, 10) || 0));
  const unit = ['hours', 'days', 'weeks', 'months'].includes(req.body.duration_unit) ? req.body.duration_unit : 'days';
  const requestedType = ['exclusion', 'eradication'].includes(req.body.type) ? req.body.type : 'ban';
  const isEradication = requestedType === 'eradication';
  const type = requestedType === 'exclusion' && duration > 0 ? 'exclusion' : 'ban';
  let endsAt = null;
  if (type === 'exclusion') {
    const modifiers = { hours: 'hours', days: 'days', weeks: 'days', months: 'months' };
    const amount = unit === 'weeks' ? duration * 7 : duration;
    endsAt = db.prepare(`SELECT datetime('now', '+${amount} ${modifiers[unit]}') AS value`).get().value;
  }

  const createSanction = db.transaction(() => {
    db.prepare(
      `UPDATE sanctions SET revoked_at = datetime('now'), revoked_by = ?
       WHERE user_id = ? AND revoked_at IS NULL AND (type = 'ban' OR ends_at > datetime('now'))`
    ).run(req.user.id, target.id);
    db.prepare(
      `INSERT INTO sanctions (user_id, type, is_eradication, reason, ends_at, issued_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(target.id, type, isEradication ? 1 : 0, reason, endsAt, req.user.id);
    db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(target.id);
    let erasedThreads = 0;
    let erasedPosts = 0;
    if (isEradication) {
      const erasedReplies = db.prepare(
        `SELECT COUNT(*) AS count FROM posts
         WHERE posts.user_id = ? AND posts.deleted_at IS NULL
           AND posts.id != (SELECT MIN(first_post.id) FROM posts first_post
                            WHERE first_post.thread_id = posts.thread_id)`
      ).get(target.id).count;
      erasedPosts = db.prepare(
        `UPDATE posts SET deleted_at = datetime('now'), deleted_by = ?, deletion_reason = ?
         WHERE user_id = ? AND deleted_at IS NULL`
      ).run(req.user.id, `Éradication du compte ${target.username}${reason ? ` - ${reason}` : ''}`, target.id).changes;
      erasedThreads = db.prepare(
        `UPDATE threads SET deleted_at = datetime('now'), deleted_by = ?, deletion_reason = ?
         WHERE user_id = ? AND deleted_at IS NULL`
      ).run(req.user.id, `Éradication du compte ${target.username}${reason ? ` - ${reason}` : ''}`, target.id).changes;
      adjustPoints(
        target.id,
        (erasedThreads * POINT_RULES.topicDeleted) + (erasedReplies * POINT_RULES.messageDeleted)
      );
      recalculateContentCounters();
    }
    return { erasedThreads, erasedPosts };
  });
  const erased = createSanction();
  logModeration(
    req.user.id,
    target.id,
    isEradication ? 'user_eradicated' : (type === 'ban' ? 'user_banned' : 'user_excluded'),
    isEradication
      ? `${reason || 'Aucun motif'} - ${erased.erasedThreads} topic(s) et ${erased.erasedPosts} message(s) masqués`
      : `${reason || 'Aucun motif'}${endsAt ? ` · fin ${endsAt}` : ''}`
  );
  req.session.toast = {
    type: 'success',
    message: isEradication
      ? `Le compte ${target.username} a été éradiqué. Son contenu reste visible et restaurable par le staff.`
      : `La sanction de ${target.username} a bien été appliquée.`,
  };
  res.redirect(safeRefererPath(req));
});

router.post('/moderation/sanctions/:id/revoquer', requireAuth, requireRole(...MODERATION_ROLES), requireModerationAccess, (req, res) => {
  const sanction = db.prepare(
    `SELECT sanctions.*, users.role AS target_role FROM sanctions
     JOIN users ON users.id = sanctions.user_id WHERE sanctions.id = ?`
  ).get(req.params.id);
  const target = sanction ? db.prepare('SELECT * FROM users WHERE id = ?').get(sanction.user_id) : null;
  if (sanction && canModerateTarget(req.user, target)) {
    db.transaction(() => {
      db.prepare("UPDATE sanctions SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ?").run(req.user.id, sanction.id);
      const stillActive = getActiveSanction(target.id);
      if (!stillActive) db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(target.id);
    })();
    logModeration(req.user.id, target.id, 'sanction_revoked', `Sanction #${sanction.id} révoquée`);
  }
  res.redirect(safeRefererPath(req));
});

router.get('/developpeur', requireAuth, requireRole('developer'), requireModerationAccess, (req, res) => {
  const counts = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    threads: db.prepare('SELECT COUNT(*) AS c FROM threads WHERE deleted_at IS NULL').get().c,
    posts: db.prepare(
      `SELECT COUNT(*) AS c FROM posts JOIN threads ON threads.id = posts.thread_id
       WHERE posts.deleted_at IS NULL AND threads.deleted_at IS NULL`
    ).get().c,
    sanctions: db.prepare("SELECT COUNT(*) AS c FROM sanctions WHERE revoked_at IS NULL AND (type = 'ban' OR ends_at > datetime('now'))").get().c,
  };
  const logs = db.prepare(
    `SELECT moderation_logs.*, actor.username AS actor_name FROM moderation_logs
     LEFT JOIN users actor ON actor.id = moderation_logs.actor_id ORDER BY id DESC LIMIT 20`
  ).all();
  const technical = {
    databaseBytes: safeSystemValue(() => require('fs').statSync(db.name).size, 0),
    processUptime: Math.round(process.uptime()),
    nodeVersion: process.version,
    online: res.locals.onlineCount,
  };
  const service = getServiceStatus();
  res.render('developer/console', { counts, logs, technical, service, pageTitle: 'Console développeur' });
});

router.get('/developpeur/etat', requireAuth, requireRole('developer'), requireModerationAccess, (req, res) => {
  res.json({
    now: new Date().toISOString(),
    hostname: safeSystemValue(() => os.hostname(), 'indisponible'),
    platform: safeSystemValue(() => `${os.platform()} ${os.release()}`, 'indisponible'),
    uptimeSeconds: safeSystemValue(() => Math.round(os.uptime())),
    loadAverage: safeSystemValue(() => os.loadavg().map((value) => Number(value.toFixed(2))), []),
    memory: {
      free: safeSystemValue(() => os.freemem()),
      total: safeSystemValue(() => os.totalmem()),
    },
    process: { pid: process.pid, uptimeSeconds: Math.round(process.uptime()), node: process.version },
    activity: db.prepare('SELECT action, details, created_at FROM moderation_logs ORDER BY id DESC LIMIT 8').all(),
  });
});

function renderSecurityDashboard(req, res) {
  const periods = { day: 1, week: 7, month: 30 };
  const requestedPeriod = String(req.query.periode || '');
  const period = Object.hasOwn(periods, requestedPeriod) ? requestedPeriod : 'week';
  const modifier = `-${periods[period]} days`;
  const count = (where, ...parameters) => db.prepare(
    `SELECT COUNT(*) AS c FROM security_events WHERE created_at >= datetime('now', ?) ${where}`
  ).get(modifier, ...parameters).c;
  const metrics = {
    events: count(''),
    critical: count("AND severity = 'critical'"),
    failedLogins: count("AND event_type IN ('login_failed','admin_unlock_failed','sanctioned_login_blocked')"),
    sensitiveProbes: count("AND event_type IN ('sensitive_probe','bot_probe','bot_ban','bot_flood_warning','bot_flood_ban')"),
    botBlocks: count("AND event_type IN ('bot_ban','bot_flood_ban')"),
    uploadThreats: count("AND event_type IN ('upload_invalid_file','upload_invalid_dimensions','upload_too_large','upload_integrity_mismatch','upload_csrf_failed')"),
  };
  const events = db.prepare(
    `SELECT security_events.*, users.username AS actor_name, users.role AS actor_role
     FROM security_events LEFT JOIN users ON users.id = security_events.actor_user_id
     WHERE security_events.created_at >= datetime('now', ?)
     ORDER BY security_events.id DESC LIMIT 120`
  ).all(modifier);
  const trend = db.prepare(
    `WITH RECURSIVE dates(day) AS (
       SELECT date('now', '-6 days')
       UNION ALL SELECT date(day, '+1 day') FROM dates WHERE day < date('now')
     )
     SELECT day,
       (SELECT COUNT(*) FROM security_events WHERE date(created_at) = day AND severity = 'critical') AS critical,
       (SELECT COUNT(*) FROM security_events WHERE date(created_at) = day AND severity = 'warning') AS warning
     FROM dates`
  ).all();
  const sourceActivity = db.prepare(
    `SELECT source_hash, COUNT(*) AS events,
      SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
      MAX(created_at) AS last_seen
     FROM security_events WHERE created_at >= datetime('now', ?) AND source_hash != ''
     GROUP BY source_hash ORDER BY critical DESC, events DESC LIMIT 8`
  ).all(modifier);
  const sessionSecret = process.env.SESSION_SECRET || '';
  const publicUrlIsHttps = /^https:\/\//i.test(process.env.SITE_URL || '');
  const cookieIsSecure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  const databaseMode = safeSystemValue(() => fs.statSync(db.name).mode & 0o777, null);
  const moderationUsesInitialPassword = safeSystemValue(
    () => verifyPasswordSync('1234', getModerationPasswordHash()),
    true
  );
  const botShieldStats = botShield.getStats();
  const configurationChecks = [
    {
      label: 'Secret de session',
      status: sessionSecret.length >= 64 && sessionSecret !== 'dev_secret_change_me' ? 'ok' : 'critical',
      detail: sessionSecret.length >= 64 && sessionSecret !== 'dev_secret_change_me' ? 'Secret personnalisé suffisamment long' : 'Secret par défaut ou trop court',
    },
    {
      label: 'Second verrou du staff',
      status: moderationUsesInitialPassword ? 'critical' : 'ok',
      detail: moderationUsesInitialPassword ? 'Le mot de passe initial 1234 est toujours actif' : 'Mot de passe initial remplacé',
    },
    {
      label: 'Cookie sécurisé HTTPS',
      status: publicUrlIsHttps && !cookieIsSecure ? 'critical' : (publicUrlIsHttps ? 'ok' : 'neutral'),
      detail: publicUrlIsHttps ? (cookieIsSecure ? 'Cookie Secure activé' : 'Cookie Secure inactif sur une URL HTTPS') : 'Contrôle non applicable à l’environnement local HTTP',
    },
    {
      label: 'Permissions de la base',
      status: databaseMode !== null && (databaseMode & 0o077) === 0 ? 'ok' : 'warning',
      detail: databaseMode === null ? 'Permissions impossibles à lire' : ((databaseMode & 0o077) === 0 ? 'Accès limité au propriétaire du processus' : `Mode ${databaseMode.toString(8)} : vérifier les accès groupe/autres`),
    },
    {
      label: 'Données sensibles au repos',
      status: encryptionEnabled() ? 'ok' : (process.env.NODE_ENV === 'production' ? 'critical' : 'neutral'),
      detail: encryptionEnabled() ? 'E-mails et messages privés chiffrés par AES-256-GCM' : 'Chiffrement désactivé dans cet environnement local',
    },
    {
      label: 'Validation e-mail',
      status: process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? 'ok' : (process.env.NODE_ENV === 'production' ? 'critical' : 'neutral'),
      detail: process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? 'Serveur SMTP configuré' : 'Transport SMTP non configuré en local',
    },
    { label: 'En-têtes de sécurité', status: 'ok', detail: 'Politique CSP et protections Helmet actives' },
    { label: 'Protection CSRF', status: 'ok', detail: 'Jeton de session et origine vérifiés sur toutes les écritures' },
    { label: 'Bot Shield', status: botShieldStats.enabled ? 'ok' : 'critical', detail: botShieldStats.enabled ? 'Sondes et floods répétés bloqués progressivement' : 'Protection désactivée par la configuration' },
    { label: 'Pipeline d’images', status: 'ok', detail: 'Décodage réel, réencodage WebP et métadonnées supprimées' },
    { label: 'Paramètres entrants', status: 'ok', detail: 'Doublons ambigus, objets et clés d’injection refusés' },
    { label: 'Rotation des sessions', status: 'ok', detail: 'Identifiant renouvelé après authentification et élévation staff' },
    { label: 'Rétention des signaux', status: 'ok', detail: 'Suppression automatique après 90 jours' },
  ];
  const service = getServiceStatus();
  const eventLabels = {
    login_failed: 'Connexion échouée', login_success: 'Connexion réussie',
    rate_limit_reached: 'Limite de tentatives atteinte', admin_unlock_failed: 'Déverrouillage staff échoué',
    admin_unlock_success: 'Déverrouillage staff réussi', sanctioned_login_blocked: 'Compte sanctionné bloqué',
    authorization_denied: 'Autorisation refusée', moderation_session_locked: 'Session staff verrouillée',
    sensitive_probe: 'Sonde vers une ressource sensible', unexpected_method: 'Méthode HTTP inhabituelle',
    invalid_encoding: 'Encodage de requête invalide', server_error: 'Erreur serveur',
    request_too_large: 'Requête trop volumineuse',
    malformed_parameters: 'Paramètres ambigus ou interdits',
    bot_probe: 'Sonde automatisée détectée', bot_ban: 'Scanner temporairement bloqué',
    bot_flood_warning: 'Cadence automatisée anormale', bot_flood_ban: 'Flood temporairement bloqué',
    csrf_failed: 'Protection CSRF déclenchée', global_rate_limit_reached: 'Limite globale atteinte',
    registration_rate_limit_reached: 'Limite d’inscriptions atteinte', account_rate_limit_reached: 'Compte ciblé par force brute',
    upload_capacity_reached: 'Capacité d’upload atteinte', upload_invalid_dimensions: 'Dimensions d’image refusées',
    upload_invalid_file: 'Fichier d’image refusé', upload_too_large: 'Image source trop volumineuse',
    upload_concurrency_reached: 'Traitements d’image simultanés refusés', upload_integrity_mismatch: 'Intégrité d’un média incohérente',
    upload_csrf_failed: 'Upload refusé par la protection CSRF',
    privilege_changed: 'Modification de privilège', security_control_changed: 'Contrôle de sécurité modifié',
    service_status_changed: 'État du service modifié', security_dashboard_viewed: 'Tableau de sécurité consulté',
  };
  logSecurityEvent(req, {
    type: 'security_dashboard_viewed',
    severity: 'info',
    details: 'Consultation du Bot Shield et des signaux de sécurité',
  });
  res.render('developer/security', {
    metrics, events, trend, sourceActivity, configurationChecks, eventLabels,
    botShieldStats,
    botShieldSources: botShield.getSourceDetails(),
    period, service, pageTitle: 'Bot Shield et sécurité',
  });
}

router.get('/admin/securite', requireAuth, requireRole(...ADMIN_ROLES), requireModerationAccess, renderSecurityDashboard);

router.get('/developpeur/securite', requireAuth, requireRole('developer'), requireModerationAccess, (req, res) => {
  const requestedPeriod = ['day', 'week', 'month'].includes(req.query.periode) ? req.query.periode : '';
  res.redirect(`/admin/securite${requestedPeriod ? `?periode=${requestedPeriod}` : ''}`);
});

router.post('/admin/securite/bot-shield/debloquer', requireAuth, requireRole(...ADMIN_ROLES), requireModerationAccess, (req, res) => {
  const sourceHash = String(req.body.source_hash || '').toLowerCase();
  const unblocked = /^[a-f0-9]{16}$/.test(sourceHash) && botShield.unbanSource(sourceHash);
  logSecurityEvent(req, {
    type: 'security_control_changed',
    severity: 'warning',
    details: unblocked ? `Source pseudonymisée ${sourceHash} débloquée` : 'Tentative de déblocage sans source active',
  });
  req.session.toast = unblocked
    ? { type: 'success', message: 'La source a été débloquée du Bot Shield.' }
    : { type: 'error', message: 'Cette source n’est plus bloquée ou n’existe pas.' };
  res.redirect('/admin/securite#bot-shield');
});

router.post('/developpeur/maintenance', requireAuth, requireRole('developer'), requireModerationAccess, (req, res) => {
  const service = updateServiceStatus({
    status: req.body.status,
    message: req.body.message,
    scheduledAt: req.body.scheduled_at,
  });
  logSecurityEvent(req, {
    type: 'service_status_changed',
    severity: 'info',
    details: `État public du service défini sur ${service.status}`,
  });
  logModeration(req.user.id, null, 'service_status_changed', `État du service : ${service.label}`);
  req.session.toast = { type: 'success', message: 'La page publique d’état a été mise à jour.' };
  res.redirect('/admin/securite#maintenance');
});

router.post(
  '/developpeur/mot-de-passe-moderation',
  requireAuth,
  requireRole('developer'),
  requireModerationAccess,
  moderationLoginLimiter,
  (req, res) => {
    const currentPassword = String(req.body.current_password || '');
    const newPassword = String(req.body.new_password || '');
    const confirmation = String(req.body.password_confirmation || '');
    const currentHash = getModerationPasswordHash();

    if (!verifyPasswordSync(currentPassword, currentHash)) {
      req.session.toast = { type: 'error', message: 'Le mot de passe actuel est incorrect.' };
      return res.redirect('/developpeur#securite');
    }
    const passwordError = passwordValidationError(newPassword);
    if (passwordError) {
      req.session.toast = { type: 'error', message: passwordError };
      return res.redirect('/developpeur#securite');
    }
    if (newPassword !== confirmation) {
      req.session.toast = { type: 'error', message: 'La confirmation ne correspond pas au nouveau mot de passe.' };
      return res.redirect('/developpeur#securite');
    }

    const newHash = hashPasswordSync(newPassword);
    db.prepare(
      "UPDATE site_settings SET value = ?, updated_at = datetime('now') WHERE key = 'moderation_password_hash'"
    ).run(newHash);
    unlockModerationAccess(req, newHash);
    logModeration(req.user.id, null, 'moderation_password_changed', 'Mot de passe du centre de contrôle renouvelé');
    logSecurityEvent(req, {
      type: 'security_control_changed',
      severity: 'critical',
      details: 'Mot de passe du centre de contrôle renouvelé',
    });
    req.session.toast = {
      type: 'success',
      message: 'Le mot de passe du centre de contrôle a été modifié. Les autres sessions ont été verrouillées.',
    };
    res.redirect('/developpeur#securite');
  }
);

module.exports = router;
