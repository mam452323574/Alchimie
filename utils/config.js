const PLACEHOLDERS = new Set([
  'dev_secret_change_me',
  'change_moi_en_une_longue_chaine_aleatoire',
  'change_moi_mot_de_passe_admin',
  'change_moi_avec_un_secret_distinct_de_64_caracteres',
  'changeme',
  '1234',
]);

function isPlaceholder(value) {
  return !value || PLACEHOLDERS.has(String(value).trim());
}

function validateProductionEnvironment() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems = [];
  const sessionSecret = String(process.env.SESSION_SECRET || '');
  if (sessionSecret.length < 64 || isPlaceholder(sessionSecret)) {
    problems.push('SESSION_SECRET doit être aléatoire et contenir au moins 64 caractères');
  }
  const securityLogKey = String(process.env.SECURITY_LOG_KEY || '');
  if (securityLogKey.length < 32 || isPlaceholder(securityLogKey)) {
    problems.push('SECURITY_LOG_KEY doit être distincte et contenir au moins 32 caractères');
  }
  const dataKey = String(process.env.DATA_ENCRYPTION_KEY || '');
  let validDataKey = /^[a-f0-9]{64}$/i.test(dataKey);
  if (!validDataKey) {
    try { validDataKey = Buffer.from(dataKey, 'base64').length === 32; } catch { validDataKey = false; }
  }
  if (!validDataKey) problems.push('DATA_ENCRYPTION_KEY doit contenir 32 octets (64 caractères hexadécimaux ou base64)');
  try {
    const siteUrl = new URL(process.env.SITE_URL || '');
    if (siteUrl.protocol !== 'https:' || siteUrl.username || siteUrl.password
        || siteUrl.pathname !== '/' || siteUrl.search || siteUrl.hash) {
      problems.push('SITE_URL doit être une origine HTTPS sans identifiants ni sous-chemin');
    }
  } catch {
    problems.push('SITE_URL doit être une URL HTTPS publique valide');
  }
  if (process.env.COOKIE_SECURE !== 'true') problems.push('COOKIE_SECURE doit valoir true');
  if (!['127.0.0.1', '::1'].includes(String(process.env.HOST || ''))) {
    problems.push('HOST doit rester lié à 127.0.0.1 ou ::1 derrière le reverse proxy');
  }
  if (String(process.env.TRUST_PROXY || 'loopback') !== 'loopback') {
    problems.push('TRUST_PROXY doit valoir loopback pour la topologie VPS fournie');
  }
  if (securityLogKey && securityLogKey === sessionSecret) {
    problems.push('SECURITY_LOG_KEY et SESSION_SECRET doivent être différentes');
  }
  if (dataKey && [sessionSecret, securityLogKey].includes(dataKey)) {
    problems.push('DATA_ENCRYPTION_KEY doit être différente des autres secrets');
  }
  const smtpValues = [process.env.SMTP_HOST, process.env.SMTP_USER, process.env.SMTP_PASS, process.env.MAIL_FROM];
  const smtpLooksLikeExample = smtpValues.some((value) => !value || /votre-|votre\.|@votre-domaine\.fr/i.test(String(value)));
  if (smtpLooksLikeExample) {
    problems.push('SMTP_HOST, SMTP_USER, SMTP_PASS et MAIL_FROM sont obligatoires pour valider réellement les comptes');
  }
  const smtpPort = Number.parseInt(process.env.SMTP_PORT, 10);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    problems.push('SMTP_PORT doit être un port TCP valide');
  }
  if (process.env.ADMIN_PASSWORD && isPlaceholder(process.env.ADMIN_PASSWORD)) {
    problems.push('ADMIN_PASSWORD ne peut pas conserver sa valeur d’exemple');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(process.env.ADMIN_EMAIL || ''))
      || /@votre-domaine\.fr$/i.test(String(process.env.ADMIN_EMAIL || ''))) {
    problems.push('ADMIN_EMAIL doit contenir l’adresse réelle du compte développeur initial');
  }
  if (process.env.MODERATION_PASSWORD && isPlaceholder(process.env.MODERATION_PASSWORD)) {
    problems.push('MODERATION_PASSWORD ne peut pas conserver sa valeur initiale');
  }
  if (problems.length) {
    throw new Error(`Configuration de production refusée :\n- ${problems.join('\n- ')}`);
  }
}

module.exports = { validateProductionEnvironment, isPlaceholder };
