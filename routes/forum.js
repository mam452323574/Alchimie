const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { hasModerationAccess, requireModerationAccess } = require('../middleware/moderation-access');
const { cleanBody } = require('../utils/sanitize');
const { formatBio, youtubeEmbedUrl } = require('../utils/profile');
const { MODERATION_ROLES, ADMIN_ROLES, canModerateTarget, logModeration, getActiveSanction } = require('../utils/moderation');
const { recalculateContentCounters } = require('../utils/content');
const { publishPublicMessage } = require('../utils/realtime');
const {
  POINT_RULES, adjustPoints, canAccessBlackTopics, rankForPoints,
} = require('../utils/points');

const router = express.Router();

const POSTS_PER_PAGE = 20;
const THREADS_PER_PAGE = 20;
const UNREAD_TRACKING_STARTED_AT = db.prepare(
  "SELECT value FROM site_settings WHERE key = 'unread_tracking_started_at'"
).get()?.value || '9999-12-31 23:59:59';
const isStaff = (req) => hasModerationAccess(req);
const canViewBlackTopics = (req) => canAccessBlackTopics(req.user) || isStaff(req);
const canViewThread = (req, thread) => Boolean(thread)
  && (!thread.is_black || canViewBlackTopics(req));
const wantsJson = (req) => String(req.get('accept') || '').includes('application/json');
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false,
});

function getFirstUnreadPost(threadId, lastReadPostId, staffView, unreadSince = '') {
  const visibility = staffView ? '' : 'AND posts.deleted_at IS NULL';
  const precedingVisibility = staffView ? '' : 'AND preceding.deleted_at IS NULL';
  return db.prepare(
    `SELECT posts.id,
      (SELECT COUNT(*) FROM posts preceding
       WHERE preceding.thread_id = posts.thread_id AND preceding.id <= posts.id ${precedingVisibility}) AS position_in_thread
     FROM posts
     WHERE posts.thread_id = ? AND posts.id > ?
       AND (? = '' OR posts.created_at > ?) ${visibility}
     ORDER BY posts.id ASC LIMIT 1`
  ).get(threadId, Math.max(0, Number(lastReadPostId) || 0), unreadSince, unreadSince);
}

function getUnreadCount(threadId, lastReadPostId, staffView, unreadSince = '') {
  const visibility = staffView ? '' : 'AND deleted_at IS NULL';
  return db.prepare(
    `SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? AND id > ?
      AND (? = '' OR created_at > ?) ${visibility}`
  ).get(threadId, Math.max(0, Number(lastReadPostId) || 0), unreadSince, unreadSince).c;
}

function markThreadRead(userId, threadId, lastReadPostId) {
  if (!userId || !lastReadPostId) return;
  db.prepare(
    `INSERT INTO thread_reads (user_id, thread_id, last_read_post_id)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, thread_id) DO UPDATE SET
       last_read_post_id = MAX(thread_reads.last_read_post_id, excluded.last_read_post_id),
       read_at = datetime('now')`
  ).run(userId, threadId, lastReadPostId);
}

function decorateThreadReadState(req, threads) {
  if (!req.user) return;
  const staffView = isStaff(req);
  const readStatement = db.prepare(
    'SELECT last_read_post_id FROM thread_reads WHERE user_id = ? AND thread_id = ?'
  );
  for (const thread of threads) {
    const readState = readStatement.get(req.user.id, thread.id);
    const lastReadPostId = readState?.last_read_post_id || 0;
    const unreadSince = readState
      ? ''
      : (String(req.user.created_at || '') > UNREAD_TRACKING_STARTED_AT
        ? String(req.user.created_at)
        : UNREAD_TRACKING_STARTED_AT);
    const firstUnread = getFirstUnreadPost(thread.id, lastReadPostId, staffView, unreadSince);
    thread.unread_count = firstUnread ? getUnreadCount(thread.id, lastReadPostId, staffView, unreadSince) : 0;
    thread.first_unread_post_id = firstUnread?.id || null;
    thread.first_unread_page = firstUnread
      ? Math.max(1, Math.ceil(firstUnread.position_in_thread / POSTS_PER_PAGE))
      : null;
  }
}

function preparePostExtras(req, posts) {
  const pollsByPost = {};
  for (const post of posts) {
    post.rank = rankForPoints(post.points);
    const poll = db.prepare('SELECT * FROM polls WHERE post_id = ?').get(post.id);
    post.can_moderate = isStaff(req) && canModerateTarget(req.user, { id: post.user_id, role: post.role });
    if (poll) {
      poll.options = db.prepare(
        `SELECT poll_options.*, COUNT(poll_votes.user_id) AS votes
         FROM poll_options LEFT JOIN poll_votes ON poll_votes.option_id = poll_options.id
         WHERE poll_options.poll_id = ? GROUP BY poll_options.id ORDER BY poll_options.position`
      ).all(poll.id);
      poll.totalVotes = poll.options.reduce((sum, option) => sum + option.votes, 0);
      poll.userOptionId = req.user
        ? db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, req.user.id)?.option_id
        : null;
      pollsByPost[post.id] = poll;
    }
  }
  return pollsByPost;
}

