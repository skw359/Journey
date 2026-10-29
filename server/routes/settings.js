const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
const { pool, reconnect, queryTenant, tenantSchemaForUser } = require('../db');
const { clearConfigCache, fetchSounding } = require('../utils/weather');
const { clearConfigCache: clearFlightConfigCache } = require('../utils/flight');
const mediaStorage = require('../utils/mediaStorage');
const mediaMove = require('../utils/mediaMove');
const { listExternalDrives } = require('../utils/drives');
const { isPrimaryAccount } = require('../middleware/auth');
const log = require('../utils/logger').scope('settings');

const UNIT_PREFERENCES = new Set(['imperial', 'metric']);

// GET /api/settings/units
router.get('/units', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT unit_preference FROM users WHERE id = $1',
      [req.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const unitPreference = UNIT_PREFERENCES.has(rows[0].unit_preference)
      ? rows[0].unit_preference
      : 'imperial';
    res.json({ unitPreference });
  } catch (err) {
    log.error('Get unit preference error:', err);
    res.status(500).json({ error: 'Failed to get unit preference' });
  }
});

// PUT /api/settings/units
router.put('/units', async (req, res) => {
  try {
    const unitPreference = req.body?.unitPreference;
    if (!UNIT_PREFERENCES.has(unitPreference)) {
      return res.status(400).json({ error: 'unitPreference must be "imperial" or "metric"' });
    }

    const result = await pool.query(
      'UPDATE users SET unit_preference = $1 WHERE id = $2',
      [unitPreference, req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, unitPreference });
  } catch (err) {
    log.error('Update unit preference error:', err);
    res.status(500).json({ error: 'Failed to update unit preference' });
  }
});

// GET /api/settings/database
router.get('/database', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM app_config WHERE key IN ('db_host', 'db_port', 'db_name', 'db_user', 'db_password')"
    );
    const config = {};
    for (const row of rows) {
      config[row.key] = row.key === 'db_password' ? '••••••••' : row.value;
    }
    res.json(config);
  } catch (err) {
    log.error('Get database config error:', err);
    res.status(500).json({ error: 'Failed to get database config' });
  }
});

// PUT /api/settings/database
router.put('/database', async (req, res) => {
  try {
    const { host, port, database, username, password } = req.body;

    if (!host || !database || !username) {
      return res.status(400).json({ error: 'Host, database, and username are required' });
    }

    const connStr = `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@${host}:${port || 5432}/${database}`;

    // Test connection first
    const testPool = new Pool({ connectionString: connStr, connectionTimeoutMillis: 5000 });
    try {
      await testPool.query('SELECT 1');
    } catch (err) {
      await testPool.end();
      return res.status(400).json({ error: `Connection failed: ${err.message}` });
    }
    await testPool.end();

    // Save to app_config
    const entries = [
      ['db_host', host],
      ['db_port', String(port || 5432)],
      ['db_name', database],
      ['db_user', username],
      ['db_password', password || ''],
    ];

    for (const [key, value] of entries) {
      await pool.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value]
      );
    }

    // Reconnect
    await reconnect(connStr);

    res.json({ success: true, message: 'Database connection updated' });
  } catch (err) {
    log.error('Update database config error:', err);
    res.status(500).json({ error: 'Failed to update database config' });
  }
});

// GET /api/settings/storage
// Whole-database size (the same figure psql's pg_database_size reports) plus how
// much of it is this account's tenant schema. Photos live on disk, not in
// Postgres, so their total comes from the photos table's recorded file sizes.
router.get('/storage', async (req, res) => {
  try {
    const [database, tenant, counts] = await Promise.all([
      pool.query(`
        SELECT current_database() AS name,
               pg_database_size(current_database()) AS bytes,
               pg_size_pretty(pg_database_size(current_database())) AS pretty,
               current_setting('server_version') AS version
      `),
      pool.query(`
        SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'm')
      `, [tenantSchemaForUser(req.userId)]),
      queryTenant(req.userId, `
        SELECT (SELECT COUNT(*) FROM routes) AS journeys,
               (SELECT COUNT(*) FROM photos) AS photos,
               (SELECT COALESCE(SUM(size), 0) FROM photos) AS photo_bytes
      `),
    ]);

    const db = database.rows[0];
    const usage = counts.rows[0];
    res.json({
      database: {
        name: db.name,
        bytes: Number(db.bytes),
        pretty: db.pretty,
        version: String(db.version).split(' ')[0],
      },
      account: {
        bytes: Number(tenant.rows[0].bytes),
        journeys: Number(usage.journeys),
      },
      photos: {
        count: Number(usage.photos),
        bytes: Number(usage.photo_bytes),
        location: mediaStorage.currentLocation().name,
      },
    });
  } catch (err) {
    log.error('Get storage usage error:', err);
    res.status(500).json({ error: 'Failed to get storage usage' });
  }
});

