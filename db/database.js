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

// Enable WAL mode and busy timeout for high concurrency and performance
db.exec('PRAGMA busy_timeout = 5000;');
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

    CREATE TABLE IF NOT EXISTS github_sync_states (
      user_id INTEGER PRIMARY KEY,
      github_id TEXT NOT NULL,
      github_username TEXT NOT NULL,
      access_token_enc TEXT,
      total_repos INTEGER DEFAULT 0,
      public_repos INTEGER DEFAULT 0,
      private_repos INTEGER DEFAULT 0,
      total_commits INTEGER DEFAULT 0,
      commit_period_days INTEGER DEFAULT 90,
      prs_created INTEGER DEFAULT 0,
      prs_merged INTEGER DEFAULT 0,
      issues_created INTEGER DEFAULT 0,
      issues_closed INTEGER DEFAULT 0,
      contributions_count INTEGER DEFAULT 0,
      language_distribution TEXT DEFAULT '[]',
      last_sync_status TEXT DEFAULT 'idle',
      last_sync_error TEXT,
      rate_limit_remaining INTEGER,
      rate_limit_limit INTEGER,
      rate_limit_reset_epoch INTEGER,
      last_synced_at DATETIME,
      next_allowed_sync_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS github_synced_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      github_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      html_url TEXT NOT NULL,
      description TEXT DEFAULT '',
      language TEXT DEFAULT 'Other',
      language_color TEXT DEFAULT '#818CF8',
      is_private INTEGER DEFAULT 0,
      is_fork INTEGER DEFAULT 0,
      stars INTEGER DEFAULT 0,
      forks INTEGER DEFAULT 0,
      open_issues INTEGER DEFAULT 0,
      license TEXT,
      topics TEXT DEFAULT '[]',
      homepage TEXT DEFAULT '',
      has_issues INTEGER DEFAULT 1,
      archived INTEGER DEFAULT 0,
      pushed_at DATETIME,
      updated_at DATETIME,
      health_json TEXT,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, repo_id)
    );

    CREATE TABLE IF NOT EXISTS github_synced_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      github_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      category TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action TEXT DEFAULT '',
      title TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      target_url TEXT NOT NULL,
      commit_count INTEGER DEFAULT 0,
      branch_or_tag TEXT DEFAULT '',
      event_timestamp DATETIME NOT NULL,
      is_private INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_gh_sync_state_ghid ON github_sync_states(github_id);
    CREATE INDEX IF NOT EXISTS idx_gh_synced_repos_user ON github_synced_repos(user_id, github_id, pushed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_gh_synced_act_user ON github_synced_activities(user_id, github_id, event_timestamp DESC);
  `);

  // Ensure is_onboarded column exists for existing SQLite database files
  const columns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!columns.includes('is_onboarded')) {
    db.exec("ALTER TABLE users ADD COLUMN is_onboarded INTEGER DEFAULT 0;");
  }

  // Additive non-destructive columns for OAuth permission visibility & repo ownership metadata
  const syncStateCols = db.prepare("PRAGMA table_info(github_sync_states)").all().map(c => c.name);
  if (!syncStateCols.includes('granted_scopes')) {
    db.exec("ALTER TABLE github_sync_states ADD COLUMN granted_scopes TEXT;");
  }
  if (!syncStateCols.includes('private_access_granted')) {
    db.exec("ALTER TABLE github_sync_states ADD COLUMN private_access_granted INTEGER DEFAULT 0;");
  }
  if (!syncStateCols.includes('private_access_note')) {
    db.exec("ALTER TABLE github_sync_states ADD COLUMN private_access_note TEXT;");
  }

  const syncedRepoCols = db.prepare("PRAGMA table_info(github_synced_repos)").all().map(c => c.name);
  if (!syncedRepoCols.includes('owner_login')) {
    db.exec("ALTER TABLE github_synced_repos ADD COLUMN owner_login TEXT DEFAULT '';");
  }
  if (!syncedRepoCols.includes('owner_type')) {
    db.exec("ALTER TABLE github_synced_repos ADD COLUMN owner_type TEXT DEFAULT 'User';");
  }

  const syncedActCols = db.prepare("PRAGMA table_info(github_synced_activities)").all().map(c => c.name);
  if (!syncedActCols.includes('repo_id')) {
    db.exec("ALTER TABLE github_synced_activities ADD COLUMN repo_id TEXT DEFAULT '';");
  }
  if (!syncedActCols.includes('canonical_key')) {
    db.exec("ALTER TABLE github_synced_activities ADD COLUMN canonical_key TEXT;");
  }
  if (!syncedActCols.includes('activity_date')) {
    db.exec("ALTER TABLE github_synced_activities ADD COLUMN activity_date TEXT;");
  }
  if (!syncedActCols.includes('points')) {
    db.exec("ALTER TABLE github_synced_activities ADD COLUMN points INTEGER DEFAULT 0;");
  }
  if (!syncedActCols.includes('source')) {
    db.exec("ALTER TABLE github_synced_activities ADD COLUMN source TEXT DEFAULT 'github';");
  }
  db.exec(`
    UPDATE github_synced_activities
    SET activity_date = substr(event_timestamp, 1, 10)
    WHERE activity_date IS NULL AND event_timestamp IS NOT NULL AND length(event_timestamp) >= 10;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_synced_act_canonical ON github_synced_activities(user_id, canonical_key) WHERE canonical_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gh_synced_act_date ON github_synced_activities(user_id, activity_date);
    CREATE INDEX IF NOT EXISTS idx_gh_synced_act_repo ON github_synced_activities(user_id, repo_name);
  `);

  const contributorCols = db.prepare("PRAGMA table_info(contributors)").all().map(c => c.name);
  if (!contributorCols.includes('user_id')) {
    db.exec("ALTER TABLE contributors ADD COLUMN user_id INTEGER;");
  }
  if (!contributorCols.includes('current_streak')) {
    db.exec("ALTER TABLE contributors ADD COLUMN current_streak INTEGER DEFAULT 0;");
  }
  if (!contributorCols.includes('longest_streak')) {
    db.exec("ALTER TABLE contributors ADD COLUMN longest_streak INTEGER DEFAULT 0;");
  }
  if (!contributorCols.includes('total_active_days')) {
    db.exec("ALTER TABLE contributors ADD COLUMN total_active_days INTEGER DEFAULT 0;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_contributors_userid ON contributors(user_id);");

  const contribActCols = db.prepare("PRAGMA table_info(contributor_activities)").all().map(c => c.name);
  if (!contribActCols.includes('action_kind')) {
    db.exec("ALTER TABLE contributor_activities ADD COLUMN action_kind TEXT DEFAULT '';");
  }
  if (!contribActCols.includes('commit_count')) {
    db.exec("ALTER TABLE contributor_activities ADD COLUMN commit_count INTEGER DEFAULT 0;");
  }

  // Centralized scoring rules, DevNexus platform activities, daily activity summaries, & productivity snapshots
  db.exec(`
    CREATE TABLE IF NOT EXISTS scoring_rules (
      rule_key TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'github',
      label TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS platform_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      unique_key TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      reference_id TEXT DEFAULT '',
      title TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      activity_date TEXT NOT NULL,
      event_timestamp DATETIME NOT NULL,
      metadata_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, unique_key)
    );

    CREATE TABLE IF NOT EXISTS daily_activity_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      summary_date TEXT NOT NULL,
      github_contributions INTEGER NOT NULL DEFAULT 0,
      commits_count INTEGER NOT NULL DEFAULT 0,
      prs_created INTEGER NOT NULL DEFAULT 0,
      prs_merged INTEGER NOT NULL DEFAULT 0,
      prs_closed INTEGER NOT NULL DEFAULT 0,
      issues_opened INTEGER NOT NULL DEFAULT 0,
      issues_closed INTEGER NOT NULL DEFAULT 0,
      reviews_count INTEGER NOT NULL DEFAULT 0,
      repo_contributions INTEGER NOT NULL DEFAULT 0,
      platform_activities_count INTEGER NOT NULL DEFAULT 0,
      github_points INTEGER NOT NULL DEFAULT 0,
      platform_points INTEGER NOT NULL DEFAULT 0,
      total_points INTEGER NOT NULL DEFAULT 0,
      is_qualifying_day INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, summary_date)
    );

    CREATE TABLE IF NOT EXISTS productivity_statistics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      period_type TEXT NOT NULL,
      period_key TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      active_days INTEGER NOT NULL DEFAULT 0,
      eligible_days INTEGER NOT NULL DEFAULT 0,
      activity_percentage REAL NOT NULL DEFAULT 0,
      total_contributions INTEGER NOT NULL DEFAULT 0,
      platform_activities_count INTEGER NOT NULL DEFAULT 0,
      commits_count INTEGER NOT NULL DEFAULT 0,
      prs_created INTEGER NOT NULL DEFAULT 0,
      prs_merged INTEGER NOT NULL DEFAULT 0,
      issues_opened INTEGER NOT NULL DEFAULT 0,
      issues_closed INTEGER NOT NULL DEFAULT 0,
      reviews_count INTEGER NOT NULL DEFAULT 0,
      github_points INTEGER NOT NULL DEFAULT 0,
      platform_points INTEGER NOT NULL DEFAULT 0,
      contribution_points INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, period_type, period_key)
    );

    CREATE INDEX IF NOT EXISTS idx_platform_act_user_date ON platform_activities(user_id, activity_date DESC);
    CREATE INDEX IF NOT EXISTS idx_platform_act_user_type ON platform_activities(user_id, activity_type);
    CREATE INDEX IF NOT EXISTS idx_daily_summary_user_date ON daily_activity_summaries(user_id, summary_date DESC);
    CREATE INDEX IF NOT EXISTS idx_prod_stats_user_period ON productivity_statistics(user_id, period_type, period_key);
  `);

  const seedRuleStmt = db.prepare(`
    INSERT OR IGNORE INTO scoring_rules (rule_key, source, label, points, description, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const defaultRulesSeed = [
    ['commit', 'github', 'Verified Git Commit', 2, 'Points awarded per unique verified commit SHA or push commit'],
    ['pr_created', 'github', 'Pull Request Created', 10, 'Points awarded per opened pull request'],
    ['pr_merged', 'github', 'Pull Request Merged', 15, 'Bonus points when an authored pull request is merged'],
    ['pr_closed', 'github', 'Pull Request Closed', 4, 'Points when an authored pull request closes without merge'],
    ['issue_opened', 'github', 'Issue Opened', 5, 'Points awarded per verified GitHub issue opened'],
    ['issue_closed', 'github', 'Issue Resolved / Closed', 8, 'Points awarded when a tracked GitHub issue is resolved/closed'],
    ['pr_review', 'github', 'Pull Request Code Review', 6, 'Points awarded per verified peer pull request review'],
    ['repo_contribution', 'github', 'Repository Contribution', 5, 'Points awarded for repository creation or published releases'],
    ['roadmap_stage', 'devnexus', 'Roadmap Stage Completed', 10, 'One-time points for completing a 14-stage Contribution Roadmap step'],
    ['skill_task', 'devnexus', 'Skill Tree Node Unlocked', 15, 'One-time points for unlocking a verified DevNexus Skill Tree node'],
    ['contribution_milestone', 'devnexus', 'Contribution Milestone Earned', 20, 'One-time points for unlocking a contribution or streak milestone badge']
  ];
  for (const r of defaultRulesSeed) {
    seedRuleStmt.run(...r);
  }

  // Flag confirmed pre-existing synthetic/QA test accounts in `users` without deleting user rows,
  // clean orphaned `contributors` lacking any registered user, and remove superseded legacy null-key PR duplicates.
  const userCols2 = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols2.includes('is_synthetic')) {
    db.exec("ALTER TABLE users ADD COLUMN is_synthetic INTEGER DEFAULT 0;");
  }

  db.exec(`
    UPDATE users
    SET is_synthetic = 1
    WHERE is_synthetic = 0
      AND (
        LOWER(username) LIKE 'streak_tester_%'
        OR LOWER(username) LIKE 'freeze_user_%'
        OR LOWER(username) LIKE 'user_alpha_%'
        OR LOWER(username) LIKE 'user_beta_%'
        OR LOWER(username) LIKE 'sync_alpha_%'
        OR LOWER(username) LIKE 'sync_beta_%'
        OR LOWER(username) LIKE 'test_dev_%'
        OR LOWER(username) IN ('test-navigator', 'test_regular_contributor', 'readiness_browser_test', 'unique_other_user_1')
        OR LOWER(username) LIKE 'signup_qa_%'
        OR LOWER(username) LIKE 'saanvi_inc_%'
        OR LOWER(username) LIKE 'ghc_%'
        OR LOWER(username) LIKE 'ghb_%'
        OR LOWER(username) LIKE 'gh_zero_%'
        OR LOWER(username) LIKE 'gh_pub_%'
        OR LOWER(username) LIKE 'gh_mix_%'
        OR LOWER(username) LIKE 'gh_large_%'
        OR LOWER(COALESCE(name, '')) LIKE 'acct %'
      );

    DELETE FROM contributor_activities
    WHERE contributor_id IN (
      SELECT c.id FROM contributors c
      LEFT JOIN users u ON u.id = c.user_id
      WHERE c.user_id IS NULL OR u.id IS NULL OR u.is_synthetic = 1
    );

    DELETE FROM contributors
    WHERE user_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = contributors.user_id)
       OR EXISTS (SELECT 1 FROM users u WHERE u.id = contributors.user_id AND u.is_synthetic = 1);

    DELETE FROM contributor_activities
    WHERE contributor_id IN (
      SELECT id FROM contributors
      WHERE id NOT IN (SELECT MIN(id) FROM contributors GROUP BY user_id)
    );

    DELETE FROM contributors
    WHERE id NOT IN (SELECT MIN(id) FROM contributors GROUP BY user_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_contributors_userid_uniq ON contributors(user_id) WHERE user_id IS NOT NULL;
  `);

  // Remove legacy unkeyed github_synced_activities PR duplicates when canonical PR entries exist for the same repo/action/day
  const legPrCleanup = db.prepare(`
    DELETE FROM github_synced_activities
    WHERE canonical_key IS NULL
      AND category = 'pr'
      AND EXISTS (
        SELECT 1 FROM github_synced_activities c2
        WHERE c2.user_id = github_synced_activities.user_id
          AND c2.canonical_key IS NOT NULL
          AND c2.category = 'pr'
          AND LOWER(c2.repo_name) = LOWER(github_synced_activities.repo_name)
          AND LOWER(c2.action) = LOWER(github_synced_activities.action)
          AND COALESCE(c2.activity_date, substr(c2.event_timestamp, 1, 10)) = COALESCE(github_synced_activities.activity_date, substr(github_synced_activities.event_timestamp, 1, 10))
      )
  `).run();

  if (legPrCleanup.changes > 0) {
    db.exec("UPDATE contributors SET last_synced_at = '1970-01-01 00:00:00';");
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

function createAuthError(message, code = 'VALIDATION_ERROR', statusCode = 400, field = null, fieldErrors = null) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.field = field;
  err.fieldErrors = fieldErrors || (field ? { [field]: message } : {});
  err.isValidationError = true;
  return err;
}