// Page d'accueil : liste des catégories avec leurs forums
router.get('/', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY position').all();
  const forumsByCategory = {};
  for (const cat of categories) {
    forumsByCategory[cat.id] = db
      .prepare('SELECT * FROM forums WHERE category_id = ? ORDER BY position')
      .all(cat.id);
  }
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    threads: db.prepare('SELECT COUNT(*) AS c FROM threads WHERE deleted_at IS NULL').get().c,
    posts: db.prepare(
      `SELECT COUNT(*) AS c FROM posts JOIN threads ON threads.id = posts.thread_id
       WHERE posts.deleted_at IS NULL AND threads.deleted_at IS NULL`
    ).get().c,
  };
  res.render('index', { categories, forumsByCategory, stats });
});

// L'onglet Forum correspond au Blabla général. Les autres espaces restent
// accessibles comme sous-forums depuis la barre latérale.
router.get('/forum', (req, res) => {
  const parameters = new URLSearchParams();
  const search = String(req.query.q || '').trim().slice(0, 100);
  const scope = req.query.scope === 'author' ? 'author' : 'title';
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  if (search) parameters.set('q', search);
  if (search) parameters.set('scope', scope);
  if (page > 1) parameters.set('page', String(page));
  const query = parameters.toString();
  res.redirect(`/f/blabla${query ? `?${query}` : ''}`);
});

