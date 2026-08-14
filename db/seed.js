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

const insertCategory = db.prepare('INSERT INTO categories (name, position) VALUES (?, ?)');
const insertForum = db.prepare(
  'INSERT INTO forums (category_id, name, description, slug, position) VALUES (?, ?, ?, ?, ?)'
);

const existing = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
if (existing > 0) {
  console.log('Des catégories existent déjà, seed ignoré.');
  process.exit(0);
}

layout.forEach((cat, ci) => {
  const { lastInsertRowid: catId } = insertCategory.run(cat.name, ci);
  cat.forums.forEach((f, fi) => {
    insertForum.run(catId, f.name, f.description, f.slug, fi);
  });
});

console.log('Seed terminé : catégories et forums de démo créés.');
