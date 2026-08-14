const DEFAULT_CATEGORY = Object.freeze({ name: 'Général', position: 0 });
const DEFAULT_FORUM = Object.freeze({
  name: 'Blabla',
  slug: 'blabla',
  description: 'Discussions générales et vie de la communauté.',
  position: 0,
});

function getPrimaryForum(db) {
  return db.prepare(
    `SELECT * FROM forums
     ORDER BY CASE WHEN slug = 'blabla' THEN 0 ELSE 1 END, position, id
     LIMIT 1`
  ).get();
}

function ensureCoreStructure(db) {
  const ensure = db.transaction(() => {
    const existingForum = getPrimaryForum(db);
    if (existingForum) return { created: false, forum: existingForum };

    let category = db.prepare(
      'SELECT * FROM categories ORDER BY position, id LIMIT 1'
    ).get();
    if (!category) {
      const result = db.prepare(
        'INSERT INTO categories (name, position) VALUES (?, ?)'
      ).run(DEFAULT_CATEGORY.name, DEFAULT_CATEGORY.position);
      category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
    }

    const result = db.prepare(
      `INSERT INTO forums (category_id, name, description, slug, position)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      category.id,
      DEFAULT_FORUM.name,
      DEFAULT_FORUM.description,
      DEFAULT_FORUM.slug,
      DEFAULT_FORUM.position
    );
    const forum = db.prepare('SELECT * FROM forums WHERE id = ?').get(result.lastInsertRowid);
    return { created: true, forum };
  });

  return ensure();
}

module.exports = { ensureCoreStructure, getPrimaryForum };
