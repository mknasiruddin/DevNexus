/**
 * DevNexus SQLite Database Layer
 * Built using Node.js native `node:sqlite` (DatabaseSync).
 * Provides ACID-compliant, persistent file storage for users, bookmarks,
 * activity logs, server-side sessions, and API caching.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'devnexus.sqlite');
const db = new DatabaseSync(dbPath);

// Enable WAL mode for high concurrency and performance
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Initialize Tables
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id TEXT UNIQUE,
      username TEXT UNIQUE NOT NULL,
      name TEXT,
      avatar_url TEXT,
      bio TEXT,
      email TEXT,
      skills TEXT DEFAULT '[]',
      experience_level TEXT DEFAULT 'Intermediate',
      role TEXT DEFAULT 'contributor',
      password_hash TEXT,
      password_salt TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      issue_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      repo_name TEXT NOT NULL,
      title TEXT NOT NULL,
      html_url TEXT NOT NULL,
      language TEXT,
      category TEXT,
      difficulty TEXT,
      comments_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, html_url)
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT,
      ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      user_id INTEGER,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      headers_json TEXT,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON api_cache(expires_at);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);

    CREATE TABLE IF NOT EXISTS contributors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id TEXT UNIQUE,
      username TEXT UNIQUE NOT NULL,
      name TEXT,
      avatar_url TEXT,
      bio TEXT,
      html_url TEXT,
      public_repos INTEGER DEFAULT 0,
      followers INTEGER DEFAULT 0,
      last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contributor_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contributor_id INTEGER NOT NULL,
      event_id TEXT UNIQUE NOT NULL,
      event_type TEXT NOT NULL,
      repo_name TEXT,
      action_summary TEXT,
      points INTEGER NOT NULL DEFAULT 0,
      source TEXT DEFAULT 'github',
      event_timestamp DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contributor_id) REFERENCES contributors(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_contrib_username ON contributors(username);
    CREATE INDEX IF NOT EXISTS idx_contrib_act_time ON contributor_activities(event_timestamp);
    CREATE INDEX IF NOT EXISTS idx_contrib_act_user ON contributor_activities(contributor_id);

    CREATE TABLE IF NOT EXISTS roadmap_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      step_number INTEGER NOT NULL CHECK(step_number >= 1 AND step_number <= 14),
      completed INTEGER NOT NULL DEFAULT 1,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, step_number)
    );

    CREATE INDEX IF NOT EXISTS idx_roadmap_user ON roadmap_progress(user_id);

    CREATE TABLE IF NOT EXISTS portfolio_settings (
      user_id INTEGER PRIMARY KEY,
      headline TEXT DEFAULT '',
      location TEXT DEFAULT '',
      github_url TEXT DEFAULT '',
      linkedin_url TEXT DEFAULT '',
      website_url TEXT DEFAULT '',
      twitter_url TEXT DEFAULT '',
      featured_repos TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS skill_tree_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT DEFAULT 'locked',
      unlocked_at DATETIME,
      xp_earned INTEGER DEFAULT 0,
      UNIQUE(user_id, node_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_xp (
      user_id INTEGER PRIMARY KEY,
      total_xp INTEGER DEFAULT 0,
      frontend_xp INTEGER DEFAULT 0,
      backend_xp INTEGER DEFAULT 0,
      devops_xp INTEGER DEFAULT 0,
      opensource_xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_skill_tree_user ON skill_tree_progress(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_xp_user ON user_xp(user_id);

    CREATE TABLE IF NOT EXISTS user_streaks (
      user_id INTEGER PRIMARY KEY,
      current_streak INTEGER DEFAULT 0,
      longest_streak INTEGER DEFAULT 0,
      last_active_date TEXT,
      total_active_days INTEGER DEFAULT 0,
      streak_freeze_count INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS streak_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      activity_date TEXT NOT NULL,
      activity_type TEXT DEFAULT 'general',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, activity_date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_streak_activities_user_date ON streak_activities(user_id, activity_date);
    CREATE INDEX IF NOT EXISTS idx_user_streaks_user ON user_streaks(user_id);

    CREATE TABLE IF NOT EXISTS user_badges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      badge_id TEXT NOT NULL,
      unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, badge_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);
  `);

  // Ensure is_onboarded column exists for existing SQLite database files
  const columns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!columns.includes('is_onboarded')) {
    db.exec("ALTER TABLE users ADD COLUMN is_onboarded INTEGER DEFAULT 0;");
  }
}

initSchema();

// Password hashing utilities using bcrypt with backward-compatible legacy verification
function hashPassword(password) {
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);
  return { hash, salt: 'bcrypt' };
}

function verifyPassword(password, hash, salt) {
  if (!password || !hash) return false;

  // 1. If hash is standard bcrypt ($2a$, $2b$, $2y$) or marked as bcrypt
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$') || salt === 'bcrypt') {
    try {
      return bcrypt.compareSync(password, hash);
    } catch (e) {
      return false;
    }
  }

  // 2. Legacy scrypt verification for previously existing password records
  if (salt && salt !== 'bcrypt') {
    try {
      const verify = crypto.scryptSync(password, salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verify, 'hex'));
    } catch (e) {
      return false;
    }
  }

  return false;
}

// Ensure initial administrator exists via environment variables
function bootstrapAdmin() {
  const adminCheck = db.prepare("SELECT * FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!adminCheck) {
    const adminUser = process.env.INITIAL_ADMIN_USERNAME || 'admin';
    const adminEmail = process.env.INITIAL_ADMIN_EMAIL || 'admin@devnexus.local';
    const adminPass = process.env.INITIAL_ADMIN_PASSWORD;

    if (!adminPass) {
      return;
    }

    const { hash, salt } = hashPassword(adminPass);
    const insert = db.prepare(`
      INSERT INTO users (username, name, email, role, password_hash, password_salt, status, is_onboarded)
      VALUES (?, ?, ?, 'admin', ?, ?, 'active', 1)
    `);
    insert.run(adminUser, 'Primary Administrator', adminEmail, hash, salt);

    logActivity(null, 'ADMIN_BOOTSTRAP', adminUser, 'Initial administrator account created via secure bootstrap with bcrypt');
  }
}

// User operations
function findUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
}

function findUserByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
}

function registerLocalUser({ username, email, password, name = null }) {
  const cleanUsername = (username || '').trim();
  const cleanEmail = (email || '').trim().toLowerCase();

  if (!cleanUsername || cleanUsername.length < 3 || cleanUsername.length > 39) {
    throw new Error('Username must be between 3 and 39 characters long.');
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(cleanUsername)) {
    throw new Error('Username may only contain letters, numbers, hyphens, and underscores.');
  }

  if (cleanEmail && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleanEmail)) {
    throw new Error('Please provide a valid email address.');
  }

  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters long.');
  }

  const existingUsername = findUserByUsername(cleanUsername);
  if (existingUsername) {
    throw new Error('Username is already taken. Please choose another.');
  }

  if (cleanEmail) {
    const existingEmail = findUserByEmail(cleanEmail);
    if (existingEmail) {
      throw new Error('An account with this email address already exists.');
    }
  }

  const { hash, salt } = hashPassword(password);
  const avatarUrl = `https://avatars.githubusercontent.com/u/9919?v=4`;

  const insert = db.prepare(`
    INSERT INTO users (username, name, email, avatar_url, bio, role, password_hash, password_salt, status, is_onboarded)
    VALUES (?, ?, ?, ?, ?, 'contributor', ?, ?, 'active', 0)
  `);

  const result = insert.run(
    cleanUsername,
    (name || cleanUsername).trim().slice(0, 80),
    cleanEmail || `${cleanUsername.toLowerCase()}@devnexus.local`,
    avatarUrl,
    'Open source developer exploring community projects.',
    hash,
    salt
  );

  return findUserById(result.lastInsertRowid);
}

function authenticateLocalUser(usernameOrEmail, password) {
  if (!usernameOrEmail || !password) return null;
  const identifier = usernameOrEmail.trim();

  let user = findUserByUsername(identifier);
  if (!user && identifier.includes('@')) {
    user = findUserByEmail(identifier);
  }

  if (!user || user.status !== 'active') return null;
  if (!user.password_hash || !user.password_salt) return null;

  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    return null;
  }

  return user;
}

function findUserByGithubId(githubId) {
  return db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(githubId));
}

function upsertGithubUser(profile) {
  const existing = findUserByGithubId(profile.id);
  if (existing) {
    const update = db.prepare(`
      UPDATE users
      SET username = ?, name = ?, avatar_url = ?, bio = ?, email = COALESCE(?, email), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    update.run(profile.login, profile.name || profile.login, profile.avatar_url, profile.bio || '', profile.email || null, existing.id);
    return { user: findUserById(existing.id), isNew: false };
  }

  // Check if username already exists without github_id
  const byUser = findUserByUsername(profile.login);
  if (byUser) {
    const update = db.prepare(`
      UPDATE users
      SET github_id = ?, name = ?, avatar_url = ?, bio = ?, email = COALESCE(?, email), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    update.run(String(profile.id), profile.name || profile.login, profile.avatar_url, profile.bio || '', profile.email || null, byUser.id);
    return { user: findUserById(byUser.id), isNew: false };
  }

  const insert = db.prepare(`
    INSERT INTO users (github_id, username, name, avatar_url, bio, email, role, status, is_onboarded)
    VALUES (?, ?, ?, ?, ?, ?, 'contributor', 'active', 0)
  `);
  const result = insert.run(String(profile.id), profile.login, profile.name || profile.login, profile.avatar_url, profile.bio || '', profile.email || null);
  return { user: findUserById(result.lastInsertRowid), isNew: true };
}

function findOrCreateDemoUser(username, name = null) {
  const cleanUsername = (username || '').trim().replace(/^@/, '');
  if (!cleanUsername || !/^[a-zA-Z0-9_-]{2,39}$/.test(cleanUsername)) {
    throw new Error('Please provide a valid GitHub username (2-39 alphanumeric, hyphen, or underscore characters).');
  }

  const existing = findUserByUsername(cleanUsername);
  if (existing) {
    // Prevent impersonation of administrators, maintainers, or protected accounts
    if (existing.role === 'admin' || existing.role === 'maintainer') {
      throw new Error('Demo sign-in cannot be used to access administrator or maintainer accounts.');
    }
    if (existing.password_hash || existing.github_id) {
      throw new Error('This username belongs to a registered account. Please sign in with your password or GitHub OAuth.');
    }
    if (existing.status !== 'active') {
      throw new Error('This account has been suspended.');
    }
    return existing;
  }

  const insert = db.prepare(`
    INSERT INTO users (username, name, email, avatar_url, bio, role, status, is_onboarded)
    VALUES (?, ?, ?, ?, ?, 'contributor', 'active', 0)
  `);
  const result = insert.run(
    cleanUsername,
    name || cleanUsername,
    `${cleanUsername.toLowerCase()}@devnexus.local`,
    `https://avatars.githubusercontent.com/u/9919?v=4`,
    'Open source developer exploring community projects.'
  );
  return findUserById(result.lastInsertRowid);
}

function updateUserProfile(userId, { name, skills, experience_level, bio, is_onboarded = 1 }) {
  const validLevels = ['Beginner', 'Intermediate', 'Advanced'];
  const cleanLevel = validLevels.includes(experience_level) ? experience_level : null;
  const cleanName = typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 80) : null;
  const cleanBio = typeof bio === 'string' ? bio.trim().slice(0, 300) : null;

  const update = db.prepare(`
    UPDATE users
    SET name = COALESCE(?, name),
        skills = COALESCE(?, skills),
        experience_level = COALESCE(?, experience_level),
        bio = COALESCE(?, bio),
        is_onboarded = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  update.run(
    cleanName,
    skills ? (typeof skills === 'string' ? skills : JSON.stringify(skills)) : null,
    cleanLevel,
    cleanBio,
    is_onboarded,
    userId
  );
  return findUserById(userId);
}

function updateUserRole(userId, newRole) {
  const update = db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  return update.run(newRole, userId);
}

function toggleUserStatus(userId) {
  const user = findUserById(userId);
  if (!user) return null;
  const newStatus = user.status === 'active' ? 'suspended' : 'active';
  db.prepare('UPDATE users SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, userId);
  return newStatus;
}

function getAllUsers() {
  return db.prepare(`
    SELECT id, github_id, username, name, email, avatar_url, role, experience_level, status, created_at
    FROM users
    ORDER BY created_at DESC
  `).all();
}

function countUsers() {
  const total = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const byRole = db.prepare('SELECT role, COUNT(*) as count FROM users GROUP BY role').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM users GROUP BY status').all();
  return { total, byRole, byStatus };
}

// Bookmarks operations
function addBookmark(userId, bookmarkData) {
  const insert = db.prepare(`
    INSERT INTO bookmarks (user_id, issue_id, issue_number, repo_name, title, html_url, language, category, difficulty, comments_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, html_url) DO UPDATE SET title = excluded.title, comments_count = excluded.comments_count
  `);
  insert.run(
    userId,
    String(bookmarkData.issue_id || bookmarkData.id || ''),
    Number(bookmarkData.issue_number || bookmarkData.number || 0),
    bookmarkData.repo_name || bookmarkData.repo || '',
    bookmarkData.title || '',
    bookmarkData.html_url || '',
    bookmarkData.language || 'Unknown',
    bookmarkData.category || 'general',
    bookmarkData.difficulty || 'Intermediate',
    Number(bookmarkData.comments_count || bookmarkData.comments || 0)
  );
  logActivity(userId, 'BOOKMARK_ADD', bookmarkData.html_url, `Bookmarked issue ${bookmarkData.repo_name} #${bookmarkData.issue_number}`);
  return true;
}

function removeBookmark(userId, htmlUrl) {
  const del = db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND html_url = ?');
  const res = del.run(userId, htmlUrl);
  if (res.changes > 0) {
    logActivity(userId, 'BOOKMARK_REMOVE', htmlUrl, 'Removed bookmark');
    return true;
  }
  return false;
}

function getUserBookmarks(userId) {
  return db.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function isBookmarked(userId, htmlUrl) {
  if (!userId) return false;
  const row = db.prepare('SELECT id FROM bookmarks WHERE user_id = ? AND html_url = ? LIMIT 1').get(userId, htmlUrl);
  return !!row;
}

function getBookmarkStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM bookmarks').get().count;
  const topRepos = db.prepare(`
    SELECT repo_name, COUNT(*) as count
    FROM bookmarks
    GROUP BY repo_name
    ORDER BY count DESC
    LIMIT 6
  `).all();
  return { total, topRepos };
}

// Activity Logging
function logActivity(userId, action, target, details, ip = null) {
  try {
    const insert = db.prepare(`
      INSERT INTO activity_logs (user_id, action, target, details, ip)
      VALUES (?, ?, ?, ?, ?)
    `);
    insert.run(userId || null, action, target || '', details || '', ip || null);
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
}

function getRecentActivities(limit = 15) {
  return db.prepare(`
    SELECT a.*, u.username, u.name as user_name
    FROM activity_logs a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(limit);
}

// Session store operations
function createSession(sid, userId, data, ttlMs = 86400000 * 7) {
  const expiresAt = Date.now() + ttlMs;
  const serialized = JSON.stringify(data);
  const upsert = db.prepare(`
    INSERT INTO sessions (sid, user_id, data, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at, user_id = excluded.user_id
  `);
  upsert.run(sid, userId || null, serialized, expiresAt);
}

function getSession(sid) {
  const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroySession(sid);
    return null;
  }
  try {
    return JSON.parse(row.data);
  } catch (e) {
    return null;
  }
}

function destroySession(sid) {
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
}

function cleanExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// API Caching operations
function getCached(cacheKey) {
  const row = db.prepare('SELECT * FROM api_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(cacheKey);
    return null;
  }
  try {
    return {
      data: JSON.parse(row.response_json),
      headers: row.headers_json ? JSON.parse(row.headers_json) : {},
      cached: true
    };
  } catch (e) {
    return null;
  }
}

function setCache(cacheKey, data, headers = {}, ttlSeconds = 300) {
  const expiresAt = Date.now() + (ttlSeconds * 1000);
  const ins = db.prepare(`
    INSERT INTO api_cache (cache_key, response_json, headers_json, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET response_json = excluded.response_json, headers_json = excluded.headers_json, expires_at = excluded.expires_at
  `);
  ins.run(cacheKey, JSON.stringify(data), JSON.stringify(headers), expiresAt);
}

// Contributor Leaderboard Operations
function upsertContributor({
  github_id = null,
  username,
  name = '',
  avatar_url = '',
  bio = '',
  html_url = '',
  public_repos = 0,
  followers = 0
}) {
  const cleanUsername = (username || '').trim().toLowerCase();
  if (!cleanUsername) return null;

  const existing = db.prepare('SELECT id FROM contributors WHERE LOWER(username) = LOWER(?)').get(cleanUsername);

  if (existing) {
    db.prepare(`
      UPDATE contributors
      SET github_id = COALESCE(?, github_id),
          name = COALESCE(NULLIF(?, ''), name),
          avatar_url = COALESCE(NULLIF(?, ''), avatar_url),
          bio = COALESCE(NULLIF(?, ''), bio),
          html_url = COALESCE(NULLIF(?, ''), html_url),
          public_repos = ?,
          followers = ?,
          last_synced_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(github_id ? String(github_id) : null, name, avatar_url, bio, html_url, public_repos, followers, existing.id);
    return db.prepare('SELECT * FROM contributors WHERE id = ?').get(existing.id);
  }

  const ins = db.prepare(`
    INSERT INTO contributors (github_id, username, name, avatar_url, bio, html_url, public_repos, followers, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const res = ins.run(github_id ? String(github_id) : null, cleanUsername, name, avatar_url, bio, html_url, public_repos, followers);
  return db.prepare('SELECT * FROM contributors WHERE id = ?').get(res.lastInsertRowid);
}

function recordContributorActivity(contributorId, {
  event_id,
  event_type,
  repo_name = '',
  action_summary = '',
  points = 0,
  source = 'github',
  event_timestamp
}) {
  if (!contributorId || !event_id) return false;

  const timestampIso = event_timestamp ? new Date(event_timestamp).toISOString() : new Date().toISOString();

  const ins = db.prepare(`
    INSERT OR IGNORE INTO contributor_activities (contributor_id, event_id, event_type, repo_name, action_summary, points, source, event_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const res = ins.run(contributorId, String(event_id), event_type, repo_name, action_summary, points, source, timestampIso);
  return res.changes > 0;
}

function getLeaderboard({
  category = 'top',
  time = 'all-time',
  search = '',
  page = 1,
  perPage = 10
} = {}) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000)).toISOString();
  const fourteenDaysAgo = new Date(now.getTime() - (14 * 24 * 60 * 60 * 1000)).toISOString();

  let timeClause = '';
  const joinParams = [];
  if (time === 'this-week') {
    timeClause = 'AND ca.event_timestamp >= ?';
    joinParams.push(sevenDaysAgo);
  } else if (time === 'this-month') {
    const monthAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000)).toISOString();
    timeClause = 'AND ca.event_timestamp >= ?';
    joinParams.push(monthAgo);
  }

  let searchClause = '';
  const searchParams = [];
  if (search && search.trim() !== '') {
    searchClause = 'WHERE (LOWER(c.username) LIKE ? OR LOWER(c.name) LIKE ?)';
    const s = `%${search.trim().toLowerCase()}%`;
    searchParams.push(s, s);
  }

  let orderBy = 'total_points DESC, activity_count DESC, c.followers DESC';
  if (category === 'active') {
    orderBy = 'activity_count DESC, total_points DESC, c.followers DESC';
  } else if (category === 'rising') {
    orderBy = 'velocity DESC, total_points DESC, activity_count DESC';
  }

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safePerPage = Math.max(1, Math.min(100, parseInt(perPage, 10) || 10));
  const offset = (safePage - 1) * safePerPage;

  const query = `
    SELECT
      c.id,
      c.github_id,
      c.username,
      c.name,
      c.avatar_url,
      c.bio,
      c.html_url,
      c.public_repos,
      c.followers,
      c.last_synced_at,
      COALESCE(SUM(ca.points), 0) AS total_points,
      COUNT(ca.id) AS activity_count,
      SUM(CASE WHEN ca.event_type = 'PullRequestEvent' THEN 1 ELSE 0 END) AS prs_count,
      SUM(CASE WHEN ca.event_type = 'PushEvent' THEN 1 ELSE 0 END) AS commits_count,
      SUM(CASE WHEN ca.event_type = 'IssuesEvent' THEN 1 ELSE 0 END) AS issues_count,
      SUM(CASE WHEN ca.source = 'devnexus' THEN ca.points ELSE 0 END) AS devnexus_points,
      SUM(CASE WHEN ca.source = 'github' THEN ca.points ELSE 0 END) AS github_points,
      (
        COALESCE((SELECT SUM(points) FROM contributor_activities WHERE contributor_id = c.id AND event_timestamp >= ?), 0)
        -
        COALESCE((SELECT SUM(points) FROM contributor_activities WHERE contributor_id = c.id AND event_timestamp >= ? AND event_timestamp < ?), 0)
      ) AS velocity
    FROM contributors c
    LEFT JOIN contributor_activities ca ON c.id = ca.contributor_id ${timeClause}
    ${searchClause}
    GROUP BY c.id
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const countQuery = `
    SELECT COUNT(*) as count FROM contributors c
    ${searchClause}
  `;

  const queryParams = [sevenDaysAgo, fourteenDaysAgo, sevenDaysAgo, ...joinParams, ...searchParams, safePerPage, offset];
  const rows = db.prepare(query).all(...queryParams);
  const totalCountRow = db.prepare(countQuery).get(...searchParams);
  const totalCount = totalCountRow ? totalCountRow.count : 0;
  const totalPages = Math.ceil(totalCount / safePerPage);

  const ranked = rows.map((r, i) => ({
    rank: offset + i + 1,
    id: r.id,
    githubId: r.github_id,
    username: r.username,
    name: r.name || r.username,
    avatarUrl: r.avatar_url || null,
    bio: r.bio || '',
    htmlUrl: r.html_url || `https://github.com/${r.username}`,
    publicRepos: r.public_repos || 0,
    followers: r.followers || 0,
    score: r.total_points,
    activityCount: r.activity_count,
    prsCount: r.prs_count,
    commitsCount: r.commits_count,
    issuesCount: r.issues_count,
    devnexusPoints: r.devnexus_points,
    githubPoints: r.github_points,
    velocity: r.velocity,
    lastSyncedAt: r.last_synced_at
  }));

  return {
    contributors: ranked,
    totalCount,
    page,
    perPage,
    totalPages
  };
}

function getLeaderboardStats() {
  const totalContributors = db.prepare('SELECT COUNT(*) as count FROM contributors').get().count;
  const totalEvents = db.prepare('SELECT COUNT(*) as count FROM contributor_activities').get().count;
  const totalPRs = db.prepare("SELECT COUNT(*) as count FROM contributor_activities WHERE event_type = 'PullRequestEvent'").get().count;
  const lastSyncRow = db.prepare('SELECT MAX(last_synced_at) as last_sync FROM contributors').get();

  return {
    totalContributors,
    totalEvents,
    totalPRs,
    lastSyncedAt: lastSyncRow ? lastSyncRow.last_sync : null
  };
}

function getContributorDetails(username) {
  const contributor = db.prepare('SELECT * FROM contributors WHERE LOWER(username) = LOWER(?)').get(username);
  if (!contributor) return null;

  const activities = db.prepare(`
    SELECT * FROM contributor_activities
    WHERE contributor_id = ?
    ORDER BY event_timestamp DESC
    LIMIT 20
  `).all(contributor.id);

  return {
    ...contributor,
    activities
  };
}

// First Contribution Roadmap Progress Operations (14-Stage Roadmap)
function getUserRoadmapProgress(userId) {
  const numericUserId = Number(userId);
  if (!numericUserId || Number.isNaN(numericUserId) || numericUserId <= 0) {
    return [];
  }
  const rows = db.prepare(`
    SELECT step_number, completed, completed_at
    FROM roadmap_progress
    WHERE user_id = ? AND completed = 1
    ORDER BY step_number ASC
  `).all(numericUserId);
  return rows.map(r => ({
    stepNumber: Number(r.step_number),
    completed: Boolean(r.completed),
    completedAt: r.completed_at
  }));
}

function setRoadmapStepStatus(userId, stepNumber, completed = true) {
  const numericUserId = Number(userId);
  const numericStep = Number(stepNumber);

  if (!numericUserId || Number.isNaN(numericUserId) || numericUserId <= 0) {
    throw new Error('A valid authenticated user ID is required to update roadmap progress.');
  }
  if (!Number.isInteger(numericStep) || numericStep < 1 || numericStep > 14) {
    throw new Error('Roadmap step number must be an integer between 1 and 14.');
  }

  const userRow = findUserById(numericUserId);
  if (!userRow) {
    throw new Error('Authenticated user does not exist.');
  }

  const isCompleted = Boolean(completed);
  if (isCompleted) {
    const upsert = db.prepare(`
      INSERT INTO roadmap_progress (user_id, step_number, completed, completed_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, step_number) DO UPDATE SET
        completed = 1,
        completed_at = CURRENT_TIMESTAMP
    `);
    upsert.run(numericUserId, numericStep);
    logActivity(numericUserId, 'ROADMAP_STEP_COMPLETE', `stage-${numericStep}`, `Completed First Contribution Roadmap stage #${numericStep}`);
  } else {
    const del = db.prepare('DELETE FROM roadmap_progress WHERE user_id = ? AND step_number = ?');
    del.run(numericUserId, numericStep);
    logActivity(numericUserId, 'ROADMAP_STEP_UNCHECK', `stage-${numericStep}`, `Marked First Contribution Roadmap stage #${numericStep} incomplete`);
  }

  return getUserRoadmapProgress(numericUserId);
}

function resetUserRoadmapProgress(userId) {
  const numericUserId = Number(userId);
  if (!numericUserId || Number.isNaN(numericUserId) || numericUserId <= 0) {
    throw new Error('A valid authenticated user ID is required.');
  }
  db.prepare('DELETE FROM roadmap_progress WHERE user_id = ?').run(numericUserId);
  logActivity(numericUserId, 'ROADMAP_RESET', 'all-stages', 'Reset First Contribution Roadmap progress');
  return [];
}

// Initial bootstrap check
bootstrapAdmin();

// --- Portfolio Settings ---

function getPortfolioSettings(userId) {
  const row = db.prepare('SELECT * FROM portfolio_settings WHERE user_id = ?').get(userId);
  return row || {};
}

function upsertPortfolioSettings(userId, payload) {
  const stmt = db.prepare(`
    INSERT INTO portfolio_settings (user_id, headline, location, github_url, linkedin_url, website_url, twitter_url, featured_repos, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      headline = excluded.headline,
      location = excluded.location,
      github_url = excluded.github_url,
      linkedin_url = excluded.linkedin_url,
      website_url = excluded.website_url,
      twitter_url = excluded.twitter_url,
      featured_repos = excluded.featured_repos,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(
    userId,
    payload.headline || '',
    payload.location || '',
    payload.github_url || '',
    payload.linkedin_url || '',
    payload.website_url || '',
    payload.twitter_url || '',
    typeof payload.featured_repos === 'string' ? payload.featured_repos : JSON.stringify(payload.featured_repos || [])
  );
}

// --- Skill Tree ---

function getSkillTreeProgress(userId) {
  return db.prepare('SELECT * FROM skill_tree_progress WHERE user_id = ?').all(userId);
}

function upsertSkillNode(userId, nodeId, status, xpEarned) {
  const stmt = db.prepare(`
    INSERT INTO skill_tree_progress (user_id, node_id, status, unlocked_at, xp_earned)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(user_id, node_id) DO UPDATE SET
      status = excluded.status,
      unlocked_at = CASE WHEN excluded.status = 'unlocked' THEN CURRENT_TIMESTAMP ELSE unlocked_at END,
      xp_earned = excluded.xp_earned
  `);
  stmt.run(userId, nodeId, status || 'locked', xpEarned || 0);
}

function getUserXP(userId) {
  const row = db.prepare('SELECT * FROM user_xp WHERE user_id = ?').get(userId);
  return row || {
    user_id: userId,
    total_xp: 0,
    frontend_xp: 0,
    backend_xp: 0,
    devops_xp: 0,
    opensource_xp: 0,
    level: 1
  };
}

function upsertUserXP(userId, xpData) {
  const stmt = db.prepare(`
    INSERT INTO user_xp (user_id, total_xp, frontend_xp, backend_xp, devops_xp, opensource_xp, level, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      total_xp = excluded.total_xp,
      frontend_xp = excluded.frontend_xp,
      backend_xp = excluded.backend_xp,
      devops_xp = excluded.devops_xp,
      opensource_xp = excluded.opensource_xp,
      level = excluded.level,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(
    userId,
    xpData.total_xp || 0,
    xpData.frontend_xp || 0,
    xpData.backend_xp || 0,
    xpData.devops_xp || 0,
    xpData.opensource_xp || 0,
    xpData.level || 1
  );
}

// --- User Activity for Portfolio ---

function getUserRecentActivity(userId, limit = 10) {
  return db.prepare(`
    SELECT * FROM activity_logs
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

// --- Contribution Streaks (Member 3) ---

function getUserStreakData(userId) {
  const row = db.prepare('SELECT * FROM user_streaks WHERE user_id = ?').get(userId);
  if (!row) {
    return {
      user_id: userId,
      current_streak: 0,
      longest_streak: 0,
      last_active_date: null,
      total_active_days: 0,
      streak_freeze_count: 1
    };
  }
  return row;
}

function upsertUserStreak(userId, streakData) {
  const stmt = db.prepare(`
    INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_active_date, total_active_days, streak_freeze_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      current_streak = excluded.current_streak,
      longest_streak = excluded.longest_streak,
      last_active_date = excluded.last_active_date,
      total_active_days = excluded.total_active_days,
      streak_freeze_count = excluded.streak_freeze_count,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(
    userId,
    streakData.current_streak || 0,
    streakData.longest_streak || 0,
    streakData.last_active_date || null,
    streakData.total_active_days || 0,
    streakData.streak_freeze_count !== undefined ? streakData.streak_freeze_count : 1
  );
  return getUserStreakData(userId);
}

function recordStreakActivityDate(userId, activityDate, activityType = 'general') {
  try {
    const stmt = db.prepare(`
      INSERT INTO streak_activities (user_id, activity_date, activity_type)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, activity_date) DO NOTHING
    `);
    const res = stmt.run(userId, activityDate, activityType);
    return res.changes > 0;
  } catch (err) {
    console.error('[DevNexus DB] Failed to record streak activity date:', err.message);
    return false;
  }
}

function getUserStreakActivities(userId, limit = 90) {
  return db.prepare(`
    SELECT activity_date, activity_type, created_at
    FROM streak_activities
    WHERE user_id = ?
    ORDER BY activity_date DESC
    LIMIT ?
  `).all(userId, limit);
}

function getUserTotalActiveDays(userId) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT activity_date) as count
    FROM streak_activities
    WHERE user_id = ?
  `).get(userId);
  return row ? row.count : 0;
}

function consumeStreakFreeze(userId) {
  const streak = getUserStreakData(userId);
  if (streak && streak.streak_freeze_count > 0) {
    db.prepare(`
      UPDATE user_streaks
      SET streak_freeze_count = streak_freeze_count - 1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(userId);
    return true;
  }
  return false;
}

// --- Achievement Badges (Member 3) ---

function getUserUnlockedBadges(userId) {
  return db.prepare('SELECT badge_id, unlocked_at FROM user_badges WHERE user_id = ? ORDER BY unlocked_at ASC').all(userId);
}

function awardUserBadge(userId, badgeId) {
  try {
    const stmt = db.prepare(`
      INSERT INTO user_badges (user_id, badge_id)
      VALUES (?, ?)
      ON CONFLICT(user_id, badge_id) DO NOTHING
    `);
    const res = stmt.run(userId, badgeId);
    if (res.changes > 0) {
      logActivity(userId, 'BADGE_EARNED', badgeId, `Earned achievement badge: ${badgeId}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[DevNexus DB] Failed to award badge:', err.message);
    return false;
  }
}

function hasUserBadge(userId, badgeId) {
  const row = db.prepare('SELECT id FROM user_badges WHERE user_id = ? AND badge_id = ? LIMIT 1').get(userId, badgeId);
  return Boolean(row);
}

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  findUserById,
  findUserByUsername,
  findUserByEmail,
  findUserByGithubId,
  registerLocalUser,
  authenticateLocalUser,
  upsertGithubUser,
  findOrCreateDemoUser,
  updateUserProfile,
  updateUserRole,
  toggleUserStatus,
  getAllUsers,
  countUsers,
  addBookmark,
  removeBookmark,
  getUserBookmarks,
  isBookmarked,
  getBookmarkStats,
  logActivity,
  getRecentActivities,
  createSession,
  getSession,
  destroySession,
  cleanExpiredSessions,
  getCached,
  setCache,
  upsertContributor,
  recordContributorActivity,
  getLeaderboard,
  getLeaderboardStats,
  getContributorDetails,
  getUserRoadmapProgress,
  setRoadmapStepStatus,
  resetUserRoadmapProgress,
  getPortfolioSettings,
  upsertPortfolioSettings,
  getSkillTreeProgress,
  upsertSkillNode,
  getUserXP,
  upsertUserXP,
  getUserRecentActivity,
  getUserStreakData,
  upsertUserStreak,
  recordStreakActivityDate,
  getUserStreakActivities,
  getUserTotalActiveDays,
  consumeStreakFreeze,
  getUserUnlockedBadges,
  awardUserBadge,
  hasUserBadge
};

