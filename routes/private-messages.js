const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { cleanBody } = require('../utils/sanitize');
const {
  getUnreadPrivateCount,
  getPrivateConversation,
  requirePrivateCsrf,
} = require('../utils/private-messages');
const { publishPrivateMessage } = require('../utils/realtime');
const { claimPrivateUploads } = require('./uploads');
const { protectPrivateMessage, revealPrivateMessage } = require('../utils/encryption');

const router = express.Router();
const MESSAGES_PER_PAGE = 25;
const MAX_GROUP_MEMBERS = 20;
const wantsJson = (req) => String(req.get('accept') || '').includes('application/json');
const privateMessageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

function parseParticipantNames(rawParticipants) {
  return [...new Map(
    String(rawParticipants || '').trim().slice(0, 500).split(/[;,\n]+/)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => [name.toLocaleLowerCase('fr'), name])
  ).values()];
}

function redirectToConversation(req, res, conversationId, type, message) {
  req.session.toast = { type, message };
  return res.redirect(`/messages/${conversationId}`);
}

function getPrivateInboxConversations(userId) {
  return db.prepare(
    `SELECT conversation.*,
      (SELECT COUNT(*) FROM private_messages message
       WHERE message.conversation_id = conversation.id) AS message_count,
      (SELECT message.created_at FROM private_messages message
       WHERE message.conversation_id = conversation.id
       ORDER BY message.id DESC LIMIT 1) AS last_message_at,
      (SELECT sender.username FROM private_messages message
       JOIN users sender ON sender.id = message.user_id
       WHERE message.conversation_id = conversation.id
       ORDER BY message.id DESC LIMIT 1) AS last_sender_name,
      (SELECT sender.role FROM private_messages message
       JOIN users sender ON sender.id = message.user_id
       WHERE message.conversation_id = conversation.id
       ORDER BY message.id DESC LIMIT 1) AS last_sender_role,
      (SELECT GROUP_CONCAT(member_user.username, ', ')
       FROM private_conversation_members member
       JOIN users member_user ON member_user.id = member.user_id
       WHERE member.conversation_id = conversation.id AND member.user_id != ?) AS other_members,
      (SELECT COUNT(*) FROM private_messages unread
       WHERE unread.conversation_id = conversation.id
         AND unread.id > membership.last_read_message_id
         AND unread.user_id != membership.user_id) AS unread_count
     FROM private_conversations conversation
     JOIN private_conversation_members membership
       ON membership.conversation_id = conversation.id
     WHERE membership.user_id = ?
     ORDER BY conversation.updated_at DESC, conversation.id DESC`
  ).all(userId, userId);
}

function lastPrivateMessageDelay(userId) {
  const lastMessage = db.prepare(
    `SELECT CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS elapsed
     FROM private_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1`
  ).get(userId);
  return lastMessage && lastMessage.elapsed < 3 ? Math.max(1, 3 - lastMessage.elapsed) : 0;
}

function renderNewConversation(res, values = {}) {
  const suggestedUsers = db.prepare(
    `SELECT username, role FROM users WHERE id != ? ORDER BY username COLLATE NOCASE LIMIT 100`
  ).all(res.locals.currentUser.id);
  return res.render('private/new', {
    error: values.error || null,
    oldTitle: values.oldTitle || '',
    oldParticipants: values.oldParticipants || '',
    oldBody: values.oldBody || '',
    suggestedUsers,
  });
}

router.get('/messages', requireAuth, (req, res) => {
  const conversations = getPrivateInboxConversations(req.user.id);
  res.render('private/inbox', { conversations });
});

router.get('/messages/nouveau', requireAuth, (req, res) => renderNewConversation(res));

