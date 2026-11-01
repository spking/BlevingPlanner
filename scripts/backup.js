'use strict';
// Makes a consistent copy of the database (safe while the app is running) and keeps the newest BACKUP_KEEP copies.
// Usage: npm run backup
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.join(__dirname, '..');
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const source = path.join(dataDir, 'meal-planner.db');
const backupDir = path.resolve(root, process.env.BACKUP_DIR || 'backups');
const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 30);

if (!fs.existsSync(source)) {
  console.error(`No database found at ${source}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
let target = path.join(backupDir, `meal-planner-${stamp}.db`);
for (let n = 2; fs.existsSync(target); n++) target = path.join(backupDir, `meal-planner-${stamp}-${n}.db`);
const db = new DatabaseSync(source);
db.exec('PRAGMA busy_timeout = 10000');
// VACUUM INTO writes a compact, transactionally consistent snapshot, unlike copying the file
// (which can catch the database mid-write while the app is running).
db.prepare('VACUUM INTO ?').run(target);
db.close();
console.log(`Backed up to ${target}`);

const old = fs.readdirSync(backupDir)
  .filter((f) => /^meal-planner-[\d-]+\.db$/.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }))
  .sort((a, b) => a.t - b.t || a.f.length - b.f.length || a.f.localeCompare(b.f))
  .map((x) => x.f)
  .slice(0, -keep);
for (const f of old) fs.rmSync(path.join(backupDir, f));
if (old.length) console.log(`Removed ${old.length} old backup(s)`);
