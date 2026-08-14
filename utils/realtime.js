const { EventEmitter } = require('events');

const realtimeBus = new EventEmitter();
realtimeBus.setMaxListeners(0);
const typingStates = new Map();
const typingTimers = new Map();

function typingKey(scope, channelId, userId) {
  return `${scope}:${Number(channelId)}:${Number(userId)}`;
}

function publishTyping(scope, event) {
  const normalized = {
    channelId: Number(event.channelId),
    userId: Number(event.userId),
    username: String(event.username || '').slice(0, 20),
    active: Boolean(event.active),
  };
  const key = typingKey(scope, normalized.channelId, normalized.userId);
  const previousTimer = typingTimers.get(key);
  if (previousTimer) clearTimeout(previousTimer);

  if (normalized.active) {
    typingStates.set(key, normalized);
    const timer = setTimeout(() => publishTyping(scope, { ...normalized, active: false }), 6000);
    timer.unref?.();
    typingTimers.set(key, timer);
  } else {
    typingStates.delete(key);
    typingTimers.delete(key);
  }
  realtimeBus.emit(`${scope}-typing`, normalized);
}

function getActiveTypers(scope, channelId) {
  const prefix = `${scope}:${Number(channelId)}:`;
  return [...typingStates.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, state]) => state);
}

function publishPublicMessage(event) {
  realtimeBus.emit('public-message', {
    threadId: Number(event.threadId),
    messageId: Number(event.messageId),
    senderId: Number(event.senderId),
  });
}

function publishPrivateMessage(event) {
  realtimeBus.emit('private-message', {
    conversationId: Number(event.conversationId),
    messageId: Number(event.messageId),
    senderId: Number(event.senderId),
  });
}

function subscribe(eventName, listener) {
  realtimeBus.on(eventName, listener);
  return () => realtimeBus.off(eventName, listener);
}

module.exports = {
  publishPublicMessage,
  publishPrivateMessage,
  publishPublicTyping: (event) => publishTyping('public', event),
  publishPrivateTyping: (event) => publishTyping('private', event),
  getActivePublicTypers: (threadId) => getActiveTypers('public', threadId),
  getActivePrivateTypers: (conversationId) => getActiveTypers('private', conversationId),
  subscribePublicMessages: (listener) => subscribe('public-message', listener),
  subscribePrivateMessages: (listener) => subscribe('private-message', listener),
  subscribePublicTyping: (listener) => subscribe('public-typing', listener),
  subscribePrivateTyping: (listener) => subscribe('private-typing', listener),
};
