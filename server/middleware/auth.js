const crypto = require('crypto');
const { pool } = require('../db');
const log = require('../utils/logger').scope('auth');

// Tokens unused for this long stop working.
const PAIRING_TOKEN_IDLE_DAYS = Math.max(parseInt(process.env.PAIRING_TOKEN_IDLE_DAYS, 10) || 180, 1);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

async function isSetup() {
  const { rows } = await pool.query('SELECT 1 FROM users LIMIT 1');
  return rows.length > 0;
}

function notAuthenticated(res) {
  return isSetup().then((setup) => {
    res.status(401).json({ error: 'Not authenticated', needsSetup: !setup });
  }).catch(() => {
    res.status(401).json({ error: 'Not authenticated' });
  });
}

// Requires a valid session (cookie-based)
function requireSession(req, res, next) {
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    req.authMethod = 'session';
    return next();
  }
  notAuthenticated(res);
}

// A pending (QR) token is valid until scanned or until pending_until passes.
async function userForPairingToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
  const { rows } = await pool.query(
    `SELECT id, user_id, pending_until, last_used_at FROM pairing_tokens
     WHERE token_hash = $1
       AND (pending_until IS NULL OR pending_until > NOW())
       AND COALESCE(last_used_at, created_at) > NOW() - make_interval(days => $2)`,
    [hashToken(token), PAIRING_TOKEN_IDLE_DAYS]
  );
  const paired = rows[0];
  if (!paired) return null;

  // First use activates the token; afterwards record use at most once a minute.
  const lastUsed = paired.last_used_at ? new Date(paired.last_used_at).getTime() : 0;
  if (paired.pending_until || Date.now() - lastUsed >= 60_000) {
    const touch = pool.query(
      'UPDATE pairing_tokens SET last_used_at = NOW(), pending_until = NULL WHERE id = $1',
      [paired.id]
    );
    if (paired.pending_until) await touch;
    else touch.catch((err) => log.error('Could not record pairing token use:', err));
  }
  return paired;
}

// Accepts session cookie OR Authorization: Bearer <token>
async function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
    req.authMethod = 'session';
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const paired = await userForPairingToken(authHeader.slice(7).trim());
      if (paired) {
        req.userId = paired.user_id;
        req.authMethod = 'token';
        req.pairingTokenId = paired.id;
        return next();
      }
    } catch (err) {
      log.error('Token auth error:', err);
    }
  }

  await notAuthenticated(res);
}

async function isAdmin(userId) {
  if (!userId) return false;
  const { rows } = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  return rows[0]?.is_admin === true;
}

// Must run after requireSession.
async function requireAdmin(req, res, next) {
  try {
    if (req.authMethod === 'session' && await isAdmin(req.userId)) return next();
    res.status(403).json({ error: 'Only the server admin can do this' });
  } catch (err) {
    log.error('Admin check error:', err);
    res.status(500).json({ error: 'Failed to check account' });
  }
}

module.exports = {
  PAIRING_TOKEN_IDLE_DAYS,
  hashToken,
  isSetup,
  isAdmin,
  requireSession,
  requireAuth,
  requireAdmin,
};
