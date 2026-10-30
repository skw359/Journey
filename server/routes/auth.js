const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const multer = require('multer');
const router = express.Router();
const { pool, ensureTenantSchema, migrateLegacyDataForUser } = require('../db');
const { requireSession, requireAuth, isAdmin, hashToken } = require('../middleware/auth');
const { AVATARS_DIR } = require('../config');
const { deleteAccount, removeAvatarFile } = require('../utils/accounts');
const { createRateLimiter, tooManyAttempts } = require('../utils/rateLimit');
const log = require('../utils/logger').scope('auth');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 100;
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const AVATAR_MAX_DIMENSION = 1024;
const AVATAR_NAME = /^user-[\w-]+-\d+\.jpe?g$/;
// Serializes first-run registration (the first account becomes admin).
const REGISTRATION_LOCK = 72_312;

const limits = {
  loginByAddress: createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 }),
  loginFailuresByAccount: createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }),
  registerByAddress: createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 }),
  inviteCheckByAddress: createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 }),
};

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpe?g|png|webp)$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG or WebP images are allowed'));
    }
  },
});

function userResponse(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    unitPreference: row.unit_preference || 'imperial',
    avatarUrl: row.avatar_filename ? `/api/auth/avatar/${row.avatar_filename}` : null,
    createdAt: row.created_at || null,
    isAdmin: row.is_admin === true,
  };
}

const USER_COLUMNS = 'id, username, display_name, first_name, last_name, unit_preference, avatar_filename, created_at, is_admin';

// New session id at sign-in (prevents session fixation).
function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

let dummyHash = null;
// Equalizes timing for unknown usernames.
async function burnPasswordCheck(password) {
  if (!dummyHash) dummyHash = await bcrypt.hash('journey-timing-equalizer', BCRYPT_ROUNDS);
  await bcrypt.compare(password, dummyHash);
}

function clientAddress(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

function validateUsername(username) {
  if (typeof username !== 'string') return 'Username is required';
  const trimmed = username.trim();
  if (trimmed.length < MIN_USERNAME_LENGTH || trimmed.length > MAX_USERNAME_LENGTH) {
    return `Username must be ${MIN_USERNAME_LENGTH} to ${MAX_USERNAME_LENGTH} characters`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'Username contains invalid characters';
  return null;
}

function cleanName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

// GET /api/auth/avatar/:filename — public (the iOS app loads it without credentials).
router.get('/avatar/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!AVATAR_NAME.test(filename)) {
    return res.status(404).json({ error: 'Avatar not found' });
  }
  const filePath = path.join(AVATARS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Avatar not found' });
  }
  res.set({
    'Content-Type': 'image/jpeg',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=86400',
  });
  res.sendFile(filePath, { headers: { 'Content-Type': 'image/jpeg' } });
});

