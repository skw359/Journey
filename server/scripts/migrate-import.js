#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const { pool, initSchema } = require('../db');
const { PROJECT_ROOT } = require('../config');

const DB_PATH = path.join(PROJECT_ROOT, 'database.json');

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('database.json not found');
    process.exit(1);
  }

  console.log('Reading database.json...');
  const routes = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  console.log(`Found ${routes.length} routes`);

  console.log('Initializing schema...');
  await initSchema();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];

      const startCoord = Array.isArray(r.startCoord) ? r.startCoord : [null, null];
      const endCoord = Array.isArray(r.endCoord) ? r.endCoord : [null, null];

      await client.query(`
        INSERT INTO routes (
          id, name, date, distance, duration, top_speed, avg_speed,
          top_elevation, lowest_elevation, avg_elevation,
          start_time, end_time, coordinates,
          elevation_gain, elevation_loss,
          start_lat, start_lon, end_lat, end_lon,
          source, watch_recorded,
          profile_time_ms, profile_dist_mi, profile_elev_m, profile_speed_mph,
          travel_mode
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10,
          $11, $12, $13,
          $14, $15,
          $16, $17, $18, $19,
          $20, $21,
          $22, $23, $24, $25,
          $26
        ) ON CONFLICT (id) DO NOTHING
      `, [
        r.id,
        r.name || null,
        r.date || null,
        r.distance != null ? parseFloat(r.distance) : null,
        r.duration || null,
        r.topSpeed != null ? parseFloat(r.topSpeed) : null,
        r.avgSpeed != null ? parseFloat(r.avgSpeed) : null,
        r.topElevation != null ? parseFloat(r.topElevation) : null,
        r.lowestElevation != null ? parseFloat(r.lowestElevation) : null,
        r.avgElevation != null ? parseFloat(r.avgElevation) : null,
        r.startTime || null,
        r.endTime || null,
        JSON.stringify(r.coordinates || []),
        r.elevationGain != null ? parseFloat(r.elevationGain) : null,
        r.elevationLoss != null ? parseFloat(r.elevationLoss) : null,
        startCoord[0] != null ? parseFloat(startCoord[0]) : null,
        startCoord[1] != null ? parseFloat(startCoord[1]) : null,
        endCoord[0] != null ? parseFloat(endCoord[0]) : null,
        endCoord[1] != null ? parseFloat(endCoord[1]) : null,
        r.source || null,
        r.watchRecorded != null ? !!r.watchRecorded : null,
        JSON.stringify(r.profileTimeMs || []),
        JSON.stringify(r.profileDistMi || []),
        JSON.stringify(r.profileElevM || []),
        JSON.stringify(r.profileSpeedMph || []),
        r.travelMode || null,
      ]);

      if (Array.isArray(r.waypoints)) {
        for (const wp of r.waypoints) {
          await client.query(`
            INSERT INTO waypoints (id, route_id, lat, lon, elevation, "timestamp", note, label)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
          `, [
            wp.id,
            r.id,
            wp.lat != null ? parseFloat(wp.lat) : null,
            wp.lon != null ? parseFloat(wp.lon) : null,
            wp.elevation != null ? parseFloat(wp.elevation) : null,
            wp.timestamp != null ? wp.timestamp : null,
            wp.note || null,
            wp.label || null,
          ]);
        }
      }

      if (Array.isArray(r.photos)) {
        for (const p of r.photos) {
          await client.query(`
            INSERT INTO photos (id, route_id, filename, original_name, mimetype, size, uploaded_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO NOTHING
          `, [
            p.id,
            r.id,
            p.filename || null,
            p.originalName || null,
            p.mimetype || null,
            p.size != null ? p.size : null,
            p.uploadedAt || null,
          ]);
        }
      }

      if ((i + 1) % 100 === 0 || i === routes.length - 1) {
        console.log(`Imported ${i + 1}/${routes.length} routes`);
      }
    }

    await client.query('COMMIT');
    console.log('Import complete!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
