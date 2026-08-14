const bcrypt = require('bcryptjs');

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 72;
const BCRYPT_COST = 12;
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('avebar-invalid-password-placeholder', BCRYPT_COST);

function passwordValidationError(password, { minimum = MIN_PASSWORD_LENGTH } = {}) {
  const value = String(password || '');
  if (value.length < minimum) return `Le mot de passe doit contenir au moins ${minimum} caractères.`;
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Le mot de passe ne peut pas dépasser ${MAX_PASSWORD_BYTES} octets.`;
  }
  return null;
}

function hashPassword(password) {
  const value = String(password);
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    return Promise.reject(new Error('PASSWORD_TOO_LONG'));
  }
  return bcrypt.hash(value, BCRYPT_COST);
}

function hashPasswordSync(password) {
  const value = String(password);
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) throw new Error('PASSWORD_TOO_LONG');
  return bcrypt.hashSync(value, BCRYPT_COST);
}

function verifyPassword(password, hash) {
  const value = String(password || '');
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    return bcrypt.compare('avebar-invalid-password-placeholder', DUMMY_PASSWORD_HASH).then(() => false);
  }
  return bcrypt.compare(value, hash || DUMMY_PASSWORD_HASH);
}

function verifyPasswordSync(password, hash) {
  const value = String(password || '');
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    bcrypt.compareSync('avebar-invalid-password-placeholder', DUMMY_PASSWORD_HASH);
    return false;
  }
  return bcrypt.compareSync(value, hash || DUMMY_PASSWORD_HASH);
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  BCRYPT_COST,
  passwordValidationError,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  verifyPasswordSync,
};