// Liste des threads d'un forum
router.get('/f/:slug', (req, res) => {
  const forum = db.prepare('SELECT * FROM forums WHERE slug = ?').get(req.params.slug);
  if (!forum) return res.status(404).render('error', { message: 'Forum introuvable.', statusCode: 404 });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const search = String(req.query.q || '').trim().slice(0, 100);
  const searchScope = req.query.scope === 'author' ? 'author' : 'title';
  const offset = (page - 1) * THREADS_PER_PAGE;
  const deletedFilter = isStaff(req) ? '' : 'AND threads.deleted_at IS NULL';
  const blackFilter = canViewBlackTopics(req) ? '' : 'AND threads.is_black = 0';
  const searchColumn = searchScope === 'author' ? 'users.username' : 'threads.title';
  const filter = `%${search}%`;

  const threads = db
    .prepare(
      `SELECT threads.*, users.username AS author_name, users.role AS author_role
       FROM threads JOIN users ON users.id = threads.user_id
       WHERE forum_id = ? AND (? = '' OR ${searchColumn} LIKE ? COLLATE NOCASE) ${deletedFilter} ${blackFilter}
       ORDER BY is_pinned DESC, last_post_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(forum.id, search, filter, THREADS_PER_PAGE, offset);
  decorateThreadReadState(req, threads);

  const totalThreads = db.prepare(
    `SELECT COUNT(*) AS c FROM threads JOIN users ON users.id = threads.user_id
     WHERE forum_id = ? AND (? = '' OR ${searchColumn} LIKE ? COLLATE NOCASE) ${deletedFilter} ${blackFilter}`
  ).get(forum.id, search, filter).c;
  const totalPages = Math.max(1, Math.ceil(totalThreads / THREADS_PER_PAGE));
  const mainForum = db.prepare("SELECT * FROM forums WHERE slug = 'blabla'").get();
  const subForums = db.prepare("SELECT * FROM forums WHERE slug != 'blabla' ORDER BY position").all();
  const threadDraft = req.session.threadDraft?.forumSlug === forum.slug
    ? req.session.threadDraft
    : null;
  if (threadDraft) delete req.session.threadDraft;

  res.render('forum', {
    forum, threads, page, totalPages, totalThreads, search, searchScope, mainForum, subForums,
    composerError: threadDraft?.error || null,
    oldTitle: threadDraft?.oldTitle || '',
    oldBody: threadDraft?.oldBody || '',
    oldIsBlack: Boolean(threadDraft?.oldIsBlack),
    canCreateBlackTopic: canAccessBlackTopics(req.user),
  });
});

// L'ancien écran dédié renvoie maintenant vers le formulaire intégré au forum.
router.get('/f/:slug/nouveau-sujet', requireAuth, (req, res) => {
  const forum = db.prepare('SELECT * FROM forums WHERE slug = ?').get(req.params.slug);
  if (!forum) return res.status(404).render('error', { message: 'Forum introuvable.', statusCode: 404 });
  res.redirect(`/f/${forum.slug}#nouveau-sujet`);
});

router.post('/f/:slug/nouveau-sujet', requireAuth, writeLimiter, (req, res) => {
  const forum = db.prepare('SELECT * FROM forums WHERE slug = ?').get(req.params.slug);
  if (!forum) return res.status(404).render('error', { message: 'Forum introuvable.', statusCode: 404 });
  if (forum.is_locked) return res.status(403).render('error', { message: 'Ce forum est verrouillé.', statusCode: 403 });

  const title = (req.body.title || '').trim().slice(0, 150);
  const body = cleanBody(req.body.body).slice(0, 20000);
  const isBlack = req.body.is_black === '1';

  if (isBlack && !canAccessBlackTopics(req.user)) {
    req.session.threadDraft = {
      forumSlug: forum.slug,
      error: 'Les topics noirs sont accessibles à partir du rang Bronze (100 points).',
      oldTitle: title,
      oldBody: req.body.body || '',
      oldIsBlack: true,
    };
    return res.redirect(`/f/${forum.slug}#nouveau-sujet`);
  }

  if (title.length < 3 || body.length < 1) {
    req.session.threadDraft = {
      forumSlug: forum.slug,
      error: 'Titre trop court ou message vide.',
      oldTitle: title,
      oldBody: req.body.body || '',
      oldIsBlack: isBlack,
    };
    return res.redirect(`/f/${forum.slug}#nouveau-sujet`);
  }

  const lastThread = db.prepare(
    `SELECT CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS elapsed
     FROM threads WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(req.user.id);
  if (lastThread && lastThread.elapsed < 60) {
    req.session.threadDraft = {
      forumSlug: forum.slug,
      error: `Patiente encore ${Math.max(1, 60 - lastThread.elapsed)} seconde(s) avant de créer un autre topic.`,
      oldTitle: title,
      oldBody: req.body.body || '',
      oldIsBlack: isBlack,
    };
    return res.redirect(`/f/${forum.slug}#nouveau-sujet`);
  }

  const insertThread = db.prepare(
    `INSERT INTO threads (forum_id, user_id, title, is_black) VALUES (?, ?, ?, ?)`
  );
  const insertPost = db.prepare(
    `INSERT INTO posts (thread_id, user_id, body) VALUES (?, ?, ?)`
  );

  const tx = db.transaction(() => {
    const { lastInsertRowid: threadId } = insertThread.run(forum.id, req.user.id, title, isBlack ? 1 : 0);
    insertPost.run(threadId, req.user.id, body);
    db.prepare('UPDATE threads SET post_count = 1 WHERE id = ?').run(threadId);
    db.prepare('UPDATE forums SET thread_count = thread_count + 1, post_count = post_count + 1 WHERE id = ?').run(forum.id);
    db.prepare('UPDATE users SET message_count = message_count + 1 WHERE id = ?').run(req.user.id);
    adjustPoints(req.user.id, POINT_RULES.topicCreated);
    return threadId;
  });
  const threadId = tx();
  req.session.toast = { type: 'success', message: 'Le topic a bien été publié.' };
  res.redirect(`/t/${threadId}`);
});

// Affichage d'un thread avec pagination des messages
router.get('/t/:id', (req, res) => {
  const staffView = isStaff(req);
  const thread = db.prepare(
    `SELECT threads.*, deleted_actor.username AS deleted_by_name
     FROM threads LEFT JOIN users deleted_actor ON deleted_actor.id = threads.deleted_by
     WHERE threads.id = ?`
  ).get(req.params.id);
  if (!canViewThread(req, thread)) return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  if (thread.deleted_at && !staffView) {
    return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  }
  const forum = db.prepare('SELECT * FROM forums WHERE id = ?').get(thread.forum_id);

  let firstUnread = null;
  if (req.user) {
    const readState = db.prepare(
      'SELECT last_read_post_id FROM thread_reads WHERE user_id = ? AND thread_id = ?'
    ).get(req.user.id, thread.id);
    if (readState) {
      const unreadPost = getFirstUnreadPost(thread.id, readState.last_read_post_id, staffView);
      if (unreadPost) {
        firstUnread = {
          postId: unreadPost.id,
          page: Math.max(1, Math.ceil(unreadPost.position_in_thread / POSTS_PER_PAGE)),
        };
      }
    }
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * POSTS_PER_PAGE;

  const posts = db
    .prepare(
      `SELECT posts.*, users.username, users.signature, users.avatar_color, users.avatar_url,
        users.role, users.message_count, users.points, users.created_at AS user_created_at,
        (posts.id = (SELECT MIN(first_post.id) FROM posts first_post
                     WHERE first_post.thread_id = posts.thread_id)) AS is_first_post,
        (SELECT CASE WHEN active.is_eradication = 1 THEN 'eradication' ELSE active.type END
         FROM sanctions active WHERE active.user_id = users.id AND active.revoked_at IS NULL
           AND (active.type = 'ban' OR active.ends_at > datetime('now'))
         ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS active_sanction,
        (SELECT active.ends_at FROM sanctions active
         WHERE active.user_id = users.id AND active.revoked_at IS NULL
           AND (active.type = 'ban' OR active.ends_at > datetime('now'))
         ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS sanction_ends_at,
        parent.id AS parent_post_id, parent.body AS parent_body,
        parent_user.username AS parent_username, parent_user.role AS parent_role,
        deleted_actor.username AS deleted_by_name
       FROM posts JOIN users ON users.id = posts.user_id
       LEFT JOIN posts parent ON parent.id = posts.reply_to_post_id ${staffView ? '' : 'AND parent.deleted_at IS NULL'}
       LEFT JOIN users parent_user ON parent_user.id = parent.user_id
       LEFT JOIN users deleted_actor ON deleted_actor.id = posts.deleted_by
       WHERE posts.thread_id = ? ${staffView ? '' : 'AND posts.deleted_at IS NULL'}
       ORDER BY posts.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(thread.id, POSTS_PER_PAGE, offset);

  const visiblePostCount = db.prepare(
    `SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? ${staffView ? '' : 'AND deleted_at IS NULL'}`
  ).get(thread.id).c;
  const totalPages = Math.max(1, Math.ceil(visiblePostCount / POSTS_PER_PAGE));

  const pollsByPost = preparePostExtras(req, posts);

  if (page === 1) {
    db.prepare('UPDATE threads SET views = views + 1 WHERE id = ?').run(thread.id);
  }

  if (req.user && posts.length) {
    markThreadRead(req.user.id, thread.id, posts[posts.length - 1].id);
  }

  const isFollowing = req.user
    ? Boolean(db.prepare(
      'SELECT 1 FROM thread_follows WHERE user_id = ? AND thread_id = ?'
    ).get(req.user.id, thread.id))
    : false;

  res.render('thread', {
    thread, forum, posts, pollsByPost, page, totalPages, firstUnread, isFollowing,
  });
});

// Fragment HTML utilisé par le flux temps réel. Le serveur conserve ici les
// mêmes règles de visibilité et de permissions que sur la page complète.
router.get('/t/:id/nouveaux-messages', (req, res) => {
  const staffView = isStaff(req);
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
  if (!canViewThread(req, thread) || (thread.deleted_at && !staffView)) {
    return res.status(404).json({ error: 'Sujet introuvable.' });
  }
  const after = Math.max(0, Number.parseInt(req.query.apres, 10) || 0);
  const currentPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const visibility = staffView ? '' : 'AND posts.deleted_at IS NULL';
  const totalMessages = db.prepare(
    `SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? ${visibility}`
  ).get(thread.id).c;
  const totalPages = Math.max(1, Math.ceil(totalMessages / POSTS_PER_PAGE));
  const latestMessageId = db.prepare(
    `SELECT COALESCE(MAX(id), 0) AS id FROM posts WHERE thread_id = ? ${visibility}`
  ).get(thread.id).id;

  if (currentPage !== totalPages) {
    return res.json({
      append: false,
      html: '',
      latestMessageId,
      newCount: db.prepare(
        `SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? AND id > ? ${visibility}`
      ).get(thread.id, after).c,
      totalPages,
    });
  }

  const posts = db.prepare(
    `SELECT posts.*, users.username, users.signature, users.avatar_color, users.avatar_url,
      users.role, users.message_count, users.points, users.created_at AS user_created_at,
      (posts.id = (SELECT MIN(first_post.id) FROM posts first_post
                   WHERE first_post.thread_id = posts.thread_id)) AS is_first_post,
      (SELECT CASE WHEN active.is_eradication = 1 THEN 'eradication' ELSE active.type END
       FROM sanctions active WHERE active.user_id = users.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS active_sanction,
      (SELECT active.ends_at FROM sanctions active
       WHERE active.user_id = users.id AND active.revoked_at IS NULL
         AND (active.type = 'ban' OR active.ends_at > datetime('now'))
       ORDER BY active.created_at DESC, active.id DESC LIMIT 1) AS sanction_ends_at,
      parent.id AS parent_post_id, parent.body AS parent_body,
      parent_user.username AS parent_username, parent_user.role AS parent_role,
      deleted_actor.username AS deleted_by_name
     FROM posts JOIN users ON users.id = posts.user_id
     LEFT JOIN posts parent ON parent.id = posts.reply_to_post_id ${staffView ? '' : 'AND parent.deleted_at IS NULL'}
     LEFT JOIN users parent_user ON parent_user.id = parent.user_id
     LEFT JOIN users deleted_actor ON deleted_actor.id = posts.deleted_by
     WHERE posts.thread_id = ? AND posts.id > ? ${visibility}
     ORDER BY posts.id ASC LIMIT ?`
  ).all(thread.id, after, POSTS_PER_PAGE);
  if (req.user && posts.length) {
    markThreadRead(req.user.id, thread.id, posts[posts.length - 1].id);
  }
  const pollsByPost = preparePostExtras(req, posts);
  res.set('Cache-Control', 'no-store');
  return res.render('partials/public-post-list', { posts, pollsByPost, thread }, (error, html) => {
    if (error) return res.status(500).json({ error: 'Actualisation impossible.' });
    return res.json({
      append: true,
      html,
      latestMessageId,
      newCount: posts.length,
      totalPages,
    });
  });
});

router.post('/t/:id/suivre', requireAuth, (req, res) => {
  const thread = db.prepare('SELECT id, deleted_at, is_black FROM threads WHERE id = ?').get(req.params.id);
  if (!canViewThread(req, thread) || (thread.deleted_at && !isStaff(req))) {
    return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  }
  db.prepare(
    `INSERT OR IGNORE INTO thread_follows (user_id, thread_id) VALUES (?, ?)`
  ).run(req.user.id, thread.id);
  req.session.toast = { type: 'success', message: 'Tu suis maintenant ce topic.' };
  const page = Math.max(1, Number.parseInt(req.body.page, 10) || 1);
  return res.redirect(`/t/${thread.id}${page > 1 ? `?page=${page}` : ''}`);
});

router.post('/t/:id/ne-plus-suivre', requireAuth, (req, res) => {
  const thread = db.prepare('SELECT id, deleted_at, is_black FROM threads WHERE id = ?').get(req.params.id);
  if (!canViewThread(req, thread) || (thread.deleted_at && !isStaff(req))) {
    return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  }
  db.prepare(
    'DELETE FROM thread_follows WHERE user_id = ? AND thread_id = ?'
  ).run(req.user.id, thread.id);
  req.session.toast = { type: 'success', message: 'Tu ne suis plus ce topic.' };
  const page = Math.max(1, Number.parseInt(req.body.page, 10) || 1);
  return res.redirect(`/t/${thread.id}${page > 1 ? `?page=${page}` : ''}`);
});

// Répondre à un thread
router.post('/t/:id/repondre', requireAuth, writeLimiter, (req, res) => {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
  if (!canViewThread(req, thread)) return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  if (thread.deleted_at) return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  if (thread.is_locked) return res.status(403).render('error', { message: 'Ce sujet est verrouillé.', statusCode: 403 });

  const body = cleanBody(req.body.body).slice(0, 20000);
  if (body.length < 1) {
    if (wantsJson(req)) return res.status(400).json({ error: 'Le message ne peut pas être vide.' });
    return res.redirect(`/t/${thread.id}`);
  }

  const lastPost = db.prepare(
    `SELECT CAST((julianday('now') - julianday(created_at)) * 86400 AS INTEGER) AS elapsed
     FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(req.user.id);
  if (lastPost && lastPost.elapsed < 3) {
    const message = `Patiente encore ${Math.max(1, 3 - lastPost.elapsed)} seconde(s) avant de poster un nouveau message.`;
    if (wantsJson(req)) return res.status(429).json({ error: message });
    req.session.toast = { type: 'error', message };
    return res.redirect(`/t/${thread.id}#bas`);
  }

  const replyToId = Number.parseInt(req.body.reply_to_post_id, 10) || null;
  const replyTarget = replyToId
    ? db.prepare('SELECT * FROM posts WHERE id = ? AND thread_id = ? AND deleted_at IS NULL').get(replyToId, thread.id)
    : null;

  const tx = db.transaction(() => {
    const postInfo = db.prepare(
      'INSERT INTO posts (thread_id, user_id, reply_to_post_id, body) VALUES (?, ?, ?, ?)'
    ).run(thread.id, req.user.id, replyTarget?.id || null, body);
    const pollQuestion = (req.body.poll_question || '').trim().slice(0, 180);
    const pollOptions = String(req.body.poll_options || '').split(/\r?\n/).map((option) => option.trim().slice(0, 100)).filter(Boolean).slice(0, 10);
    if (pollQuestion && pollOptions.length >= 2) {
      const pollInfo = db.prepare('INSERT INTO polls (post_id, question, created_by) VALUES (?, ?, ?)').run(postInfo.lastInsertRowid, pollQuestion, req.user.id);
      const insertOption = db.prepare('INSERT INTO poll_options (poll_id, label, position) VALUES (?, ?, ?)');
      pollOptions.forEach((option, index) => insertOption.run(pollInfo.lastInsertRowid, option, index));
    }
    db.prepare(
      `UPDATE threads SET post_count = post_count + 1, last_post_at = datetime('now') WHERE id = ?`
    ).run(thread.id);
    db.prepare('UPDATE forums SET post_count = post_count + 1 WHERE id = ?').run(thread.forum_id);
    db.prepare('UPDATE users SET message_count = message_count + 1 WHERE id = ?').run(req.user.id);
    adjustPoints(req.user.id, POINT_RULES.messageCreated);
    const directRecipientId = replyTarget && replyTarget.user_id !== req.user.id
      ? replyTarget.user_id
      : null;
    if (directRecipientId) {
      db.prepare(
        `INSERT INTO notifications (user_id, actor_id, post_id, thread_id, kind)
         VALUES (?, ?, ?, ?, 'reply')`
      ).run(directRecipientId, req.user.id, postInfo.lastInsertRowid, thread.id);
    }
    db.prepare(
      `INSERT INTO notifications (user_id, actor_id, post_id, thread_id, kind)
       SELECT follows.user_id, ?, ?, ?, 'follow'
       FROM thread_follows follows
       WHERE follows.thread_id = ? AND follows.user_id != ?
         AND follows.user_id != COALESCE(?, -1)`
    ).run(
      req.user.id, postInfo.lastInsertRowid, thread.id, thread.id,
      req.user.id, directRecipientId
    );
    return postInfo.lastInsertRowid;
  });
  const newPostId = tx();

  const totalPages = Math.max(1, Math.ceil((thread.post_count + 1) / POSTS_PER_PAGE));
  publishPublicMessage({ threadId: thread.id, messageId: newPostId, senderId: req.user.id });
  if (wantsJson(req)) {
    return res.status(201).json({
      ok: true,
      postId: Number(newPostId),
      totalPages,
      message: replyTarget ? 'Ta réponse a bien été publiée.' : 'Ton message a bien été publié.',
    });
  }
  req.session.toast = { type: 'success', message: replyTarget ? 'Ta réponse a bien été publiée.' : 'Ton message a bien été publié.' };
  res.redirect(`/t/${thread.id}?page=${totalPages}#post-${newPostId}`);
});

router.post('/sondage/:id/voter', requireAuth, (req, res) => {
  const poll = db.prepare(
    `SELECT polls.*, posts.thread_id, threads.is_black FROM polls
     JOIN posts ON posts.id = polls.post_id
     JOIN threads ON threads.id = posts.thread_id
     WHERE polls.id = ? AND posts.deleted_at IS NULL AND threads.deleted_at IS NULL`
  ).get(req.params.id);
  const option = db.prepare('SELECT * FROM poll_options WHERE id = ? AND poll_id = ?').get(req.body.option_id, req.params.id);
  if (!poll || !option || !canViewThread(req, poll)) return res.status(404).render('error', { message: 'Sondage introuvable.', statusCode: 404 });
  db.prepare(
    `INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)
     ON CONFLICT(poll_id, user_id) DO UPDATE SET option_id = excluded.option_id, created_at = datetime('now')`
  ).run(poll.id, option.id, req.user.id);
  res.redirect(`/t/${poll.thread_id}#post-${poll.post_id}`);
});

// Édition d'un message (auteur, modérateur ou admin)
router.get('/message/:id/editer', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).render('error', { message: 'Message introuvable.', statusCode: 404 });
  const thread = db.prepare('SELECT id, is_black FROM threads WHERE id = ?').get(post.thread_id);
  if (!canViewThread(req, thread)) return res.status(404).render('error', { message: 'Message introuvable.', statusCode: 404 });
  if (post.deleted_at) return res.status(409).render('error', { message: 'Restaure ce message avant de le modifier.', statusCode: 409 });
  const canEdit = post.user_id === req.user.id || (hasModerationAccess(req) && ADMIN_ROLES.includes(req.user.role));
  if (!canEdit) return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });
  res.render('edit-post', { post, error: null });
});

