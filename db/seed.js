// Lance ce script une seule fois (npm run seed) pour créer une arborescence
// de catégories/forums de démo, dans l'esprit d'avenoel.org.
const db = require('./database');

const layout = [
  {
    name: 'Général',
    forums: [
      { name: 'Blabla', slug: 'blabla', description: "Discussions générales, tout et n'importe quoi." },
      { name: 'Actualités', slug: 'actualites', description: "L'actualité qui vous intéresse." },
    ],
  },
  {
    name: 'Communauté',
    forums: [
      { name: 'Présentations', slug: 'presentations', description: 'Nouveau ici ? Présente-toi.' },
      { name: 'Suggestions', slug: 'suggestions', description: 'Propositions et retours sur le forum.' },
    ],
  },
];

const seed = db.transaction(() => {
  let createdCategories = 0;
  let createdForums = 0;
  for (const [categoryPosition, categoryData] of layout.entries()) {
    let category = db.prepare('SELECT * FROM categories WHERE name = ?').get(categoryData.name);
    if (!category) {
      const result = db.prepare(
        'INSERT INTO categories (name, position) VALUES (?, ?)'
      ).run(categoryData.name, categoryPosition);
      category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid);
      createdCategories += 1;
    }
    for (const [forumPosition, forumData] of categoryData.forums.entries()) {
      const existingForum = db.prepare('SELECT id FROM forums WHERE slug = ?').get(forumData.slug);
      if (existingForum) continue;
      db.prepare(
        `INSERT INTO forums (category_id, name, description, slug, position)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        category.id,
        forumData.name,
        forumData.description,
        forumData.slug,
        forumPosition
      );
      createdForums += 1;
    }
  }
  return { createdCategories, createdForums };
});

const result = seed();
console.log(
  `Seed terminé : ${result.createdCategories} catégorie(s) et ${result.createdForums} forum(s) ajoutés.`
);
