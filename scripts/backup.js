process.umask(0o077);
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

async function main() {
  const source = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'forum.sqlite3');
  const destinationDirectory = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
  const retentionDays = Math.min(365, Math.max(1, Number.parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || 14));
  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(destinationDirectory, `avebar-${stamp}.sqlite3`);
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(destination); } finally { db.close(); }
  fs.chmodSync(destination, 0o600);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
  fs.writeFileSync(`${destination}.sha256`, `${digest}  ${path.basename(destination)}\n`, { mode: 0o600 });

  const cutoff = Date.now() - retentionDays * 86400000;
  for (const entry of fs.readdirSync(destinationDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^avebar-.*\.sqlite3(?:\.sha256)?$/.test(entry.name)) continue;
    const file = path.join(destinationDirectory, entry.name);
    if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
  }
  console.log(`Sauvegarde SQLite cohérente créée : ${destination}`);
}

main().catch((error) => {
  console.error(`Sauvegarde impossible : ${error.message}`);
  process.exitCode = 1;
});