router.post('/message/:id/editer', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).render('error', { message: 'Message introuvable.', statusCode: 404 });
  const thread = db.prepare('SELECT id, is_black FROM threads WHERE id = ?').get(post.thread_id);
  if (!canViewThread(req, thread)) return res.status(404).render('error', { message: 'Message introuvable.', statusCode: 404 });
  if (post.deleted_at) return res.status(409).render('error', { message: 'Restaure ce message avant de le modifier.', statusCode: 409 });
  const canEdit = post.user_id === req.user.id || (hasModerationAccess(req) && ADMIN_ROLES.includes(req.user.role));
  if (!canEdit) return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });

  const body = cleanBody(req.body.body).slice(0, 20000);
  if (body.length < 1) return res.render('edit-post', { post, error: 'Le message ne peut pas être vide.' });

  db.prepare(`UPDATE posts SET body = ?, edited_at = datetime('now') WHERE id = ?`).run(body, post.id);
  req.session.toast = { type: 'success', message: 'Le message a bien été modifié.' };
  res.redirect(`/t/${post.thread_id}`);
});

// Suppression réversible d'un message (auteur, administrateur ou développeur)
router.post('/message/:id/supprimer', requireAuth, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).render('error', { message: 'Message introuvable.', statusCode: 404 });
  const canDelete = post.user_id === req.user.id || (hasModerationAccess(req) && ADMIN_ROLES.includes(req.user.role));
  if (!canDelete) return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });

  if (post.deleted_at) return res.redirect(`/t/${post.thread_id}#post-${post.id}`);
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(post.thread_id);
  if (!canViewThread(req, thread)) return res.status(404).render('error', { message: 'Message introuvable.', statusCode: 404 });
  const firstPostId = db.prepare(
    'SELECT id FROM posts WHERE thread_id = ? ORDER BY id ASC LIMIT 1'
  ).get(thread.id)?.id;
  if (post.id === firstPostId) {
    return res.status(409).render('error', {
      message: 'Le message initial est lié au topic. Utilise « Supprimer le topic » pour les masquer ensemble.',
      statusCode: 409,
    });
  }

  const tx = db.transaction(() => {
    const postDeleted = db.prepare(
      `UPDATE posts SET deleted_at = datetime('now'), deleted_by = ?, deletion_reason = 'Suppression manuelle'
       WHERE id = ? AND deleted_at IS NULL`
    ).run(req.user.id, post.id).changes > 0;
    if (postDeleted) adjustPoints(post.user_id, POINT_RULES.messageDeleted);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? AND deleted_at IS NULL').get(thread.id).c;
    let threadDeleted = false;
    if (remaining === 0) {
      threadDeleted = db.prepare(
        `UPDATE threads SET deleted_at = datetime('now'), deleted_by = ?, deletion_reason = 'Sujet sans message visible'
         WHERE id = ? AND deleted_at IS NULL`
      ).run(req.user.id, thread.id).changes > 0;
      if (threadDeleted) adjustPoints(thread.user_id, POINT_RULES.topicDeleted);
    }
    recalculateContentCounters();
    return { postDeleted, threadDeleted };
  });
  tx();

  logModeration(req.user.id, post.user_id, 'post_deleted', `Message #${post.id} masqué dans le sujet #${thread.id}`);
  const updatedThread = db.prepare('SELECT deleted_at FROM threads WHERE id = ?').get(thread.id);
  if (!thread.deleted_at && updatedThread?.deleted_at) {
    logModeration(req.user.id, thread.user_id, 'thread_deleted', `Sujet #${thread.id} « ${thread.title} » masqué car il ne contient plus de message visible`);
  }
  req.session.toast = { type: 'success', message: 'Le message a été supprimé et peut être restauré par le staff.' };

  if (!updatedThread?.deleted_at || isStaff(req)) {
    res.redirect(`/t/${thread.id}`);
  } else {
    res.redirect(`/f/${db.prepare('SELECT slug FROM forums WHERE id = ?').get(thread.forum_id).slug}`);
  }
});

