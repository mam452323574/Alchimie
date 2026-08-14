process.umask(0o077);
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const SQLiteSessionStore = require('./db/session-store');
const { validateProductionEnvironment } = require('./utils/config');
validateProductionEnvironment();
const { formatPostBody, formatPrivateMessageBody } = require('./utils/sanitize');
const db = require('./db/database');
const { getPrimaryForum } = require('./db/core-structure');
const packageInfo = require('./package.json');

const { loadUser } = require('./middleware/auth');
const { loadModerationAccess } = require('./middleware/moderation-access');
const { loadNotifications } = require('./middleware/notifications');
const { loadPrivateMessages } = require('./middleware/private-messages');
const authRoutes = require('./routes/auth');
const forumRoutes = require('./routes/forum');
const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admin');
const communityRoutes = require('./routes/community');
const notificationRoutes = require('./routes/notifications');
const presenceRoutes = require('./routes/presence');
const privateMessageRoutes = require('./routes/private-messages');
const realtimeRoutes = require('./routes/realtime');
const { router: uploadRoutes } = require('./routes/uploads');
const { getOnlineCount } = require('./utils/presence');
const { needsPageChrome } = require('./utils/request');
const { logSecurityEvent, securityRequestMonitor } = require('./utils/security');
const { csrfProtection } = require('./middleware/csrf');
const botShield = require('./middleware/bot-shield');
const { inputGuard } = require('./middleware/input-guard');
const { rankForPoints } = require('./utils/points');

const app = express();
const PORT = Math.min(65535, Math.max(1, Number.parseInt(process.env.PORT, 10) || 3000));
const HOST = process.env.HOST || '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';
const configuredSiteUrl = process.env.SITE_URL ? new URL(process.env.SITE_URL) : null;
const sessionTtlHours = Math.min(168, Math.max(1, Number.parseInt(process.env.SESSION_TTL_HOURS, 10) || 24));
const sessionTtlMs = sessionTtlHours * 60 * 60 * 1000;
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.locals.executionTime = () => (
    Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
  ).toFixed(3);
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.set('view cache', isProduction);
app.disable('x-powered-by');

if (configuredSiteUrl) {
  app.use((req, res, next) => {
    if (String(req.get('host') || '').toLowerCase() !== configuredSiteUrl.host.toLowerCase()) {
      return res.status(421).send('Hôte HTTP refusé.');
    }
    return next();
  });
}

app.use(
  helmet({
    frameguard: { action: 'deny' },
    crossOriginEmbedderPolicy: false,
    hsts: isProduction ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcElem: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'self'", 'https://risibank.fr', 'https://www.youtube-nocookie.com', 'https://www.tiktok.com', 'https://vocaroo.com'],
        upgradeInsecureRequests: isProduction ? [] : null,
      },
    },
  })
);
app.use((req, res, next) => {
  res.set({
    'Permissions-Policy': 'accelerometer=(), autoplay=(self), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    'X-Permitted-Cross-Domain-Policies': 'none',
  });
  next();
});

app.use(botShield);
app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 120 }));
app.use(inputGuard);
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  index: false,
  maxAge: isProduction ? '1h' : 0,
  setHeaders: (res, filePath) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (filePath.includes(`${path.sep}fonts${path.sep}`)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

const sessionStore = new SQLiteSessionStore({
  filename: process.env.SESSION_DB_PATH || path.join(__dirname, 'db', 'sessions.sqlite3'),
  defaultTtlMs: sessionTtlMs,
});

app.use(
  session({
    store: sessionStore,
    secret: sessionSecret,
    name: isProduction ? '__Host-avebar.sid' : 'avebar.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    unset: 'destroy',
    proxy: isProduction,
    cookie: {
      httpOnly: true,
      secure: isProduction || process.env.COOKIE_SECURE === 'true',
      maxAge: sessionTtlMs,
      sameSite: 'lax',
      path: '/',
    },
  })
);

app.use(loadUser);
app.use(securityRequestMonitor);
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(req.method)) {
    return res.status(405).set('Allow', 'GET, HEAD, POST, OPTIONS').send('Méthode HTTP refusée.');
  }
  return next();
});
app.use(rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const { logSecurityEvent } = require('./utils/security');
    logSecurityEvent(req, {
      type: 'global_rate_limit_reached', severity: 'critical', statusCode: 429,
      details: 'Volume global de requêtes anormalement élevé',
    });
    res.status(429).send('Trop de requêtes. Réessaie dans quelques minutes.');
  },
}));
app.use(csrfProtection);
app.use(loadModerationAccess);
app.use(loadNotifications);
app.use(loadPrivateMessages);
app.use((req, res, next) => {
  if (req.user || /^\/(?:connexion|inscription|verifier-email|compte|messages|admin|developpeur)(?:\/|$)/.test(req.path)) {
    res.set({ 'Cache-Control': 'private, no-store', Pragma: 'no-cache' });
  }
  next();
});

