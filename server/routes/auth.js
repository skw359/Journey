const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const multer = require('multer');
const router = express.Router();
const { pool, ensureTenantSchema, migrateLegacyDataForUser, tenantSchemaForUser } = require('../db');
const { requireSession, requireAuth, isPrimaryAccount } = require('../middleware/auth');
const { AVATARS_DIR } = require('../config');
const mediaStorage = require('../utils/mediaStorage');
const { cancelMediaJobsForUser } = require('../utils/mediaQueue');
const { stopGeoBackfillsForUser } = require('../utils/geoBackfill');
const log = require('../utils/logger').scope('auth');

const BCRYPT_ROUNDS = 12;

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function resolvePathWithin(baseDir, relativePath) {
  const root = path.resolve(baseDir);
  const fullPath = path.resolve(path.join(baseDir, relativePath));
  if (fullPath === root || fullPath.startsWith(`${root}${path.sep}`)) {
    return fullPath;
  }
  return null;
}

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.userId}-${Date.now()}${ext}`);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/jpe?g$/.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG images are allowed'));
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
  };
}

// GET /api/auth/avatar/:filename
router.get('/avatar/:filename', (req, res) => {
  const filePath = path.join(AVATARS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Avatar not found' });
  }
  res.sendFile(filePath);
});

// GET /api/auth/me — Bearer-compatible profile lookup for paired clients (iOS, Watch)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, display_name, first_name, last_name, unit_preference, avatar_filename, created_at FROM users WHERE id = $1',
      [req.userId]
    );
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
      const { rows } = await pool.query(
        'SELECT id, username, display_name, first_name, last_name, unit_preference, avatar_filename, created_at FROM users WHERE id = $1',
        [req.session.userId]
      );
      if (rows.length > 0) {
        await ensureTenantSchema(rows[0].id);
        return res.json({
          isSetup,
          isAuthenticated: true,
          user: userResponse(rows[0]),
          marcoEnabled,
        });
      }
    }

    res.json({ isSetup, isAuthenticated: false, user: null, marcoEnabled });
  } catch (err) {
    log.error('Auth status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, password, firstName, lastName } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    const { rows: userCountRows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
    const isFirstUser = Number(userCountRows[0]?.count || 0) === 0;

    const id = `user-${crypto.randomBytes(8).toString('hex')}`;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const first = firstName?.trim() || '';
    const last = lastName?.trim() || '';
    const displayName = [first, last].filter(Boolean).join(' ') || username.trim();

    const { rows: created } = await pool.query(
      `INSERT INTO users
        (id, username, password_hash, display_name, first_name, last_name, unit_preference)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING created_at`,
      [id, username.trim(), passwordHash, displayName, first, last, 'imperial']
    );

    req.session.userId = id;
    await ensureTenantSchema(id);

    // Check if there's legacy unassigned data to migrate (first account only).
    let existingCount = 0;
    if (isFirstUser) {
      const { rows: existingRoutes } = await pool.query(
        'SELECT COUNT(*)::int AS count FROM routes WHERE user_id IS NULL'
      );
      existingCount = Number(existingRoutes[0]?.count || 0);
    }

    res.status(201).json({
      user: {
        id,
        username: username.trim(),
        displayName,
        firstName: first,
        lastName: last,
        unitPreference: 'imperial',
        avatarUrl: null,
        createdAt: created[0]?.created_at || null,
      },
      existingDataCount: existingCount,
    });
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
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const { rows } = await pool.query(
      'SELECT id, username, password_hash, display_name, first_name, last_name, unit_preference, avatar_filename, created_at FROM users WHERE username = $1',
      [username.trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'No account found with provided credentials.' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'No account found with provided credentials.' });
    }

    req.session.userId = user.id;
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

    const userId = req.userId;
    const tenantSchema = tenantSchemaForUser(userId);
    const quotedTenantSchema = quoteIdent(tenantSchema);
    let avatarFilename = null;
    let photoFilenames = [];
    let isSetup = true;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: users } = await client.query(
        'SELECT id, password_hash, avatar_filename FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (users.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Account not found' });
      }

      const account = users[0];
      const validPassword = await bcrypt.compare(password, account.password_hash || '');
      if (!validPassword) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid password' });
      }

      avatarFilename = account.avatar_filename || null;

      const { rows: schemaRows } = await client.query(
        'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists',
        [tenantSchema]
      );
      const schemaExists = schemaRows[0]?.exists === true;

      if (schemaExists) {
        const { rows: photos } = await client.query(`SELECT filename FROM ${quotedTenantSchema}.photos`);
        photoFilenames = photos.map((photo) => photo.filename).filter(Boolean);
        await client.query(`DROP SCHEMA ${quotedTenantSchema} CASCADE`);
      }

      await client.query("DELETE FROM session WHERE sess->>'userId' = $1", [userId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);

      const { rows: remainingUsers } = await client.query('SELECT COUNT(*)::int AS count FROM users');
      isSetup = Number(remainingUsers[0]?.count || 0) > 0;

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    cancelMediaJobsForUser(userId);
    stopGeoBackfillsForUser(userId);

    if (avatarFilename) {
      const avatarPath = resolvePathWithin(AVATARS_DIR, path.basename(avatarFilename));
      if (avatarPath && fs.existsSync(avatarPath)) {
        fs.unlinkSync(avatarPath);
      }
    }

    await mediaStorage.removeFiles(photoFilenames, { dirs: [userId] });

    req.session.destroy(() => {
      res.clearCookie('journey.sid');
      res.json({ success: true, isSetup });
    });
  } catch (err) {
    log.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// POST /api/auth/migrate
router.post('/migrate', requireSession, async (req, res) => {
  try {
    if (!(await isPrimaryAccount(req.userId))) {
      return res.status(403).json({ error: 'Legacy data migration is only available to the primary account' });
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

// POST /api/auth/avatar
router.post('/avatar', requireSession, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      const message = err instanceof multer.MulterError
        ? (err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5MB)' : err.message)
        : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      // Delete old avatar if exists
      const { rows } = await pool.query(
        'SELECT avatar_filename FROM users WHERE id = $1',
        [req.userId]
      );
      if (rows[0]?.avatar_filename) {
        const oldPath = path.join(AVATARS_DIR, rows[0].avatar_filename);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      await pool.query(
        'UPDATE users SET avatar_filename = $1 WHERE id = $2',
        [req.file.filename, req.userId]
      );

      res.json({
        avatarUrl: `/api/auth/avatar/${req.file.filename}`,
      });
    } catch (dbErr) {
      log.error('Avatar upload error:', dbErr);
      res.status(500).json({ error: 'Failed to save avatar' });
    }
  });
});

module.exports = router;