function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, message: 'Password is required.' };
  }
  if (password.length < 8) {
    return { valid: false, message: 'Password must be at least 8 characters long.' };
  }
  if (password.length > 128) {
    return { valid: false, message: 'Password must not exceed 128 characters.' };
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^a-zA-Z0-9\s]/.test(password)) {
    return {
      valid: false,
      message: 'Password must include uppercase, lowercase, a number, and a special character.'
    };
  }
  return { valid: true, message: null };
}

function validateRegistrationInput({ username, email, password, confirmPassword, requireConfirm = false }) {
  const cleanUsername = typeof username === 'string' ? username.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const rawPassword = typeof password === 'string' ? password : '';
  const rawConfirm = typeof confirmPassword === 'string' ? confirmPassword : '';
  const fieldErrors = {};

  if (!cleanUsername) {
    fieldErrors.username = 'Username is required.';
  } else if (cleanUsername.length < 3 || cleanUsername.length > 39) {
    fieldErrors.username = 'Username must be between 3 and 39 characters long.';
  } else if (!/^[a-zA-Z0-9_-]+$/.test(cleanUsername)) {
    fieldErrors.username = 'Username may only contain letters, numbers, hyphens, and underscores.';
  }

  if (!cleanEmail) {
    fieldErrors.email = 'Email address is required.';
  } else if (
    cleanEmail.length > 254 ||
    cleanEmail.includes('..') ||
    !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleanEmail)
  ) {
    fieldErrors.email = 'Please provide a valid email address.';
  }

  const strength = validatePasswordStrength(rawPassword);
  if (!strength.valid) {
    fieldErrors.password = strength.message;
  }

  if (requireConfirm) {
    if (!rawConfirm) {
      fieldErrors.confirmPassword = 'Please confirm your password.';
    } else if (rawPassword !== rawConfirm) {
      fieldErrors.confirmPassword = 'Passwords do not match.';
    }
  }

  const firstField = Object.keys(fieldErrors)[0];
  if (firstField) {
    const firstMsg = fieldErrors[firstField];
    const code = firstField === 'confirmPassword' && rawConfirm && rawPassword !== rawConfirm
      ? 'PASSWORD_MISMATCH'
      : 'VALIDATION_ERROR';
    throw createAuthError(firstMsg, code, 400, firstField, fieldErrors);
  }

  return { cleanUsername, cleanEmail };
}

function registerLocalUser({ username, email, password, name = null }) {
  const { cleanUsername, cleanEmail } = validateRegistrationInput({
    username,
    email,
    password,
    requireConfirm: false
  });

  const { hash, salt } = hashPassword(password);
  const avatarUrl = `https://avatars.githubusercontent.com/u/9919?v=4`;
  const displayName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 80) : cleanUsername;

  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    inTransaction = true;

    const existingUsername = findUserByUsername(cleanUsername);
    if (existingUsername) {
      throw createAuthError('Username is already taken. Please choose another.', 'USERNAME_TAKEN', 409, 'username');
    }

    const existingEmail = findUserByEmail(cleanEmail);
    if (existingEmail) {
      throw createAuthError('An account with this email address already exists.', 'EMAIL_EXISTS', 409, 'email');
    }

    const insert = db.prepare(`
      INSERT INTO users (username, name, email, avatar_url, bio, experience_level, role, password_hash, password_salt, status, is_onboarded)
      VALUES (?, ?, ?, ?, ?, NULL, 'contributor', ?, ?, 'active', 0)
    `);

    const result = insert.run(
      cleanUsername,
      displayName,
      cleanEmail,
      avatarUrl,
      'Open source developer exploring community projects.',
      hash,
      salt
    );

    const createdUser = findUserById(result.lastInsertRowid);
    db.exec('COMMIT;');
    inTransaction = false;
    return createdUser;
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK;'); } catch (rollbackErr) {}
    }
    if (err && err.isValidationError) {
      throw err;
    }
    if (err && (err.code === 'ERR_SQLITE_ERROR' || String(err.message).includes('UNIQUE constraint failed'))) {
      if (String(err.message).includes('users.username')) {
        throw createAuthError('Username is already taken. Please choose another.', 'USERNAME_TAKEN', 409, 'username');
      }
      if (String(err.message).includes('users.email')) {
        throw createAuthError('An account with this email address already exists.', 'EMAIL_EXISTS', 409, 'email');
      }
    }
    throw err;
  }
}

function authenticateLocalUserWithStatus(usernameOrEmail, password) {
  if (!usernameOrEmail || !password) {
    return { ok: false, reason: 'MISSING_CREDENTIALS', user: null };
  }

  let identifier = String(usernameOrEmail).trim();
  if (identifier.startsWith('@') && !identifier.slice(1).includes('@')) {
    identifier = identifier.slice(1).trim();
  }
  if (!identifier) {
    return { ok: false, reason: 'MISSING_CREDENTIALS', user: null };
  }

  let user = findUserByUsername(identifier);
  if (!user && identifier.includes('@')) {
    user = db.prepare(`
      SELECT * FROM users
      WHERE LOWER(email) = LOWER(?)
      ORDER BY CASE
        WHEN status = 'active' AND password_hash IS NOT NULL THEN 0
        WHEN status = 'active' THEN 1
        ELSE 2
      END, id DESC
      LIMIT 1
    `).get(identifier);
  }

  if (!user) {
    return { ok: false, reason: 'USER_NOT_FOUND', user: null };
  }
  if (user.status !== 'active') {
    return { ok: false, reason: 'ACCOUNT_SUSPENDED', user };
  }
  if (!user.password_hash || !user.password_salt) {
    return { ok: false, reason: user.github_id ? 'OAUTH_ONLY' : 'NO_PASSWORD', user };
  }

  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    return { ok: false, reason: 'WRONG_PASSWORD', user };
  }

  // Upgrade legacy scrypt password hash to bcrypt transparently on login
  if (user.password_salt !== 'bcrypt' && !user.password_hash.startsWith('$2')) {
    try {
      const upgraded = hashPassword(password);
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(upgraded.hash, upgraded.salt, user.id);
      user = findUserById(user.id);
    } catch (e) {
      // Non-fatal if hash upgrade fails
    }
  }

  return { ok: true, reason: null, user };
}

function authenticateLocalUser(usernameOrEmail, password) {
  const result = authenticateLocalUserWithStatus(usernameOrEmail, password);
  return result.ok ? result.user : null;
}

function findUserByGithubId(githubId) {
  return db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(githubId));
}

