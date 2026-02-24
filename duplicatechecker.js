#!/usr/bin/env node
/**
 * Duplicate Journey Checker
 * Finds journeys with identical distance, duration, and start_time across all tenant schemas.
 *
 * Usage: node duplicatechecker.js
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getTenantSchemas() {
  const { rows } = await pool.query(`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  `);
  return rows.map(r => r.schema_name);
}

async function getUserForSchema(schema) {
  // Reverse-lookup: hash all user IDs and match against the schema name
  const { rows } = await pool.query('SELECT id, username, display_name FROM users');
  const crypto = require('crypto');
  for (const user of rows) {
    const digest = crypto.createHash('sha256').update(user.id).digest('hex').slice(0, 24);
    if (schema === `tenant_${digest}`) {
      return user;
    }
  }
  return null;
}

async function findDuplicates() {
  const schemas = await getTenantSchemas();

  if (schemas.length === 0) {
    console.log('No tenant schemas found.');
    await pool.end();
    return;
  }

  console.log(`Found ${schemas.length} tenant schema(s). Scanning for duplicates...\n`);

  let totalDuplicateGroups = 0;
  let totalDuplicateJourneys = 0;

  for (const schema of schemas) {
    const user = await getUserForSchema(schema);
    const label = user
      ? `${user.display_name || user.username} (${schema})`
      : schema;

    const quotedSchema = `"${schema}"`;

    // Find groups of routes sharing the same distance, duration, AND start_time
    const { rows: dupes } = await pool.query(`
      SELECT distance, duration, start_time, COUNT(*) AS cnt
      FROM ${quotedSchema}.routes
      WHERE distance IS NOT NULL AND duration IS NOT NULL AND start_time IS NOT NULL
      GROUP BY distance, duration, start_time
      HAVING COUNT(*) > 1
      ORDER BY start_time DESC
    `);

    if (dupes.length === 0) continue;

    console.log(`═══ ${label} ═══`);

    for (const group of dupes) {
      totalDuplicateGroups++;

      const { rows: journeys } = await pool.query(`
        SELECT id, name, date, distance, duration, start_time, end_time, travel_mode, source
        FROM ${quotedSchema}.routes
        WHERE distance = $1 AND duration = $2 AND start_time = $3
        ORDER BY id
      `, [group.distance, group.duration, group.start_time]);

      totalDuplicateJourneys += journeys.length;

      const startStr = group.start_time
        ? new Date(group.start_time).toLocaleString()
        : 'N/A';

      console.log(`\n  Duplicate group (${journeys.length} journeys) — ${startStr}`);
      console.log(`  Distance: ${Number(group.distance).toFixed(2)} mi | Duration: ${group.duration}`);
      console.log(`  ${'─'.repeat(70)}`);

      for (const j of journeys) {
        const endStr = j.end_time ? new Date(j.end_time).toLocaleString() : 'N/A';
        console.log(`    ID:     ${j.id}`);
        console.log(`    Name:   ${j.name || '(unnamed)'}`);
        console.log(`    Date:   ${j.date || 'N/A'}`);
        console.log(`    End:    ${endStr}`);
        console.log(`    Mode:   ${j.travel_mode || 'N/A'}  |  Source: ${j.source || 'N/A'}`);
        console.log();
      }
    }
  }

  console.log('━'.repeat(60));
  if (totalDuplicateGroups === 0) {
    console.log('No duplicate journeys found!');
  } else {
    console.log(`Found ${totalDuplicateGroups} duplicate group(s) containing ${totalDuplicateJourneys} total journeys.`);
  }

  await pool.end();
}

findDuplicates().catch(err => {
  console.error('Error:', err);
  pool.end();
  process.exit(1);
});
