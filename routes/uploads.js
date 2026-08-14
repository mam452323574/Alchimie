const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { getPrivateConversation } = require('../utils/private-messages');
const { logSecurityEvent } = require('../utils/security');

const router = express.Router();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DAILY_UPLOADS = 20;
const MAX_DAILY_BYTES = 50 * 1024 * 1024;
const MAX_STORED_UPLOADS = Math.max(100, Number.parseInt(process.env.MAX_STORED_UPLOADS, 10) || 10000);
const MAX_STORED_UPLOAD_BYTES = Math.max(100 * 1024 * 1024, Number.parseInt(process.env.MAX_STORED_UPLOAD_BYTES, 10) || 5 * 1024 * 1024 * 1024);
const uploadDirectory = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'storage', 'uploads');
fs.mkdirSync(uploadDirectory, { recursive: true, mode: 0o750 });
try { fs.chmodSync(uploadDirectory, 0o700); } catch (_error) { /* système sans chmod */ }

const parseImageBody = express.raw({ type: () => true, limit: MAX_IMAGE_BYTES });

function validCsrf(req) {
  const expected = String(req.session.csrfToken || '');
  const received = String(req.get('x-csrf-token') || '');
  return /^[a-f0-9]{64}$/.test(expected)
    && /^[a-f0-9]{64}$/.test(received)
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function imageDimensions(buffer, detected) {
  try {
    if (detected.extension === 'png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (detected.extension === 'gif') return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (detected.extension === 'webp') {
      const type = buffer.subarray(12, 16).toString('ascii');
      if (type === 'VP8X' && buffer.length >= 30) {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3),
        };
      }
      if (type === 'VP8 ' && buffer.length >= 30
          && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        };
      }
      if (type === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
        const bits = buffer.readUInt32LE(21);
        return {
          width: 1 + (bits & 0x3fff),
          height: 1 + ((bits >>> 14) & 0x3fff),
        };
      }
    }
    if (detected.extension === 'jpg') {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        }
        if (length < 2) break;
        offset += length + 2;
      }
    }
  } catch { return null; }
  return null;
}

function detectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', extension: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpg' };
  }
  const gifHeader = buffer.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') return { mime: 'image/gif', extension: 'gif' };
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', extension: 'webp' };
  }
  return null;
}

function originalFileName(req, extension) {
  let decoded = '';
  try { decoded = decodeURIComponent(String(req.get('x-file-name') || '')); } catch (_error) { decoded = ''; }
  const safe = path.basename(decoded).replace(/[^a-zA-Z0-9À-ÿ._ -]/g, '_').slice(0, 120);
  return safe || `image.${extension}`;
}

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
  return parseImageBody(req, res, (error) => {
    if (error) {
      const tooLarge = error.type === 'entity.too.large';
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'L’image dépasse la limite de 5 Mo.' : 'Image illisible.' });
    }
    return next();
  });
}, (req, res) => {
  const detected = detectImage(req.body);
  if (!detected) {
    logSecurityEvent(req, { type: 'upload_invalid_file', severity: 'warning', statusCode: 415 });
    return res.status(415).json({ error: 'Format refusé. Utilise une image PNG, JPEG, GIF ou WebP.' });
  }
  const dimensions = imageDimensions(req.body, detected);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 12000 || dimensions.height > 12000 || dimensions.width * dimensions.height > 60_000_000) {
    logSecurityEvent(req, { type: 'upload_invalid_dimensions', severity: 'warning', statusCode: 415 });
    return res.status(415).json({ error: 'Les dimensions de cette image sont refusées.' });
  }

  const usage = db.prepare(
    `SELECT COUNT(*) AS uploads, COALESCE(SUM(byte_size), 0) AS bytes
     FROM uploaded_images WHERE user_id = ? AND created_at >= datetime('now', '-1 day')`
  ).get(req.user.id);
  if (usage.uploads >= MAX_DAILY_UPLOADS || usage.bytes + req.body.length > MAX_DAILY_BYTES) {
    return res.status(429).json({ error: 'Ton quota d’images des dernières 24 heures est atteint.' });
  }
  const globalUsage = db.prepare(
    'SELECT COUNT(*) AS uploads, COALESCE(SUM(byte_size), 0) AS bytes FROM uploaded_images'
  ).get();
  if (globalUsage.uploads >= MAX_STORED_UPLOADS || globalUsage.bytes + req.body.length > MAX_STORED_UPLOAD_BYTES) {
    logSecurityEvent(req, {
      type: 'upload_capacity_reached', severity: 'critical', statusCode: 507,
      details: 'Capacité globale du stockage des images atteinte',
    });
    return res.status(507).json({ error: 'Le stockage des images est momentanément indisponible.' });
  }

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

  const token = crypto.randomBytes(24).toString('hex');
  const storageName = `${crypto.randomBytes(24).toString('hex')}.${detected.extension}`;
  const destination = path.join(uploadDirectory, storageName);
  try {
    fs.writeFileSync(destination, req.body, { flag: 'wx', mode: 0o640 });
    db.prepare(
      `INSERT INTO uploaded_images
       (token, user_id, storage_name, original_name, mime_type, byte_size, visibility, conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      token,
      req.user.id,
      storageName,
      originalFileName(req, detected.extension),
      detected.mime,
      req.body.length,
      visibility,
      visibility === 'private' ? conversationId : null
    );
  } catch (error) {
    try { fs.unlinkSync(destination); } catch (_unlinkError) { /* aucun fichier à nettoyer */ }
    console.error('[upload] Enregistrement impossible:', error.message);
    return res.status(500).json({ error: 'L’image n’a pas pu être enregistrée.' });
  }

  return res.status(201).json({ url: `/media/${token}`, mime: detected.mime });
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
  const absolutePath = path.join(uploadDirectory, image.storage_name);
  if (!fs.existsSync(absolutePath)) return res.status(404).end();
  res.set({
    'Content-Type': image.mime_type,
    'Content-Disposition': `inline; filename="${image.original_name.replace(/["\\]/g, '_')}"`,
    'Cache-Control': image.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  return res.sendFile(absolutePath);
});

module.exports = { router, claimPrivateUploads };
