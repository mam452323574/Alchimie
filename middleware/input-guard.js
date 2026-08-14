const { logSecurityEvent } = require('../utils/security');

const MAX_PARAMETER_COUNT = 120;
const MAX_PARAMETER_NAME_LENGTH = 80;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function inspectContainer(value, location) {
  if (value === undefined || value === null || Buffer.isBuffer(value)) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { location, reason: 'container_type' };
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_PARAMETER_COUNT) {
    return { location, reason: 'parameter_count' };
  }

  for (const [key, parameterValue] of entries) {
    const normalizedKey = String(key).toLowerCase();
    if (
      key.length < 1
      || key.length > MAX_PARAMETER_NAME_LENGTH
      || /[\0\r\n]/.test(key)
      || FORBIDDEN_KEYS.has(normalizedKey)
      || key.startsWith('$')
    ) {
      return { location, reason: 'parameter_name' };
    }
    if (Array.isArray(parameterValue) || (parameterValue !== null && typeof parameterValue === 'object')) {
      return { location, reason: 'ambiguous_parameter' };
    }
  }
  return null;
}

function findInputIssue(req) {
  return inspectContainer(req.query, 'query') || inspectContainer(req.body, 'body');
}

function inputGuard(req, res, next) {
  const issue = findInputIssue(req);
  if (!issue) return next();

  logSecurityEvent(req, {
    type: 'malformed_parameters',
    severity: 'warning',
    statusCode: 400,
    details: `Paramètres refusés (${issue.location}:${issue.reason})`,
  });
  res.set('Cache-Control', 'no-store');
  if (String(req.get?.('accept') || '').includes('application/json')) {
    return res.status(400).json({ error: 'Paramètres de requête invalides.' });
  }
  return res.status(400).type('text/plain').send('Paramètres de requête invalides.');
}

module.exports = { inputGuard, findInputIssue, inspectContainer };
