const db = require('../db/database');

const POINT_RULES = Object.freeze({
  topicCreated: 2,
  messageCreated: 1,
  messageDeleted: -2,
  topicDeleted: -3,
  messageRestored: 2,
  topicRestored: 3,
});

const RANKS = Object.freeze([
  { key: 'poire', label: 'Poire', min: Number.NEGATIVE_INFINITY, max: -1 },
  { key: 'carton', label: 'Carton', min: 0, max: 99 },
  { key: 'bronze', label: 'Bronze', min: 100, max: 499 },
  { key: 'argent', label: 'Argent', min: 500, max: 1499 },
  { key: 'or', label: 'Or', min: 1500, max: 4999 },
  { key: 'platine', label: 'Platine', min: 5000, max: 9999 },
  { key: 'rubis', label: 'Rubis', min: 10000, max: 19999 },
  { key: 'saphir', label: 'Saphir', min: 20000, max: 49999 },
  { key: 'emeraude', label: 'Émeraude', min: 50000, max: 99999 },
  { key: 'diamant', label: 'Diamant', min: 100000, max: Number.POSITIVE_INFINITY },
]);

function normalizePoints(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function rankForPoints(value) {
  const points = normalizePoints(value);
  return RANKS.find((rank) => points >= rank.min && points <= rank.max) || RANKS[1];
}

function isGifUrl(value) {
  if (!value) return false;
  try {
    return new URL(String(value)).pathname.toLowerCase().endsWith('.gif');
  } catch (_error) {
    return /\.gif(?:$|[?#])/i.test(String(value));
  }
}

function canAccessBlackTopics(user) {
  return normalizePoints(user?.points) >= 100;
}

function canUseGifAvatar(user) {
  return normalizePoints(user?.points) >= 5000;
}

function adjustPoints(userId, delta) {
  const amount = normalizePoints(delta);
  if (!userId || !amount) return null;
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(amount, userId);
  const user = db.prepare('SELECT id, points, avatar_url FROM users WHERE id = ?').get(userId);
  // Le droit au GIF disparaît si le solde repasse sous Platine. L'URL est
  // conservée dans le formulaire tant qu'elle est statique, mais un GIF ne
  // peut pas contourner le seuil après une perte de points.
  if (user && !canUseGifAvatar(user) && isGifUrl(user.avatar_url)) {
    db.prepare("UPDATE users SET avatar_url = '' WHERE id = ?").run(userId);
    user.avatar_url = '';
  }
  return user;
}

module.exports = {
  POINT_RULES,
  RANKS,
  adjustPoints,
  canAccessBlackTopics,
  canUseGifAvatar,
  isGifUrl,
  normalizePoints,
  rankForPoints,
};
