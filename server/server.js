const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = require('./app');
const { pool, initSchema, withTenantClient } = require('./db');
const { PORT, CLIENT_DIST } = require('./config');
const fs = require('fs');

async function backfillTravelModes() {
    const { rows: users } = await pool.query('SELECT id FROM users');
    let totalBackfilled = 0;

    for (const user of users) {
        await withTenantClient(user.id, async (db) => {
            const result = await db.query(`
                UPDATE routes SET travel_mode = CASE
                    WHEN avg_speed <= 7 THEN 'foot'
                    WHEN avg_speed <= 22 THEN 'scooter'
                    ELSE 'drive'
                END
                WHERE travel_mode IS NULL AND avg_speed IS NOT NULL
            `);
            totalBackfilled += result.rowCount;
        });
    }

    if (totalBackfilled > 0) {
        console.log(`Backfilled travel modes for ${totalBackfilled} existing journeys`);
    }
}

async function startServer() {
    try {
        await initSchema();
        console.log('Database schema initialized');
        await backfillTravelModes();
        app.listen(PORT, () => {
            console.log(`Journey backend listening at http://localhost:${PORT}`);
            if (fs.existsSync(CLIENT_DIST)) {
                console.log('Serving React build from client/dist/');
            } else {
                console.log('Serving legacy frontend from public/. Run "npm run build" to build the React app.');
            }
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();
