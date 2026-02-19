#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const { pool, initSchema, toApiRoute } = require('../db');
const { PROJECT_ROOT } = require('../config');

const OUTPUT_PATH = path.join(PROJECT_ROOT, 'database-export.json');

async function main() {
  console.log('Connecting to database...');
  await initSchema();

  const { rows: routes } = await pool.query('SELECT * FROM routes ORDER BY start_time ASC');
  console.log(`Found ${routes.length} routes`);

  const result = [];

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];

    const { rows: waypoints } = await pool.query(
      'SELECT * FROM waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC',
      [route.id]
    );

    const { rows: photos } = await pool.query(
      'SELECT * FROM photos WHERE route_id = $1 ORDER BY uploaded_at ASC',
      [route.id]
    );

    result.push(toApiRoute(route, waypoints, photos));

    if ((i + 1) % 100 === 0 || i === routes.length - 1) {
      console.log(`Exported ${i + 1}/${routes.length} routes`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(`Export complete! Written to ${OUTPUT_PATH}`);

  await pool.end();
}

main().catch(err => {
  console.error('Export failed:', err);
  process.exit(1);
});