function upsertGithubUser(profile) {
  if (!profile || !profile.id || !profile.login) {
    throw new Error('Incomplete GitHub user profile returned by OAuth.');
  }

  const githubId = String(profile.id).trim();
  const cleanLogin = String(profile.login).trim();
  const cleanName = (profile.name && String(profile.name).trim()) ? String(profile.name).trim().slice(0, 80) : cleanLogin;
  const cleanAvatar = profile.avatar_url || null;
  const cleanBio = typeof profile.bio === 'string' ? profile.bio.trim().slice(0, 300) : '';
  const cleanEmail = (profile.email && String(profile.email).trim()) ? String(profile.email).trim().toLowerCase() : null;

  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    inTransaction = true;

    const existing = findUserByGithubId(githubId);
    if (existing) {
      // Only update username to profile.login if no other account owns it
      const conflictUser = findUserByUsername(cleanLogin);
      const nextUsername = (!conflictUser || conflictUser.id === existing.id) ? cleanLogin : existing.username;
      const nextName = existing.is_onboarded && existing.name ? existing.name : cleanName;
      const nextBio = existing.is_onboarded && existing.bio ? existing.bio : (cleanBio || existing.bio || '');

      db.prepare(`
        UPDATE users
        SET username = ?, name = ?, avatar_url = COALESCE(?, avatar_url), bio = ?, email = COALESCE(?, email), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextUsername, nextName, cleanAvatar, nextBio, cleanEmail, existing.id);

      const updated = findUserById(existing.id);
      db.exec('COMMIT;');
      inTransaction = false;
      return { user: updated, isNew: false };
    }

    // Create new GitHub developer account (never hijack unlinked local/password accounts via username/email collision)
    const byUser = findUserByUsername(cleanLogin);
    let insertUsername = cleanLogin;
    if (byUser && String(byUser.github_id || '') !== githubId) {
      insertUsername = `${cleanLogin.slice(0, 28)}_${githubId.slice(-6)}`;
    }

    const result = db.prepare(`
      INSERT INTO users (github_id, username, name, avatar_url, bio, email, experience_level, role, status, is_onboarded)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'contributor', 'active', 0)
    `).run(githubId, insertUsername, cleanName, cleanAvatar, cleanBio, cleanEmail);

    const created = findUserById(result.lastInsertRowid);
    db.exec('COMMIT;');
    inTransaction = false;
    return { user: created, isNew: true };
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK;'); } catch (rollbackErr) {}
    }
    throw err;
  }
}

function linkGithubAccountToUser(userId, profile) {
  if (!userId || !profile || !profile.id || !profile.login) {
    throw new Error('Incomplete GitHub user profile returned by OAuth.');
  }
  const githubId = String(profile.id).trim();
  const cleanLogin = String(profile.login).trim();
  const cleanName = (profile.name && String(profile.name).trim()) ? String(profile.name).trim().slice(0, 80) : cleanLogin;
  const cleanAvatar = profile.avatar_url || null;
  const cleanBio = typeof profile.bio === 'string' ? profile.bio.trim().slice(0, 300) : '';
  const cleanEmail = (profile.email && String(profile.email).trim()) ? String(profile.email).trim().toLowerCase() : null;

  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    inTransaction = true;

    const existingOwner = findUserByGithubId(githubId);
    if (existingOwner && existingOwner.id !== Number(userId)) {
      const conflictErr = new Error('This GitHub account is already linked to another DevNexus account.');
      conflictErr.code = 'GITHUB_ALREADY_LINKED';
      throw conflictErr;
    }

    const currentUser = findUserById(userId);
    if (!currentUser) {
      throw new Error('DevNexus user account not found.');
    }

    if (currentUser.github_id && String(currentUser.github_id) !== githubId) {
      db.prepare('DELETE FROM github_synced_repos WHERE user_id = ?').run(currentUser.id);
      db.prepare('DELETE FROM github_synced_activities WHERE user_id = ?').run(currentUser.id);
      db.prepare('DELETE FROM github_sync_states WHERE user_id = ?').run(currentUser.id);
    }

    const nextName = currentUser.is_onboarded && currentUser.name ? currentUser.name : cleanName;
    const nextBio = currentUser.is_onboarded && currentUser.bio ? currentUser.bio : (cleanBio || currentUser.bio || '');

    db.prepare(`
      UPDATE users
      SET github_id = ?,
          name = ?,
          avatar_url = COALESCE(?, avatar_url),
          bio = ?,
          email = COALESCE(email, ?),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(githubId, nextName, cleanAvatar, nextBio, cleanEmail, currentUser.id);

    const updated = findUserById(currentUser.id);
    db.exec('COMMIT;');
    inTransaction = false;
    return updated;
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK;'); } catch (rollbackErr) {}
    }
    throw err;
  }
}

