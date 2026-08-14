const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const { sendVerificationEmail } = require('../utils/email');
const { getActiveSanction, hasSanctionHistory } = require('../utils/moderation');
const { removePresence } = require('../utils/presence');
const { logSecurityEvent } = require('../utils/security');
const { passwordValidationError, hashPassword, verifyPassword } = require('../utils/passwords');
const { establishAuthenticatedSession } = require('../utils/session');
const { lookupHash, protectEmail } = require('../utils/encryption');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logSecurityEvent(req, {
      type: 'rate_limit_reached',
      severity: 'critical',
      statusCode: 429,
      details: 'Limite de tentatives atteinte sur une route d’authentification',
    });
    res.status(429).send('Trop de tentatives, réessaie dans quelques minutes.');
  },
});
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => crypto.createHash('sha256')
    .update(String(req.body?.username || '').trim().toLowerCase() || 'empty-identifier')
    .digest('hex'),
  handler: (req, res) => {
    logSecurityEvent(req, {
      type: 'account_rate_limit_reached', severity: 'critical', statusCode: 429,
      details: 'Trop de tentatives ciblant le même identifiant de compte',
    });
    res.status(429).send('Trop de tentatives pour ce compte. Réessaie dans quelques minutes.');
  },
});
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logSecurityEvent(req, {
      type: 'registration_rate_limit_reached', severity: 'critical', statusCode: 429,
      details: 'Trop de demandes de création de compte depuis la même source',
    });
    res.status(429).send('Trop de demandes d’inscription. Réessaie plus tard.');
  },
});

router.get('/inscription', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/register', { error: null, oldUsername: '', oldEmail: '' });
});

