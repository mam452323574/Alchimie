const crypto = require('crypto');
const db = require('../db/database');
const { ensureCsrfToken } = require('../middleware/csrf');

function getUnreadPrivateCount(userId) {
  if (!userId) return 0;
  return db.prepare(
    `SELECT COUNT(*) AS count
     FROM private_conversation_members membership
     WHERE membership.user_id = ?
       AND EXISTS (
         SELECT 1 FROM private_messages message
         WHERE message.conversation_id = membership.conversation_id
           AND message.id > membership.last_read_message_id
           AND message.user_id != membership.user_id
       )`
  ).get(userId).count;
}

function getPrivateConversation(conversationId, userId) {
  return db.prepare(
    `SELECT conversation.*
     FROM private_conversations conversation
     JOIN private_conversation_members membership
       ON membership.conversation_id = conversation.id
     WHERE conversation.id = ? AND membership.user_id = ?`
  ).get(conversationId, userId);
}

function ensurePrivateCsrfToken(req) {
  return ensureCsrfToken(req);
}

function requirePrivateCsrf(req, res, next) {
  const expected = String(req.session.csrfToken || '');
  const received = String(req.body.csrf_token || '');
  const valid = /^[a-f0-9]{64}$/.test(expected)
    && /^[a-f0-9]{64}$/.test(received)
    && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  if (!valid) {
    if (String(req.get('accept') || '').includes('application/json')) {
      return res.status(403).json({
        error: 'La vérification de sécurité a expiré. Recharge la page puis réessaie.',
      });
    }
    return res.status(403).render('error', {
      message: 'La vérification de sécurité a expiré. Recharge la page puis réessaie.',
      statusCode: 403,
    });
  }
  next();
}

module.exports = {
  getUnreadPrivateCount,
  getPrivateConversation,
  ensurePrivateCsrfToken,
  requirePrivateCsrf,
};