function disconnectGithubAccount(userId) {
  if (!userId) return null;
  let inTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    inTransaction = true;

    db.prepare('UPDATE users SET github_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    db.prepare('DELETE FROM github_synced_repos WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM github_synced_activities WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM github_sync_states WHERE user_id = ?').run(userId);
    db.prepare("DELETE FROM streak_activities WHERE user_id = ? AND activity_type = 'github_contribution'").run(userId);
    db.prepare("DELETE FROM contributor_activities WHERE contributor_id IN (SELECT id FROM contributors WHERE user_id = ?) AND source = 'github'").run(userId);
    db.prepare("DELETE FROM daily_activity_summaries WHERE user_id = ? AND platform_activities_count = 0").run(userId);
    db.prepare(`
      UPDATE daily_activity_summaries
      SET github_contributions = 0, commits_count = 0, prs_created = 0, prs_merged = 0, prs_closed = 0,
          issues_opened = 0, issues_closed = 0, reviews_count = 0, repo_contributions = 0,
          github_points = 0, total_points = platform_points, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND platform_activities_count > 0
    `).run(userId);
    db.prepare("DELETE FROM productivity_statistics WHERE user_id = ?").run(userId);
    db.prepare("UPDATE contributors SET github_id = NULL, public_repos = 0, current_streak = 0, longest_streak = 0, total_active_days = 0 WHERE user_id = ?").run(userId);

    const updated = findUserById(userId);
    db.exec('COMMIT;');
    inTransaction = false;
    return updated;
  } catch (err) {
    if (inTransaction) {
      try { db.exec('ROLLBACK;'); } catch (rollbackErr) {}
    }
    throw err;
  }
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

// API Caching operations (keeps stale rows up to 24h for rate-limit/outage fallback)
function getCached(cacheKey, { allowStale = false, maxStaleAgeMs = 86400000 } = {}) {
  const row = db.prepare('SELECT * FROM api_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  const now = Date.now();
  const isExpired = row.expires_at < now;
  if (isExpired) {
    if (!allowStale || (now - row.expires_at) > maxStaleAgeMs) {
      if ((now - row.expires_at) > maxStaleAgeMs) {
        db.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(cacheKey);
      }
      return null;
    }
  }
  try {
    return {
      data: JSON.parse(row.response_json),
      headers: row.headers_json ? JSON.parse(row.headers_json) : {},
      cached: true,
      stale: isExpired
    };
  } catch (e) {
    return null;
  }
}

function setCache(cacheKey, data, headers = {}, ttlSeconds = 300) {
  const expiresAt = Date.now() + (ttlSeconds * 1000);
  const storedHeaders = {
    ...(headers && typeof headers === 'object' ? headers : {}),
    cachedAt: new Date().toISOString(),
    expiresAt
  };
  const ins = db.prepare(`
    INSERT INTO api_cache (cache_key, response_json, headers_json, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET response_json = excluded.response_json, headers_json = excluded.headers_json, expires_at = excluded.expires_at
  `);
  ins.run(cacheKey, JSON.stringify(data), JSON.stringify(storedHeaders), expiresAt);
}

// Contributor Leaderboard Operations
function upsertContributor({
  github_id = null,
  user_id = null,
  username,
  name = '',
  avatar_url = '',
  bio = '',
  html_url = '',
  public_repos = 0,
  followers = 0,
  current_streak = null,
  longest_streak = null,
  total_active_days = null
}) {
  const cleanUsername = (username || '').trim().toLowerCase();
  if (!cleanUsername && !user_id) return null;

  let existing = null;
  if (user_id) {
    existing = db.prepare('SELECT id FROM contributors WHERE user_id = ?').get(Number(user_id));
  }
  if (!existing && github_id && !user_id) {
    existing = db.prepare('SELECT id FROM contributors WHERE github_id = ?').get(String(github_id));
  }

  const csVal = (current_streak !== null && current_streak !== undefined) ? Math.max(0, Number(current_streak) || 0) : null;
  const lsVal = (longest_streak !== null && longest_streak !== undefined) ? Math.max(0, Number(longest_streak) || 0) : null;
  const tadVal = (total_active_days !== null && total_active_days !== undefined) ? Math.max(0, Number(total_active_days) || 0) : null;

  if (existing) {
    db.prepare(`
      UPDATE contributors
      SET github_id = COALESCE(?, github_id),
          user_id = COALESCE(?, user_id),
          username = COALESCE(NULLIF(?, ''), username),
          name = COALESCE(NULLIF(?, ''), name),
          avatar_url = COALESCE(NULLIF(?, ''), avatar_url),
          bio = COALESCE(NULLIF(?, ''), bio),
          html_url = COALESCE(NULLIF(?, ''), html_url),
          public_repos = ?,
          followers = ?,
          current_streak = COALESCE(?, current_streak),
          longest_streak = COALESCE(?, longest_streak),
          total_active_days = COALESCE(?, total_active_days),
          last_synced_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      github_id ? String(github_id) : null,
      user_id ? Number(user_id) : null,
      cleanUsername,
      name,
      avatar_url,
      bio,
      html_url,
      public_repos,
      followers,
      csVal,
      lsVal,
      tadVal,
      existing.id
    );
    return db.prepare('SELECT * FROM contributors WHERE id = ?').get(existing.id);
  }

  const ins = db.prepare(`
    INSERT INTO contributors (github_id, user_id, username, name, avatar_url, bio, html_url, public_repos, followers, current_streak, longest_streak, total_active_days, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const res = ins.run(
    github_id ? String(github_id) : null,
    user_id ? Number(user_id) : null,
    cleanUsername || `user_${user_id}`,
    name,
    avatar_url,
    bio,
    html_url,
    public_repos,
    followers,
    csVal || 0,
    lsVal || 0,
    tadVal || 0
  );
  return db.prepare('SELECT * FROM contributors WHERE id = ?').get(res.lastInsertRowid);
}

function replaceContributorSyncedActivities(contributorId, activities = []) {
  if (!contributorId) return 0;
  let inTx = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    inTx = true;
    db.prepare("DELETE FROM contributor_activities WHERE contributor_id = ? AND source IN ('github', 'devnexus')").run(Number(contributorId));

    const ins = db.prepare(`
      INSERT INTO contributor_activities (contributor_id, event_id, event_type, action_kind, commit_count, repo_name, action_summary, points, source, event_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `);
    let count = 0;
    for (const act of activities) {
      if (!act || !act.event_id) continue;
      const timestampIso = act.event_timestamp ? new Date(act.event_timestamp).toISOString() : new Date().toISOString();
      const r = ins.run(
        Number(contributorId),
        String(act.event_id),
        String(act.event_type || 'GitHubActivity'),
        String(act.action_kind || ''),
        Math.max(0, Number(act.commit_count) || 0),
        String(act.repo_name || ''),
        String(act.action_summary || ''),
        Math.max(0, Math.round(Number(act.points) || 0)),
        String(act.source || 'github'),
        timestampIso
      );
      if (r.changes > 0) count++;
    }
    db.exec('COMMIT;');
    inTx = false;
    return count;
  } catch (err) {
    if (inTx) {
      try { db.exec('ROLLBACK;'); } catch (e) {}
    }
    throw err;
  }
}

function recordContributorActivity(contributorId, {
  event_id,
  event_type,
  action_kind = '',
  commit_count = 0,
  repo_name = '',
  action_summary = '',
  points = 0,
  source = 'github',
  event_timestamp
}) {
  if (!contributorId || !event_id) return false;

  const timestampIso = event_timestamp ? new Date(event_timestamp).toISOString() : new Date().toISOString();

  const ins = db.prepare(`
    INSERT INTO contributor_activities (contributor_id, event_id, event_type, action_kind, commit_count, repo_name, action_summary, points, source, event_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `);
  const res = ins.run(
    contributorId,
    String(event_id),
    event_type,
    String(action_kind || ''),
    Math.max(0, Number(commit_count) || 0),
    repo_name,
    action_summary,
    points,
    source,
    timestampIso
  );
  return res.changes > 0;
}

const REGISTERED_REAL_USERS_WHERE = `
  u.status = 'active'
  AND u.role != 'admin'
  AND COALESCE(u.is_synthetic, 0) = 0
  AND LOWER(u.username) NOT LIKE 'streak_tester_%'
  AND LOWER(u.username) NOT LIKE 'freeze_user_%'
  AND LOWER(u.username) NOT LIKE 'user_alpha_%'
  AND LOWER(u.username) NOT LIKE 'user_beta_%'
  AND LOWER(u.username) NOT LIKE 'sync_alpha_%'
  AND LOWER(u.username) NOT LIKE 'sync_beta_%'
  AND LOWER(u.username) NOT LIKE 'test_dev_%'
  AND LOWER(u.username) NOT IN ('test-navigator', 'test_regular_contributor', 'readiness_browser_test', 'unique_other_user_1')
  AND LOWER(u.username) NOT LIKE 'signup_qa_%'
  AND LOWER(u.username) NOT LIKE 'saanvi_inc_%'
  AND LOWER(u.username) NOT LIKE 'ghc_%'
  AND LOWER(u.username) NOT LIKE 'ghb_%'
  AND LOWER(u.username) NOT LIKE 'gh_zero_%'
  AND LOWER(u.username) NOT LIKE 'gh_pub_%'
  AND LOWER(u.username) NOT LIKE 'gh_mix_%'
  AND LOWER(u.username) NOT LIKE 'gh_large_%'
  AND LOWER(COALESCE(u.name, '')) NOT LIKE 'acct %'
`;

function resolveLeaderboardPeriodBounds(time = 'all-time', now = new Date()) {
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const normalizedTime = String(time || 'all-time').toLowerCase();
  const todayEndIso = now.toISOString();

  if (normalizedTime === 'this-week' || normalizedTime === 'weekly') {
    const startMs = Date.UTC(utcYear, utcMonth, now.getUTCDate() - 6);
    const prevStartMs = Date.UTC(utcYear, utcMonth, now.getUTCDate() - 13);
    return {
      normalizedTime: 'this-week',
      startIso: new Date(startMs).toISOString(),
      prevStartIso: new Date(prevStartMs).toISOString(),
      prevEndIso: new Date(startMs).toISOString(),
      eligibleDays: 7
    };
  }
  if (normalizedTime === 'this-month' || normalizedTime === 'monthly') {
    const currStart = new Date(Date.UTC(utcYear, utcMonth, 1));
    const prevStart = new Date(Date.UTC(utcYear, utcMonth - 1, 1));
    const daysElapsed = Math.max(1, now.getUTCDate());
    return {
      normalizedTime: 'this-month',
      startIso: currStart.toISOString(),
      prevStartIso: prevStart.toISOString(),
      prevEndIso: currStart.toISOString(),
      eligibleDays: daysElapsed
    };
  }
  if (normalizedTime === 'this-quarter' || normalizedTime === 'quarterly') {
    const qStartMonth = Math.floor(utcMonth / 3) * 3;
    const currStart = new Date(Date.UTC(utcYear, qStartMonth, 1));
    const prevQStart = qStartMonth === 0
      ? new Date(Date.UTC(utcYear - 1, 9, 1))
      : new Date(Date.UTC(utcYear, qStartMonth - 3, 1));
    return {
      normalizedTime: 'quarterly',
      startIso: currStart.toISOString(),
      prevStartIso: prevQStart.toISOString(),
      prevEndIso: currStart.toISOString(),
      eligibleDays: Math.max(1, Math.floor((now.getTime() - currStart.getTime()) / 86400000) + 1)
    };
  }
  if (normalizedTime === 'this-year' || normalizedTime === 'yearly') {
    const currStart = new Date(Date.UTC(utcYear, 0, 1));
    const prevStart = new Date(Date.UTC(utcYear - 1, 0, 1));
    return {
      normalizedTime: 'yearly',
      startIso: currStart.toISOString(),
      prevStartIso: prevStart.toISOString(),
      prevEndIso: currStart.toISOString(),
      eligibleDays: Math.max(1, Math.floor((now.getTime() - currStart.getTime()) / 86400000) + 1)
    };
  }
  // all-time: compare trailing 30d vs prior 30d for Rising Stars velocity; eligibleDays spans earliest activity or current year
  const thirtyAgo = new Date(Date.UTC(utcYear, utcMonth, now.getUTCDate() - 29)).toISOString();
  const sixtyAgo = new Date(Date.UTC(utcYear, utcMonth, now.getUTCDate() - 59)).toISOString();
  const yearStart = new Date(Date.UTC(utcYear, 0, 1));
  return {
    normalizedTime: 'all-time',
    startIso: null,
    prevStartIso: sixtyAgo,
    prevEndIso: thirtyAgo,
    currRiseStartIso: thirtyAgo,
    eligibleDays: Math.max(1, Math.floor((now.getTime() - yearStart.getTime()) / 86400000) + 1),
    todayEndIso
  };
}

function getLeaderboard({
  category = 'top',
  time = 'all-time',
  search = '',
  page = 1,
  perPage = 10
} = {}) {
  const now = new Date();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const quarterStartMonth = Math.floor(utcMonth / 3) * 3;
  const quarterStart = new Date(Date.UTC(utcYear, quarterStartMonth, 1)).toISOString();
  const yearStart = new Date(Date.UTC(utcYear, 0, 1)).toISOString();

  const bounds = resolveLeaderboardPeriodBounds(time, now);
  const timeClause = bounds.startIso ? 'AND ca.event_timestamp >= ?' : '';
  const joinParams = bounds.startIso ? [bounds.startIso] : [];
  const riseCurrStart = bounds.currRiseStartIso || bounds.startIso || new Date(Date.UTC(utcYear, utcMonth, 1)).toISOString();

  const whereClauses = [REGISTERED_REAL_USERS_WHERE];
  const searchParams = [];
  if (search && search.trim() !== '') {
    whereClauses.push('(LOWER(u.username) LIKE ? OR LOWER(COALESCE(u.name, \'\')) LIKE ? OR LOWER(COALESCE(gss.github_username, \'\')) LIKE ?)');
    const s = `%${search.trim().toLowerCase()}%`;
    searchParams.push(s, s, s);
  }
  const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

  let orderBy = 'total_points DESC, verified_contributions DESC, active_days DESC, (u.github_id IS NOT NULL) DESC, u.id ASC';
  if (category === 'active') {
    orderBy = 'active_days DESC, verified_contributions DESC, total_points DESC, (u.github_id IS NOT NULL) DESC, u.id ASC';
  } else if (category === 'rising') {
    orderBy = 'velocity DESC, velocity_points DESC, verified_contributions DESC, total_points DESC, u.id ASC';
  }

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safePerPage = Math.max(1, Math.min(100, parseInt(perPage, 10) || 10));
  const offset = (safePage - 1) * safePerPage;

  const validActivityScopeSql = `(ca.source = 'devnexus' OR (u.github_id IS NOT NULL AND c.github_id = u.github_id))`;

  const query = `
    SELECT
      u.id AS user_id,
      u.github_id,
      u.username AS devnexus_username,
      u.name AS devnexus_name,
      u.avatar_url AS user_avatar_url,
      u.bio AS user_bio,
      u.created_at AS user_created_at,
      c.id AS contributor_id,
      CASE WHEN u.github_id IS NOT NULL THEN (
        CASE WHEN EXISTS (SELECT 1 FROM github_sync_states gs WHERE gs.user_id = u.id AND gs.github_id = u.github_id)
          THEN (SELECT COUNT(*) FROM github_synced_repos gsr WHERE gsr.user_id = u.id AND gsr.github_id = u.github_id AND gsr.is_private = 0)
          ELSE COALESCE(c.public_repos, 0)
        END
      ) ELSE 0 END AS public_repos,
      c.followers,
      c.last_synced_at,
      gss.github_username,
      gss.last_synced_at AS state_last_synced_at,
      COALESCE(us.current_streak, 0) AS current_streak,
      COALESCE(us.longest_streak, 0) AS longest_streak,
      COALESCE(SUM(CASE WHEN ${validActivityScopeSql} THEN ca.points ELSE 0 END), 0) AS total_points,
      COUNT(CASE WHEN ${validActivityScopeSql} THEN ca.id ELSE NULL END) AS activity_count,
      COALESCE(SUM(CASE WHEN ${validActivityScopeSql} THEN (CASE WHEN ca.commit_count > 1 THEN ca.commit_count ELSE 1 END) ELSE 0 END), 0) AS verified_contributions,
      SUM(CASE WHEN ${validActivityScopeSql} AND ca.event_type IN ('PullRequestEvent', 'PullRequestSearch') AND ca.action_kind != 'pr_closed' THEN 1 ELSE 0 END) AS prs_count,
      SUM(CASE WHEN ${validActivityScopeSql} AND (ca.action_kind = 'pr_created' OR (ca.event_type = 'PullRequestEvent' AND LOWER(ca.action_summary) LIKE 'opened%')) THEN 1 ELSE 0 END) AS prs_created,
      SUM(CASE WHEN ${validActivityScopeSql} AND (ca.action_kind = 'pr_merged' OR (ca.event_type = 'PullRequestEvent' AND LOWER(ca.action_summary) LIKE 'merged%')) THEN 1 ELSE 0 END) AS prs_merged,
      SUM(CASE WHEN ${validActivityScopeSql} AND ca.event_type IN ('PushEvent', 'CommitSearch') THEN (CASE WHEN ca.commit_count > 0 THEN ca.commit_count ELSE 1 END) ELSE 0 END) AS commits_count,
      SUM(CASE WHEN ${validActivityScopeSql} AND ca.event_type IN ('IssuesEvent', 'IssueSearch') THEN 1 ELSE 0 END) AS issues_count,
      SUM(CASE WHEN ${validActivityScopeSql} AND (ca.action_kind = 'issue_closed' OR (ca.event_type IN ('IssuesEvent', 'IssueSearch') AND LOWER(ca.action_summary) LIKE 'closed%')) THEN 1 ELSE 0 END) AS issues_resolved,
      SUM(CASE WHEN ${validActivityScopeSql} AND (ca.action_kind = 'pr_review' OR ca.event_type IN ('PullRequestReviewEvent', 'PullRequestReviewCommentEvent', 'PullRequestReviewSearch')) THEN 1 ELSE 0 END) AS reviews_count,
      COUNT(DISTINCT CASE WHEN ${validActivityScopeSql} AND ca.source != 'non_qualifying' THEN substr(ca.event_timestamp, 1, 10) END) AS active_days,
      MIN(CASE WHEN ${validActivityScopeSql} THEN substr(ca.event_timestamp, 1, 10) END) AS earliest_activity_date,
      SUM(CASE WHEN ${validActivityScopeSql} AND ca.source = 'devnexus' THEN ca.points ELSE 0 END) AS devnexus_points,
      SUM(CASE WHEN ${validActivityScopeSql} AND ca.source = 'github' THEN ca.points ELSE 0 END) AS github_points,
      (
        COALESCE((SELECT SUM(CASE WHEN commit_count > 1 THEN commit_count ELSE 1 END) FROM contributor_activities ca2 WHERE ca2.contributor_id = c.id AND (ca2.source = 'devnexus' OR (u.github_id IS NOT NULL AND c.github_id = u.github_id)) AND ca2.event_timestamp >= ?), 0)
        -
        COALESCE((SELECT SUM(CASE WHEN commit_count > 1 THEN commit_count ELSE 1 END) FROM contributor_activities ca2 WHERE ca2.contributor_id = c.id AND (ca2.source = 'devnexus' OR (u.github_id IS NOT NULL AND c.github_id = u.github_id)) AND ca2.event_timestamp >= ? AND ca2.event_timestamp < ?), 0)
      ) AS velocity,
      (
        COALESCE((SELECT SUM(points) FROM contributor_activities ca2 WHERE ca2.contributor_id = c.id AND (ca2.source = 'devnexus' OR (u.github_id IS NOT NULL AND c.github_id = u.github_id)) AND ca2.event_timestamp >= ?), 0)
        -
        COALESCE((SELECT SUM(points) FROM contributor_activities ca2 WHERE ca2.contributor_id = c.id AND (ca2.source = 'devnexus' OR (u.github_id IS NOT NULL AND c.github_id = u.github_id)) AND ca2.event_timestamp >= ? AND ca2.event_timestamp < ?), 0)
      ) AS velocity_points
    FROM users u
    LEFT JOIN contributors c ON c.user_id = u.id
    LEFT JOIN github_sync_states gss ON (gss.user_id = u.id AND u.github_id IS NOT NULL AND gss.github_id = u.github_id)
    LEFT JOIN user_streaks us ON us.user_id = u.id
    LEFT JOIN contributor_activities ca ON (ca.contributor_id = c.id ${timeClause})
    ${whereSql}
    GROUP BY u.id
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const countQuery = `
    SELECT COUNT(*) AS count
    FROM users u
    LEFT JOIN github_sync_states gss ON (gss.user_id = u.id AND u.github_id IS NOT NULL AND gss.github_id = u.github_id)
    ${whereSql}
  `;

  const queryParams = [
    riseCurrStart,
    bounds.prevStartIso,
    bounds.prevEndIso,
    riseCurrStart,
    bounds.prevStartIso,
    bounds.prevEndIso,
    ...joinParams,
    ...searchParams,
    safePerPage,
    offset
  ];
  const rows = db.prepare(query).all(...queryParams);
  const totalCountRow = db.prepare(countQuery).get(...searchParams);
  const totalCount = totalCountRow ? totalCountRow.count : 0;
  const totalPages = Math.ceil(totalCount / safePerPage);

  const monthStartIso = new Date(Date.UTC(utcYear, utcMonth, 1)).toISOString();
  const monthEligibleDays = Math.max(1, now.getUTCDate());
  const quarterEligibleDays = Math.max(1, Math.floor((now.getTime() - Date.parse(quarterStart)) / 86400000) + 1);
  const contribIds = rows.map(r => r.contributor_id).filter(Boolean);
  const monthlyMap = new Map();
  const quarterlyMap = new Map();

  if (contribIds.length > 0) {
    const placeholders = contribIds.map(() => '?').join(',');
    const aggSql = `
      SELECT
        ca.contributor_id,
        COALESCE(SUM(ca.points), 0) AS pts,
        COALESCE(SUM(CASE WHEN ca.commit_count > 1 THEN ca.commit_count ELSE 1 END), 0) AS units,
        COUNT(DISTINCT substr(ca.event_timestamp, 1, 10)) AS active_days
      FROM contributor_activities ca
      JOIN contributors c ON c.id = ca.contributor_id
      JOIN users u ON u.id = c.user_id
      WHERE ca.contributor_id IN (${placeholders})
        AND (ca.source = 'devnexus' OR (u.github_id IS NOT NULL AND c.github_id = u.github_id))
        AND ca.event_timestamp >= ?
      GROUP BY ca.contributor_id
    `;
    const mRows = db.prepare(aggSql).all(...contribIds, monthStartIso);
    for (const mr of mRows) monthlyMap.set(mr.contributor_id, mr);
    const qRows = db.prepare(aggSql).all(...contribIds, quarterStart);
    for (const qr of qRows) quarterlyMap.set(qr.contributor_id, qr);
  }

  const round2 = v => Math.round((Number(v) || 0) * 100) / 100;

  const ranked = rows.map((r, i) => {
    const hasGithub = Boolean(r.github_id);
    const activeDays = Number(r.active_days) || 0;
    let contributorEligibleDays = bounds.eligibleDays;
    if (bounds.normalizedTime === 'all-time') {
      const earliestMs = r.earliest_activity_date
        ? Date.parse(`${r.earliest_activity_date}T00:00:00Z`)
        : (r.user_created_at ? Date.parse(String(r.user_created_at).replace(' ', 'T') + 'Z') : NaN);
      const yearStartMs = Date.parse(yearStart);
      if (!Number.isNaN(earliestMs)) {
        const refMs = Math.min(earliestMs, yearStartMs);
        contributorEligibleDays = Math.max(1, Math.floor((now.getTime() - (earliestMs < yearStartMs ? earliestMs : Math.max(yearStartMs, earliestMs))) / 86400000) + 1);
      }
    }
    const activityPercentage = activeDays === 0
      ? 0
      : Math.min(100, round2((activeDays / Math.max(1, contributorEligibleDays)) * 100));

    const mAgg = r.contributor_id ? monthlyMap.get(r.contributor_id) : null;
    const mActiveDays = mAgg ? (Number(mAgg.active_days) || 0) : 0;
    const qAgg = r.contributor_id ? quarterlyMap.get(r.contributor_id) : null;
    const qActiveDays = qAgg ? (Number(qAgg.active_days) || 0) : 0;

    const actualGithubHandle = hasGithub ? (r.github_username || r.devnexus_username) : null;

    return {
      rank: offset + i + 1,
      id: r.contributor_id || r.user_id,
      userId: r.user_id,
      githubId: hasGithub ? String(r.github_id) : null,
      githubConnected: hasGithub,
      githubUsername: actualGithubHandle,
      username: actualGithubHandle || r.devnexus_username,
      devnexusUsername: r.devnexus_username,
      name: r.devnexus_name || r.devnexus_username,
      avatarUrl: r.user_avatar_url || null,
      bio: r.user_bio || '',
      htmlUrl: hasGithub ? `https://github.com/${actualGithubHandle}` : null,
      publicRepos: hasGithub ? (Number(r.public_repos) || 0) : 0,
      followers: hasGithub ? (Number(r.followers) || 0) : 0,
      score: Number(r.total_points) || 0,
      totalPoints: Number(r.total_points) || 0,
      activityCount: Number(r.activity_count) || 0,
      verifiedContributions: Number(r.verified_contributions) || 0,
      prsCount: Number(r.prs_count) || 0,
      prsCreated: Number(r.prs_created) || 0,
      prsMerged: Number(r.prs_merged) || 0,
      commitsCount: Number(r.commits_count) || 0,
      issuesCount: Number(r.issues_count) || 0,
      issuesResolved: Number(r.issues_resolved) || 0,
      reviewsCount: Number(r.reviews_count) || 0,
      activeDays,
      eligibleDays: contributorEligibleDays,
      activityPercentage,
      currentStreak: Number(r.current_streak) || 0,
      longestStreak: Number(r.longest_streak) || 0,
      devnexusPoints: Number(r.devnexus_points) || 0,
      githubPoints: Number(r.github_points) || 0,
      velocity: Number(r.velocity) || 0,
      velocityPoints: Number(r.velocity_points) || 0,
      lastSyncedAt: hasGithub ? (r.state_last_synced_at || r.last_synced_at || null) : null,
      monthlyPerformance: {
        totalPoints: mAgg ? (Number(mAgg.pts) || 0) : 0,
        verifiedContributions: mAgg ? (Number(mAgg.units) || 0) : 0,
        activeDays: mActiveDays,
        eligibleDays: monthEligibleDays,
        activityPercentage: mActiveDays === 0 ? 0 : Math.min(100, round2((mActiveDays / monthEligibleDays) * 100))
      },
      quarterlyPerformance: {
        quarter: `Q${Math.floor(utcMonth / 3) + 1} ${utcYear}`,
        totalPoints: qAgg ? (Number(qAgg.pts) || 0) : 0,
        verifiedContributions: qAgg ? (Number(qAgg.units) || 0) : 0,
        activeDays: qActiveDays,
        eligibleDays: quarterEligibleDays,
        activityPercentage: qActiveDays === 0 ? 0 : Math.min(100, round2((qActiveDays / quarterEligibleDays) * 100))
      }
    };
  });

  return {
    contributors: ranked,
    totalCount,
    page: safePage,
    perPage: safePerPage,
    totalPages
  };
}

function getLeaderboardStats({ time = 'all-time' } = {}) {
  const bounds = resolveLeaderboardPeriodBounds(time, new Date());
  const timeClause = bounds.startIso ? 'AND ca.event_timestamp >= ?' : '';
  const params = bounds.startIso ? [bounds.startIso] : [];

  const registeredRow = db.prepare(`
    SELECT
      COUNT(*) AS registered_count,
      SUM(CASE WHEN u.github_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM contributors c JOIN contributor_activities ca ON ca.contributor_id = c.id WHERE c.user_id = u.id
      ) THEN 1 ELSE 0 END) AS verified_contributors,
      MAX(COALESCE(gss.last_synced_at, c.last_synced_at)) AS last_synced_at
    FROM users u
    LEFT JOIN contributors c ON c.user_id = u.id
    LEFT JOIN github_sync_states gss ON (gss.user_id = u.id AND u.github_id IS NOT NULL AND gss.github_id = u.github_id)
    WHERE ${REGISTERED_REAL_USERS_WHERE}
  `).get();

  const activityRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN ca.commit_count > 1 THEN ca.commit_count ELSE 1 END), 0) AS total_events,
      SUM(CASE WHEN ca.event_type IN ('PullRequestEvent', 'PullRequestSearch') AND ca.action_kind != 'pr_closed' THEN 1 ELSE 0 END) AS total_prs
    FROM contributor_activities ca
    JOIN contributors c ON c.id = ca.contributor_id
    JOIN users u ON u.id = c.user_id
    WHERE ${REGISTERED_REAL_USERS_WHERE}
      AND (ca.source = 'devnexus' OR (u.github_id IS NOT NULL AND c.github_id = u.github_id))
      ${timeClause}
  `).get(...params);

  let lastSyncedIso = registeredRow && registeredRow.last_synced_at ? String(registeredRow.last_synced_at) : null;
  if (lastSyncedIso && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(lastSyncedIso)) {
    lastSyncedIso = lastSyncedIso.replace(' ', 'T') + 'Z';
  }

  return {
    totalContributors: Number(registeredRow && registeredRow.verified_contributors) || 0,
    registeredUsersCount: Number(registeredRow && registeredRow.registered_count) || 0,
    totalEvents: Number(activityRow && activityRow.total_events) || 0,
    totalPRs: Number(activityRow && activityRow.total_prs) || 0,
    lastSyncedAt: lastSyncedIso
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
      ON CONFLICT(user_id, activity_date) DO UPDATE SET
        activity_type = CASE
          WHEN streak_activities.activity_type IN ('dashboard_visit', 'streak_page_visit', 'login', 'page_refresh', 'navigation', 'view')
            THEN excluded.activity_type
          ELSE streak_activities.activity_type
        END
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

// --- GitHub Activity Synchronization Storage (User-Isolated & Encrypted Token At Rest) ---

function getSyncEncryptionKey() {
  const secret = process.env.SESSION_SECRET || 'devnexus-local-sync-fallback-secret';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptSyncToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSyncEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSyncToken(encValue) {
  if (!encValue || typeof encValue !== 'string') return null;
  const parts = encValue.split(':');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getSyncEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

function saveUserGithubToken(userId, githubId, githubUsername, rawToken, grantedScopes = null) {
  if (!userId || !githubId || !githubUsername) return false;
  const owner = findUserById(userId);
  if (!owner || String(owner.github_id || '') !== String(githubId)) {
    return false;
  }
  const encrypted = rawToken ? encryptSyncToken(rawToken) : null;
  const cleanScopes = typeof grantedScopes === 'string' && grantedScopes.trim() !== '' ? grantedScopes.trim() : null;
  db.prepare(`
    INSERT INTO github_sync_states (user_id, github_id, github_username, access_token_enc, granted_scopes, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      github_id = excluded.github_id,
      github_username = excluded.github_username,
      access_token_enc = COALESCE(excluded.access_token_enc, github_sync_states.access_token_enc),
      granted_scopes = CASE WHEN excluded.access_token_enc IS NOT NULL THEN excluded.granted_scopes ELSE COALESCE(excluded.granted_scopes, github_sync_states.granted_scopes) END,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, String(githubId), String(githubUsername), encrypted, cleanScopes);
  return true;
}