// Suppression et restauration réversibles des sujets.
router.post('/t/:id/supprimer', requireAuth, (req, res) => {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
  if (!canViewThread(req, thread)) return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  const canDelete = thread.user_id === req.user.id || (hasModerationAccess(req) && ADMIN_ROLES.includes(req.user.role));
  if (!canDelete) return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });
  if (!thread.deleted_at) {
    const deletion = db.transaction(() => {
      const firstPost = db.prepare(
        'SELECT id, user_id, deleted_at FROM posts WHERE thread_id = ? ORDER BY id ASC LIMIT 1'
      ).get(thread.id);
      db.prepare(
        `UPDATE threads SET deleted_at = datetime('now'), deleted_by = ?, deletion_reason = 'Suppression manuelle'
         WHERE id = ?`
      ).run(req.user.id, thread.id);
      adjustPoints(thread.user_id, POINT_RULES.topicDeleted);
      const firstPostDeleted = firstPost && !firstPost.deleted_at
        ? db.prepare(
          `UPDATE posts SET deleted_at = datetime('now'), deleted_by = ?, deletion_reason = 'Suppression liée au topic'
           WHERE id = ? AND deleted_at IS NULL`
        ).run(req.user.id, firstPost.id).changes > 0
        : false;
      recalculateContentCounters();
      return { firstPost, firstPostDeleted };
    })();
    logModeration(
      req.user.id,
      thread.user_id,
      'thread_deleted',
      `Sujet #${thread.id} « ${thread.title} » et son message initial${deletion.firstPost ? ` #${deletion.firstPost.id}` : ''} masqués`
    );
    if (deletion.firstPostDeleted) {
      logModeration(req.user.id, deletion.firstPost.user_id, 'post_deleted', `Message initial #${deletion.firstPost.id} masqué avec le sujet #${thread.id}`);
    }
  }
  req.session.toast = { type: 'success', message: 'Le topic a été supprimé et reste restaurable par le staff.' };
  res.redirect(isStaff(req) ? `/t/${thread.id}` : `/f/${db.prepare('SELECT slug FROM forums WHERE id = ?').get(thread.forum_id).slug}`);
});

