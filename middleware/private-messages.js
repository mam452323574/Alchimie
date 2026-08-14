const { getUnreadPrivateCount, ensurePrivateCsrfToken } = require('../utils/private-messages');
const { needsPageChrome } = require('../utils/request');

function loadPrivateMessages(req, res, next) {
  res.locals.unreadPrivateMessages = 0;
  res.locals.privateMessageCsrfToken = '';
  if (!req.user || !needsPageChrome(req)) return next();
  res.locals.privateMessageCsrfToken = ensurePrivateCsrfToken(req);
  res.locals.unreadPrivateMessages = getUnreadPrivateCount(req.user.id);
  next();
}

module.exports = { loadPrivateMessages };
