const db = require('../db/database');

// Les compteurs publics ne prennent en compte que le contenu actuellement visible.
function recalculateContentCounters() {
  db.prepare(
    `UPDATE threads SET post_count = (
       SELECT COUNT(*) FROM posts
       WHERE posts.thread_id = threads.id AND posts.deleted_at IS NULL
     )`
  ).run();
  db.prepare(
    `UPDATE threads SET last_post_at = COALESCE(
       (SELECT MAX(posts.created_at) FROM posts
        WHERE posts.thread_id = threads.id AND posts.deleted_at IS NULL),
       threads.created_at
     )`
  ).run();
  db.prepare(
    `UPDATE forums SET thread_count = (
       SELECT COUNT(*) FROM threads
       WHERE threads.forum_id = forums.id AND threads.deleted_at IS NULL
     )`
  ).run();
  db.prepare(
    `UPDATE forums SET post_count = (
       SELECT COUNT(*) FROM posts
       JOIN threads ON threads.id = posts.thread_id
       WHERE threads.forum_id = forums.id
         AND threads.deleted_at IS NULL AND posts.deleted_at IS NULL
     )`
  ).run();
  db.prepare(
    `UPDATE users SET message_count = (
       SELECT COUNT(*) FROM posts
       JOIN threads ON threads.id = posts.thread_id
       WHERE posts.user_id = users.id
         AND threads.deleted_at IS NULL AND posts.deleted_at IS NULL
     )`
  ).run();
}

module.exports = { recalculateContentCounters };
