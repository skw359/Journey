const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db');
const { PUBLIC_URL } = require('../config');
const { hashToken } = require('../middleware/auth');
const { deleteAccount } = require('../utils/accounts');
const log = require('../utils/logger').scope('admin');

// Mounted at /api/admin behind requireSession + requireAdmin.

const DEFAULT_INVITE_DAYS = 7;
const MAX_INVITE_DAYS = 30;

function inviteStatus(row) {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function inviteResponse(row) {
  return {
    id: row.id,
    note: row.note || '',
    status: inviteStatus(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    usedBy: row.used_by_username || null,
    createdBy: row.created_by_username || null,
  };
}

// GET /api/admin/invites
router.get('/invites', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*, cu.username AS created_by_username, uu.username AS used_by_username
      FROM invites i
      LEFT JOIN users cu ON cu.id = i.created_by
      LEFT JOIN users uu ON uu.id = i.used_by
      ORDER BY i.created_at DESC
      LIMIT 200
    `);
    res.json(rows.map(inviteResponse));
  } catch (err) {
    log.error('List invites error:', err);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

// POST /api/admin/invites { note?, expiresInDays? } — the link is shown only once.
router.post('/invites', async (req, res) => {
  try {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
    const days = Number(req.body?.expiresInDays ?? DEFAULT_INVITE_DAYS);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_INVITE_DAYS) {
      return res.status(400).json({ error: `Invites can last from 1 to ${MAX_INVITE_DAYS} days` });
    }

    const id = `inv-${crypto.randomBytes(8).toString('hex')}`;
    const token = crypto.randomBytes(32).toString('base64url');
    const { rows } = await pool.query(
      `INSERT INTO invites (id, token_hash, created_by, expires_at, note)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5)
       RETURNING *`,
      [id, hashToken(token), req.userId, Math.round(days * 86400), note || null]
    );

    const origin = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    res.status(201).json({
      ...inviteResponse(rows[0]),
      token,
      url: `${origin}/register?invite=${encodeURIComponent(token)}`,
    });
  } catch (err) {
    log.error('Create invite error:', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// DELETE /api/admin/invites/:id — revoke an invite that hasn't been used
router.delete('/invites/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE invites SET revoked_at = NOW() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL',
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'No unused invite with that id' });
    res.json({ success: true });
  } catch (err) {
    log.error('Revoke invite error:', err);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, username, display_name, is_admin, created_at
      FROM users ORDER BY created_at ASC, id ASC
    `);
    res.json(rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      isAdmin: row.is_admin === true,
      createdAt: row.created_at,
      isYou: row.id === req.userId,
    })));
  } catch (err) {
    log.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list accounts' });
  }
});

// PATCH /api/admin/users/:id { isAdmin } — keeps at least one admin
router.patch('/users/:id', async (req, res) => {
  if (typeof req.body?.isAdmin !== 'boolean') {
    return res.status(400).json({ error: 'isAdmin must be true or false' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM users WHERE is_admin FOR UPDATE');
    if (!req.body.isAdmin) {
      const { rows } = await client.query(
        'SELECT COUNT(*)::int AS admins FROM users WHERE is_admin AND id <> $1',
        [req.params.id]
      );
      if (rows[0].admins === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'The server needs at least one admin' });
      }
    }
    const { rowCount } = await client.query('UPDATE users SET is_admin = $2 WHERE id = $1', [req.params.id, req.body.isAdmin]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found' });
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update account' });
  } finally {
    client.release();
  }
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req, res) => {
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: 'Delete your own account from the Account section instead' });
  }
  try {
    const result = await deleteAccount(req.params.id);
    if (result.status === 'not_found') return res.status(404).json({ error: 'Account not found' });
    if (result.status === 'last_admin') return res.status(409).json({ error: 'The server needs at least one admin' });
    log.info(`account ${req.params.id} removed by an admin`);
    res.json({ success: true });
  } catch (err) {
    log.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

module.exports = router;
