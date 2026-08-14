process.umask(0o077);
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateProductionEnvironment } = require('../utils/config');
const projectRoot = path.join(__dirname, '..');

const failures = [];
const warnings = [];
const pass = (label) => console.log(`OK  ${label}`);
const fail = (label) => { failures.push(label); console.error(`KO  ${label}`); };
const warn = (label) => { warnings.push(label); console.warn(`AV  ${label}`); };

if (process.env.NODE_ENV === 'production') {
  try { validateProductionEnvironment(); pass('configuration de production'); } catch (error) { fail(error.message); }
} else {
  warn('contrôle exécuté hors production : les secrets, HTTPS et SMTP ne sont pas validés');
}

for (const file of [
  process.env.DB_PATH || path.join(__dirname, '..', 'db', 'forum.sqlite3'),
  process.env.SESSION_DB_PATH || path.join(__dirname, '..', 'db', 'sessions.sqlite3'),
]) {
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) === 0) pass(`permissions ${path.basename(file)} (${mode.toString(8)})`);
    else fail(`permissions trop larges sur ${file} (${mode.toString(8)})`);
  } catch (error) { fail(`${file} inaccessible : ${error.message}`); }
}

const environmentFile = path.join(projectRoot, '.env');
if (fs.existsSync(environmentFile)) {
  const mode = fs.statSync(environmentFile).mode & 0o777;
  if ((mode & 0o077) === 0) pass(`permissions .env (${mode.toString(8)})`);
  else fail(`permissions trop larges sur .env (${mode.toString(8)})`);
}

if (fs.existsSync(path.join(projectRoot, 'package-lock.json'))) pass('lockfile npm présent');
else fail('package-lock.json absent : les dépendances ne sont pas reproductibles');

try {
  const db = require('../db/database');
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity === 'ok') pass('intégrité SQLite'); else fail(`intégrité SQLite : ${integrity}`);
  if (db.pragma('trusted_schema', { simple: true }) === 0) pass('trusted_schema désactivé');
  else fail('trusted_schema encore actif');
  if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal') pass('journal SQLite en mode WAL');
  else fail('journal SQLite hors mode WAL');
  const foreignKeyErrors = db.pragma('foreign_key_check');
  if (!foreignKeyErrors.length) pass('intégrité des clés étrangères');
  else fail(`${foreignKeyErrors.length} violation(s) de clé étrangère`);
  const requiredIndexes = [
    'idx_threads_forum_listing',
    'idx_threads_user_created',
    'idx_posts_user_created',
    'idx_notifications_user_listing',
    'idx_sanctions_user_active',
    'idx_private_messages_conversation',
  ];
  const existingIndexes = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name)
  );
  const missingIndexes = requiredIndexes.filter((name) => !existingIndexes.has(name));
  if (!missingIndexes.length) pass('index critiques SQLite présents');
  else fail(`index SQLite manquants : ${missingIndexes.join(', ')}`);
  db.close();
} catch (error) { fail(`contrôle SQLite impossible : ${error.message}`); }

try {
  const Database = require('better-sqlite3');
  const sessionPath = process.env.SESSION_DB_PATH || path.join(__dirname, '..', 'db', 'sessions.sqlite3');
  const sessions = new Database(sessionPath, { readonly: true, fileMustExist: true });
  const sessionIntegrity = sessions.pragma('integrity_check', { simple: true });
  if (sessionIntegrity === 'ok') pass('intégrité de la base de sessions');
  else fail(`intégrité des sessions : ${sessionIntegrity}`);
  sessions.close();
} catch (error) { fail(`contrôle des sessions impossible : ${error.message}`); }

function validateDeploymentFile(relativePath, controls) {
  try {
    const contents = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
    const missing = controls.filter(({ pattern }) => !pattern.test(contents)).map(({ label }) => label);
    if (!missing.length) pass(`${relativePath} durci`);
    else fail(`${relativePath} incomplet : ${missing.join(', ')}`);
  } catch (error) { fail(`${relativePath} inaccessible : ${error.message}`); }
}

validateDeploymentFile('deploy/nginx-avebar.conf', [
  { label: 'TLS 1.2/1.3', pattern: /ssl_protocols\s+TLSv1\.2\s+TLSv1\.3/ },
  { label: 'HSTS', pattern: /Strict-Transport-Security/ },
  { label: 'limitation de débit', pattern: /limit_req\s+zone=avebar_general/ },
  { label: 'compression', pattern: /gzip\s+on/ },
  { label: 'protection des fichiers cachés', pattern: /location\s+~\s+\/\\\./ },
]);
validateDeploymentFile('deploy/avebar.service', [
  { label: 'utilisateur non-root', pattern: /^User=avebar$/m },
  { label: 'NoNewPrivileges', pattern: /^NoNewPrivileges=true$/m },
  { label: 'système en lecture seule', pattern: /^ProtectSystem=strict$/m },
  { label: 'répertoires privés', pattern: /^PrivateTmp=true$/m },
  { label: 'capacités retirées', pattern: /^CapabilityBoundingSet=$/m },
]);

const audit = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--omit=dev', '--audit-level=moderate'], {
  cwd: projectRoot, encoding: 'utf8', timeout: 120000,
});
if (audit.status === 0) pass('aucune vulnérabilité npm connue de niveau modéré ou supérieur');
else fail('npm audit signale une vulnérabilité : lance npm audit pour les détails');

if (Number(process.versions.node.split('.')[0]) < 22) warn(`Node.js ${process.version} est ancien ; utilise une version LTS maintenue`);
if (warnings.length) console.warn(`${warnings.length} avertissement(s) à examiner.`);
if (failures.length) {
  console.error(`${failures.length} contrôle(s) de sécurité en échec.`);
  process.exitCode = 1;
} else console.log('Tous les contrôles bloquants sont validés.');