router.post('/message/:id/restaurer', requireAuth, requireModerationAccess, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).render('error', { message: 'Message introuvable.', statusCode: 404 });
  if (post.deleted_at) {
    const firstPostId = db.prepare(
      'SELECT id FROM posts WHERE thread_id = ? ORDER BY id ASC LIMIT 1'
    ).get(post.thread_id)?.id;
    const restoresMessagePoints = post.id !== firstPostId
      || post.deletion_reason === 'Suppression manuelle';
    db.transaction(() => {
      db.prepare("UPDATE posts SET deleted_at = NULL, deleted_by = NULL, deletion_reason = '' WHERE id = ?").run(post.id);
      if (restoresMessagePoints) adjustPoints(post.user_id, POINT_RULES.messageRestored);
      recalculateContentCounters();
    })();
    logModeration(req.user.id, post.user_id, 'post_restored', `Message #${post.id} restauré dans le sujet #${post.thread_id}`);
  }
  req.session.toast = { type: 'success', message: 'Le message a bien été restauré.' };
  res.redirect(`/t/${post.thread_id}#post-${post.id}`);
});

router.post('/t/:id/restaurer', requireAuth, requireModerationAccess, (req, res) => {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
  if (!thread) return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  if (thread.deleted_at) {
    const restoration = db.transaction(() => {
      const firstPost = db.prepare(
        'SELECT id, user_id, deleted_at, deletion_reason FROM posts WHERE thread_id = ? ORDER BY id ASC LIMIT 1'
      ).get(thread.id);
      db.prepare("UPDATE threads SET deleted_at = NULL, deleted_by = NULL, deletion_reason = '' WHERE id = ?").run(thread.id);
      adjustPoints(thread.user_id, POINT_RULES.topicRestored);
      const firstPostRestored = firstPost?.deleted_at
        ? db.prepare(
          "UPDATE posts SET deleted_at = NULL, deleted_by = NULL, deletion_reason = '' WHERE id = ? AND deleted_at IS NOT NULL"
        ).run(firstPost.id).changes > 0
        : false;
      const separatelyDeletedFirstPost = firstPostRestored && firstPost.deletion_reason === 'Suppression manuelle';
      if (separatelyDeletedFirstPost) adjustPoints(firstPost.user_id, POINT_RULES.messageRestored);
      recalculateContentCounters();
      return { firstPost, firstPostRestored, separatelyDeletedFirstPost };
    })();
    logModeration(
      req.user.id,
      thread.user_id,
      'thread_restored',
      `Sujet #${thread.id} « ${thread.title} » et son message initial${restoration.firstPost ? ` #${restoration.firstPost.id}` : ''} restaurés`
    );
    if (restoration.firstPostRestored) {
      logModeration(req.user.id, restoration.firstPost.user_id, 'post_restored', `Message initial #${restoration.firstPost.id} restauré avec le sujet #${thread.id}`);
    }
  }
  req.session.toast = { type: 'success', message: 'Le topic a bien été restauré.' };
  res.redirect(`/t/${thread.id}`);
});