function getUserGithubSyncCredentials(userId, githubId) {
  if (!userId || !githubId) return { token: null, grantedScopes: null };
  const row = db.prepare(`
    SELECT access_token_enc, granted_scopes
    FROM github_sync_states
    WHERE user_id = ? AND github_id = ?
    LIMIT 1
  `).get(userId, String(githubId));
  return {
    token: row && row.access_token_enc ? decryptSyncToken(row.access_token_enc) : null,
    grantedScopes: row && row.granted_scopes ? row.granted_scopes : null
  };
}

function getUserGithubSyncToken(userId, githubId) {
  return getUserGithubSyncCredentials(userId, githubId).token;
}

function clearUserGithubSyncToken(userId) {
  if (!userId) return;
  db.prepare(`
    UPDATE github_sync_states
    SET access_token_enc = NULL, granted_scopes = NULL, private_access_granted = 0, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(userId);
}

function markGithubSyncStatus(userId, githubId, githubUsername, {
  status = 'idle',
  error = null,
  rateLimit = null,
  nextAllowedSyncAt = null
} = {}) {
  if (!userId || !githubId || !githubUsername) return;
  const rlRemaining = rateLimit && Number.isFinite(Number(rateLimit.remaining)) ? Number(rateLimit.remaining) : null;
  const rlLimit = rateLimit && Number.isFinite(Number(rateLimit.limit)) ? Number(rateLimit.limit) : null;
  const rlReset = rateLimit && Number.isFinite(Number(rateLimit.resetEpoch)) ? Number(rateLimit.resetEpoch) : null;

  db.prepare(`
    INSERT INTO github_sync_states (
      user_id, github_id, github_username, last_sync_status, last_sync_error,
      rate_limit_remaining, rate_limit_limit, rate_limit_reset_epoch,
      next_allowed_sync_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      github_id = excluded.github_id,
      github_username = excluded.github_username,
      last_sync_status = excluded.last_sync_status,
      last_sync_error = excluded.last_sync_error,
      rate_limit_remaining = COALESCE(excluded.rate_limit_remaining, github_sync_states.rate_limit_remaining),
      rate_limit_limit = COALESCE(excluded.rate_limit_limit, github_sync_states.rate_limit_limit),
      rate_limit_reset_epoch = COALESCE(excluded.rate_limit_reset_epoch, github_sync_states.rate_limit_reset_epoch),
      next_allowed_sync_at = COALESCE(excluded.next_allowed_sync_at, github_sync_states.next_allowed_sync_at),
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    String(githubId),
    String(githubUsername),
    status,
    error ? String(error).slice(0, 500) : null,
    rlRemaining,
    rlLimit,
    rlReset,
    nextAllowedSyncAt || null
  );
}

function upsertGithubSyncState(userId, githubId, githubUsername, summary = {}) {
  if (!userId || !githubId || !githubUsername) return null;
  const owner = findUserById(userId);
  if (!owner || String(owner.github_id || '') !== String(githubId)) {
    throw new Error('Ownership verification failed: user does not own target GitHub ID.');
  }

  const langJson = JSON.stringify(Array.isArray(summary.languageDistribution) ? summary.languageDistribution : []);
  const rl = summary.rateLimit || null;
  const rlRemaining = rl && Number.isFinite(Number(rl.remaining)) ? Number(rl.remaining) : null;
  const rlLimit = rl && Number.isFinite(Number(rl.limit)) ? Number(rl.limit) : null;
  const rlReset = rl && Number.isFinite(Number(rl.resetEpoch)) ? Number(rl.resetEpoch) : null;
  const nowIso = summary.lastSyncedAt || new Date().toISOString();
  const nextAllowedIso = summary.nextAllowedSyncAt || new Date(Date.now() + 60 * 1000).toISOString();
  const grantedScopes = typeof summary.grantedScopes === 'string' && summary.grantedScopes.trim() !== ''
    ? summary.grantedScopes.trim()
    : null;
  const privateAccessGranted = summary.privateAccessGranted ? 1 : 0;
  const privateAccessNote = summary.privateAccessNote ? String(summary.privateAccessNote).slice(0, 500) : null;

  db.prepare(`
    INSERT INTO github_sync_states (
      user_id, github_id, github_username,
      total_repos, public_repos, private_repos,
      total_commits, commit_period_days,
      prs_created, prs_merged, issues_created, issues_closed, contributions_count,
      language_distribution, granted_scopes, private_access_granted, private_access_note,
      last_sync_status, last_sync_error,
      rate_limit_remaining, rate_limit_limit, rate_limit_reset_epoch,
      last_synced_at, next_allowed_sync_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', NULL, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      github_id = excluded.github_id,
      github_username = excluded.github_username,
      total_repos = excluded.total_repos,
      public_repos = excluded.public_repos,
      private_repos = excluded.private_repos,
      total_commits = excluded.total_commits,
      commit_period_days = excluded.commit_period_days,
      prs_created = excluded.prs_created,
      prs_merged = excluded.prs_merged,
      issues_created = excluded.issues_created,
      issues_closed = excluded.issues_closed,
      contributions_count = excluded.contributions_count,
      language_distribution = excluded.language_distribution,
      granted_scopes = COALESCE(excluded.granted_scopes, github_sync_states.granted_scopes),
      private_access_granted = excluded.private_access_granted,
      private_access_note = excluded.private_access_note,
      last_sync_status = 'success',
      last_sync_error = NULL,
      rate_limit_remaining = COALESCE(excluded.rate_limit_remaining, github_sync_states.rate_limit_remaining),
      rate_limit_limit = COALESCE(excluded.rate_limit_limit, github_sync_states.rate_limit_limit),
      rate_limit_reset_epoch = COALESCE(excluded.rate_limit_reset_epoch, github_sync_states.rate_limit_reset_epoch),
      last_synced_at = excluded.last_synced_at,
      next_allowed_sync_at = excluded.next_allowed_sync_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    String(githubId),
    String(githubUsername),
    Math.max(0, Number(summary.totalRepos) || 0),
    Math.max(0, Number(summary.publicRepos) || 0),
    Math.max(0, Number(summary.privateRepos) || 0),
    Math.max(0, Number(summary.totalCommits) || 0),
    Math.max(1, Number(summary.commitPeriodDays) || 90),
    Math.max(0, Number(summary.prsCreated) || 0),
    Math.max(0, Number(summary.prsMerged) || 0),
    Math.max(0, Number(summary.issuesCreated) || 0),
    Math.max(0, Number(summary.issuesClosed) || 0),
    Math.max(0, Number(summary.contributionsCount) || 0),
    langJson,
    grantedScopes,
    privateAccessGranted,
    privateAccessNote,
    rlRemaining,
    rlLimit,
    rlReset,
    nowIso,
    nextAllowedIso
  );

  return getUserGithubSyncState(userId, githubId);
}

function getUserGithubSyncState(userId, githubId = null) {
  if (!userId) return null;
  const query = githubId
    ? `SELECT user_id, github_id, github_username, total_repos, public_repos, private_repos,
              total_commits, commit_period_days, prs_created, prs_merged, issues_created,
              issues_closed, contributions_count, language_distribution,
              granted_scopes, private_access_granted, private_access_note,
              last_sync_status, last_sync_error, rate_limit_remaining, rate_limit_limit,
              rate_limit_reset_epoch, last_synced_at, next_allowed_sync_at, updated_at
       FROM github_sync_states WHERE user_id = ? AND github_id = ? LIMIT 1`
    : `SELECT user_id, github_id, github_username, total_repos, public_repos, private_repos,
              total_commits, commit_period_days, prs_created, prs_merged, issues_created,
              issues_closed, contributions_count, language_distribution,
              granted_scopes, private_access_granted, private_access_note,
              last_sync_status, last_sync_error, rate_limit_remaining, rate_limit_limit,
              rate_limit_reset_epoch, last_synced_at, next_allowed_sync_at, updated_at
       FROM github_sync_states WHERE user_id = ? LIMIT 1`;

  const row = githubId ? db.prepare(query).get(userId, String(githubId)) : db.prepare(query).get(userId);
  if (!row) return null;

  let languageDistribution = [];
  try {
    const parsed = JSON.parse(row.language_distribution || '[]');
    if (Array.isArray(parsed)) languageDistribution = parsed;
  } catch (e) {
    languageDistribution = [];
  }

  return {
    userId: row.user_id,
    githubId: row.github_id,
    githubUsername: row.github_username,
    totalRepos: row.total_repos || 0,
    publicRepos: row.public_repos || 0,
    privateRepos: row.private_repos || 0,
    totalCommits: row.total_commits || 0,
    commitPeriodDays: row.commit_period_days || 90,
    prsCreated: row.prs_created || 0,
    prsMerged: row.prs_merged || 0,
    issuesCreated: row.issues_created || 0,
    issuesClosed: row.issues_closed || 0,
    contributionsCount: row.contributions_count || 0,
    languageDistribution,
    grantedScopes: row.granted_scopes || null,
    privateAccessGranted: Boolean(row.private_access_granted),
    privateAccessNote: row.private_access_note || null,
    lastSyncStatus: row.last_sync_status || 'idle',
    lastSyncError: row.last_sync_error || null,
    rateLimitRemaining: row.rate_limit_remaining,
    rateLimitLimit: row.rate_limit_limit,
    rateLimitResetEpoch: row.rate_limit_reset_epoch,
    lastSyncedAt: row.last_synced_at || null,
    nextAllowedSyncAt: row.next_allowed_sync_at || null
  };
}

function replaceUserSyncedRepos(userId, githubId, repos = []) {
  if (!userId || !githubId) return 0;
  const owner = findUserById(userId);
  if (!owner || String(owner.github_id || '') !== String(githubId)) {
    throw new Error('Ownership verification failed while storing repositories.');
  }

  let inTx = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    inTx = true;

    const upsertRepo = db.prepare(`
      INSERT INTO github_synced_repos (
        user_id, github_id, repo_id, name, full_name, owner_login, owner_type, html_url, description,
        language, language_color, is_private, is_fork, stars, forks, open_issues,
        license, topics, homepage, has_issues, archived, pushed_at, updated_at, health_json, synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, repo_id) DO UPDATE SET
        github_id = excluded.github_id,
        name = excluded.name,
        full_name = excluded.full_name,
        owner_login = excluded.owner_login,
        owner_type = excluded.owner_type,
        html_url = excluded.html_url,
        description = excluded.description,
        language = excluded.language,
        language_color = excluded.language_color,
        is_private = excluded.is_private,
        is_fork = excluded.is_fork,
        stars = excluded.stars,
        forks = excluded.forks,
        open_issues = excluded.open_issues,
        license = excluded.license,
        topics = excluded.topics,
        homepage = excluded.homepage,
        has_issues = excluded.has_issues,
        archived = excluded.archived,
        pushed_at = excluded.pushed_at,
        updated_at = excluded.updated_at,
        health_json = excluded.health_json,
        synced_at = CURRENT_TIMESTAMP
    `);

    const seenRepoIds = new Set();
    let upsertedCount = 0;

    for (const r of repos) {
      const repoIdKey = (r.id !== undefined && r.id !== null)
        ? String(r.id)
        : String(r.repoId || r.fullName || '');
      if (!repoIdKey || seenRepoIds.has(repoIdKey)) continue;
      seenRepoIds.add(repoIdKey);

      const fullName = String(r.fullName || r.name || '');
      const inferredOwner = fullName.includes('/') ? fullName.split('/')[0] : '';
      const ownerLogin = String(r.ownerLogin || inferredOwner || '');
      const ownerType = String(r.ownerType || 'User');

      upsertRepo.run(
        userId,
        String(githubId),
        repoIdKey,
        String(r.name || ''),
        fullName,
        ownerLogin,
        ownerType,
        String(r.htmlUrl || ''),
        String(r.description || ''),
        String(r.language || 'Other'),
        String(r.languageColor || '#818CF8'),
        r.isPrivate ? 1 : 0,
        r.isFork ? 1 : 0,
        Math.max(0, Number(r.stars) || 0),
        Math.max(0, Number(r.forks) || 0),
        Math.max(0, Number(r.openIssues) || 0),
        r.license || null,
        JSON.stringify(Array.isArray(r.topics) ? r.topics : []),
        String(r.homepage || ''),
        r.hasIssues === false ? 0 : 1,
        r.archived ? 1 : 0,
        r.pushedAt || null,
        r.updatedAtExact || r.updatedAt || null,
        r.health ? JSON.stringify(r.health) : null
      );
      upsertedCount++;
    }

    if (seenRepoIds.size === 0) {
      db.prepare('DELETE FROM github_synced_repos WHERE user_id = ?').run(userId);
    } else {
      const existingRows = db.prepare('SELECT id, github_id, repo_id FROM github_synced_repos WHERE user_id = ?').all(userId);
      const delById = db.prepare('DELETE FROM github_synced_repos WHERE id = ?');
      const targetGhStr = String(githubId);
      for (const ex of existingRows) {
        if (String(ex.github_id) !== targetGhStr || !seenRepoIds.has(String(ex.repo_id))) {
          delById.run(ex.id);
        }
      }
    }

    db.exec('COMMIT;');
    inTx = false;
    return upsertedCount;
  } catch (err) {
    if (inTx) {
      try { db.exec('ROLLBACK;'); } catch (e) {}
    }
    throw err;
  }
}

function getUserSyncedRepoCounts(userId, githubId = null) {
  if (!userId) return { total: 0, publicCount: 0, privateCount: 0 };
  const row = githubId
    ? db.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN is_private = 0 THEN 1 ELSE 0 END), 0) AS publicCount,
               COALESCE(SUM(CASE WHEN is_private = 1 THEN 1 ELSE 0 END), 0) AS privateCount
        FROM github_synced_repos
        WHERE user_id = ? AND github_id = ?
      `).get(userId, String(githubId))
    : db.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN is_private = 0 THEN 1 ELSE 0 END), 0) AS publicCount,
               COALESCE(SUM(CASE WHEN is_private = 1 THEN 1 ELSE 0 END), 0) AS privateCount
        FROM github_synced_repos
        WHERE user_id = ?
      `).get(userId);

  return {
    total: Number(row && row.total) || 0,
    publicCount: Number(row && row.publicCount) || 0,
    privateCount: Number(row && row.privateCount) || 0
  };
}

function getUserSyncedRepos(userId, githubId, { includePrivate = false, limit = null, offset = 0 } = {}) {
  if (!userId || !githubId) return [];
  const parsedLimit = (limit === null || limit === undefined || limit === '') ? null : parseInt(limit, 10);
  const safeLimit = parsedLimit && Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(5000, parsedLimit)
    : 5000;
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  const privacyClause = includePrivate ? '' : 'AND is_private = 0';

  const rows = db.prepare(`
    SELECT *
    FROM github_synced_repos
    WHERE user_id = ? AND github_id = ? ${privacyClause}
    ORDER BY COALESCE(pushed_at, updated_at) DESC, stars DESC
    LIMIT ? OFFSET ?
  `).all(userId, String(githubId), safeLimit, safeOffset);

  return rows.map(row => {
    let topics = [];
    let health = null;
    try { topics = JSON.parse(row.topics || '[]'); } catch (e) { topics = []; }
    try { health = row.health_json ? JSON.parse(row.health_json) : null; } catch (e) { health = null; }
    const fullName = row.full_name || '';
    const inferredOwner = fullName.includes('/') ? fullName.split('/')[0] : '';
    return {
      id: row.repo_id,
      name: row.name,
      fullName,
      ownerLogin: row.owner_login || inferredOwner,
      ownerType: row.owner_type || 'User',
      htmlUrl: row.html_url,
      description: row.description || 'No description provided.',
      language: row.language || 'Other',
      languageColor: row.language_color || '#818CF8',
      isPrivate: Boolean(row.is_private),
      isFork: Boolean(row.is_fork),
      stars: row.stars || 0,
      forks: row.forks || 0,
      openIssues: row.open_issues || 0,
      license: row.license || null,
      topics,
      homepage: row.homepage || '',
      hasIssues: Boolean(row.has_issues),
      archived: Boolean(row.archived),
      pushedAt: row.pushed_at || null,
      updatedAt: row.updated_at || null,
      updatedAtExact: row.updated_at || null,
      health
    };
  });
}

function upsertUserSyncedActivities(userId, githubId, activities = []) {
  if (!userId || !githubId || !Array.isArray(activities) || activities.length === 0) return 0;
  const owner = findUserById(userId);
  if (!owner || String(owner.github_id || '') !== String(githubId)) {
    throw new Error('Ownership verification failed while storing activities.');
  }

  let inTx = false;
  let inserted = 0;
  try {
    db.exec('BEGIN IMMEDIATE;');
    inTx = true;

    const findByCanonical = db.prepare(`
      SELECT id FROM github_synced_activities WHERE user_id = ? AND canonical_key = ? LIMIT 1
    `);

    const updateById = db.prepare(`
      UPDATE github_synced_activities
      SET repo_id = COALESCE(NULLIF(?, ''), repo_id),
          action = ?,
          title = ?,
          target_url = ?,
          commit_count = MAX(commit_count, ?),
          branch_or_tag = COALESCE(NULLIF(?, ''), branch_or_tag),
          event_timestamp = ?,
          activity_date = ?,
          points = MAX(points, ?),
          is_private = ?
      WHERE id = ?
    `);

    const stmt = db.prepare(`
      INSERT INTO github_synced_activities (
        user_id, github_id, event_id, canonical_key, category, event_type, action, title,
        repo_id, repo_name, repo_url, target_url, commit_count, branch_or_tag, event_timestamp, activity_date, points, source, is_private
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, event_id) DO UPDATE SET
        canonical_key = COALESCE(excluded.canonical_key, github_synced_activities.canonical_key),
        repo_id = COALESCE(NULLIF(excluded.repo_id, ''), github_synced_activities.repo_id),
        action = excluded.action,
        title = excluded.title,
        target_url = excluded.target_url,
        commit_count = MAX(github_synced_activities.commit_count, excluded.commit_count),
        branch_or_tag = COALESCE(NULLIF(excluded.branch_or_tag, ''), github_synced_activities.branch_or_tag),
        event_timestamp = excluded.event_timestamp,
        activity_date = excluded.activity_date,
        points = MAX(github_synced_activities.points, excluded.points),
        source = COALESCE(excluded.source, github_synced_activities.source),
        is_private = excluded.is_private
    `);

    for (const act of activities) {
      if (!act || !act.eventId) continue;
      const tsIso = act.eventTimestamp ? new Date(act.eventTimestamp).toISOString() : new Date().toISOString();
      const actDate = (act.activityDate && /^\d{4}-\d{2}-\d{2}$/.test(String(act.activityDate)))
        ? String(act.activityDate)
        : tsIso.slice(0, 10);
      const canonical = act.canonicalKey ? String(act.canonicalKey) : null;
      const pts = Math.max(0, Number(act.points) || 0);
      const cCount = Math.max(0, Number(act.commitCount) || 0);

      if (canonical) {
        const existingCanon = findByCanonical.get(userId, canonical);
        if (existingCanon) {
          updateById.run(
            String(act.repoId || ''),
            String(act.action || ''),
            String(act.title || 'GitHub activity').slice(0, 280),
            String(act.targetUrl || act.repoUrl || ''),
            cCount,
            String(act.branchOrTag || ''),
            tsIso,
            actDate,
            pts,
            act.isPrivate ? 1 : 0,
            existingCanon.id
          );
          continue;
        }
      }

      const res = stmt.run(
        userId,
        String(githubId),
        String(act.eventId),
        canonical,
        String(act.category || 'activity'),
        String(act.eventType || 'GitHubEvent'),
        String(act.action || ''),
        String(act.title || 'GitHub activity').slice(0, 280),
        String(act.repoId || ''),
        String(act.repoName || ''),
        String(act.repoUrl || ''),
        String(act.targetUrl || act.repoUrl || ''),
        cCount,
        String(act.branchOrTag || ''),
        tsIso,
        actDate,
        pts,
        String(act.source || 'github'),
        act.isPrivate ? 1 : 0
      );
      if (res.changes > 0) inserted++;
    }

    db.exec('COMMIT;');
    inTx = false;
    return inserted;
  } catch (err) {
    if (inTx) {
      try { db.exec('ROLLBACK;'); } catch (e) {}
    }
    throw err;
  }
}

function getAllUserSyncedActivities(userId, githubId = null, {
  includePrivate = true,
  fromDate = null,
  toDate = null,
  category = 'all',
  repoName = null,
  limit = null,
  offset = 0
} = {}) {
  if (!userId) return [];
  const clauses = ['user_id = ?'];
  const params = [Number(userId)];

  if (githubId) {
    clauses.push('github_id = ?');
    params.push(String(githubId));
  }
  if (!includePrivate) {
    clauses.push('is_private = 0');
  }
  if (fromDate) {
    clauses.push('COALESCE(activity_date, substr(event_timestamp, 1, 10)) >= ?');
    params.push(String(fromDate).slice(0, 10));
  }
  if (toDate) {
    clauses.push('COALESCE(activity_date, substr(event_timestamp, 1, 10)) <= ?');
    params.push(String(toDate).slice(0, 10));
  }
  if (category && category !== 'all') {
    clauses.push('category = ?');
    params.push(String(category));
  }
  if (repoName) {
    clauses.push('LOWER(repo_name) = LOWER(?)');
    params.push(String(repoName));
  }

  let limitClause = '';
  if (limit !== null && limit !== undefined) {
    const safeLimit = Math.max(1, Math.min(5000, parseInt(limit, 10) || 100));
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
    limitClause = 'LIMIT ? OFFSET ?';
    params.push(safeLimit, safeOffset);
  }

  const rows = db.prepare(`
    SELECT *
    FROM github_synced_activities
    WHERE ${clauses.join(' AND ')}
    ORDER BY event_timestamp DESC, id DESC
    ${limitClause}
  `).all(...params);

  return rows.map(row => ({
    id: row.event_id,
    canonicalKey: row.canonical_key || null,
    category: row.category,
    eventType: row.event_type,
    action: row.action,
    title: row.title,
    repoId: row.repo_id || '',
    repoName: row.repo_name,
    repoUrl: row.repo_url,
    targetUrl: row.target_url,
    commitCount: row.commit_count || 0,
    branchOrTag: row.branch_or_tag || '',
    eventTimestamp: row.event_timestamp,
    activityDate: row.activity_date || (row.event_timestamp ? String(row.event_timestamp).slice(0, 10) : ''),
    points: row.points || 0,
    source: row.source || 'github',
    isPrivate: Boolean(row.is_private)
  }));
}

function getUserSyncedActivities(userId, githubId, { includePrivate = false, category = 'all', limit = 20, offset = 0 } = {}) {
  if (!userId || !githubId) return [];
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  const privacyClause = includePrivate ? '' : 'AND is_private = 0';
  const hasCat = category && category !== 'all';
  const catClause = hasCat ? 'AND category = ?' : '';
  const params = hasCat
    ? [userId, String(githubId), String(category), safeLimit, safeOffset]
    : [userId, String(githubId), safeLimit, safeOffset];

  const rows = db.prepare(`
    SELECT *
    FROM github_synced_activities
    WHERE user_id = ? AND github_id = ? ${privacyClause} ${catClause}
    ORDER BY event_timestamp DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params);

  return rows.map(row => ({
    id: row.event_id,
    canonicalKey: row.canonical_key || null,
    category: row.category,
    eventType: row.event_type,
    action: row.action,
    title: row.title,
    repoId: row.repo_id || '',
    repoName: row.repo_name,
    repoUrl: row.repo_url,
    targetUrl: row.target_url,
    commitCount: row.commit_count || 0,
    branchOrTag: row.branch_or_tag || '',
    eventTimestamp: row.event_timestamp,
    activityDate: row.activity_date || (row.event_timestamp ? String(row.event_timestamp).slice(0, 10) : ''),
    points: row.points || 0,
    source: row.source || 'github',
    isPrivate: Boolean(row.is_private)
  }));
}

