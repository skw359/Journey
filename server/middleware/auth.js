const { pool } = require('../db');
const log = require('../utils/logger').scope('auth');

async function isSetup() {
  const { rows } = await pool.query('SELECT 1 FROM users LIMIT 1');
  return rows.length > 0;
}

// Requires a valid session (cookie-based)
function requireSession(req, res, next) {
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    return next();
  }
  isSetup().then(setup => {
    res.status(401).json({ error: 'Not authenticated', needsSetup: !setup });
  }).catch(() => {
    res.status(401).json({ error: 'Not authenticated' });
  });
}

// Accepts session cookie OR Authorization: Bearer <token>
async function requireAuth(req, res, next) {
  // Check session first
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    return next();
  }

  // Check bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const { rows } = await pool.query(
        'SELECT user_id FROM pairing_tokens WHERE token = $1',
        [token]
      );
      if (rows.length > 0) {
        req.userId = rows[0].user_id;
        // Update last_used_at
        pool.query(
          'UPDATE pairing_tokens SET last_used_at = NOW() WHERE token = $1',
          [token]
        ).catch(() => {});
        return next();
      }
    } catch (err) {
      log.error('Token auth error:', err);
    }
  }

  const setup = await isSetup().catch(() => true);
  res.status(401).json({ error: 'Not authenticated', needsSetup: !setup });
}

// The first account created on this server, which owns server-wide choices like where
// attachments are stored.
async function isPrimaryAccount(userId) {
  const { rows } = await pool.query('SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1');
  return Boolean(userId) && rows[0]?.id === userId;
}

// Only allows if zero users exist (for initial registration)
async function setupCheck(req, res, next) {
  try {
    const setup = await isSetup();
    if (setup) {
      return res.status(403).json({ error: 'Setup already completed' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { requireSession, requireAuth, setupCheck, isPrimaryAccount };
