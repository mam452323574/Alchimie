const { logSecurityEvent, sourceFingerprint } = require('../utils/security');

const STATIC_PREFIXES = ['/css/', '/js/', '/images/', '/fonts/', '/media/'];
const FLOOD_EXEMPT_PREFIXES = [
  ...STATIC_PREFIXES,
  '/flux/',
  '/presence',
  '/notifications/',
  '/messages/liste-fragment',
];
const SUSPICIOUS_EXTENSION = /\.(?:php\d*|phtml|phar|asp|aspx|jsp|cgi|pl|env|ini|cfg|conf|bak|old|sql|sqlite\d*|log|swp)(?:\/|$)/i;
const SUSPICIOUS_PATHS = [
  { category: 'hidden_repository', pattern: /(?:^|\/)\.(?:git|svn|hg)(?:\/|$)/i },
  { category: 'secret_file', pattern: /(?:^|\/)\.env(?:\.[^/]*)?(?:\/|$)/i },
  { category: 'wordpress_probe', pattern: /(?:^|\/)(?:wp-admin|wp-content|wp-includes|wordpress)(?:\/|$)|(?:^|\/)wp-login\.php$|(?:^|\/)xmlrpc\.php$/i },
  { category: 'database_admin_probe', pattern: /(?:^|\/)(?:phpmyadmin|pma|myadmin|adminer)(?:\/|$)/i },
  { category: 'server_probe', pattern: /(?:^|\/)(?:cgi-bin|fcgi-bin|actuator|telescope|solr|jenkins|node_modules|vendor)(?:\/|$)/i },
  { category: 'sensitive_file', pattern: /\/(?:package\.json|composer\.json|web\.config|\.htaccess|\.htpasswd|server-status|server-info)$/i },
  { category: 'system_file', pattern: /(?:^|\/)etc\/passwd(?:\/|$)/i },
];

function integerSetting(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizedPath(rawTarget) {
  const rawPath = String(rawTarget || '/').split('?')[0].slice(0, 4096);
  let decoded = rawPath;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return { path: rawPath, invalidEncoding: true };
    }
  }
  return { path: decoded.replace(/\\/g, '/'), invalidEncoding: false };
}

function classifySuspiciousPath(rawTarget) {
  const normalized = normalizedPath(rawTarget);
  const candidate = normalized.path;
  if (normalized.invalidEncoding) return 'invalid_encoding';
  if (candidate.length > 2048) return 'oversized_path';
  if (/(?:^|\/)\.\.(?:\/|$)/.test(candidate)) return 'path_traversal';
  if (SUSPICIOUS_EXTENSION.test(candidate)) return 'suspicious_extension';
  return SUSPICIOUS_PATHS.find(({ pattern }) => pattern.test(candidate))?.category || null;
}

function safeDisplayedPath(rawTarget) {
  return normalizedPath(rawTarget).path.replace(/[\r\n\0]/g, ' ').slice(0, 180);
}