function getScheduledGithubSyncUsers({ limit = 25 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 25));
  return db.prepare(`
    SELECT u.id, u.github_id, u.username, s.last_synced_at, s.next_allowed_sync_at, s.rate_limit_reset_epoch
    FROM users u
    LEFT JOIN github_sync_states s ON u.id = s.user_id
    WHERE u.github_id IS NOT NULL AND u.status = 'active'
    ORDER BY CASE WHEN s.last_synced_at IS NULL THEN 0 ELSE 1 END ASC, s.last_synced_at ASC
    LIMIT ?
  `).all(safeLimit);
}

function getSyncedUsersNeedingLeaderboardSync(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  return db.prepare(`
    SELECT DISTINCT gss.user_id
    FROM github_sync_states gss
    JOIN users u ON u.id = gss.user_id
    LEFT JOIN contributors c ON c.user_id = gss.user_id
    WHERE ${REGISTERED_REAL_USERS_WHERE}
      AND u.github_id IS NOT NULL
      AND (c.id IS NULL OR datetime(c.last_synced_at) < datetime(gss.last_synced_at))
    LIMIT ?
  `).all(safeLimit).map(r => r.user_id);
}

function getLeaderboardSyntheticAudit() {
  const excludedAccounts = db.prepare(`
    SELECT id, username, name, email, role, status, github_id, COALESCE(is_synthetic, 0) AS is_synthetic, created_at
    FROM users u
    WHERE NOT (${REGISTERED_REAL_USERS_WHERE})
    ORDER BY id DESC
    LIMIT 100
  `).all();
  const realAccounts = db.prepare(`
    SELECT id, username, name, email, github_id, status, created_at
    FROM users u
    WHERE ${REGISTERED_REAL_USERS_WHERE}
    ORDER BY id ASC
  `).all();
  return {
    realUsersCount: realAccounts.length,
    excludedCount: db.prepare(`SELECT COUNT(*) AS c FROM users u WHERE NOT (${REGISTERED_REAL_USERS_WHERE})`).get().c,
    realAccounts,
    excludedSample: excludedAccounts
  };
}

