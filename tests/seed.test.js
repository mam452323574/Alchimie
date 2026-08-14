const test = require('node:test');
const assert = require('node:assert/strict');

test('the optional demo seed remains idempotent after the minimal bootstrap', () => {
  process.env.DB_PATH = ':memory:';
  process.env.NODE_ENV = 'development';
  process.env.ADMIN_PASSWORD = 'Local-Only-Admin-Password-987654321';
  process.env.MODERATION_PASSWORD = 'Local-Only-Moderation-Password-987654321';

  const db = require('../db/database');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forums').get().count, 1);

  const seedPath = require.resolve('../db/seed');
  require(seedPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM categories').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forums').get().count, 4);

  delete require.cache[seedPath];
  require(seedPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM categories').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forums').get().count, 4);

  db.close();
});