// Pin / lock (modérateur ou admin)
router.post('/t/:id/epingler', requireAuth, requireModerationAccess, (req, res) => {
  if (!MODERATION_ROLES.includes(req.user.role)) return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
  if (!thread) return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  db.prepare('UPDATE threads SET is_pinned = ? WHERE id = ?').run(thread.is_pinned ? 0 : 1, thread.id);
  logModeration(req.user.id, thread.user_id, thread.is_pinned ? 'thread_unpinned' : 'thread_pinned', `Sujet #${thread.id} « ${thread.title} »`);
  res.redirect(`/t/${thread.id}`);
});

router.post('/t/:id/verrouiller', requireAuth, requireModerationAccess, (req, res) => {
  if (!ADMIN_ROLES.includes(req.user.role)) return res.status(403).render('error', { message: 'Accès refusé.', statusCode: 403 });
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(req.params.id);
  if (!thread) return res.status(404).render('error', { message: 'Sujet introuvable.', statusCode: 404 });
  db.prepare('UPDATE threads SET is_locked = ? WHERE id = ?').run(thread.is_locked ? 0 : 1, thread.id);
  logModeration(req.user.id, thread.user_id, thread.is_locked ? 'thread_unlocked' : 'thread_locked', `Sujet #${thread.id} « ${thread.title} »`);
  res.redirect(`/t/${thread.id}`);
});

