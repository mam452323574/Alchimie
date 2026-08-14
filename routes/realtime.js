const express = require('express');
const db = require('../db/database');
const { hasModerationAccess } = require('../middleware/moderation-access');
const { getUnreadPrivateCount, getPrivateConversation, requirePrivateCsrf } = require('../utils/private-messages');
const { canAccessBlackTopics } = require('../utils/points');
const {
  getActivePublicTypers,
  getActivePrivateTypers,
  publishPublicTyping,
  publishPrivateTyping,
  subscribePublicMessages,
  subscribePrivateMessages,
  subscribePublicTyping,
  subscribePrivateTyping,
} = require('../utils/realtime');

const router = express.Router();
const activeConnections = new Map();
const latestTypingSignals = new Map();
const canViewThread = (req, thread) => Boolean(thread)
  && (!thread.is_black || canAccessBlackTopics(req.user) || hasModerationAccess(req));

function acceptTypingSignal(key, active) {
  if (!active) {
    latestTypingSignals.delete(key);
    return true;
  }
  const now = Date.now();
  const previous = latestTypingSignals.get(key) || 0;
  if (now - previous < 350) return false;
  latestTypingSignals.set(key, now);
  return true;
}

function isInternalRealtimeRequest(req) {
  return req.get('x-avebar-realtime') === '1';
}

function reserveConnection(key, maximum) {
  const current = activeConnections.get(key) || 0;
  if (current >= maximum) return false;
  activeConnections.set(key, current + 1);
  return true;
}

function releaseConnection(key) {
  const remaining = (activeConnections.get(key) || 1) - 1;
  if (remaining > 0) activeConnections.set(key, remaining);
  else activeConnections.delete(key);
}

function startEventStream(res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Content-Encoding': 'identity',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
}

function sendEvent(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function stopStreamAfter(res, cleanup, milliseconds = 30 * 60 * 1000) {
  const timer = setTimeout(() => {
    if (!res.writableEnded) res.end();
  }, milliseconds);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
    cleanup();
  };
}

router.get('/flux/t/:id', (req, res) => {
  const threadId = Number.parseInt(req.params.id, 10);
  const thread = Number.isInteger(threadId)
    ? db.prepare('SELECT id, deleted_at, is_black FROM threads WHERE id = ?').get(threadId)
    : null;
  if (!canViewThread(req, thread) || (thread.deleted_at && !hasModerationAccess(req))) {
    return res.status(404).end();
  }

  const connectionKey = `public:${req.ip || 'unknown'}`;
  if (!reserveConnection(connectionKey, 8)) return res.status(429).end();

  startEventStream(res);
  sendEvent(res, { kind: 'ready', threadId });
  getActivePublicTypers(threadId).forEach((typing) => {
    if (!req.user || typing.userId !== req.user.id) {
      sendEvent(res, { kind: 'typing', threadId, ...typing });
    }
  });

  const unsubscribeMessages = subscribePublicMessages((event) => {
    if (event.threadId === threadId) sendEvent(res, { kind: 'message', ...event });
  });
  const unsubscribeTyping = subscribePublicTyping((event) => {
    if (event.channelId === threadId && (!req.user || event.userId !== req.user.id)) {
      sendEvent(res, { kind: 'typing', threadId, ...event });
    }
  });
  const heartbeat = setInterval(() => {
    const currentThread = db.prepare('SELECT deleted_at, is_black FROM threads WHERE id = ?').get(threadId);
    if (!canViewThread(req, currentThread) || (currentThread.deleted_at && !hasModerationAccess(req))) {
      res.end();
      return;
    }
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 25000);

  let cleaned = false;
  const cleanupResources = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribeMessages();
    unsubscribeTyping();
    releaseConnection(connectionKey);
  };
  const cleanup = stopStreamAfter(res, cleanupResources);
  req.on('close', cleanup);
  res.on('close', cleanup);
  return undefined;
});

router.get('/flux/messages', (req, res) => {
  if (!req.user) return res.status(401).end();
  const userId = req.user.id;
  const connectionKey = `private:${userId}`;
  if (!reserveConnection(connectionKey, 4)) return res.status(429).end();

  startEventStream(res);
  sendEvent(res, {
    kind: 'ready',
    unreadPrivateMessages: getUnreadPrivateCount(userId),
  });

  const unsubscribe = subscribePrivateMessages((event) => {
    // Ce contrôle est refait pour chaque événement : connaître un identifiant
    // de conversation ne suffit jamais pour recevoir la moindre information.
    if (!getPrivateConversation(event.conversationId, userId)) return;
    sendEvent(res, {
      kind: 'message',
      conversationId: event.conversationId,
      messageId: event.messageId,
      senderId: event.senderId,
      unreadPrivateMessages: getUnreadPrivateCount(userId),
    });
  });
  const privateConversationIds = db.prepare(
    'SELECT conversation_id FROM private_conversation_members WHERE user_id = ?'
  ).all(userId);
  privateConversationIds.forEach(({ conversation_id: conversationId }) => {
    getActivePrivateTypers(conversationId).forEach((typing) => {
      if (typing.userId !== userId) {
        sendEvent(res, {
          kind: 'typing',
          conversationId,
          userId: typing.userId,
          username: typing.username,
          active: true,
        });
      }
    });
  });
  const unsubscribeTyping = subscribePrivateTyping((event) => {
    if (event.userId === userId || !getPrivateConversation(event.channelId, userId)) return;
    sendEvent(res, {
      kind: 'typing',
      conversationId: event.channelId,
      userId: event.userId,
      username: event.username,
      active: event.active,
    });
  });
  const heartbeat = setInterval(() => {
    const user = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(userId);
    if (!user || user.is_banned) {
      res.end();
      return;
    }
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 25000);

  let cleaned = false;
  const cleanupResources = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeTyping();
    releaseConnection(connectionKey);
  };
  const cleanup = stopStreamAfter(res, cleanupResources);
  req.on('close', cleanup);
  res.on('close', cleanup);
  return undefined;
});

router.post('/flux/t/:id/ecriture', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
  if (!isInternalRealtimeRequest(req)) return res.status(403).json({ error: 'Requête refusée.' });
  const threadId = Number.parseInt(req.params.id, 10);
  const thread = db.prepare('SELECT id, deleted_at, is_locked, is_black FROM threads WHERE id = ?').get(threadId);
  if (!canViewThread(req, thread) || thread.deleted_at) return res.status(404).json({ error: 'Sujet introuvable.' });
  if (thread.is_locked) return res.status(409).json({ error: 'Sujet verrouillé.' });
  const active = req.body.active === '1';
  if (!acceptTypingSignal(`public:${threadId}:${req.user.id}`, active)) return res.status(204).end();
  publishPublicTyping({ channelId: threadId, userId: req.user.id, username: req.user.username, active });
  return res.status(204).end();
});

router.post(
  '/flux/messages/:id/ecriture',
  (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Connexion requise.' });
    if (!isInternalRealtimeRequest(req)) return res.status(403).json({ error: 'Requête refusée.' });
    return next();
  },
  requirePrivateCsrf,
  (req, res) => {
    const conversation = getPrivateConversation(req.params.id, req.user.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation privée introuvable.' });
    const active = req.body.active === '1';
    if (!acceptTypingSignal(`private:${conversation.id}:${req.user.id}`, active)) return res.status(204).end();
    publishPrivateTyping({
      channelId: conversation.id,
      userId: req.user.id,
      username: req.user.username,
      active,
    });
    return res.status(204).end();
  }
);

module.exports = router;
