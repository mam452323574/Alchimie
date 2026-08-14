const db = require('../db/database');

const STATUS_LABELS = {
  operational: 'Opérationnel',
  maintenance: 'Maintenance en cours',
  degraded: 'Service dégradé',
};

function getSetting(key, fallback = '') {
  return db.prepare('SELECT value, updated_at FROM site_settings WHERE key = ?').get(key) || { value: fallback, updated_at: null };
}

function getServiceStatus() {
  const statusSetting = getSetting('service_status', 'operational');
  const status = Object.hasOwn(STATUS_LABELS, statusSetting.value) ? statusSetting.value : 'operational';
  return {
    status,
    label: STATUS_LABELS[status],
    message: getSetting('service_status_message', '').value,
    scheduledAt: getSetting('service_maintenance_scheduled_at', '').value,
    updatedAt: statusSetting.updated_at,
  };
}

function updateServiceStatus({ status, message, scheduledAt }) {
  const safeStatus = Object.hasOwn(STATUS_LABELS, status) ? status : 'operational';
  const update = db.prepare(
    `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  db.transaction(() => {
    update.run('service_status', safeStatus);
    update.run('service_status_message', String(message || '').trim().slice(0, 500));
    update.run('service_maintenance_scheduled_at', String(scheduledAt || '').trim().slice(0, 40));
  })();
  return getServiceStatus();
}

module.exports = { getServiceStatus, updateServiceStatus, STATUS_LABELS };