// Profil public d'un membre
router.get('/membre/:username', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).render('error', { message: 'Membre introuvable.', statusCode: 404 });
  const activeSanction = getActiveSanction(user.id);
  const membershipDays = Math.max(0, Math.floor(
    (Date.now() - Date.parse(`${user.created_at.replace(' ', 'T')}Z`)) / 86400000
  ));
  const latestTopics = db.prepare(
    `SELECT threads.id, threads.title, threads.post_count, threads.created_at, threads.last_post_at,
      threads.is_pinned, forums.name AS forum_name, forums.slug AS forum_slug
     FROM threads JOIN forums ON forums.id = threads.forum_id
     WHERE threads.user_id = ? AND threads.deleted_at IS NULL
       ${canViewBlackTopics(req) ? '' : 'AND threads.is_black = 0'}
     ORDER BY threads.created_at DESC LIMIT 10`
  ).all(user.id);
  res.render('profile', {
    profileUser: user,
    latestTopics,
    formattedBio: formatBio(user.bio),
    youtubeEmbed: youtubeEmbedUrl(user.youtube_url),
    avatarIsGif: /\.gif(?:$|\?)/i.test(user.avatar_url || ''),
    profileSanction: activeSanction ? {
      type: activeSanction.is_eradication ? 'eradication' : activeSanction.type,
      endsAt: activeSanction.ends_at || null,
      reason: String(activeSanction.reason || '').trim(),
    } : null,
    membershipDays,
    profileRank: rankForPoints(user.points),
    canAccessBlackTopics: canAccessBlackTopics(user),
  });
});

module.exports = router;
