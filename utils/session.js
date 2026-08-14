function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

async function establishAuthenticatedSession(req, user) {
  await regenerateSession(req);
  req.session.userId = Number(user.id);
  req.session.authVersion = Number(user.session_version || 0);
  req.session.authenticatedAt = Date.now();
  await saveSession(req);
}

module.exports = { regenerateSession, saveSession, establishAuthenticatedSession };
