const express = require('express');
const { Pool } = require('pg');
const router = express.Router();
const { pool, reconnect } = require('../db');

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
    console.error('Get unit preference error:', err);
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
    console.error('Update unit preference error:', err);
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
    console.error('Get database config error:', err);
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
    console.error('Update database config error:', err);
    res.status(500).json({ error: 'Failed to update database config' });
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
    console.error('Test database connection error:', err);
    res.status(500).json({ error: 'Failed to test connection' });
  }
});

module.exports = router;
