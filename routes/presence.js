const express = require('express');
const { touchPresence } = require('../utils/presence');
const { getUnreadPrivateCount } = require('../utils/private-messages');

const router = express.Router();

router.post('/presence', (req, res) => {
  // Cette petite valeur garantit un identifiant de session persistant aux visiteurs anonymes.
  req.session.presenceEnabled = true;
  const online = touchPresence(req.sessionID, req.user?.id || null);
  res.json({ online, unreadPrivateMessages: getUnreadPrivateCount(req.user?.id) });
});

module.exports = router;
