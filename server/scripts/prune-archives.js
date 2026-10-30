#!/usr/bin/env node
// Lists raw upload archives that belong to nothing: uploads of journeys deleted before archives
// were tracked, and archives of deleted accounts. Archives whose recording still overlaps a
// journey are kept (see findOrphanArchives). Nothing is deleted unless --apply is given.
// Usage: npm run archive:prune [-- --apply]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const { pool, initSchema } = require('../db');
const {
  ARCHIVE_DIR,
  listUserArchives,
  deleteArchiveFiles,
  linkAllArchivesOnce,
  findOrphanArchives,
} = require('../utils/uploadArchive');

async function main() {
  const apply = process.argv.includes('--apply');
  await initSchema();
  await linkAllArchivesOnce();

  const accounts = await findOrphanArchives();
  const orphans = accounts.flatMap((account) => account.orphans);
  const orphanBytes = accounts.reduce((sum, account) => sum + account.bytes, 0);
  for (const a of accounts) {
    const kept = a.overlapping + a.recent + a.unreadable;
    console.log(`${a.owner ? a.owner.username : `${a.dir} (no such account)`}: ${a.total} archive(s), ${a.unreferenced} unreferenced`
      + (kept ? `, ${kept} kept (${a.overlapping} overlap a journey, ${a.recent} under a day old, ${a.unreadable} unreadable)` : ''));
  }

  console.log(`\n${orphans.length} archive(s) to delete, ${(orphanBytes / 1024 / 1024).toFixed(1)} MB`);
  if (!apply) {
    if (orphans.length > 0) console.log('Dry run: nothing deleted. Re-run with --apply to delete them.');
  } else {
    const deleted = await deleteArchiveFiles(orphans);
    for (const account of accounts) {
      if (!account.owner && (await listUserArchives(account.dir)).length === 0) {
        fs.rmSync(path.join(ARCHIVE_DIR, account.dir), { recursive: true, force: true });
      }
    }
    console.log(`Deleted ${deleted} archive(s).`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error('Prune failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