router.post('/messages/nouveau', requireAuth, privateMessageLimiter, requirePrivateCsrf, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const rawParticipants = String(req.body.participants || '').trim().slice(0, 500);
  const rawBody = String(req.body.body || '');
  const body = cleanBody(rawBody).slice(0, 20000);
  const renderError = (error) => renderNewConversation(res.status(400), {
    error, oldTitle: title, oldParticipants: rawParticipants, oldBody: rawBody,
  });

  if (title.length < 2) return renderError('Le titre doit contenir au moins 2 caractères.');
  if (!body) return renderError('Le premier message ne peut pas être vide.');

  const participantNames = parseParticipantNames(rawParticipants);
  if (!participantNames.length) return renderError('Ajoute au moins un destinataire.');
  if (participantNames.length >= MAX_GROUP_MEMBERS) {
    return renderError(`Un groupe peut contenir au maximum ${MAX_GROUP_MEMBERS} personnes, toi compris.`);
  }

  const findUser = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE');
  const recipients = [];
  const missing = [];
  for (const name of participantNames) {
    const user = findUser.get(name);
    if (!user) missing.push(name);
    else if (user.id !== req.user.id && !recipients.some((recipient) => recipient.id === user.id)) recipients.push(user);
  }
  if (missing.length) return renderError(`Compte${missing.length > 1 ? 's' : ''} introuvable${missing.length > 1 ? 's' : ''} : ${missing.join(', ')}.`);
  if (!recipients.length) return renderError('Ajoute au moins un autre membre à la conversation.');

  const delay = lastPrivateMessageDelay(req.user.id);
  if (delay) return renderError(`Patiente encore ${delay} seconde(s) avant d'envoyer un autre message privé.`);

  const createConversation = db.transaction(() => {
    const conversationInfo = db.prepare(
      'INSERT INTO private_conversations (title, created_by) VALUES (?, ?)'
    ).run(title, req.user.id);
    const conversationId = conversationInfo.lastInsertRowid;
    const addMember = db.prepare(
      'INSERT INTO private_conversation_members (conversation_id, user_id) VALUES (?, ?)'
    );
    addMember.run(conversationId, req.user.id);
    recipients.forEach((recipient) => addMember.run(conversationId, recipient.id));
    const messageInfo = db.prepare(
      'INSERT INTO private_messages (conversation_id, user_id, body) VALUES (?, ?, ?)'
    ).run(conversationId, req.user.id, protectPrivateMessage(body));
    db.prepare(
      `UPDATE private_conversation_members SET last_read_message_id = ?
       WHERE conversation_id = ? AND user_id = ?`
    ).run(messageInfo.lastInsertRowid, conversationId, req.user.id);
    claimPrivateUploads(req.user.id, conversationId, body);
    return { conversationId, messageId: messageInfo.lastInsertRowid };
  });
  const created = createConversation();
  publishPrivateMessage({
    conversationId: created.conversationId,
    messageId: created.messageId,
    senderId: req.user.id,
  });
  req.session.toast = { type: 'success', message: 'La conversation privée a bien été créée.' };
  res.redirect(`/messages/${created.conversationId}#mp-${created.messageId}`);
});

router.get('/messages/liste-fragment', requireAuth, (req, res) => {
  const conversations = getPrivateInboxConversations(req.user.id);
  res.set('Cache-Control', 'no-store');
  res.render('private/_inbox-rows', { conversations }, (error, html) => {
    if (error) return res.status(500).json({ error: 'Actualisation impossible.' });
    return res.json({
      html,
      unreadPrivateMessages: getUnreadPrivateCount(req.user.id),
    });
  });
});

