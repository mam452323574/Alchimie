const db = require('../db/database');
const { getActiveSanction, hasSanctionHistory } = require('../utils/moderation');
const { logSecurityEvent } = require('../utils/security');
const { revealEmail } = require('../utils/encryption');
const AUTH_SESSION_MAX_MS = Math.min(30 * 24 * 60 * 60 * 1000, Math.max(
  24 * 60 * 60 * 1000,
  (Number.parseInt(process.env.AUTH_SESSION_MAX_HOURS, 10) || 168) * 60 * 60 * 1000
));

// Injecte l'utilisateur courant et coupe immédiatement les sessions sanctionnées.
function loadUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    const activeSanction = user ? getActiveSanction(user.id) : null;
    const legacyBan = user && user.is_banned && !hasSanctionHistory(user.id);
    const validSessionVersion = user
      && Number.isInteger(req.session.authVersion)
      && req.session.authVersion === Number(user.session_version || 0);
    const validAbsoluteLifetime = Number.isFinite(req.session.authenticatedAt)
      && Date.now() - req.session.authenticatedAt <= AUTH_SESSION_MAX_MS;
    if (user && validSessionVersion && validAbsoluteLifetime && !activeSanction && !legacyBan) {
      if (user.email) user.email = revealEmail(user.email);
      req.user = user;
    } else {
      req.session.destroy(() => {});
    }
  }
  res.locals.currentUser = req.user || null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.flash = 'Tu dois être connecté pour faire ça.';
    return res.redirect('/connexion');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      logSecurityEvent(req, {
        type: 'authorization_denied',
        severity: 'warning',
        statusCode: 403,
        details: 'Accès refusé à une route réservée par rôle',
      });
      return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });
    }
    next();
  };
}

module.exports = { loadUser, requireAuth, requireRole };
