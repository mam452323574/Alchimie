const crypto = require('crypto');
const db = require('../db/database');

let lastPruneAt = 0;

function sanitizeLogValue(value, maximum = 180) {
  return String(value || '').replace(/[\r\n\0]/g, ' ').slice(0, maximum);
}

function sourceFingerprint(req) {
  const source = req.ip || req.socket?.remoteAddress || 'unknown';
  const secret = process.env.SECURITY_LOG_KEY || process.env.SESSION_SECRET || 'local-development-key';
  return crypto.createHmac('sha256', secret).update(source).digest('hex').slice(0, 16);
}

function pruneSecurityEvents() {
  const now = Date.now();
  if (now - lastPruneAt < 60 * 60 * 1000) return;
  lastPruneAt = now;
  db.prepare("DELETE FROM security_events WHERE created_at < datetime('now', '-90 days')").run();
}

function logSecurityEvent(req, event = {}) {
  try {
    pruneSecurityEvents();
    const eventType = sanitizeLogValue(event.type, 50) || 'unknown';
    const severity = ['info', 'warning', 'critical'].includes(event.severity) ? event.severity : 'info';
    const sourceHash = sourceFingerprint(req);
    const recentDuplicates = db.prepare(
      `SELECT COUNT(*) AS c FROM security_events
       WHERE event_type = ? AND source_hash = ? AND created_at >= datetime('now', '-1 minute')`
    ).get(eventType, sourceHash).c;
    if (recentDuplicates >= 25) return;
    db.prepare(
      `INSERT INTO security_events
       (event_type, severity, actor_user_id, source_hash, path, method, status_code, details, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventType,
      severity,
      Number.isInteger(event.actorUserId) ? event.actorUserId : (req.user?.id || null),
      sourceHash,
      sanitizeLogValue(req.path, 180),
      sanitizeLogValue(req.method, 10),
      Number.isInteger(event.statusCode) ? event.statusCode : null,
      sanitizeLogValue(event.details, 300),
      sanitizeLogValue(req.get?.('user-agent'), 180)
    );
  } catch (error) {
    console.error('[security-log] Écriture impossible:', error.message);
  }
}

function securityRequestMonitor(req, res, next) {
  const rawTarget = String(req.originalUrl || req.url || '').slice(0, 500);
  let requestTarget = rawTarget;
  try { requestTarget = decodeURIComponent(rawTarget); } catch (_error) {
    logSecurityEvent(req, {
      type: 'invalid_encoding',
      severity: 'warning',
      details: 'Encodage d’URL invalide',
    });
  }
  const suspiciousPatterns = [
    /(?:^|\/)\.(?:env|git|svn)(?:\/|$)/i,
    /wp-(?:admin|login)|phpmyadmin|adminer/i,
    /(?:forum|sessions)\.sqlite3|\/etc\/passwd/i,
    /\.\.\/|%2e%2e|<script|union\s+(?:all\s+)?select/i,
  ];
  if (suspiciousPatterns.some((pattern) => pattern.test(requestTarget))) {
    logSecurityEvent(req, {
      type: 'sensitive_probe',
      severity: 'critical',
      details: 'Requête correspondant à un motif de reconnaissance ou d’accès sensible',
    });
  }
  if (['TRACE', 'CONNECT'].includes(req.method)) {
    logSecurityEvent(req, {
      type: 'unexpected_method',
      severity: 'warning',
      details: 'Méthode HTTP inhabituelle',
    });
  }
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      logSecurityEvent(req, {
        type: 'server_error',
        severity: 'warning',
        statusCode: res.statusCode,
        details: 'Erreur serveur retournée au client',
      });
    }
  });
  next();
}

module.exports = { logSecurityEvent, securityRequestMonitor };