// =============================================================================
// Scoring Rules, Platform Activities, Daily Summaries & Productivity Statistics
// =============================================================================

function getAllScoringRules() {
  return db.prepare(`
    SELECT rule_key, source, label, points, description, is_active, updated_at
    FROM scoring_rules
    ORDER BY source ASC, points DESC, rule_key ASC
  `).all();
}

function upsertScoringRule(ruleKey, { source = 'github', label = '', points = 0, description = '', isActive = 1 } = {}) {
  if (!ruleKey) throw new Error('ruleKey is required');
  db.prepare(`
    INSERT INTO scoring_rules (rule_key, source, label, points, description, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(rule_key) DO UPDATE SET
      points = excluded.points,
      label = CASE WHEN excluded.label != '' THEN excluded.label ELSE scoring_rules.label END,
      description = CASE WHEN excluded.description != '' THEN excluded.description ELSE scoring_rules.description END,
      is_active = excluded.is_active,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    String(ruleKey),
    String(source || 'github'),
    String(label || ruleKey),
    Math.max(0, Math.round(Number(points) || 0)),
    String(description || ''),
    isActive ? 1 : 0
  );
  return db.prepare('SELECT * FROM scoring_rules WHERE rule_key = ?').get(String(ruleKey));
}

function recordPlatformActivityRow({
  userId,
  uniqueKey,
  activityType,
  referenceId = '',
  title,
  points = 0,
  activityDate,
  eventTimestamp,
  metadata = {}
}) {
  if (!userId || !uniqueKey || !activityType || !title) {
    return { inserted: false, row: null };
  }
  const tsIso = eventTimestamp ? new Date(eventTimestamp).toISOString() : new Date().toISOString();
  const dateKey = activityDate ? String(activityDate).slice(0, 10) : tsIso.slice(0, 10);
  const metaJson = JSON.stringify(metadata || {});

  const res = db.prepare(`
    INSERT INTO platform_activities (
      user_id, unique_key, activity_type, reference_id, title, points, activity_date, event_timestamp, metadata_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, unique_key) DO NOTHING
  `).run(
    Number(userId),
    String(uniqueKey),
    String(activityType),
    String(referenceId || ''),
    String(title),
    Math.max(0, Math.round(Number(points) || 0)),
    dateKey,
    tsIso,
    metaJson
  );

  const row = db.prepare('SELECT * FROM platform_activities WHERE user_id = ? AND unique_key = ?').get(Number(userId), String(uniqueKey));
  return { inserted: res.changes > 0, row };
}

function getUserPlatformActivities(userId, { fromDate = null, toDate = null, activityType = null, limit = 500, offset = 0 } = {}) {
  if (!userId) return [];
  const clauses = ['user_id = ?'];
  const params = [Number(userId)];

  if (fromDate) {
    clauses.push('activity_date >= ?');
    params.push(String(fromDate).slice(0, 10));
  }
  if (toDate) {
    clauses.push('activity_date <= ?');
    params.push(String(toDate).slice(0, 10));
  }
  if (activityType && activityType !== 'all') {
    clauses.push('activity_type = ?');
    params.push(String(activityType));
  }

  const safeLimit = Math.max(1, Math.min(2000, parseInt(limit, 10) || 500));
  const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
  params.push(safeLimit, safeOffset);

  return db.prepare(`
    SELECT *
    FROM platform_activities
    WHERE ${clauses.join(' AND ')}
    ORDER BY event_timestamp DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params).map(r => ({
    id: r.id,
    userId: r.user_id,
    uniqueKey: r.unique_key,
    activityType: r.activity_type,
    referenceId: r.reference_id || '',
    title: r.title,
    points: Number(r.points) || 0,
    activityDate: r.activity_date,
    eventTimestamp: r.event_timestamp,
    metadata: (() => { try { return JSON.parse(r.metadata_json || '{}'); } catch (e) { return {}; } })(),
    createdAt: r.created_at
  }));
}

