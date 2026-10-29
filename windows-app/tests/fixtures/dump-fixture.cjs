// Read-only dump of real tenant rows into JSON fixtures for equivalence tests.
// Usage: node tests/fixtures/dump-fixture.cjs  (run from windows-app/, needs ../.env DATABASE_URL)
// Never modifies the database. Output is gitignored (large).
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '../../../node_modules/dotenv')).config({ path: path.join(__dirname, '../../../.env') });
const { Pool } = require(path.join(__dirname, '../../../node_modules/pg'));

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows: schemas } = await pool.query(
    "SELECT table_schema FROM information_schema.tables WHERE table_name='routes' AND table_schema LIKE 'tenant_%' ORDER BY 1");
  const out = {};
  for (const { table_schema } of schemas) {
    const { rows } = await pool.query(`
      SELECT id, name, date, distance, duration, top_speed, avg_speed, start_time, end_time,
             coordinates, start_lat, start_lon, end_lat, end_lon, travel_mode, profile_speed_mph
      FROM ${table_schema}.routes`);
    if (rows.length === 0) continue;
    // Full rows for the detail endpoint tests (first 25 by start_time desc), plus waypoints/photos.
    const { rows: fullRows } = await pool.query(`SELECT * FROM ${table_schema}.routes ORDER BY start_time DESC NULLS LAST LIMIT 25`);
    const details = [];
    for (const r of fullRows) {
      const { rows: waypoints } = await pool.query(`SELECT * FROM ${table_schema}.waypoints WHERE route_id = $1 ORDER BY "timestamp" ASC`, [r.id]);
      const { rows: photos } = await pool.query(`SELECT * FROM ${table_schema}.photos WHERE route_id = $1 ORDER BY uploaded_at ASC`, [r.id]);
      details.push({ route: r, waypoints, photos });
    }
    out[table_schema] = { routes: rows, details };
    console.log(table_schema, rows.length, 'routes,', fullRows.length, 'detail rows');
  }
  await pool.end();
  const file = path.join(__dirname, 'tenants.json');
  fs.writeFileSync(file, JSON.stringify(out));
  console.log('wrote', file, (fs.statSync(file).size / 1e6).toFixed(1), 'MB');
}
main().catch((e) => { console.error(e); process.exit(1); });
