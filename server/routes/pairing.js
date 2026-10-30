const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db');
const { PUBLIC_URL } = require('../config');
const { hashToken, PAIRING_TOKEN_IDLE_DAYS } = require('../middleware/auth');
const log = require('../utils/logger').scope('pairing');

// Tokens are stored hashed and shown once. A new token must be used within
// PENDING_MINUTES; see pairingTokenAllowed in app.js for what tokens may do.

const PENDING_MINUTES = 15;

function tokenStatus(row) {
  return row.pending_until ? 'pending' : 'active';
}

// GET /api/pairing/tokens — paired devices, plus codes still waiting to be scanned
router.get('/tokens', async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM pairing_tokens
       WHERE user_id = $1
         AND ((pending_until IS NOT NULL AND pending_until <= NOW())
              OR COALESCE(last_used_at, created_at) <= NOW() - make_interval(days => $2))`,
      [req.userId, PAIRING_TOKEN_IDLE_DAYS]
    );
    const { rows } = await pool.query(
      `SELECT id, label, created_at, last_used_at, pending_until FROM pairing_tokens
       WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json(rows.map((row) => ({
      id: row.id,
      label: row.label,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      status: tokenStatus(row),
      pending_until: row.pending_until,
    })));
  } catch (err) {
    log.error('List pairing tokens error:', err);
    res.status(500).json({ error: 'Failed to list tokens' });
  }
});

// POST /api/pairing/tokens { label? } -> { id, token, label, serverUrl, expiresAt }
router.post('/tokens', async (req, res) => {
  try {
    const id = `pt-${crypto.randomBytes(8).toString('hex')}`;
    const token = crypto.randomBytes(32).toString('hex'); // 64-char hex
    const rawLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
    const label = rawLabel.slice(0, 60) || 'iPhone';

    const { rows } = await pool.query(
      `INSERT INTO pairing_tokens (id, user_id, token_hash, label, pending_until)
       VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))
       RETURNING created_at, pending_until`,
      [id, req.userId, hashToken(token), label, PENDING_MINUTES]
    );

    const serverUrl = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      id,
      token,
      label,
      serverUrl,
      created_at: rows[0].created_at,
      expiresAt: rows[0].pending_until,
    });
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

// Removed: tokens can't be shown again. The pairing page creates a new one instead.
router.get('/qr-data', (req, res) => {
  res.status(410).json({ error: 'Reload the pairing page to get a new pairing code' });
});

module.exports = router;