function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function createBotShield(options = {}) {
  const now = options.now || Date.now;
  const logger = options.logSecurityEvent || logSecurityEvent;
  const fingerprint = options.sourceFingerprint || sourceFingerprint;
  const settings = {
    enabled: options.enabled ?? process.env.BOT_SHIELD_ENABLED !== 'false',
    maxStrikes: integerSetting(options.maxStrikes ?? process.env.BOT_SHIELD_MAX_STRIKES, 5, 3, 20),
    strikeDecayMs: integerSetting(options.strikeDecayMs, 10 * 60_000, 60_000, 24 * 60 * 60_000),
    banBaseMs: integerSetting(options.banBaseMs, 5 * 60_000, 60_000, 24 * 60 * 60_000),
    maxBanMs: integerSetting(options.maxBanMs, 24 * 60 * 60_000, 5 * 60_000, 7 * 24 * 60 * 60_000),
    floodWindowMs: integerSetting(options.floodWindowMs, 60_000, 10_000, 10 * 60_000),
    floodWarning: integerSetting(options.floodWarning ?? process.env.BOT_SHIELD_FLOOD_WARNING, 240, 60, 10_000),
    floodBan: integerSetting(options.floodBan ?? process.env.BOT_SHIELD_FLOOD_BAN, 360, 90, 20_000),
    maxTrackedSources: integerSetting(options.maxTrackedSources, 5000, 100, 50_000),
    cleanupIntervalMs: options.cleanupIntervalMs === 0 ? 0 : integerSetting(options.cleanupIntervalMs, 5 * 60_000, 30_000, 60 * 60_000),
  };
  settings.floodBan = Math.max(settings.floodBan, settings.floodWarning + 30);

  const sourceRecords = new Map();
  const floodCounters = new Map();
  const counters = {
    totalBlocked: 0,
    totalProbes: 0,
    totalFloodBans: 0,
    totalFloodWarnings: 0,
  };
  const startedAt = now();

  function requestIp(req) {
    return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
  }

  function trimMap(store) {
    if (store.size < settings.maxTrackedSources) return;
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }

  function trimSourceRecords() {
    if (sourceRecords.size < settings.maxTrackedSources) return;
    const currentTime = now();
    let candidate;
    let fallback;
    for (const [ip, record] of sourceRecords) {
      if (!fallback || record.banUntil < fallback.record.banUntil) fallback = { ip, record };
      if (record.banUntil > currentTime) continue;
      if (!candidate || record.lastSeen < candidate.record.lastSeen) candidate = { ip, record };
    }
    sourceRecords.delete((candidate || fallback).ip);
  }

  function getOrCreateRecord(ip) {
    let record = sourceRecords.get(ip);
    if (!record) {
      trimSourceRecords();
      record = {
        strikes: 0,
        lastStrike: 0,
        lastSeen: now(),
        banUntil: 0,
        banCount: 0,
        banReason: '',
        lastPath: '',
        probeCategories: [],
      };
      sourceRecords.set(ip, record);
    }
    return record;
  }

  function banSource(req, ip, reason, path) {
    const currentTime = now();
    const record = getOrCreateRecord(ip);
    record.banCount += 1;
    const duration = Math.min(settings.banBaseMs * (2 ** (record.banCount - 1)), settings.maxBanMs);
    record.banUntil = currentTime + duration;
    record.strikes = 0;
    record.lastStrike = currentTime;
    record.lastSeen = currentTime;
    record.banReason = reason;
    record.lastPath = safeDisplayedPath(path);
    logger(req, {
      type: reason === 'flood' ? 'bot_flood_ban' : 'bot_ban',
      severity: 'critical',
      statusCode: reason === 'flood' ? 429 : 403,
      details: `Bot Shield : blocage temporaire ${Math.ceil(duration / 60_000)} min (${reason})`,
    });
  }

  function cleanup() {
    const currentTime = now();
    for (const [ip, record] of sourceRecords) {
      const banExpired = !record.banUntil || record.banUntil <= currentTime;
      const stale = currentTime - record.lastSeen > settings.strikeDecayMs * 6;
      if (banExpired && stale) sourceRecords.delete(ip);
    }
    for (const [ip, counter] of floodCounters) {
      if (currentTime - counter.windowStart > settings.floodWindowMs * 2) floodCounters.delete(ip);
    }
  }

  const cleanupTimer = settings.cleanupIntervalMs ? setInterval(cleanup, settings.cleanupIntervalMs) : null;
  cleanupTimer?.unref?.();

  function middleware(req, res, next) {
    if (!settings.enabled) return next();

    const rawTarget = String(req.originalUrl || req.url || req.path || '/');
    const path = normalizedPath(rawTarget).path.toLowerCase();
    if (path === '/favicon.ico' || startsWithAny(path, STATIC_PREFIXES)) return next();

    const ip = requestIp(req);
    const currentTime = now();
    const existing = sourceRecords.get(ip);
    if (existing?.banUntil > currentTime) {
      existing.lastSeen = currentTime;
      counters.totalBlocked += 1;
      const retryAfter = Math.max(1, Math.ceil((existing.banUntil - currentTime) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(existing.banReason === 'flood' ? 429 : 403).end();
    }

    if (!startsWithAny(path, FLOOD_EXEMPT_PREFIXES)) {
      let counter = floodCounters.get(ip);
      if (!counter || currentTime - counter.windowStart >= settings.floodWindowMs) {
        trimMap(floodCounters);
        counter = { count: 1, windowStart: currentTime, warned: false };
        floodCounters.set(ip, counter);
      } else {
        counter.count += 1;
      }

      if (counter.count >= settings.floodWarning && !counter.warned) {
        counter.warned = true;
        counters.totalFloodWarnings += 1;
        logger(req, {
          type: 'bot_flood_warning',
          severity: 'warning',
          details: `Bot Shield : cadence anormale (${counter.count} req/min)`,
        });
      }
      if (counter.count >= settings.floodBan) {
        counters.totalFloodBans += 1;
        counters.totalBlocked += 1;
        banSource(req, ip, 'flood', rawTarget);
        counter.count = 0;
        res.set('Retry-After', String(Math.ceil(settings.banBaseMs / 1000)));
        return res.status(429).end();
      }
    }

    const category = classifySuspiciousPath(rawTarget);
    if (!category) return next();

    const record = getOrCreateRecord(ip);
    if (currentTime - record.lastStrike > settings.strikeDecayMs) record.strikes = 0;
    record.strikes += 1;
    record.lastStrike = currentTime;
    record.lastSeen = currentTime;
    record.lastPath = safeDisplayedPath(rawTarget);
    if (!record.probeCategories.includes(category)) {
      record.probeCategories.push(category);
      if (record.probeCategories.length > 6) record.probeCategories.shift();
    }
    counters.totalProbes += 1;
    logger(req, {
      type: 'bot_probe',
      severity: 'warning',
      statusCode: 404,
      details: `Bot Shield : sonde ${category}`,
    });

    if (record.strikes >= settings.maxStrikes) {
      counters.totalBlocked += 1;
      banSource(req, ip, 'scanner', rawTarget);
      return res.status(403).end();
    }
    return res.status(404).type('text/plain').send('Page introuvable.');
  }

  middleware.getStats = () => {
    const currentTime = now();
    return {
      enabled: settings.enabled,
      maxStrikes: settings.maxStrikes,
      floodWarning: settings.floodWarning,
      floodBan: settings.floodBan,
      trackedSources: sourceRecords.size,
      activeBans: [...sourceRecords.values()].filter((record) => record.banUntil > currentTime).length,
      totalBlocked: counters.totalBlocked,
      totalProbes: counters.totalProbes,
      totalFloodBans: counters.totalFloodBans,
      totalFloodWarnings: counters.totalFloodWarnings,
      startedAt: new Date(startedAt).toISOString(),
    };
  };

  middleware.getSourceDetails = () => {
    const currentTime = now();
    const details = [];
    for (const [ip, record] of sourceRecords) {
      const flood = floodCounters.get(ip);
      details.push({
        sourceHash: fingerprint({ ip, socket: {} }),
        strikes: record.strikes,
        banCount: record.banCount,
        banReason: record.banReason,
        isBanned: record.banUntil > currentTime,
        banRemainingSeconds: record.banUntil > currentTime ? Math.ceil((record.banUntil - currentTime) / 1000) : 0,
        requestsInWindow: flood && currentTime - flood.windowStart < settings.floodWindowMs ? flood.count : 0,
        lastSeen: new Date(record.lastSeen).toISOString(),
        lastPath: record.lastPath,
        probeCategories: [...record.probeCategories],
      });
    }
    details.sort((a, b) => Number(b.isBanned) - Number(a.isBanned)
      || b.requestsInWindow - a.requestsInWindow
      || b.strikes - a.strikes
      || b.banCount - a.banCount);
    return details.slice(0, 100);
  };

  middleware.unbanSource = (sourceHash) => {
    for (const [ip, record] of sourceRecords) {
      if (fingerprint({ ip, socket: {} }) !== sourceHash) continue;
      record.banUntil = 0;
      record.strikes = 0;
      record.banReason = '';
      floodCounters.delete(ip);
      return true;
    }
    return false;
  };

  middleware.close = () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
  };
  middleware.cleanup = cleanup;
  middleware.settings = Object.freeze({ ...settings });
  return middleware;
}

const botShield = createBotShield();
botShield.createBotShield = createBotShield;
botShield.classifySuspiciousPath = classifySuspiciousPath;
module.exports = botShield;
