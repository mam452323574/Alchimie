const crypto = require('crypto');
const db = require('./database');
const { hashPasswordSync } = require('../utils/passwords');
const { protectEmail } = require('../utils/encryption');

const demoUsers = [
  { username: 'Aster', role: 'moderator', color: '#749ecc', bio: '<g>Modération</g> et organisation de la communauté.', age: '-18 days' },
  { username: 'Nox', role: 'member', color: '#836eaa', bio: 'Cinéma, musique et discussions tardives.', age: '-14 days' },
  { username: 'Kira', role: 'member', color: '#b5747e', bio: 'Jeux vidéo, art et café.', age: '-11 days' },
  { username: 'Milo', role: 'member', color: '#638f82', bio: 'Curieux de tout, expert de rien.', age: '-8 days' },
];

function ensureUser(user) {
  const existing = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(user.username);
  if (existing) return existing;
  const inaccessiblePassword = hashPasswordSync(crypto.randomBytes(32).toString('hex'));
  const email = protectEmail(`${user.username.toLowerCase()}@demo.local`);
  const info = db.prepare(
    `INSERT INTO users
     (username, password_hash, email, email_lookup_hash, email_verified_at, role, avatar_color, bio, created_at)
     VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, datetime('now', ?))`
  ).run(
    user.username,
    inaccessiblePassword,
    email.encrypted,
    email.lookup,
    user.role,
    user.color,
    user.bio,
    user.age
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function ensureCategory(name, position) {
  const existing = db.prepare('SELECT * FROM categories WHERE name = ?').get(name);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO categories (name, position) VALUES (?, ?)').run(name, position);
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid);
}

function ensureForum(categoryId, name, slug, description, position) {
  const existing = db.prepare('SELECT * FROM forums WHERE slug = ?').get(slug);
  if (existing) return existing;
  const info = db.prepare(
    'INSERT INTO forums (category_id, name, slug, description, position) VALUES (?, ?, ?, ?, ?)'
  ).run(categoryId, name, slug, description, position);
  return db.prepare('SELECT * FROM forums WHERE id = ?').get(info.lastInsertRowid);
}

const users = Object.fromEntries(demoUsers.map((user) => [user.username, ensureUser(user)]));
const categories = {
  discussion: ensureCategory('Discussion', 0),
};
const forums = {
  blabla: ensureForum(categories.discussion.id, 'Blabla général', 'blabla', 'Discussions libres, actualité, culture, quotidien et vie de la communauté.', 0),
  plus18: ensureForum(categories.discussion.id, 'Blabla +18', 'plus-18', 'Espace réservé aux discussions et contenus sensibles destinés à un public majeur.', 1),
};

const topics = [
  {
    forum: 'blabla', author: 'Aster', title: 'Bienvenue - quelques repères pour bien commencer', pinned: true, age: '-7 days',
    body: "Bienvenue sur le forum ! Présentez-vous, choisissez une catégorie et lancez-vous. Le respect des autres et la lisibilité des discussions restent les deux règles essentielles.",
    replies: [['Nox', "Merci pour l'accueil. L'interface est vraiment agréable à parcourir.", '-6 days'], ['Kira', 'Bien reçu ! Je vais commencer par le forum jeux vidéo.', '-5 days']],
  },
  {
    forum: 'blabla', author: 'Milo', title: 'Le topic du café - on raconte sa journée', pinned: false, age: '-4 days',
    body: "Le comptoir est ouvert. Une bonne nouvelle, une anecdote ou juste l'envie de discuter ? Posez ça ici.",
    replies: [['Kira', "Premier café de la journée et déjà trois onglets ouverts. C'est mal parti.", '-3 days'], ['Nox', "J'ai enfin terminé le livre que je traînais depuis deux mois.", '-2 days'], ['Aster', 'Bonne soirée à tout le monde 👋', '-1 day']],
  },
  {
    forum: 'blabla', author: 'Kira', title: 'Votre petit plaisir du jour ?', pinned: false, age: '-2 days',
    body: "Le mien : sortir juste après la pluie quand les rues sont encore calmes.",
    replies: [['Milo', 'Une boulangerie encore ouverte en rentrant du travail.', '-1 day'], ['Nox', 'Réécouter un album oublié depuis des années.', '-8 hours']],
  },
  {
    forum: 'blabla', author: 'Nox', title: 'Le récap des actualités intéressantes de la semaine', pinned: true, age: '-6 days',
    body: "Partagez ici les articles qui méritent une vraie discussion. Un résumé rapide avec chaque lien est toujours apprécié.",
    replies: [['Aster', 'Bonne idée : essayons de garder un sujet par semaine pour que cela reste lisible.', '-5 days']],
  },
  {
    forum: 'blabla', author: 'Milo', title: 'Technologies : quelle innovation vous impressionne vraiment ?', pinned: false, age: '-3 days',
    body: "Au-delà du battage médiatique, quelle technologie récente vous semble réellement utile ou prometteuse ?",
    replies: [['Kira', "Les progrès sur le stockage d'énergie auront probablement plus d'impact qu'on ne l'imagine.", '-2 days'], ['Nox', "Les outils d'accessibilité basés sur la reconnaissance vocale me paraissent déjà très concrets.", '-1 day']],
  },
  {
    forum: 'blabla', author: 'Kira', title: 'À quoi jouez-vous en ce moment ?', pinned: true, age: '-5 days',
    body: "Le topic permanent pour partager vos jeux du moment, vos découvertes et vos abandons honteux.",
    replies: [['Milo', 'Je reprends un vieux jeu de stratégie. Il reste étonnamment moderne.', '-4 days'], ['Nox', "Je cherche surtout un bon jeu narratif pas trop long.", '-3 days'], ['Aster', 'Petit sondage pour organiser une soirée communautaire.', '-2 days']],
    poll: { replyIndex: 2, question: 'Quel genre pour la prochaine soirée ?', options: ['Jeu de course', 'Coopération', 'Jeu de stratégie', 'Quiz'] },
  },
  {
    forum: 'blabla', author: 'Milo', title: 'Les jeux terminés cette année', pinned: false, age: '-2 days',
    body: "Votre liste, une note rapide et surtout le jeu que vous recommanderiez sans hésiter.",
    replies: [['Kira', 'Deux terminés seulement, mais aucun remplissage inutile : je prends.', '-1 day']],
  },
  {
    forum: 'blabla', author: 'Nox', title: 'Le dernier film que vous avez vu', pinned: true, age: '-6 days',
    body: "Une impression à chaud, une note facultative et pas de divulgâchage sans avertissement.",
    replies: [['Milo', "Un polar des années 70. L'ambiance fait tout le film.", '-4 days'], ['Kira', 'Un film d’animation superbe visuellement, mais un peu trop long.', '-2 days']],
  },
  {
    forum: 'blabla', author: 'Aster', title: 'Séries courtes à recommander', pinned: false, age: '-1 day',
    body: "Je cherche des séries bouclées en une ou deux saisons, avec une vraie fin. Vos recommandations ?",
    replies: [['Nox', "Je prépare une petite liste sans spoiler pour ce soir.", '-6 hours']],
  },
  {
    forum: 'blabla', author: 'Nox', title: 'Partagez vos découvertes musicales', pinned: true, age: '-7 days',
    body: "Tous les styles sont les bienvenus. Quelques mots sur le morceau ou l'album rendent le partage encore meilleur.",
    replies: [['Kira', 'Je viens de découvrir un groupe de jazz fusion japonais assez incroyable.', '-5 days'], ['Milo', 'De mon côté, retour aux bandes originales de jeux vidéo.', '-3 days']],
  },
  {
    forum: 'blabla', author: 'Milo', title: 'Salut, moi c’est Milo', pinned: false, age: '-7 days',
    body: "Je passe surtout pour parler culture, bidouillage et projets personnels. Ravi de découvrir le forum !",
    replies: [['Aster', 'Bienvenue Milo, installe-toi !', '-7 days'], ['Nox', 'Bienvenue 👋', '-6 days']],
  },
  {
    forum: 'blabla', author: 'Kira', title: 'Boîte à idées pour améliorer le forum', pinned: true, age: '-4 days',
    body: "Centralisons ici les petites améliorations d'interface et les fonctionnalités qui pourraient rendre le forum plus agréable.",
    replies: [['Milo', "Un raccourci vers les derniers messages non lus serait pratique.", '-3 days'], ['Aster', 'Bonne idée, je la note pour la prochaine évolution.', '-2 days']],
  },
  {
    forum: 'plus18', author: 'Aster', title: 'À lire avant de publier dans la section +18', pinned: true, age: '-1 day',
    body: "Cette section accueille les sujets sensibles destinés à un public majeur. Pensez à annoncer clairement la nature du contenu et utilisez la balise <spoiler>contenu sensible</spoiler> lorsque c'est utile.",
    replies: [],
  },
];

let createdTopics = 0;
let createdPosts = 0;

const insertTopic = db.transaction((topic) => {
  const forum = forums[topic.forum];
  const existing = db.prepare('SELECT id FROM threads WHERE forum_id = ? AND title = ?').get(forum.id, topic.title);
  if (existing) return;
  const threadInfo = db.prepare(
    `INSERT INTO threads (forum_id, user_id, title, is_pinned, created_at, last_post_at)
     VALUES (?, ?, ?, ?, datetime('now', ?), datetime('now', ?))`
  ).run(forum.id, users[topic.author].id, topic.title, topic.pinned ? 1 : 0, topic.age, topic.age);
  const threadId = threadInfo.lastInsertRowid;
  db.prepare(
    `INSERT INTO posts (thread_id, user_id, body, created_at) VALUES (?, ?, ?, datetime('now', ?))`
  ).run(threadId, users[topic.author].id, topic.body, topic.age);
  createdPosts += 1;
  let lastAge = topic.age;
  topic.replies.forEach(([author, body, age], replyIndex) => {
    const postInfo = db.prepare(
      `INSERT INTO posts (thread_id, user_id, body, created_at) VALUES (?, ?, ?, datetime('now', ?))`
    ).run(threadId, users[author].id, body, age);
    createdPosts += 1;
    lastAge = age;
    if (topic.poll && topic.poll.replyIndex === replyIndex) {
      const pollInfo = db.prepare('INSERT INTO polls (post_id, question, created_by) VALUES (?, ?, ?)').run(postInfo.lastInsertRowid, topic.poll.question, users[author].id);
      const insertPollOption = db.prepare('INSERT INTO poll_options (poll_id, label, position) VALUES (?, ?, ?)');
      topic.poll.options.forEach((option, index) => insertPollOption.run(pollInfo.lastInsertRowid, option, index));
    }
  });
  db.prepare("UPDATE threads SET last_post_at = datetime('now', ?) WHERE id = ?").run(lastAge, threadId);
  createdTopics += 1;
});

topics.forEach(insertTopic);

db.transaction(() => {
  db.prepare(`UPDATE threads SET post_count = (SELECT COUNT(*) FROM posts WHERE posts.thread_id = threads.id)`).run();
  db.prepare(`UPDATE forums SET thread_count = (SELECT COUNT(*) FROM threads WHERE threads.forum_id = forums.id)`).run();
  db.prepare(`UPDATE forums SET post_count = (SELECT COUNT(*) FROM posts JOIN threads ON threads.id = posts.thread_id WHERE threads.forum_id = forums.id)`).run();
  db.prepare(`UPDATE users SET message_count = (SELECT COUNT(*) FROM posts WHERE posts.user_id = users.id)`).run();
  db.prepare(
    `UPDATE users SET points =
      2 * (SELECT COUNT(*) FROM threads WHERE threads.user_id = users.id AND threads.deleted_at IS NULL)
      + (SELECT COUNT(*) FROM posts
         JOIN threads ON threads.id = posts.thread_id
         WHERE posts.user_id = users.id AND posts.deleted_at IS NULL AND threads.deleted_at IS NULL
           AND posts.id != (SELECT MIN(first_post.id) FROM posts first_post
                            WHERE first_post.thread_id = posts.thread_id))`
  ).run();
})();
db.pragma('optimize');

console.log(`Contenu de démonstration prêt : ${createdTopics} topics et ${createdPosts} messages ajoutés.`);
