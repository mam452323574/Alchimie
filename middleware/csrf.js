const crypto = require('crypto');
const { logSecurityEvent } = require('../utils/security');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function constantTimeEqual(expected, received) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(received)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(received, 'ascii'));
}

function expectedOrigin(req) {
  try {
    if (process.env.SITE_URL) return new URL(process.env.SITE_URL).origin;
    return new URL(`${req.protocol}://${req.get('host')}`).origin;
  } catch {
    return '';
  }
}

function validRequestOrigin(req) {
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false;
  const source = req.get('origin') || req.get('referer');
  if (!source) return process.env.NODE_ENV !== 'production';
  try { return new URL(source).origin === expectedOrigin(req); } catch { return false; }
}

function csrfProtection(req, res, next) {
  const expected = ensureCsrfToken(req);
  res.locals.csrfToken = expected;
  if (SAFE_METHODS.has(req.method)) return next();

  const bodyToken = req.body && !Buffer.isBuffer(req.body) ? req.body.csrf_token : '';
  const received = String(req.get('x-csrf-token') || bodyToken || '');
  if (validRequestOrigin(req) && constantTimeEqual(expected, received)) return next();

  logSecurityEvent(req, {
    type: 'csrf_failed',
    severity: 'critical',
    statusCode: 403,
    details: 'Requête modifiant des données refusée par la protection CSRF',
  });
  res.set('Cache-Control', 'no-store');
  if (String(req.get('accept') || '').includes('application/json')) {
    return res.status(403).json({ error: 'La vérification de sécurité a expiré. Recharge la page.' });
  }
  return res.status(403).type('text/plain').send(
    'La vérification de sécurité a expiré. Recharge la page puis réessaie.'
  );
}

module.exports = { ensureCsrfToken, csrfProtection };
