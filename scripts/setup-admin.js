#!/usr/bin/env node
/**
 * DevNexus Admin Setup & Password Reset CLI Utility
 *
 * Securely creates or rotates administrator credentials using bcrypt hashing.
 *
 * Usage:
 *   node scripts/setup-admin.js <username> <email> <password>
 * Or rely on environment variables:
 *   INITIAL_ADMIN_USERNAME, INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD
 */

require('dotenv').config();
const { db, hashPassword, logActivity } = require('../db/database');

const args = process.argv.slice(2);
const username = (args[0] || process.env.INITIAL_ADMIN_USERNAME || 'admin').trim();
const email = (args[1] || process.env.INITIAL_ADMIN_EMAIL || 'admin@devnexus.local').trim();
const password = args[2] || process.env.INITIAL_ADMIN_PASSWORD;

if (!password || password.length < 8) {
  console.error('Error: Password must be at least 8 characters long.');
  console.error('Usage: node scripts/setup-admin.js <username> <email> <password>');
  console.error('Or set INITIAL_ADMIN_PASSWORD in your .env environment file.');
  process.exit(1);
}

try {
  const existing = db.prepare('SELECT id, role FROM users WHERE LOWER(username) = LOWER(?)').get(username);
  const { hash, salt } = hashPassword(password);

  if (existing) {
    db.prepare(`
      UPDATE users
      SET email = ?, role = 'admin', password_hash = ?, password_salt = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(email, hash, salt, existing.id);
    logActivity(existing.id, 'ADMIN_CLI_RESET', username, 'Administrator credentials rotated via secure CLI utility with bcrypt');
    console.log(`[DevNexus] Administrator account '${username}' credentials rotated successfully (bcrypt).`);
  } else {
    const res = db.prepare(`
      INSERT INTO users (username, name, email, role, password_hash, password_salt, status, is_onboarded)
      VALUES (?, 'Platform Administrator', ?, 'admin', ?, ?, 'active', 1)
    `).run(username, email, hash, salt);
    logActivity(res.lastInsertRowid, 'ADMIN_CLI_CREATE', username, 'Administrator account created via secure CLI utility with bcrypt');
    console.log(`[DevNexus] Administrator account '${username}' created successfully (bcrypt).`);
  }

  console.log(`Username: ${username}`);
  console.log(`Email: ${email}`);
  console.log(`Status: Active | Role: Administrator`);
  console.log(`Password Hashing: bcrypt (10 rounds)`);
} catch (err) {
  console.error('[DevNexus] Failed to configure administrator:', err.message);
  process.exit(1);
}
