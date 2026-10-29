const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db');
const { PUBLIC_URL } = require('../config');
const log = require('../utils/logger').scope('pairing');

// GET /api/pairing/tokens
router.get('/tokens', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, label, created_at, last_used_at FROM pairing_tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    log.error('List pairing tokens error:', err);
    res.status(500).json({ error: 'Failed to list tokens' });
  }
});

// POST /api/pairing/tokens
router.post('/tokens', async (req, res) => {
  try {
    const id = `pt-${crypto.randomBytes(8).toString('hex')}`;
    const token = crypto.randomBytes(32).toString('hex'); // 64-char hex
    const label = req.body.label || 'iPhone';

    await pool.query(
      'INSERT INTO pairing_tokens (id, user_id, token, label) VALUES ($1, $2, $3, $4)',
      [id, req.userId, token, label]
    );

    res.status(201).json({ id, token, label, created_at: new Date().toISOString() });
  } catch (err) {
    log.error('Create pairing token error:', err);
    res.status(500).json({ error: 'Failed to create token' });
  }
});

// DELETE /api/pairing/tokens/:id
router.delete('/tokens/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM pairing_tokens WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Token not found' });
    }
    res.json({ success: true });
  } catch (err) {
    log.error('Revoke pairing token error:', err);
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

// GET /api/pairing/qr-data
router.get('/qr-data', async (req, res) => {
  try {
    // Get or create a token for QR code
    let { rows } = await pool.query(
      'SELECT token FROM pairing_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.userId]
    );

    let token;
    if (rows.length > 0) {
      token = rows[0].token;
    } else {
      // Auto-create a token
      const id = `pt-${crypto.randomBytes(8).toString('hex')}`;
      token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'INSERT INTO pairing_tokens (id, user_id, token, label) VALUES ($1, $2, $3, $4)',
        [id, req.userId, token, 'Auto-generated']
      );
    }

    const serverUrl = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ serverUrl, token });
  } catch (err) {
    log.error('QR data error:', err);
    res.status(500).json({ error: 'Failed to generate QR data' });
  }
});

module.exports = router;
