const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { cleanBody } = require('../utils/sanitize');
const { normalizeHttpsUrl, youtubeEmbedUrl } = require('../utils/profile');
const { passwordValidationError, hashPassword, verifyPassword } = require('../utils/passwords');
const { establishAuthenticatedSession } = require('../utils/session');
const { canUseGifAvatar, isGifUrl } = require('../utils/points');

const router = express.Router();
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/compte', requireAuth, (req, res) => {
  res.render('account', { error: null, success: null });
});

router.post('/compte/profil', requireAuth, (req, res) => {
  const avatarUrl = normalizeHttpsUrl(req.body.avatar_url || '');
  const profileBgUrl = normalizeHttpsUrl(req.body.profile_bg_url || '', { imgurOnly: true });
  const youtubeUrl = normalizeHttpsUrl(req.body.youtube_url || '');
  const bio = String(req.body.bio || '').trim().slice(0, 2000);
  if (avatarUrl === null) return res.render('account', { error: "L'avatar doit utiliser une adresse HTTPS valide.", success: null });
  if (avatarUrl && isGifUrl(avatarUrl) && !canUseGifAvatar(req.user)) {
    return res.render('account', {
      error: 'Les avatars GIF sont accessibles à partir du rang Platine (5 000 points).',
      success: null,
    });
  }
  if (profileBgUrl === null) return res.render('account', { error: "Le fond de profil doit être un lien HTTPS hébergé sur Imgur.", success: null });
  if (youtubeUrl === null || (youtubeUrl && !youtubeEmbedUrl(youtubeUrl))) {
    return res.render('account', { error: 'Le lien musical doit pointer vers une vidéo YouTube valide.', success: null });
  }
  db.prepare(
    'UPDATE users SET avatar_url = ?, profile_bg_url = ?, youtube_url = ?, bio = ? WHERE id = ?'
  ).run(avatarUrl, profileBgUrl, youtubeUrl, bio, req.user.id);
  req.user.avatar_url = avatarUrl;
  req.user.profile_bg_url = profileBgUrl;
  req.user.youtube_url = youtubeUrl;
  req.user.bio = bio;
  req.session.toast = { type: 'success', message: 'Les modifications du profil ont bien été enregistrées.' };
  res.redirect('/compte');
});

router.post('/compte/signature', requireAuth, (req, res) => {
  const signature = cleanBody(req.body.signature).slice(0, 300);
  db.prepare('UPDATE users SET signature = ? WHERE id = ?').run(signature, req.user.id);
  res.render('account', { error: null, success: 'Signature mise à jour.' });
});

router.post('/compte/mot-de-passe', requireAuth, passwordChangeLimiter, async (req, res, next) => {
  try {
  const { current_password, new_password, new_password_confirm } = req.body;
  const ok = await verifyPassword(current_password || '', req.user.password_hash);
  if (!ok) {
    return res.render('account', { error: 'Mot de passe actuel incorrect.', success: null });
  }
  const passwordError = passwordValidationError(new_password);
  if (passwordError) return res.render('account', { error: passwordError, success: null });
  if (new_password !== new_password_confirm) {
    return res.render('account', { error: 'Les deux nouveaux mots de passe ne correspondent pas.', success: null });
  }
  const hash = await hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?').run(hash, req.user.id);
  const updatedUser = db.prepare('SELECT id, session_version FROM users WHERE id = ?').get(req.user.id);
  await establishAuthenticatedSession(req, updatedUser);
  req.session.toast = { type: 'success', message: 'Mot de passe changé. Toutes les autres sessions ont été déconnectées.' };
  return res.redirect('/compte');
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
