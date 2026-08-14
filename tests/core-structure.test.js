const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureCoreStructure, getPrimaryForum } = require('../db/core-structure');

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE forums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      slug TEXT UNIQUE NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      thread_count INTEGER NOT NULL DEFAULT 0,
      post_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

test('creates only the minimal public structure in an empty database', (context) => {
  const db = createDatabase();
  context.after(() => db.close());

  const first = ensureCoreStructure(db);
  const second = ensureCoreStructure(db);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM categories').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT name, slug, thread_count, post_count FROM forums').get(),
    { name: 'Blabla', slug: 'blabla', thread_count: 0, post_count: 0 }
  );
});

test('keeps an existing customized forum as the primary forum', (context) => {
  const db = createDatabase();
  context.after(() => db.close());
  const categoryId = db.prepare(
    'INSERT INTO categories (name, position) VALUES (?, ?)'
  ).run('Communauté', 0).lastInsertRowid;
  db.prepare(
    `INSERT INTO forums (category_id, name, slug, position)
     VALUES (?, ?, ?, ?)`
  ).run(categoryId, 'Discussions', 'discussions', 0);

  const result = ensureCoreStructure(db);

  assert.equal(result.created, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM forums').get().count, 1);
  assert.equal(getPrimaryForum(db).slug, 'discussions');
});