function replaceUserDailyActivitySummaries(userId, summaries = []) {
  if (!userId) return 0;
  let inTx = false;
  try {
    db.exec('BEGIN IMMEDIATE;');
    inTx = true;
    db.prepare('DELETE FROM daily_activity_summaries WHERE user_id = ?').run(Number(userId));

    const ins = db.prepare(`
      INSERT INTO daily_activity_summaries (
        user_id, summary_date, github_contributions, commits_count, prs_created, prs_merged, prs_closed,
        issues_opened, issues_closed, reviews_count, repo_contributions, platform_activities_count,
        github_points, platform_points, total_points, is_qualifying_day, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    let count = 0;
    for (const s of summaries) {
      if (!s || !s.summaryDate) continue;
      ins.run(
        Number(userId),
        String(s.summaryDate).slice(0, 10),
        Number(s.githubContributions) || 0,
        Number(s.commitsCount) || 0,
        Number(s.prsCreated) || 0,
        Number(s.prsMerged) || 0,
        Number(s.prsClosed) || 0,
        Number(s.issuesOpened) || 0,
        Number(s.issuesClosed) || 0,
        Number(s.reviewsCount) || 0,
        Number(s.repoContributions) || 0,
        Number(s.platformActivitiesCount) || 0,
        Number(s.githubPoints) || 0,
        Number(s.platformPoints) || 0,
        Number(s.totalPoints) || 0,
        s.isQualifyingDay === 0 ? 0 : 1
      );
      count++;
    }
    db.exec('COMMIT;');
    inTx = false;
    return count;
  } catch (err) {
    if (inTx) {
      try { db.exec('ROLLBACK;'); } catch (e) {}
    }
    throw err;
  }
}

function getUserDailyActivitySummaries(userId, { fromDate = null, toDate = null } = {}) {
  if (!userId) return [];
  const clauses = ['user_id = ?'];
  const params = [Number(userId)];
  if (fromDate) {
    clauses.push('summary_date >= ?');
    params.push(String(fromDate).slice(0, 10));
  }
  if (toDate) {
    clauses.push('summary_date <= ?');
    params.push(String(toDate).slice(0, 10));
  }
  return db.prepare(`
    SELECT * FROM daily_activity_summaries
    WHERE ${clauses.join(' AND ')}
    ORDER BY summary_date DESC
  `).all(...params);
}

function upsertUserProductivityStatistic(userId, stat) {
  if (!userId || !stat || !stat.periodType || !stat.periodKey) return;
  db.prepare(`
    INSERT INTO productivity_statistics (
      user_id, period_type, period_key, start_date, end_date,
      active_days, eligible_days, activity_percentage,
      total_contributions, platform_activities_count, commits_count,
      prs_created, prs_merged, issues_opened, issues_closed, reviews_count,
      github_points, platform_points, contribution_points, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, period_type, period_key) DO UPDATE SET
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      active_days = excluded.active_days,
      eligible_days = excluded.eligible_days,
      activity_percentage = excluded.activity_percentage,
      total_contributions = excluded.total_contributions,
      platform_activities_count = excluded.platform_activities_count,
      commits_count = excluded.commits_count,
      prs_created = excluded.prs_created,
      prs_merged = excluded.prs_merged,
      issues_opened = excluded.issues_opened,
      issues_closed = excluded.issues_closed,
      reviews_count = excluded.reviews_count,
      github_points = excluded.github_points,
      platform_points = excluded.platform_points,
      contribution_points = excluded.contribution_points,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    Number(userId),
    String(stat.periodType),
    String(stat.periodKey),
    String(stat.startDate),
    String(stat.endDate),
    Number(stat.activeDays) || 0,
    Number(stat.eligibleDays) || 0,
    Number(stat.activityPercentage) || 0,
    Number(stat.totalContributions) || 0,
    Number(stat.platformActivitiesCount) || 0,
    Number(stat.commitsCount) || 0,
    Number(stat.prsCreated) || 0,
    Number(stat.prsMerged) || 0,
    Number(stat.issuesOpened) || 0,
    Number(stat.issuesClosed) || 0,
    Number(stat.reviewsCount) || 0,
    Number(stat.githubPoints) || 0,
    Number(stat.platformPoints) || 0,
    Number(stat.contributionPoints) || 0
  );
}

function getUserProductivityStatistics(userId, { periodType = null } = {}) {
  if (!userId) return [];
  if (periodType) {
    return db.prepare(`
      SELECT * FROM productivity_statistics
      WHERE user_id = ? AND period_type = ?
      ORDER BY period_key DESC
    `).all(Number(userId), String(periodType));
  }
  return db.prepare(`
    SELECT * FROM productivity_statistics
    WHERE user_id = ?
    ORDER BY period_type ASC, period_key DESC
  `).all(Number(userId));
}

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  createAuthError,
  validatePasswordStrength,
  validateRegistrationInput,
  findUserById,
  findUserByUsername,
  findUserByEmail,
  findUserByGithubId,
  registerLocalUser,
  authenticateLocalUser,
  authenticateLocalUserWithStatus,
  upsertGithubUser,
  linkGithubAccountToUser,
  disconnectGithubAccount,
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
  replaceContributorSyncedActivities,
  getLeaderboard,
  getLeaderboardStats,
  getLeaderboardSyntheticAudit,
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
  hasUserBadge,
  saveUserGithubToken,
  getUserGithubSyncToken,
  getUserGithubSyncCredentials,
  clearUserGithubSyncToken,
  markGithubSyncStatus,
  upsertGithubSyncState,
  getUserGithubSyncState,
  replaceUserSyncedRepos,
  getUserSyncedRepos,
  getUserSyncedRepoCounts,
  upsertUserSyncedActivities,
  getUserSyncedActivities,
  getAllUserSyncedActivities,
  getScheduledGithubSyncUsers,
  getSyncedUsersNeedingLeaderboardSync,
  getAllScoringRules,
  upsertScoringRule,
  recordPlatformActivityRow,
  getUserPlatformActivities,
  replaceUserDailyActivitySummaries,
  getUserDailyActivitySummaries,
  upsertUserProductivityStatistic,
  getUserProductivityStatistics
};