router.post('/inscription', registrationLimiter, async (req, res, next) => {
  try {
  const username = (req.body.username || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const passwordConfirm = req.body.password_confirm || '';
  const renderError = (error) => res.render('auth/register', { error, oldUsername: username, oldEmail: email });

  if (username.length < 3 || username.length > 20 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
    return renderError('Le pseudo doit faire 3 à 20 caractères (lettres, chiffres, _ et - uniquement).');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return renderError('Saisis une adresse e-mail valide.');
  }
  const passwordError = passwordValidationError(password);
  if (passwordError) return renderError(passwordError);
  if (password !== passwordConfirm) return renderError('Les deux mots de passe ne correspondent pas.');

  // Le coût est volontairement identique avant de tester l'existence du compte,
  // afin de ne pas transformer le temps de réponse en outil d'énumération.
  const passwordHash = await hashPassword(password);
  const emailLookup = lookupHash(email, 'user-email');
  db.prepare("DELETE FROM pending_registrations WHERE expires_at <= datetime('now')").run();
  const already = db.prepare(
    `SELECT 1 FROM users WHERE username = ? COLLATE NOCASE OR email_lookup_hash = ?
     UNION ALL
     SELECT 1 FROM pending_registrations WHERE username = ? COLLATE NOCASE OR email_lookup_hash = ?
     LIMIT 1`
  ).get(username, emailLookup, username, emailLookup);
  if (already) {
    // Réponse volontairement identique : elle ne confirme ni l'existence du
    // pseudo, ni celle de l'adresse e-mail, et ne remplace pas un jeton en cours.
    return res.render('auth/check-email', { email, developmentUrl: null });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const protectedEmail = protectEmail(email);
  const colors = ['#6f91bd', '#89a9cf', '#7997ba', '#8da7c4', '#6f8fb7'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  try {
    db.prepare(
      `INSERT INTO pending_registrations
       (username, email, email_lookup_hash, password_hash, avatar_color, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))`
    ).run(username, protectedEmail.encrypted, protectedEmail.lookup, passwordHash, color, tokenHash);
  } catch (error) {
    if (error.code && String(error.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.render('auth/check-email', { email, developmentUrl: null });
    }
    throw error;
  }

  const baseUrl = (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const verificationUrl = `${baseUrl}/verifier-email?token=${token}`;
  try {
    const delivery = await sendVerificationEmail({
      email,
      username,
      verificationUrl,
      siteName: res.locals.siteName,
    });
    return res.render('auth/check-email', {
      email,
      developmentUrl: process.env.NODE_ENV === 'production' ? null : delivery.developmentUrl,
    });
  } catch (error) {
    console.error('[email] Échec de livraison:', error.message);
    db.prepare('DELETE FROM pending_registrations WHERE token_hash = ?').run(tokenHash);
    return renderError("Le message de validation n'a pas pu être envoyé. Réessaie plus tard.");
  }
  } catch (error) {
    return next(error);
  }
});

router.get('/verifier-email', async (req, res, next) => {
  const token = String(req.query.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).render('auth/verified', { error: 'Lien de validation invalide.' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const pending = db.prepare(
    "SELECT * FROM pending_registrations WHERE token_hash = ? AND expires_at > datetime('now')"
  ).get(tokenHash);
  if (!pending) return res.status(400).render('auth/verified', { error: 'Ce lien est invalide ou a expiré.' });

  try {
    const createUser = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO users (username, email, email_lookup_hash, password_hash, avatar_color, email_verified_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`
      ).run(pending.username, pending.email, pending.email_lookup_hash, pending.password_hash, pending.avatar_color);
      db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);
      return info.lastInsertRowid;
    });
    const userId = createUser();
    await establishAuthenticatedSession(req, { id: userId, session_version: 0 });
    return res.render('auth/verified', { error: null });
  } catch (error) {
    console.error('[auth] Validation impossible:', error.message);
    if (error.code && String(error.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).render('auth/verified', { error: 'Le compte existe déjà ou le lien a déjà été utilisé.' });
    }
    return next(error);
  }
});

router.get('/connexion', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { error: null, oldUsername: '' });
});

router.post('/connexion', loginLimiter, loginAccountLimiter, async (req, res, next) => {
  try {
  const identifier = (req.body.username || '').trim().slice(0, 254);
  const password = req.body.password || '';
  const emailLookup = identifier.includes('@') ? lookupHash(identifier, 'user-email') : '';
  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? COLLATE NOCASE OR (? != \'\' AND email_lookup_hash = ?)'
  ).get(identifier, emailLookup, emailLookup);
  if (!(await verifyPassword(password, user?.password_hash))) {
    logSecurityEvent(req, {
      type: 'login_failed',
      severity: 'warning',
      statusCode: 401,
      details: 'Échec de connexion au compte',
    });
    return res.status(401).render('auth/login', { error: 'Identifiants incorrects.', oldUsername: identifier });
  }

  const sanction = getActiveSanction(user.id);
  const legacyBan = user.is_banned && !hasSanctionHistory(user.id);
  if (sanction || legacyBan) {
    logSecurityEvent(req, {
      type: 'sanctioned_login_blocked',
      severity: 'warning',
      actorUserId: user.id,
      statusCode: 403,
      details: 'Connexion refusée à un compte sanctionné',
    });
    const expiry = sanction && sanction.type === 'exclusion' ? ` jusqu’au ${sanction.ends_at}` : '';
    const reason = sanction?.reason || 'Aucun motif';
    const sanctionLabel = sanction?.type === 'exclusion' ? 'exclu' : 'banni';
    return res.status(403).render('auth/login', {
      error: `Ce compte est ${sanctionLabel}${expiry} : ${reason}.`,
      oldUsername: identifier,
    });
  }

  db.prepare("UPDATE users SET last_login_at = datetime('now'), is_banned = 0 WHERE id = ?").run(user.id);
  logSecurityEvent(req, {
    type: 'login_success',
    severity: 'info',
    actorUserId: user.id,
    statusCode: 302,
    details: 'Connexion au compte réussie',
  });
  await establishAuthenticatedSession(req, user);
  return res.redirect('/');
  } catch (error) {
    return next(error);
  }
});

router.post('/deconnexion', (req, res) => {
  removePresence(req.sessionID);
  req.session.destroy(() => {
    res.clearCookie(process.env.NODE_ENV === 'production' ? '__Host-avebar.sid' : 'avebar.sid', {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/',
    });
    res.redirect('/');
  });
});

module.exports = router;