router.get('/messages/:id', requireAuth, (req, res) => {
  const conversation = getPrivateConversation(req.params.id, req.user.id);
  if (!conversation) return res.status(404).render('error', { message: 'Conversation privée introuvable.', statusCode: 404 });

  const totalMessages = db.prepare(
    'SELECT COUNT(*) AS count FROM private_messages WHERE conversation_id = ?'
  ).get(conversation.id).count;
  const totalPages = Math.max(1, Math.ceil(totalMessages / MESSAGES_PER_PAGE));
  const requestedPage = Number.parseInt(req.query.page, 10);
  const page = Math.min(totalPages, Math.max(1, requestedPage || totalPages));
  const messages = db.prepare(
    `SELECT message.*, sender.username, sender.role, sender.avatar_url, sender.avatar_color,
      sender.message_count, sender.points, sender.created_at AS user_created_at,
      (SELECT CASE WHEN active.is_eradication = 1 THEN 'eradication' ELSE active.type END
       FROM sanctions active WHERE active.user_id = sender.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS active_sanction,
      (SELECT active.ends_at FROM sanctions active
       WHERE active.user_id = sender.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS sanction_ends_at
     FROM private_messages message
     JOIN users sender ON sender.id = message.user_id
     WHERE message.conversation_id = ?
     ORDER BY message.id ASC LIMIT ? OFFSET ?`
  ).all(conversation.id, MESSAGES_PER_PAGE, (page - 1) * MESSAGES_PER_PAGE)
    .map((message) => ({ ...message, body: revealPrivateMessage(message.body) }));
  const members = db.prepare(
    `SELECT user.id, user.username, user.role, user.avatar_url, user.avatar_color,
      (SELECT CASE WHEN active.is_eradication = 1 THEN 'eradication' ELSE active.type END
       FROM sanctions active WHERE active.user_id = user.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS active_sanction,
      (SELECT active.ends_at FROM sanctions active
       WHERE active.user_id = user.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS sanction_ends_at
     FROM private_conversation_members membership
     JOIN users user ON user.id = membership.user_id
     WHERE membership.conversation_id = ?
     ORDER BY user.username COLLATE NOCASE`
  ).all(conversation.id);
  const suggestedUsers = conversation.created_by === req.user.id
    ? db.prepare(
      `SELECT user.username, user.role FROM users user
       WHERE NOT EXISTS (
         SELECT 1 FROM private_conversation_members membership
         WHERE membership.conversation_id = ? AND membership.user_id = user.id
       )
       ORDER BY user.username COLLATE NOCASE LIMIT 100`
    ).all(conversation.id)
    : [];

  const latestMessageId = db.prepare(
    'SELECT COALESCE(MAX(id), 0) AS id FROM private_messages WHERE conversation_id = ?'
  ).get(conversation.id).id;
  db.prepare(
    `UPDATE private_conversation_members
     SET last_read_message_id = MAX(last_read_message_id, ?)
     WHERE conversation_id = ? AND user_id = ?`
  ).run(latestMessageId, conversation.id, req.user.id);
  res.locals.unreadPrivateMessages = getUnreadPrivateCount(req.user.id);

  res.render('private/conversation', {
    conversation,
    messages,
    members,
    suggestedUsers,
    canManageMembers: conversation.created_by === req.user.id,
    maximumGroupMembers: MAX_GROUP_MEMBERS,
    page,
    totalPages,
  });
});

