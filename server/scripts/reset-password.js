#!/usr/bin/env node
// Sets a new random password for an account and signs it out everywhere. For when the only
// admin has forgotten theirs; other accounts can be reset by an admin in Settings.
// Usage: npm run password:reset -- <username>
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const { pool, initSchema } = require('../db');
const { resetPassword } = require('../utils/accounts');

async function main() {
  const username = (process.argv[2] || '').trim();
  if (!username) {
    console.error('Usage: npm run password:reset -- <username>');
    process.exitCode = 2;
    return;
  }
  await initSchema();
  const { rows } = await pool.query(
    'SELECT id, username FROM users WHERE username = $1 OR lower(username) = lower($1) ORDER BY (username = $1) DESC',
    [username]
  );
  if (rows.length === 0) {
    const { rows: all } = await pool.query('SELECT username FROM users ORDER BY created_at ASC');
    console.error(`No account named "${username}". Accounts: ${all.map((user) => user.username).join(', ') || '(none)'}`);
    process.exitCode = 1;
    return;
  }
  const { temporaryPassword, sessionsEnded } = await resetPassword(rows[0].id);
  console.log(`New password for ${rows[0].username}: ${temporaryPassword}`);
  console.log(`${sessionsEnded} session(s) signed out. Sign in and change it in Settings.`);
}

main()
  .catch((err) => {
    console.error('Password reset failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
