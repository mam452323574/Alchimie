const db = require('../db/database');
const { MODERATION_ROLES } = require('../utils/moderation');
const { logSecurityEvent } = require('../utils/security');

const ACCESS_DURATION_MS = Math.min(2 * 60 * 60 * 1000, Math.max(
  10 * 60 * 1000,
  (Number.parseInt(process.env.MODERATION_SESSION_MINUTES, 10) || 30) * 60 * 1000
));

function getModerationPasswordHash() {
  return db.prepare(
    "SELECT value FROM site_settings WHERE key = 'moderation_password_hash'"
  ).get()?.value || '';
}

function hasModerationAccess(req) {
  if (!req.user || !MODERATION_ROLES.includes(req.user.role)) return false;
  const access = req.session?.moderationAccess;
  if (!access || access.userId !== req.user.id) return false;
  if (!access.unlockedAt || Date.now() - access.unlockedAt > ACCESS_DURATION_MS) return false;
  return Boolean(access.credentialHash && access.credentialHash === getModerationPasswordHash());
}

function unlockModerationAccess(req, credentialHash = getModerationPasswordHash()) {
  req.session.moderationAccess = {
    userId: req.user.id,
    credentialHash,
    unlockedAt: Date.now(),
  };
}

function clearModerationAccess(req) {
  if (req.session) delete req.session.moderationAccess;
}

function loadModerationAccess(req, res, next) {
  res.locals.moderationUnlocked = hasModerationAccess(req);
  next();
}

function requireModerationAccess(req, res, next) {
  if (!req.user || !MODERATION_ROLES.includes(req.user.role)) {
    logSecurityEvent(req, {
      type: 'authorization_denied',
      severity: 'warning',
      statusCode: 403,
      details: 'Accès refusé à une fonction de modération',
    });
    return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });
  }
  if (!hasModerationAccess(req)) {
    logSecurityEvent(req, {
      type: 'moderation_session_locked',
      severity: 'warning',
      statusCode: 403,
      details: 'Action sensible tentée sans second déverrouillage',
    });
    if (req.method === 'GET') {
      const returnTo = req.originalUrl.startsWith('/') ? req.originalUrl : '/admin';
      return res.redirect(`/admin/connexion?return_to=${encodeURIComponent(returnTo)}`);
    }
    return res.status(403).render('error', {
      message: 'La session de modération est verrouillée. Reconnecte-toi au centre de contrôle.',
      statusCode: 403,
    });
  }
  next();
}

module.exports = {
  getModerationPasswordHash,
  hasModerationAccess,
  unlockModerationAccess,
  clearModerationAccess,
  loadModerationAccess,
  requireModerationAccess,
};
