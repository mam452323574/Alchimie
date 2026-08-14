const db = require('../db/database');

const MODERATION_ROLES = ['moderator', 'admin', 'developer'];
const ADMIN_ROLES = ['admin', 'developer'];
const MODERATION_ACTION_LABELS = Object.freeze({
  bootstrap_account_disabled: 'Compte initial désactivé',
  post_deleted: 'Message supprimé',
  post_restored: 'Message restauré',
  thread_deleted: 'Sujet supprimé',
  thread_restored: 'Sujet restauré',
  thread_pinned: 'Sujet épinglé',
  thread_unpinned: 'Sujet désépinglé',
  thread_locked: 'Sujet verrouillé',
  thread_unlocked: 'Sujet déverrouillé',
  category_created: 'Catégorie créée',
  category_deleted: 'Catégorie supprimée',
  forum_created: 'Forum créé',
  forum_deleted: 'Forum supprimé',
  role_changed: 'Rôle modifié',
  user_banned: 'Utilisateur banni',
  user_excluded: 'Utilisateur exclu',
  user_eradicated: 'Utilisateur éradiqué',
  sanction_revoked: 'Sanction révoquée',
  service_status_changed: 'État du service modifié',
  moderation_password_changed: 'Mot de passe de modération modifié',
});
const MODERATION_ROLE_LABELS = Object.freeze({
  member: 'Membre',
  moderator: 'Modérateur',
  admin: 'Administrateur',
  developer: 'Développeur',
});

function moderationActionLabel(action) {
  return MODERATION_ACTION_LABELS[action] || 'Action de modération';
}

function formatModerationDetails(action, details) {
  let output = String(details || 'Aucun détail complémentaire.');
  if (action === 'role_changed') {
    output = output.replace(/\b(member|moderator|admin|developer)\b/gi, (role) => (
      MODERATION_ROLE_LABELS[role.toLowerCase()] || role
    ));
  }
  output = output.replace(/topic\(s\)/gi, 'sujet(s)');
  if (action === 'user_banned') {
    return /^Aucun motif$/i.test(output.trim())
      ? 'Aucun motif renseigné.'
      : `Motif : « ${output.trim()} »`;
  }
  if (action === 'user_excluded') {
    const [reason, endDate] = output.split(/\s+·\s+fin\s+/i, 2);
    const formattedReason = /^Aucun motif$/i.test(reason.trim())
      ? 'Aucun motif renseigné.'
      : `Motif : « ${reason.trim()} »`;
    return endDate ? `${formattedReason} · Fin de l’exclusion : ${endDate.trim()}` : formattedReason;
  }
  if (action === 'user_eradicated') {
    const match = output.match(/^([\s\S]*?)\s+-\s+(\d+\s+sujet\(s\)[\s\S]*)$/i);
    const reason = (match?.[1] || output).trim();
    const formattedReason = /^Aucun motif$/i.test(reason)
      ? 'Aucun motif renseigné.'
      : `Motif : « ${reason} »`;
    return match ? `${formattedReason} - ${match[2]}` : formattedReason;
  }
  return output;
}

function getActiveSanction(userId) {
  return db.prepare(
    `SELECT * FROM sanctions
     WHERE user_id = ? AND revoked_at IS NULL
       AND (type = 'ban' OR (type = 'exclusion' AND ends_at > datetime('now')))
     ORDER BY created_at DESC LIMIT 1`
  ).get(userId);
}

function hasSanctionHistory(userId) {
  return Boolean(db.prepare('SELECT id FROM sanctions WHERE user_id = ? LIMIT 1').get(userId));
}

function logModeration(actorId, targetUserId, action, details = '') {
  db.prepare(
    'INSERT INTO moderation_logs (actor_id, target_user_id, action, details) VALUES (?, ?, ?, ?)'
  ).run(actorId || null, targetUserId || null, action, String(details || '').slice(0, 1000));
}

function canModerateTarget(actor, target) {
  if (!actor || !target || actor.id === target.id) return false;
  const power = { member: 0, moderator: 1, admin: 2, developer: 3 };
  return MODERATION_ROLES.includes(actor.role) && power[actor.role] > power[target.role];
}

module.exports = {
  MODERATION_ROLES,
  ADMIN_ROLES,
  getActiveSanction,
  hasSanctionHistory,
  logModeration,
  canModerateTarget,
  moderationActionLabel,
  formatModerationDetails,
};