async function attachmentStorageStatus(userId) {
  const [storage, canManage] = await Promise.all([mediaStorage.status(), isPrimaryAccount(userId)]);
  return { canManage, ...storage, move: mediaMove.status() };
}

async function requirePrimary(req, res, next) {
  try {
    if (await isPrimaryAccount(req.userId)) return next();
    res.status(403).json({ error: 'Only the primary account can change where attachments are stored' });
  } catch (err) {
    log.error('Primary account check error:', err);
    res.status(500).json({ error: 'Failed to check account' });
  }
}

// GET /api/settings/attachment-storage
// Where photos and videos are stored, files still waiting elsewhere, and any move in progress.
router.get('/attachment-storage', async (req, res) => {
  try {
    res.json(await attachmentStorageStatus(req.userId));
  } catch (err) {
    log.error('Get attachment storage error:', err);
    res.status(500).json({ error: 'Failed to get attachment storage' });
  }
});

// GET /api/settings/attachment-storage/drives?refresh=1
// External drives Windows can see. Slow (~2 s), so the page asks for it separately.
router.get('/attachment-storage/drives', async (req, res) => {
  try {
    const [drives, internal] = await Promise.all([
      listExternalDrives({ refresh: req.query.refresh === '1' }),
      mediaStorage.internalSpace(),
    ]);
    res.json({ drives, internal });
  } catch (err) {
    log.error('List drives error:', err);
    res.status(500).json({ error: 'Could not list drives' });
  }
});

// GET /api/settings/attachment-storage/plan?target=internal|<volumeId> — what a move would involve
router.get('/attachment-storage/plan', requirePrimary, async (req, res) => {
  try {
    const target = req.query.target === 'internal'
      ? { kind: 'internal' }
      : { kind: 'drive', volumeId: String(req.query.target || '') };
    res.json(await mediaStorage.planMoveTo(target));
  } catch (err) {
    if (err instanceof mediaStorage.StorageError) return res.status(err.status).json({ error: err.message });
    log.error('Plan attachment move error:', err);
    res.status(500).json({ error: 'Failed to measure attachments' });
  }
});

// PUT /api/settings/attachment-storage  { target: { kind: 'internal' } | { kind: 'drive', volumeId } }
// New uploads go to the new location at once; existing files move there in the background.
router.put('/attachment-storage', requirePrimary, async (req, res) => {
  try {
    await mediaMove.interrupt();
    await mediaStorage.selectLocation(req.body?.target);
    mediaMove.kick();
    res.json(await attachmentStorageStatus(req.userId));
  } catch (err) {
    mediaMove.kick();
    if (err instanceof mediaStorage.StorageError) return res.status(err.status).json({ error: err.message });
    log.error('Change attachment storage error:', err);
    res.status(500).json({ error: 'Failed to change attachment storage' });
  }
});

// POST /api/settings/attachment-storage/pause — files already moved stay where they are
router.post('/attachment-storage/pause', requirePrimary, async (req, res) => {
  try {
    await mediaMove.pause();
    res.json(await attachmentStorageStatus(req.userId));
  } catch (err) {
    log.error('Pause attachment move error:', err);
    res.status(500).json({ error: 'Failed to pause' });
  }
});

// POST /api/settings/attachment-storage/resume — also retries after an error
router.post('/attachment-storage/resume', requirePrimary, async (req, res) => {
  try {
    await mediaMove.resume();
    res.json(await attachmentStorageStatus(req.userId));
  } catch (err) {
    log.error('Resume attachment move error:', err);
    res.status(500).json({ error: 'Failed to resume' });
  }
});

// POST /api/settings/database/test
router.post('/database/test', async (req, res) => {
  try {
    const { host, port, database, username, password } = req.body;

    if (!host || !database || !username) {
      return res.status(400).json({ error: 'Host, database, and username are required' });
    }

    const connStr = `postgres://${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@${host}:${port || 5432}/${database}`;

    const testPool = new Pool({ connectionString: connStr, connectionTimeoutMillis: 5000 });
    try {
      const { rows } = await testPool.query('SELECT version()');
      await testPool.end();
      res.json({ success: true, version: rows[0].version });
    } catch (err) {
      await testPool.end();
      res.status(400).json({ success: false, error: err.message });
    }
  } catch (err) {
    log.error('Test database connection error:', err);
    res.status(500).json({ error: 'Failed to test connection' });
  }
});

