#!/usr/bin/env node
// Exports every account's journeys to exports/<username>-<date>.ndjson (one journey per
// line; the same format as Settings → Export data). Usage: npm run migrate:export
// JOURNEY_EXPORT_DIR overrides the output folder.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const { pool, initSchema } = require('../db');
const { writeNdjson } = require('../utils/exporter');
const { PROJECT_ROOT } = require('../config');

const OUTPUT_DIR = process.env.JOURNEY_EXPORT_DIR
  ? path.resolve(process.env.JOURNEY_EXPORT_DIR)
  : path.join(PROJECT_ROOT, 'exports');

async function main() {
  console.log('Connecting to database...');
  await initSchema();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const { rows: users } = await pool.query('SELECT id, username, display_name FROM users ORDER BY created_at');
  console.log(`Found ${users.length} account${users.length === 1 ? '' : 's'}`);

  const date = new Date().toISOString().slice(0, 10);
  let total = 0;
  for (const user of users) {
    const safeName = String(user.username).replace(/[^\w.-]+/g, '_').slice(0, 60) || user.id;
    const file = path.join(OUTPUT_DIR, `${safeName}-${date}.ndjson`);
    const stream = fs.createWriteStream(file);
    const count = await writeNdjson(user.id, stream, { user: { username: user.username, displayName: user.display_name } });
    await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
    console.log(`  ${user.username}: ${count} journeys -> ${file}`);
    total += count;
  }

  console.log(`Export complete: ${total} journeys`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('Export failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