router.post('/messages/:id/membres', requireAuth, privateMessageLimiter, requirePrivateCsrf, (req, res) => {
  const conversation = getPrivateConversation(req.params.id, req.user.id);
  if (!conversation) {
    return res.status(404).render('error', { message: 'Conversation privée introuvable.', statusCode: 404 });
  }
  if (conversation.created_by !== req.user.id) {
    return res.status(403).render('error', {
      message: 'Seul le créateur de cette conversation peut ajouter des membres.',
      statusCode: 403,
    });
  }

  const participantNames = parseParticipantNames(req.body.participants);
  if (!participantNames.length) {
    return redirectToConversation(req, res, conversation.id, 'error', 'Indique au moins un pseudonyme à ajouter.');
  }
  if (participantNames.length >= MAX_GROUP_MEMBERS) {
    return redirectToConversation(req, res, conversation.id, 'error', `Un groupe est limité à ${MAX_GROUP_MEMBERS} membres.`);
  }

  const findUser = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE');
  const recipients = [];
  const missing = [];
  for (const name of participantNames) {
    const user = findUser.get(name);
    if (!user) missing.push(name);
    else if (!recipients.some((recipient) => recipient.id === user.id)) recipients.push(user);
  }
  if (missing.length) {
    return redirectToConversation(
      req,
      res,
      conversation.id,
      'error',
      `Compte${missing.length > 1 ? 's' : ''} introuvable${missing.length > 1 ? 's' : ''} : ${missing.join(', ')}.`
    );
  }

  const addMembers = db.transaction(() => {
    const ownedConversation = db.prepare(
      'SELECT id FROM private_conversations WHERE id = ? AND created_by = ?'
    ).get(conversation.id, req.user.id);
    if (!ownedConversation) throw new Error('PRIVATE_CONVERSATION_OWNER_CHANGED');

    const currentMembers = db.prepare(
      'SELECT user_id FROM private_conversation_members WHERE conversation_id = ?'
    ).all(conversation.id);
    const memberIds = new Set(currentMembers.map((member) => member.user_id));
    const newRecipients = recipients.filter((recipient) => !memberIds.has(recipient.id));
    if (!newRecipients.length) return { added: [], latestMessageId: 0 };
    if (currentMembers.length + newRecipients.length > MAX_GROUP_MEMBERS) {
      throw new Error('PRIVATE_CONVERSATION_MEMBER_LIMIT');
    }

    const addMember = db.prepare(
      `INSERT INTO private_conversation_members
       (conversation_id, user_id, last_read_message_id) VALUES (?, ?, 0)`
    );
    newRecipients.forEach((recipient) => addMember.run(conversation.id, recipient.id));
    db.prepare("UPDATE private_conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation.id);
    const latestMessageId = db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM private_messages WHERE conversation_id = ?'
    ).get(conversation.id).id;
    return { added: newRecipients, latestMessageId };
  });

  let result;
  try {
    result = addMembers();
  } catch (error) {
    if (error.message === 'PRIVATE_CONVERSATION_MEMBER_LIMIT') {
      return redirectToConversation(req, res, conversation.id, 'error', `Un groupe est limité à ${MAX_GROUP_MEMBERS} membres.`);
    }
    if (error.message === 'PRIVATE_CONVERSATION_OWNER_CHANGED') {
      return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });
    }
    throw error;
  }

  if (!result.added.length) {
    return redirectToConversation(req, res, conversation.id, 'error', 'Ces utilisateurs font déjà partie de la conversation.');
  }
  if (result.latestMessageId) {
    publishPrivateMessage({
      conversationId: conversation.id,
      messageId: result.latestMessageId,
      senderId: req.user.id,
    });
  }
  const addedNames = result.added.map((member) => member.username).join(', ');
  return redirectToConversation(
    req,
    res,
    conversation.id,
    'success',
    `${addedNames} ${result.added.length > 1 ? 'ont été ajoutés' : 'a été ajouté'} à la conversation.`
  );
});

router.get('/messages/:id/nouveaux-messages', requireAuth, (req, res) => {
  const conversation = getPrivateConversation(req.params.id, req.user.id);
  if (!conversation) {
    // Réponse volontairement identique entre un identifiant inexistant et une
    // conversation dont le compte n'est pas membre.
    return res.status(404).json({ error: 'Conversation privée introuvable.' });
  }
  const after = Math.max(0, Number.parseInt(req.query.apres, 10) || 0);
  const currentPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const totalMessages = db.prepare(
    'SELECT COUNT(*) AS count FROM private_messages WHERE conversation_id = ?'
  ).get(conversation.id).count;
  const totalPages = Math.max(1, Math.ceil(totalMessages / MESSAGES_PER_PAGE));
  const latestMessageId = db.prepare(
    'SELECT COALESCE(MAX(id), 0) AS id FROM private_messages WHERE conversation_id = ?'
  ).get(conversation.id).id;

  if (currentPage !== totalPages) {
    return res.json({
      append: false,
      html: '',
      latestMessageId,
      newCount: db.prepare(
        'SELECT COUNT(*) AS count FROM private_messages WHERE conversation_id = ? AND id > ?'
      ).get(conversation.id, after).count,
      totalPages,
      unreadPrivateMessages: getUnreadPrivateCount(req.user.id),
    });
  }

  // La vérification d'appartenance ci-dessus est faite avant toute lecture du
  // contenu. Seuls les nouveaux messages de cette conversation sont renvoyés.
  const messages = db.prepare(
    `SELECT message.*, sender.username, sender.role, sender.avatar_url, sender.avatar_color,
      sender.message_count, sender.points, sender.created_at AS user_created_at,
      (SELECT CASE WHEN active.is_eradication = 1 THEN 'eradication' ELSE active.type END
       FROM sanctions active WHERE active.user_id = sender.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS active_sanction,
      (SELECT active.ends_at FROM sanctions active
       WHERE active.user_id = sender.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS sanction_ends_at
     FROM private_messages message
     JOIN users sender ON sender.id = message.user_id
     WHERE message.conversation_id = ? AND message.id > ?
     ORDER BY message.id ASC LIMIT ?`
  ).all(conversation.id, after, MESSAGES_PER_PAGE)
    .map((message) => ({ ...message, body: revealPrivateMessage(message.body) }));

  if (latestMessageId > after) {
    db.prepare(
      `UPDATE private_conversation_members SET last_read_message_id = MAX(last_read_message_id, ?)
       WHERE conversation_id = ? AND user_id = ?`
    ).run(latestMessageId, conversation.id, req.user.id);
  }
  res.set('Cache-Control', 'no-store');
  return res.render('private/_message-list', { messages }, (error, html) => {
    if (error) return res.status(500).json({ error: 'Actualisation impossible.' });
    return res.json({
      append: true,
      html,
      latestMessageId,
      newCount: messages.length,
      totalPages,
      unreadPrivateMessages: getUnreadPrivateCount(req.user.id),
    });
  });
});

