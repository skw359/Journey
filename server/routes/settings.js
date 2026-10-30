const express = require('express');
const router = express.Router();
const { pool, queryTenant, tenantSchemaForUser } = require('../db');
const { clearConfigCache, soundingForRoute } = require('../utils/weather');
const { clearConfigCache: clearFlightConfigCache } = require('../utils/flight');
const mediaStorage = require('../utils/mediaStorage');
const mediaMove = require('../utils/mediaMove');
const { listExternalDrives } = require('../utils/drives');
const { isAdmin, requireAdmin } = require('../middleware/auth');
const { assertHttpUrl, OutboundUrlError } = require('../utils/outboundUrl');
const log = require('../utils/logger').scope('settings');

// Server-wide settings require the admin; per-account preferences don't.

const UNIT_PREFERENCES = new Set(['imperial', 'metric']);
const MASK = '••••••••';

async function saveConfig(entries) {
  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
}

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

// GET /api/settings/database — read-only; the connection comes from DATABASE_URL.
router.get('/database', requireAdmin, (req, res) => {
  try {
    const url = new URL(process.env.DATABASE_URL || '');
    res.json({
      db_host: url.hostname,
      db_port: url.port || '5432',
      db_name: url.pathname.replace(/^\//, '') || 'postgres',
      db_user: decodeURIComponent(url.username || ''),
      source: 'DATABASE_URL',
    });
  } catch {
    res.json({ source: 'DATABASE_URL' });
  }
});

// GET /api/settings/storage
// This account's usage; the admin also sees the whole database (pg_database_size).
// Photo totals come from the photos table's recorded sizes.
router.get('/storage', async (req, res) => {
  try {
    const admin = await isAdmin(req.userId);
    const [database, tenant, counts] = await Promise.all([
      admin ? pool.query(`
        SELECT current_database() AS name,
               pg_database_size(current_database()) AS bytes,
               pg_size_pretty(pg_database_size(current_database())) AS pretty,
               current_setting('server_version') AS version
      `) : null,
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

    const usage = counts.rows[0];
    const accountBytes = Number(tenant.rows[0].bytes);
    const db = database?.rows[0];
    res.json({
      database: db ? {
        name: db.name,
        bytes: Number(db.bytes),
        pretty: db.pretty,
        version: String(db.version).split(' ')[0],
      } : { name: null, bytes: accountBytes, pretty: null, version: null },
      account: {
        bytes: accountBytes,
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
  const [storage, canManage] = await Promise.all([mediaStorage.status(), isAdmin(userId)]);
  return { canManage, ...storage, move: mediaMove.status() };
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
router.get('/attachment-storage/drives', requireAdmin, async (req, res) => {
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
router.get('/attachment-storage/plan', requireAdmin, async (req, res) => {
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
router.put('/attachment-storage', requireAdmin, async (req, res) => {
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
router.post('/attachment-storage/pause', requireAdmin, async (req, res) => {
  try {
    await mediaMove.pause();
    res.json(await attachmentStorageStatus(req.userId));
  } catch (err) {
    log.error('Pause attachment move error:', err);
    res.status(500).json({ error: 'Failed to pause' });
  }
});

// POST /api/settings/attachment-storage/resume — also retries after an error
router.post('/attachment-storage/resume', requireAdmin, async (req, res) => {
  try {
    await mediaMove.resume();
    res.json(await attachmentStorageStatus(req.userId));
  } catch (err) {
    log.error('Resume attachment move error:', err);
    res.status(500).json({ error: 'Failed to resume' });
  }
});

// GET /api/settings/weather — provider details only for the admin.
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
                config[row.key] = row.value ? MASK : '';
            } else {
                config[row.key] = row.value;
            }
        }
        if (!(await isAdmin(req.userId))) {
            return res.json({
                weather_enabled: config.weather_enabled,
                weather_sounding_enabled: config.weather_sounding_enabled,
                canManage: false,
            });
        }
        res.json({ ...config, canManage: true });
    } catch (err) {
        log.error('Get weather config error:', err);
        res.status(500).json({ error: 'Failed to get weather config' });
    }
});

// PUT /api/settings/weather
router.put('/weather', requireAdmin, async (req, res) => {
    try {
        const { enabled, provider, apiKey, customUrl, soundingEnabled } = req.body || {};

        const validProviders = ['open-meteo', 'openweather', 'custom'];
        if (provider && !validProviders.includes(provider)) {
            return res.status(400).json({ error: 'Invalid provider' });
        }
        if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 512)) {
            return res.status(400).json({ error: 'Invalid API key' });
        }

        let url = customUrl;
        if (typeof customUrl === 'string' && customUrl.trim()) {
            url = assertHttpUrl(customUrl, { label: 'The custom weather URL' });
        } else if (customUrl !== undefined) {
            url = '';
        }
        if (provider === 'custom' && !url) {
            const { rows } = await pool.query("SELECT value FROM app_config WHERE key = 'weather_custom_url'");
            if (!rows[0]?.value) return res.status(400).json({ error: 'The custom provider needs a URL' });
        }

        const entries = [];
        if (enabled !== undefined) entries.push(['weather_enabled', String(enabled === true || enabled === 'true')]);
        if (provider) entries.push(['weather_provider', provider]);
        if (apiKey !== undefined) entries.push(['weather_api_key', apiKey]);
        if (url !== undefined) entries.push(['weather_custom_url', url]);
        if (soundingEnabled !== undefined) entries.push(['weather_sounding_enabled', String(soundingEnabled === true || soundingEnabled === 'true')]);

        await saveConfig(entries);
        clearConfigCache();
        res.json({ success: true, message: 'Weather settings updated' });
    } catch (err) {
        if (err instanceof OutboundUrlError) return res.status(400).json({ error: err.message });
        log.error('Update weather config error:', err);
        res.status(500).json({ error: 'Failed to update weather config' });
    }
});

// GET /api/settings/weather/sounding?routeId=… (location resolved server-side)
router.get('/weather/sounding', async (req, res) => {
    try {
        const routeId = typeof req.query.routeId === 'string' ? req.query.routeId : '';
        if (!routeId) {
            return res.status(400).json({ error: 'routeId is required' });
        }

        const result = await soundingForRoute(req.userId, routeId);
        if (result.status === 'not_found') return res.status(404).json({ error: 'Journey not found' });
        if (!result.sounding) return res.status(404).json({ error: 'No sounding data available' });
        res.json(result.sounding);
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
        const configured = Boolean(rows.find((row) => row.key === 'flightaware_api_key')?.value);
        if (!(await isAdmin(req.userId))) {
            return res.json({ configured, canManage: false });
        }
        res.json({ flightaware_api_key: configured ? MASK : '', configured, canManage: true });
    } catch (err) {
        log.error('Get flight config error:', err);
        res.status(500).json({ error: 'Failed to get flight config' });
    }
});

// PUT /api/settings/flights
router.put('/flights', requireAdmin, async (req, res) => {
    try {
        const { apiKey } = req.body || {};

        if (apiKey !== undefined) {
            if (typeof apiKey !== 'string' || apiKey.length > 512) {
                return res.status(400).json({ error: 'Invalid API key' });
            }
            await saveConfig([['flightaware_api_key', apiKey]]);
        }

        clearFlightConfigCache();
        res.json({ success: true, message: 'Flight settings updated' });
    } catch (err) {
        log.error('Update flight config error:', err);
        res.status(500).json({ error: 'Failed to update flight config' });
    }
});

module.exports = router;
