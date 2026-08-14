const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function configuredKey() {
  const raw = String(process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

function encryptionEnabled() {
  return Boolean(configuredKey());
}

function seal(value, context = 'avebar-data') {
  const plaintext = String(value || '');
  const key = configuredKey();
  if (!key || !plaintext || plaintext.startsWith(PREFIX)) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

function open(value, context = 'avebar-data') {
  const stored = String(value || '');
  if (!stored.startsWith(PREFIX)) return stored;
  const key = configuredKey();
  if (!key) throw new Error('DATA_ENCRYPTION_KEY manquante pour déchiffrer les données.');
  const payload = Buffer.from(stored.slice(PREFIX.length), 'base64url');
  if (payload.length < 29) throw new Error('Donnée chiffrée invalide.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
}

function lookupHash(value, context = 'lookup') {
  const normalized = String(value || '').trim().toLowerCase();
  const key = configuredKey();
  return key
    ? crypto.createHmac('sha256', key).update(`${context}:${normalized}`).digest('hex')
    : crypto.createHash('sha256').update(`${context}:${normalized}`).digest('hex');
}

function protectEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return { encrypted: seal(normalized, 'user-email'), lookup: lookupHash(normalized, 'user-email') };
}

function revealEmail(value) {
  return open(value, 'user-email');
}

function protectPrivateMessage(body) {
  return seal(body, 'private-message');
}

function revealPrivateMessage(body) {
  return open(body, 'private-message');
}

module.exports = {
  encryptionEnabled,
  seal,
  open,
  lookupHash,
  protectEmail,
  revealEmail,
  protectPrivateMessage,
  revealPrivateMessage,
};