// GET /api/settings/weather
router.get('/weather', async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT key, value FROM app_config WHERE key IN ('weather_enabled', 'weather_provider', 'weather_api_key', 'weather_custom_url', 'weather_sounding_enabled')"
        );
        const config = {
            weather_enabled: 'true',
            weather_provider: 'open-meteo',
            weather_api_key: '',
            weather_custom_url: '',
            weather_sounding_enabled: 'true',
        };
        for (const row of rows) {
            if (row.key === 'weather_api_key') {
                config[row.key] = row.value ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : '';
            } else {
                config[row.key] = row.value;
            }
        }
        res.json(config);
    } catch (err) {
        log.error('Get weather config error:', err);
        res.status(500).json({ error: 'Failed to get weather config' });
    }
});

// PUT /api/settings/weather
router.put('/weather', async (req, res) => {
    try {
        const { enabled, provider, apiKey, customUrl, soundingEnabled } = req.body;

        const validProviders = ['open-meteo', 'openweather', 'custom'];
        if (provider && !validProviders.includes(provider)) {
            return res.status(400).json({ error: 'Invalid provider' });
        }

        const entries = [];
        if (enabled !== undefined) entries.push(['weather_enabled', String(enabled)]);
        if (provider) entries.push(['weather_provider', provider]);
        if (apiKey !== undefined) entries.push(['weather_api_key', apiKey]);
        if (customUrl !== undefined) entries.push(['weather_custom_url', customUrl]);
        if (soundingEnabled !== undefined) entries.push(['weather_sounding_enabled', String(soundingEnabled)]);

        for (const [key, value] of entries) {
            await pool.query(
                `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
                [key, value]
            );
        }

        clearConfigCache();
        res.json({ success: true, message: 'Weather settings updated' });
    } catch (err) {
        log.error('Update weather config error:', err);
        res.status(500).json({ error: 'Failed to update weather config' });
    }
});

// GET /api/settings/weather/sounding
router.get('/weather/sounding', async (req, res) => {
    try {
        const { lat, lon, time, routeId } = req.query;
        if (!lat || !lon || !time) {
            return res.status(400).json({ error: 'lat, lon, and time are required' });
        }

        // Check cache if routeId provided
        if (routeId && req.userId) {
            const { rows } = await queryTenant(
                req.userId,
                'SELECT sounding_data FROM routes WHERE id = $1',
                [routeId]
            );
            if (rows.length > 0 && rows[0].sounding_data != null) {
                return res.json(rows[0].sounding_data);
            }
        }

        const sounding = await fetchSounding(
            parseFloat(lat),
            parseFloat(lon),
            time
        );
        if (!sounding) {
            return res.status(404).json({ error: 'No sounding data available' });
        }

        // Cache the result fire-and-forget
        if (routeId && req.userId) {
            queryTenant(
                req.userId,
                'UPDATE routes SET sounding_data = $1 WHERE id = $2',
                [JSON.stringify(sounding), routeId]
            ).catch(err => log.error('Failed to cache sounding data:', err));
        }

        res.json(sounding);
    } catch (err) {
        log.error('Sounding fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch sounding data' });
    }
});

// GET /api/settings/flights
router.get('/flights', async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT key, value FROM app_config WHERE key IN ('flightaware_api_key')"
        );
        const config = {
            flightaware_api_key: '',
        };
        for (const row of rows) {
            if (row.key === 'flightaware_api_key') {
                config[row.key] = row.value ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : '';
            }
        }
        res.json(config);
    } catch (err) {
        log.error('Get flight config error:', err);
        res.status(500).json({ error: 'Failed to get flight config' });
    }
});

// PUT /api/settings/flights
router.put('/flights', async (req, res) => {
    try {
        const { apiKey } = req.body;

        if (apiKey !== undefined) {
            await pool.query(
                `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
                ['flightaware_api_key', apiKey]
            );
        }

        clearFlightConfigCache();
        res.json({ success: true, message: 'Flight settings updated' });
    } catch (err) {
        log.error('Update flight config error:', err);
        res.status(500).json({ error: 'Failed to update flight config' });
    }
});

module.exports = router;