router.post('/messages/:id/repondre', requireAuth, privateMessageLimiter, requirePrivateCsrf, (req, res) => {
  const conversation = getPrivateConversation(req.params.id, req.user.id);
  if (!conversation) {
    if (wantsJson(req)) return res.status(404).json({ error: 'Conversation privée introuvable.' });
    return res.status(404).render('error', { message: 'Conversation privée introuvable.', statusCode: 404 });
  }
  const body = cleanBody(req.body.body).slice(0, 20000);
  if (!body) {
    if (wantsJson(req)) return res.status(400).json({ error: 'Le message privé ne peut pas être vide.' });
    return res.redirect(`/messages/${conversation.id}`);
  }
  const delay = lastPrivateMessageDelay(req.user.id);
  if (delay) {
    const message = `Patiente encore ${delay} seconde(s) avant d'envoyer un autre message privé.`;
    if (wantsJson(req)) return res.status(429).json({ error: message });
    req.session.toast = { type: 'error', message };
    return res.redirect(`/messages/${conversation.id}#bas`);
  }

  const sendMessage = db.transaction(() => {
    // Nouvelle vérification dans la transaction pour empêcher tout envoi hors du groupe.
    const membership = db.prepare(
      `SELECT 1 FROM private_conversation_members
       WHERE conversation_id = ? AND user_id = ?`
    ).get(conversation.id, req.user.id);
    if (!membership) throw new Error('PRIVATE_CONVERSATION_ACCESS_REVOKED');
    const info = db.prepare(
      'INSERT INTO private_messages (conversation_id, user_id, body) VALUES (?, ?, ?)'
    ).run(conversation.id, req.user.id, protectPrivateMessage(body));
    db.prepare("UPDATE private_conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation.id);
    db.prepare(
      `UPDATE private_conversation_members SET last_read_message_id = ?
       WHERE conversation_id = ? AND user_id = ?`
    ).run(info.lastInsertRowid, conversation.id, req.user.id);
    return info.lastInsertRowid;
  });
  let messageId;
  try { messageId = sendMessage(); } catch (error) {
    if (error.message === 'PRIVATE_CONVERSATION_ACCESS_REVOKED') {
      return res.status(404).render('error', { message: 'Conversation privée introuvable.', statusCode: 404 });
    }
    throw error;
  }
  const total = db.prepare('SELECT COUNT(*) AS count FROM private_messages WHERE conversation_id = ?').get(conversation.id).count;
  const page = Math.max(1, Math.ceil(total / MESSAGES_PER_PAGE));
  publishPrivateMessage({ conversationId: conversation.id, messageId, senderId: req.user.id });
  if (wantsJson(req)) {
    return res.status(201).json({
      ok: true,
      conversationId: conversation.id,
      messageId: Number(messageId),
      totalPages: page,
      unreadPrivateMessages: getUnreadPrivateCount(req.user.id),
      message: 'Ton message privé a bien été envoyé.',
    });
  }
  req.session.toast = { type: 'success', message: 'Ton message privé a bien été envoyé.' };
  res.redirect(`/messages/${conversation.id}?page=${page}#mp-${messageId}`);
});

module.exports = router;