// GET /api/auth/me — Bearer-compatible profile lookup for paired clients (iOS, Watch)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(userResponse(rows[0]));
  } catch (err) {
    log.error('Auth me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/status
router.get('/status', async (req, res) => {
  try {
    const { rows: users } = await pool.query('SELECT 1 FROM users LIMIT 1');
    const isSetup = users.length > 0;
    const registration = isSetup ? 'invite-only' : 'first-run';

    // Journey AI (Marco) flag, so the client can show/hide the Marco page
    // without an extra round trip. Never let a config read break auth status.
    let marcoEnabled = false;
    try {
      const { getMarcoConfig } = require('../ai/marco-config');
      marcoEnabled = (await getMarcoConfig()).enabled;
    } catch {
      marcoEnabled = false;
    }

    if (req.session && req.session.userId) {
      const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.session.userId]);
      if (rows.length > 0) {
        await ensureTenantSchema(rows[0].id);
        return res.json({
          isSetup,
          isAuthenticated: true,
          user: userResponse(rows[0]),
          marcoEnabled,
          registration,
        });
      }
    }

    res.json({ isSetup, isAuthenticated: false, user: null, marcoEnabled, registration });
  } catch (err) {
    log.error('Auth status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/invite?token=… — whether an invite link can still be used
router.get('/invite', async (req, res) => {
  const wait = limits.inviteCheckByAddress.hit(clientAddress(req));
  if (wait) return tooManyAttempts(res, wait);
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token || token.length > 256) return res.status(404).json({ valid: false });
  try {
    const { rows } = await pool.query(
      `SELECT expires_at FROM invites
       WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`,
      [hashToken(token)]
    );
    if (rows.length === 0) return res.status(404).json({ valid: false });
    res.json({ valid: true, expiresAt: rows[0].expires_at });
  } catch (err) {
    log.error('Invite check error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register — first account (becomes admin), or with a valid invite.
router.post('/register', async (req, res) => {
  const wait = limits.registerByAddress.hit(clientAddress(req));
  if (wait) return tooManyAttempts(res, wait, 'Too many sign-up attempts. Try again later.');

  const { username, password, firstName, lastName, invite } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const problem = validateUsername(username) || validatePassword(password);
  if (problem) return res.status(400).json({ error: problem });

  const id = `user-${crypto.randomBytes(8).toString('hex')}`;
  const name = username.trim();
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  const displayName = [first, last].filter(Boolean).join(' ') || name;

  let created;
  let isFirstUser = false;
  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [REGISTRATION_LOCK]);
      const { rows: existing } = await client.query('SELECT EXISTS (SELECT 1 FROM users) AS any');
      isFirstUser = existing[0].any !== true;

      const { rows } = await client.query(
        `INSERT INTO users
          (id, username, password_hash, display_name, first_name, last_name, unit_preference, is_admin)
         VALUES ($1, $2, $3, $4, $5, $6, 'imperial', $7)
         RETURNING ${USER_COLUMNS}`,
        [id, name, passwordHash, displayName, first, last, isFirstUser]
      );
      created = rows[0];

      if (!isFirstUser) {
        const token = typeof invite === 'string' ? invite : '';
        const { rows: redeemed } = token && token.length <= 256
          ? await client.query(
            `UPDATE invites SET used_at = NOW(), used_by = $2
             WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
             RETURNING id`,
            [hashToken(token), id]
          )
          : { rows: [] };
        if (redeemed.length === 0) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'Journey accounts are invite-only. Ask the server admin for an invite link.',
            code: 'invite_required',
          });
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await ensureTenantSchema(id);
    await establishSession(req, id);

    // Check if there's legacy unassigned data to migrate (first account only).
    let existingCount = 0;
    if (isFirstUser) {
      const { rows: existingRoutes } = await pool.query(
        'SELECT COUNT(*)::int AS count FROM routes WHERE user_id IS NULL'
      );
      existingCount = Number(existingRoutes[0]?.count || 0);
    }

    res.status(201).json({ user: userResponse(created), existingDataCount: existingCount });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    log.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const address = clientAddress(req);
  const account = username.trim().toLowerCase();
  const blocked = Math.max(limits.loginFailuresByAccount.blockedFor(account), limits.loginByAddress.hit(address));
  if (blocked) return tooManyAttempts(res, blocked, 'Too many sign-in attempts. Try again later.');

  try {
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = $1`,
      [username.trim()]
    );

    const user = rows[0];
    const valid = user
      ? await bcrypt.compare(password, user.password_hash || '')
      : (await burnPasswordCheck(password), false);
    if (!valid) {
      limits.loginFailuresByAccount.hit(account);
      return res.status(401).json({ error: 'No account found with provided credentials.' });
    }

    limits.loginFailuresByAccount.reset(account);
    await establishSession(req, user.id);
    await ensureTenantSchema(user.id);

    res.json({ user: userResponse(user) });
  } catch (err) {
    log.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', requireSession, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to logout' });
    }
    res.clearCookie('journey.sid');
    res.json({ success: true });
  });
});

// DELETE /api/auth/account
router.delete('/account', requireSession, async (req, res) => {
  try {
    const password = req.body?.password;
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }

    const result = await deleteAccount(req.userId, {
      verify: (account) => bcrypt.compare(password, account.password_hash || ''),
    });
    if (result.status === 'not_found') return res.status(404).json({ error: 'Account not found' });
    if (result.status === 'unverified') return res.status(401).json({ error: 'Invalid password' });
    if (result.status === 'last_admin') {
      return res.status(409).json({ error: 'Make another account an admin before deleting the only admin account' });
    }

    req.session.destroy(() => {
      res.clearCookie('journey.sid');
      res.json({ success: true, isSetup: result.isSetup });
    });
  } catch (err) {
    log.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// POST /api/auth/migrate
router.post('/migrate', requireSession, async (req, res) => {
  try {
    if (!(await isAdmin(req.userId))) {
      return res.status(403).json({ error: 'Legacy data migration is only available to the server admin' });
    }

    const result = await migrateLegacyDataForUser(req.userId, {
      includeUnassigned: true,
      purgeLegacy: true,
    });
    res.json({ migrated: result.migratedRoutes });
  } catch (err) {
    log.error('Migration error:', err);
    res.status(500).json({ error: 'Migration failed' });
  }
});

// POST /api/auth/avatar — re-encoded to JPEG; non-images are rejected.
router.post('/avatar', requireSession, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      const message = err instanceof multer.MulterError
        ? (err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 8MB)' : err.message)
        : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!sharp) {
      return res.status(503).json({ error: 'Avatar uploads need the sharp image library (run npm install)' });
    }

    let jpeg;
    try {
      jpeg = await sharp(req.file.buffer, { limitInputPixels: 50_000_000 })
        .rotate()
        .resize({ width: AVATAR_MAX_DIMENSION, height: AVATAR_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    } catch {
      return res.status(400).json({ error: 'That file is not a readable image' });
    }

    const filename = `${req.userId}-${Date.now()}.jpg`;
    const finalPath = path.join(AVATARS_DIR, filename);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, jpeg);
      await fs.promises.rename(tmpPath, finalPath);

      const { rows } = await pool.query(
        `WITH previous AS (SELECT avatar_filename FROM users WHERE id = $2)
         UPDATE users SET avatar_filename = $1 WHERE id = $2
         RETURNING (SELECT avatar_filename FROM previous) AS previous`,
        [filename, req.userId]
      );
      if (rows[0]?.previous && rows[0].previous !== filename) removeAvatarFile(rows[0].previous);

      res.json({ avatarUrl: `/api/auth/avatar/${filename}` });
    } catch (dbErr) {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
      log.error('Avatar upload error:', dbErr);
      res.status(500).json({ error: 'Failed to save avatar' });
    }
  });
});

router.resetRateLimits = () => {
  for (const limiter of Object.values(limits)) limiter.clear();
};

module.exports = router;
module.exports.MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;
