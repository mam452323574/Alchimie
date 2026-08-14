const db = require('./database');

const consolidate = db.transaction(() => {
  let category = db.prepare("SELECT * FROM categories WHERE name IN ('Discussion', 'Discussions') ORDER BY id LIMIT 1").get();
  if (!category) {
    const info = db.prepare("INSERT INTO categories (name, position) VALUES ('Discussion', 0)").run();
    category = db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid);
  } else {
    db.prepare("UPDATE categories SET name = 'Discussion', position = 0 WHERE id = ?").run(category.id);
  }

  let blabla = db.prepare("SELECT * FROM forums WHERE slug = 'blabla'").get();
  if (!blabla) {
    const info = db.prepare(
      `INSERT INTO forums (category_id, name, slug, description, position)
       VALUES (?, 'Blabla général', 'blabla', ?, 0)`
    ).run(category.id, 'Discussions libres, actualité, culture, quotidien et vie de la communauté.');
    blabla = db.prepare('SELECT * FROM forums WHERE id = ?').get(info.lastInsertRowid);
  } else {
    db.prepare(
      `UPDATE forums SET category_id = ?, name = 'Blabla général',
       description = ?, position = 0 WHERE id = ?`
    ).run(category.id, 'Discussions libres, actualité, culture, quotidien et vie de la communauté.', blabla.id);
  }

  let sensitive = db.prepare("SELECT * FROM forums WHERE slug = 'plus-18'").get();
  if (!sensitive) {
    const info = db.prepare(
      `INSERT INTO forums (category_id, name, slug, description, position)
       VALUES (?, 'Blabla +18', 'plus-18', ?, 1)`
    ).run(category.id, 'Espace réservé aux discussions et contenus sensibles destinés à un public majeur.');
    sensitive = db.prepare('SELECT * FROM forums WHERE id = ?').get(info.lastInsertRowid);
  } else {
    db.prepare(
      `UPDATE forums SET category_id = ?, name = 'Blabla +18',
       description = ?, position = 1 WHERE id = ?`
    ).run(category.id, 'Espace réservé aux discussions et contenus sensibles destinés à un public majeur.', sensitive.id);
  }

  // Préserve tous les sujets : ceux d'éventuels anciens espaces +18 restent sensibles,
  // tous les autres sont regroupés dans le Blabla général.
  db.prepare(
    `UPDATE threads SET forum_id = ? WHERE forum_id IN (
       SELECT id FROM forums WHERE id NOT IN (?, ?) AND (slug LIKE '%18%' OR name LIKE '%18%')
     )`
  ).run(sensitive.id, blabla.id, sensitive.id);
  db.prepare('UPDATE threads SET forum_id = ? WHERE forum_id NOT IN (?, ?)').run(blabla.id, blabla.id, sensitive.id);

  db.prepare('DELETE FROM forums WHERE id NOT IN (?, ?)').run(blabla.id, sensitive.id);
  db.prepare('DELETE FROM categories WHERE id != ?').run(category.id);
  db.prepare(`UPDATE forums SET thread_count = (SELECT COUNT(*) FROM threads WHERE threads.forum_id = forums.id)`).run();
  db.prepare(`UPDATE forums SET post_count = (SELECT COUNT(*) FROM posts JOIN threads ON threads.id = posts.thread_id WHERE threads.forum_id = forums.id)`).run();
});

consolidate();
db.pragma('optimize');
console.log('Forums consolidés : Discussion / Blabla général / Blabla +18.');
