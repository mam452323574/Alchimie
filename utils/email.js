const nodemailer = require('nodemailer');

function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (!hasSmtpConfig()) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    requireTLS: process.env.SMTP_SECURE !== 'true',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

async function sendVerificationEmail({ email, username, verificationUrl, siteName }) {
  const transport = getTransport();
  if (!transport) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Configuration SMTP absente en production.');
    }
    console.log(`[email-dev] Validation pour ${username}: ${verificationUrl}`);
    return { delivered: false, developmentUrl: verificationUrl };
  }

  await transport.sendMail({
    from: process.env.MAIL_FROM || `noreply@${new URL(verificationUrl).hostname}`,
    to: email,
    subject: `Valide ton inscription sur ${siteName}`,
    text: `Bonjour ${username},\n\nValide ton adresse e-mail et crée ton compte en ouvrant ce lien :\n${verificationUrl}\n\nCe lien expire dans 24 heures.`,
    html: `<p>Bonjour <strong>${escapeHtml(username)}</strong>,</p><p>Valide ton adresse e-mail pour créer ton compte sur ${escapeHtml(siteName)}.</p><p><a href="${escapeHtml(verificationUrl)}">Valider mon inscription</a></p><p>Ce lien expire dans 24 heures.</p>`,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return { delivered: true, developmentUrl: null };
}

module.exports = { sendVerificationEmail, hasSmtpConfig };