const legalPlaceholder = 'À compléter avant la mise en ligne publique';
const legalInformation = Object.freeze({
  publisherName: process.env.LEGAL_PUBLISHER_NAME || legalPlaceholder,
  publisherStatus: process.env.LEGAL_PUBLISHER_STATUS || legalPlaceholder,
  publisherAddress: process.env.LEGAL_PUBLISHER_ADDRESS || legalPlaceholder,
  publicationDirector: process.env.LEGAL_PUBLICATION_DIRECTOR || legalPlaceholder,
  hostName: process.env.LEGAL_HOST_NAME || legalPlaceholder,
  hostAddress: process.env.LEGAL_HOST_ADDRESS || legalPlaceholder,
  contactEmail: process.env.CONTACT_EMAIL || legalPlaceholder,
  updatedAt: process.env.LEGAL_UPDATED_AT || '14 août 2026',
  placeholder: legalPlaceholder,
});
let cachedWebmasters = [];
let webmastersCacheExpiresAt = 0;
function getWebmasters() {
  const now = Date.now();
  if (now >= webmastersCacheExpiresAt) {
    cachedWebmasters = db.prepare(
      "SELECT username FROM users WHERE role = 'developer' ORDER BY id"
    ).all();
    webmastersCacheExpiresAt = now + 60_000;
  }
  return cachedWebmasters;
}

// Variables globales disponibles dans tous les templates EJS
app.use((req, res, next) => {
  res.locals.siteName = process.env.SITE_NAME || 'Alchimie';
  res.locals.siteVersion = packageInfo.version;
  res.locals.siteStartYear = Number.parseInt(process.env.SITE_START_YEAR, 10) || 2026;
  res.locals.currentYear = new Date().getFullYear();
  res.locals.contactEmail = process.env.CONTACT_EMAIL || '';
  res.locals.reportEmail = process.env.REPORT_EMAIL || process.env.CONTACT_EMAIL || '';
  res.locals.webmasters = getWebmasters();
  res.locals.legal = legalInformation;
  res.locals.path = req.path;
  const primaryForum = getPrimaryForum(db);
  res.locals.primaryForumPath = primaryForum ? `/f/${primaryForum.slug}` : '/forum';
  res.locals.roleLabels = {
    member: 'Membre', moderator: 'Modérateur', admin: 'Administrateur', developer: 'Développeur',
  };
  res.locals.formatPostBody = formatPostBody;
  res.locals.formatPrivateMessageBody = formatPrivateMessageBody;
  res.locals.rankForPoints = rankForPoints;
  res.locals.onlineCount = needsPageChrome(req) ? getOnlineCount() : 0;
  res.locals.toast = req.session.toast || null;
  if (req.session.toast) delete req.session.toast;
  next();
});

app.use('/', authRoutes);
app.use('/', forumRoutes);
app.use('/', accountRoutes);
app.use('/', adminRoutes);
app.use('/', communityRoutes);
app.use('/', notificationRoutes);
app.use('/', presenceRoutes);
app.use('/', privateMessageRoutes);
app.use('/', realtimeRoutes);
app.use('/', uploadRoutes);

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page introuvable.', statusCode: 404 });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const statusCode = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (statusCode < 500) {
    console.warn(`[request] ${statusCode} ${req.method} ${req.path} (${String(err.type || err.name || 'client-error').slice(0, 50)})`);
    if (statusCode === 413) {
      logSecurityEvent(req, {
        type: 'request_too_large', severity: 'warning', statusCode,
        details: 'Corps de requête supérieur à la limite applicative',
      });
    }
  } else {
    console.error(err);
  }
  if (!res.locals.csrfToken) {
    return res.status(statusCode).type('text/plain').send(
      statusCode === 413 ? 'Requête trop volumineuse.' : 'Une erreur est survenue.'
    );
  }
  return res.status(statusCode).render('error', {
    message: statusCode === 413 ? 'La requête envoyée est trop volumineuse.' : 'Une erreur est survenue.',
    statusCode,
  });
});

const httpServer = app.listen(PORT, HOST, () => {
  const siteName = process.env.SITE_NAME || 'Alchimie';
  console.log(`${siteName} lancé sur http://${HOST}:${PORT}`);
});
httpServer.headersTimeout = 15_000;
httpServer.requestTimeout = 30_000;
httpServer.keepAliveTimeout = 5_000;
httpServer.maxHeadersCount = 100;

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Arrêt propre demandé (${signal}).`);
  httpServer.close(() => {
    try { botShield.close(); } catch (_error) { /* minuterie déjà arrêtée */ }
    try { sessionStore.close(); } catch (_error) { /* fermeture déjà effectuée */ }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_error) { /* fermeture déjà effectuée */ }
    process.exit(0);
  });
  const drainTimer = setTimeout(() => httpServer.closeAllConnections?.(), 5000);
  drainTimer.unref?.();
  const forceTimer = setTimeout(() => process.exit(1), 10000);
  forceTimer.unref?.();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
