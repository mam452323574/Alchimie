const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { getPrivateConversation } = require('../utils/private-messages');
const { processUploadedImage } = require('../utils/image-upload');
const { logSecurityEvent } = require('../utils/security');

const router = express.Router();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DAILY_UPLOADS = 20;
const MAX_DAILY_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 2;
const MAX_ACTIVE_UPLOADS_PER_USER = 1;
const MAX_STORED_UPLOADS = Math.max(100, Number.parseInt(process.env.MAX_STORED_UPLOADS, 10) || 10000);
const MAX_STORED_UPLOAD_BYTES = Math.max(100 * 1024 * 1024, Number.parseInt(process.env.MAX_STORED_UPLOAD_BYTES, 10) || 5 * 1024 * 1024 * 1024);
const uploadDirectory = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'storage', 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });
try { fs.chmodSync(uploadDirectory, 0o700); } catch (_error) { /* système sans chmod */ }

const parseImageBody = express.raw({ type: () => true, limit: MAX_IMAGE_BYTES });
const activeUploadsByUser = new Map();
let activeUploads = 0;

function validCsrf(req) {
  const expected = String(req.session.csrfToken || '');
  const received = String(req.get('x-csrf-token') || '');
  return /^[a-f0-9]{64}$/.test(expected)
    && /^[a-f0-9]{64}$/.test(received)
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function originalFileName(req, extension) {
  let decoded = '';
  try { decoded = decodeURIComponent(String(req.get('x-file-name') || '')); } catch (_error) { decoded = ''; }
  const base = path.basename(decoded);
  const stem = base.slice(0, Math.max(0, base.length - path.extname(base).length))
    .replace(/[^a-zA-Z0-9À-ÿ._ -]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 110);
  return `${stem || 'image'}.${extension}`;
}

function safeDownloadName(value) {
  return String(value || 'image.webp')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'image.webp';
}

function acquireUploadSlot(req, res, next) {
  const userId = req.user.id;
  const userActive = activeUploadsByUser.get(userId) || 0;
  if (activeUploads >= MAX_ACTIVE_UPLOADS || userActive >= MAX_ACTIVE_UPLOADS_PER_USER) {
    logSecurityEvent(req, {
      type: 'upload_concurrency_reached',
      severity: 'warning',
      statusCode: 429,
      details: 'Traitement d’image simultané refusé',
    });
    res.set('Retry-After', '5');
    return res.status(429).json({ error: 'Une image est déjà en cours de traitement. Réessaie dans quelques secondes.' });
  }

  activeUploads += 1;
  activeUploadsByUser.set(userId, userActive + 1);
  let released = false;
  req.releaseUploadSlot = () => {
    if (released) return;
    released = true;
    activeUploads = Math.max(0, activeUploads - 1);
    const remaining = Math.max(0, (activeUploadsByUser.get(userId) || 1) - 1);
    if (remaining) activeUploadsByUser.set(userId, remaining);
    else activeUploadsByUser.delete(userId);
  };
  return next();
}

const reserveUpload = db.transaction((image) => {
  const usage = db.prepare(
    `SELECT COUNT(*) AS uploads, COALESCE(SUM(byte_size), 0) AS bytes
     FROM uploaded_images WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`
  ).get(image.userId);
  if (usage.uploads >= MAX_DAILY_UPLOADS || usage.bytes + image.byteSize > MAX_DAILY_BYTES) {
    return { ok: false, reason: 'user_quota' };
  }

  const globalUsage = db.prepare(
    'SELECT COUNT(*) AS uploads, COALESCE(SUM(byte_size), 0) AS bytes FROM uploaded_images'
  ).get();
  if (globalUsage.uploads >= MAX_STORED_UPLOADS || globalUsage.bytes + image.byteSize > MAX_STORED_UPLOAD_BYTES) {
    return { ok: false, reason: 'global_capacity' };
  }

  db.prepare(
    `INSERT INTO uploaded_images
     (token, user_id, storage_name, original_name, mime_type, byte_size, visibility, conversation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    image.token,
    image.userId,
    image.storageName,
    image.originalName,
    image.mime,
    image.byteSize,
    image.visibility,
    image.conversationId
  );
  return { ok: true };
});

function claimPrivateUploads(userId, conversationId, body) {
  const tokens = [...new Set(
    [...String(body || '').matchAll(/\/media\/([a-f0-9]{48})(?:\b|$)/gi)].map((match) => match[1].toLowerCase())
  )];
  if (!tokens.length) return;
  const claim = db.prepare(
    `UPDATE uploaded_images SET visibility = 'private', conversation_id = ?
     WHERE token = ? AND user_id = ? AND visibility = 'private_pending'`
  );
  tokens.forEach((token) => claim.run(conversationId, token, userId));
}

router.post('/api/images', requireAuth, (req, res, next) => {
  if (!validCsrf(req)) {
    logSecurityEvent(req, { type: 'upload_csrf_failed', severity: 'warning', statusCode: 403 });
    return res.status(403).json({ error: 'La vérification de sécurité a expiré. Recharge la page.' });
  }
  return next();
}, acquireUploadSlot, (req, res, next) => {
  parseImageBody(req, res, (error) => {
    if (!error) return next();
    req.releaseUploadSlot?.();
    const tooLarge = error.type === 'entity.too.large';
    logSecurityEvent(req, {
      type: tooLarge ? 'upload_too_large' : 'upload_invalid_file',
      severity: 'warning',
      statusCode: tooLarge ? 413 : 400,
      details: tooLarge ? 'Image source supérieure à 5 Mo' : 'Corps d’upload illisible',
    });
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'L’image dépasse la limite de 5 Mo.' : 'Image illisible.',
    });
  });
}, async (req, res) => {
  let destination = '';
  let committed = false;
  try {
    const requestedScope = String(req.query.scope || 'public');
    const conversationId = Number.parseInt(req.query.conversation_id, 10) || null;
    let visibility = 'public';
    if (requestedScope === 'private') {
      if (conversationId) {
        if (!getPrivateConversation(conversationId, req.user.id)) {
          return res.status(404).json({ error: 'Conversation privée introuvable.' });
        }
        visibility = 'private';
      } else {
        visibility = 'private_pending';
      }
    }

    const processed = await processUploadedImage(req.body);
    const token = crypto.randomBytes(24).toString('hex');
    const storageName = `${crypto.randomBytes(24).toString('hex')}.${processed.extension}`;
    destination = path.join(uploadDirectory, storageName);
    await fs.promises.writeFile(destination, processed.buffer, { flag: 'wx', mode: 0o600 });

    const reservation = reserveUpload({
      token,
      userId: req.user.id,
      storageName,
      originalName: originalFileName(req, processed.extension),
      mime: processed.mime,
      byteSize: processed.byteSize,
      visibility,
      conversationId: visibility === 'private' ? conversationId : null,
    });
    if (!reservation.ok) {
      await fs.promises.unlink(destination).catch(() => {});
      destination = '';
      if (reservation.reason === 'global_capacity') {
        logSecurityEvent(req, {
          type: 'upload_capacity_reached',
          severity: 'critical',
          statusCode: 507,
          details: 'Capacité globale du stockage des images atteinte',
        });
        return res.status(507).json({ error: 'Le stockage des images est momentanément indisponible.' });
      }
      return res.status(429).json({ error: 'Ton quota d’images des dernières 24 heures est atteint.' });
    }
    committed = true;
    return res.status(201).json({ url: `/media/${token}`, mime: processed.mime });
  } catch (error) {
    if (!committed && destination) await fs.promises.unlink(destination).catch(() => {});
    const rejectedCodes = new Set([
      'UNSUPPORTED_IMAGE',
      'INVALID_IMAGE',
      'INVALID_DIMENSIONS',
      'ANIMATION_TOO_LARGE',
      'ANIMATION_DIMENSIONS',
      'OUTPUT_TOO_LARGE',
    ]);
    if (rejectedCodes.has(error.code)) {
      const statusCode = error.code === 'OUTPUT_TOO_LARGE' ? 413 : 415;
      logSecurityEvent(req, {
        type: error.code === 'INVALID_DIMENSIONS' ? 'upload_invalid_dimensions' : 'upload_invalid_file',
        severity: 'warning',
        statusCode,
        details: `Image refusée par le décodeur (${error.code})`,
      });
      return res.status(statusCode).json({ error: error.message });
    }
    console.error('[upload] Enregistrement impossible:', error.message);
    return res.status(500).json({ error: 'L’image n’a pas pu être enregistrée.' });
  } finally {
    req.releaseUploadSlot?.();
  }
});

router.get('/media/:token([a-f0-9]{48})', (req, res) => {
  const image = db.prepare('SELECT * FROM uploaded_images WHERE token = ?').get(req.params.token);
  if (!image) return res.status(404).end();
  if (image.visibility !== 'public') {
    const allowed = req.user && (
      image.user_id === req.user.id
      || (image.conversation_id && getPrivateConversation(image.conversation_id, req.user.id))
    );
    if (!allowed) return res.status(404).end();
  }
  if (!/^[a-f0-9]{48}\.(?:png|jpe?g|gif|webp)$/i.test(image.storage_name)) {
    logSecurityEvent(req, {
      type: 'upload_integrity_mismatch',
      severity: 'critical',
      statusCode: 404,
      details: 'Nom de stockage invalide dans la base',
    });
    return res.status(404).end();
  }
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime_type)) return res.status(404).end();

  const absolutePath = path.resolve(uploadDirectory, image.storage_name);
  if (path.dirname(absolutePath) !== uploadDirectory) return res.status(404).end();
  let stat;
  try { stat = fs.lstatSync(absolutePath); } catch { return res.status(404).end(); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== image.byte_size) {
    logSecurityEvent(req, {
      type: 'upload_integrity_mismatch',
      severity: 'critical',
      statusCode: 404,
      details: 'Fichier média absent, irrégulier ou de taille inattendue',
    });
    return res.status(404).end();
  }

  res.set({
    'Content-Type': image.mime_type,
    'Content-Disposition': `inline; filename="${safeDownloadName(image.original_name)}"`,
    'Cache-Control': image.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  return res.sendFile(absolutePath);
});

module.exports = { router, claimPrivateUploads };
