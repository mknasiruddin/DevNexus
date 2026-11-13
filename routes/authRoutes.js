/**
 * DevNexus Integrated Authentication Routes
 * Handles developer Sign In, Sign Up, GitHub OAuth flows, student demo login,
 * developer onboarding, and admin credential verification.
 */

const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();

const {
  isOAuthConfigured,
  getOAuthAuthorizeUrl,
  exchangeOAuthCode,
  getCallbackUrl,
  getAuthenticatedUser,
  getUserProfile
} = require('../services/githubService');

const { upsertMongoUser } = require('../models/User');

const {
  db,
  findUserByUsername,
  findUserById,
  findUserByEmail,
  hashPassword,
  verifyPassword,
  upsertGithubUser,
  findOrCreateDemoUser,
  registerLocalUser,
  authenticateLocalUser,
  updateUserProfile,
  logActivity
} = require('../db/database');

const {
  requireAuth,
  loginRateLimiter,
  recordFailedLoginAttempt,
  clearLoginAttempts
} = require('../services/authService');

const SKILL_PALETTE = {
  'JavaScript': '#f1e05a',
  'TypeScript': '#3178c6',
  'Python': '#3572A5',
  'Node.js': '#339933',
  'Go': '#00ADD8',
  'Rust': '#dea584',
  'React': '#61dafb',
  'Java': '#b07219',
  'C++': '#f34b7d',
  'Docs': '#8b949e'
};

// Login Handler
function handleGetLogin(req, res) {
  if (req.user) {
    return res.redirect(req.user.is_onboarded ? '/dashboard' : '/onboarding');
  }

  res.render('login', {
    siteName: 'DevNexus',
    activePage: 'login',
    mode: 'login',
    isOAuthConfigured: isOAuthConfigured(),
    error: req.query.error || null,
    success: req.query.success || null
  });
}

// Sign Up Handler
function handleGetSignup(req, res) {
  if (req.user) {
    return res.redirect(req.user.is_onboarded ? '/dashboard' : '/onboarding');
  }

  res.render('login', {
    siteName: 'DevNexus',
    activePage: 'signup',
    mode: 'signup',
    isOAuthConfigured: isOAuthConfigured(),
    error: req.query.error || null,
    success: req.query.success || null
  });
}

// POST /login (Local credential authentication)
function handlePostLogin(req, res) {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  if (!username || !password) {
    return res.redirect('/login?error=Please+enter+both+username+and+password');
  }

  const user = authenticateLocalUser(username, password);
  if (!user) {
    recordFailedLoginAttempt(req);
    logActivity(null, 'USER_LOGIN_FAIL', username, 'Failed user login: invalid credentials');
    return res.redirect('/login?error=Invalid+username+or+password');
  }

  clearLoginAttempts(req);
  if (req.session.regenerate) req.session.regenerate();
  req.session.userId = user.id;
  req.session.save();

  logActivity(user.id, 'USER_LOGIN', user.username, 'Authenticated via local credentials');

  if (!user.is_onboarded) {
    return res.redirect('/onboarding');
  }
  res.redirect('/dashboard');
}

// POST /signup (Local developer registration)
function handlePostSignup(req, res) {
  const username = (req.body.username || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const confirmPassword = req.body.confirmPassword || req.body.confirm_password || '';

  if (!username || !password) {
    return res.redirect('/signup?error=Username+and+password+are+required');
  }

  if (email && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
    return res.redirect('/signup?error=Please+enter+a+valid+email+address');
  }

  if (password !== confirmPassword) {
    return res.redirect('/signup?error=Passwords+do+not+match');
  }

  if (password.length < 6) {
    return res.redirect('/signup?error=Password+must+be+at+least+6+characters');
  }

  try {
    const newUser = registerLocalUser({ username, email, password });

    if (req.session.regenerate) req.session.regenerate();
    req.session.userId = newUser.id;
    req.session.save();

    logActivity(newUser.id, 'USER_SIGNUP', newUser.username, 'New developer registered via local signup');
    res.redirect('/onboarding');
  } catch (err) {
    return res.redirect('/signup?error=' + encodeURIComponent(err.message));
  }
}

// Forgot Password / Account Assistance Handler
function handleForgotPassword(req, res) {
  const identifier = (req.body && req.body.identifier ? req.body.identifier : '').trim();
  if (!identifier) {
    return res.redirect('/login?error=Please+enter+your+registered+username+or+email+address');
  }

  const matchedUser = findUserByUsername(identifier) || (identifier.includes('@') ? findUserByEmail(identifier) : null);
  logActivity(
    matchedUser ? matchedUser.id : null,
    'PASSWORD_ASSISTANCE_REQ',
    identifier,
    'Account recovery assistance requested (automated email delivery not configured; logged for admin review)'
  );

  return res.redirect('/login?success=' + encodeURIComponent(
    `Account assistance request logged for administrator review. Note: Automated email password reset is disabled in this environment—please sign in with GitHub OAuth or contact the platform administrator.`
  ));
}

router.get('/login', handleGetLogin);
router.get('/signup', handleGetSignup);
router.post('/login', loginRateLimiter, handlePostLogin);
router.post('/signup', handlePostSignup);
router.post('/forgot-password', loginRateLimiter, handleForgotPassword);

// Initiate GitHub OAuth Flow
router.get('/github', (req, res) => {
  if (!isOAuthConfigured()) {
    return res.redirect('/login?error=GitHub+OAuth+authentication+is+temporarily+unavailable.+Please+contact+the+administrator.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save();

  const authUrl = getOAuthAuthorizeUrl(state, req);
  res.redirect(authUrl);
});

// Student Demo / Offline Sign-in (Restricted to non-privileged sandbox accounts)
router.post('/demo-login', loginRateLimiter, async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_LOGIN !== 'true') {
    return res.status(403).redirect('/login?error=Demo+login+is+disabled+in+production+environments');
  }

  const username = (req.body && req.body.username ? req.body.username : '').trim().replace(/^@/, '');
  if (!username || !/^[a-zA-Z0-9_-]{2,39}$/.test(username)) {
    return res.redirect('/auth/login?error=Please+provide+a+valid+GitHub+username');
  }

  // Pre-check existing user before making any external API request to block account impersonation
  const existing = findUserByUsername(username);
  if (existing) {
    if (existing.role === 'admin' || existing.role === 'maintainer') {
      logActivity(null, 'DEMO_IMPERSONATION_BLOCKED', username, 'Blocked attempt to access privileged account via demo login');
      return res.status(403).redirect('/auth/login?error=' + encodeURIComponent('Demo sign-in cannot be used to access administrator or maintainer accounts.'));
    }
    if (existing.password_hash || existing.github_id) {
      logActivity(null, 'DEMO_IMPERSONATION_BLOCKED', username, 'Blocked attempt to access registered account via demo login');
      return res.status(403).redirect('/auth/login?error=' + encodeURIComponent('This username belongs to a registered account. Please sign in with your password or GitHub OAuth.'));
    }
    if (existing.status !== 'active') {
      return res.status(403).redirect('/auth/login?error=' + encodeURIComponent('This account has been suspended.'));
    }
  }

  try {
    const { user: ghProfile } = await getUserProfile(username);
    const localUser = findOrCreateDemoUser(username, ghProfile ? ghProfile.name : username);

    if (req.session.regenerate) req.session.regenerate();
    req.session.userId = localUser.id;
    req.session.save();

    logActivity(localUser.id, 'DEMO_LOGIN', localUser.username, 'Logged in via student demo account');

    if (!localUser.is_onboarded) {
      return res.redirect('/onboarding');
    }
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Demo login error:', err.message);
    res.redirect('/auth/login?error=' + encodeURIComponent(err.message));
  }
});

// GitHub OAuth Callback
router.get('/github/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).render('error', {
      siteName: 'DevNexus',
      activePage: 'login',
      statusCode: 400,
      title: 'GitHub Authorization Cancelled',
      message: error_description || error,
      actionUrl: '/login',
      actionText: 'Return to Sign In'
    });
  }

  if (!code) {
    return res.status(400).render('error', {
      siteName: 'DevNexus',
      activePage: 'login',
      statusCode: 400,
      title: 'Authorization Code Missing',
      message: 'No authorization code was returned by GitHub. Please retry the authorization flow.',
      actionUrl: '/login',
      actionText: 'Return to Sign In'
    });
  }

  if (!req.session.oauthState || req.session.oauthState !== state) {
    return res.status(403).render('error', {
      siteName: 'DevNexus',
      activePage: 'login',
      statusCode: 403,
      title: 'State Mismatch (CSRF Protected)',
      message: 'State verification token did not match. Please restart the sign-in process from DevNexus.',
      actionUrl: '/login',
      actionText: 'Retry Sign In'
    });
  }

  try {
    // 1. Secure backend authorization code exchange
    const tokenData = await exchangeOAuthCode(code, req);
    const accessToken = tokenData.access_token;

    // 2. Fetch authenticated GitHub user profile
    const { user: githubProfile } = await getAuthenticatedUser(accessToken);

    // 3. Create or update user in SQLite ACID database
    const { user: localUser, isNew } = upsertGithubUser(githubProfile);

    // 4. Create or update user in MongoDB if configured
    await upsertMongoUser(githubProfile, localUser);

    // 5. Establish secure regenerated session
    if (req.session.regenerate) req.session.regenerate();
    req.session.userId = localUser.id;
    req.session.githubAccessToken = accessToken;
    req.session.githubToken = accessToken;
    req.session.oauthState = null;
    req.session.save();

    logActivity(localUser.id, isNew ? 'USER_SIGNUP' : 'USER_LOGIN', localUser.username, 'Authenticated via GitHub OAuth');

    // 6. Redirect new users to onboarding, existing users to dashboard
    if (isNew || !localUser.is_onboarded) {
      return res.redirect('/onboarding');
    }
    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth exchange error:', err.message);
    res.status(500).render('error', {
      siteName: 'DevNexus',
      activePage: 'login',
      statusCode: 500,
      title: 'OAuth Authentication Failed',
      message: err.message,
      actionUrl: '/login',
      actionText: 'Return to Sign In'
    });
  }
});

// Onboarding Handlers (Shared with top-level /onboarding)
function handleGetOnboarding(req, res) {
  if (!req.user) {
    return res.redirect('/auth/login?error=Please+sign+in+to+continue');
  }

  // Allow editing profile preferences when ?edit=1 is passed
  if (req.user.is_onboarded && req.query.edit !== '1') {
    return res.redirect('/dashboard');
  }

  let existingSkills = [];
  try {
    const parsed = JSON.parse(req.user.skills || '[]');
    existingSkills = parsed.map(s => (typeof s === 'string' ? s : s.name));
  } catch (e) {
    existingSkills = [];
  }

  res.render('onboarding', {
    user: req.user,
    existingSkills,
    isEditing: req.query.edit === '1',
    error: req.query.error || null,
    siteName: 'DevNexus',
    activePage: 'onboarding'
  });
}

function handlePostOnboarding(req, res) {
  if (!req.user) {
    return res.redirect('/auth/login?error=Please+sign+in+to+continue');
  }

  const validLevels = ['Beginner', 'Intermediate', 'Advanced'];
  const experienceLevel = validLevels.includes(req.body.experience_level) ? req.body.experience_level : 'Intermediate';
  const bio = typeof req.body.bio === 'string' ? req.body.bio.trim().slice(0, 300) : undefined;
  const name = typeof req.body.name === 'string' && req.body.name.trim() !== '' ? req.body.name.trim().slice(0, 80) : undefined;

  let rawSkills = req.body.skills || [];
  if (typeof rawSkills === 'string') {
    rawSkills = [rawSkills];
  }
  rawSkills = rawSkills.map(s => String(s).trim()).filter(Boolean);
  if (rawSkills.length === 0) {
    rawSkills = ['JavaScript'];
  }

  const formattedSkills = rawSkills.map(skillName => ({
    name: skillName,
    color: SKILL_PALETTE[skillName] || '#818cf8'
  }));

  updateUserProfile(req.user.id, {
    name,
    bio,
    skills: formattedSkills,
    experience_level: experienceLevel,
    is_onboarded: 1
  });

  logActivity(req.user.id, 'ONBOARDING_COMPLETE', req.user.username, `Updated developer profile with ${rawSkills.length} skills (${experienceLevel})`);
  res.redirect('/dashboard');
}

// Profile Update Handler (POST /profile or POST /dashboard/profile)
function handlePostProfile(req, res) {
  if (!req.user) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    return res.redirect('/login');
  }

  // Ownership check: if body specifies a userId, it must match req.user.id
  if (req.body.userId && Number(req.body.userId) !== req.user.id) {
    return res.status(403).json({ success: false, error: 'Forbidden: You can only edit your own profile.' });
  }

  const validLevels = ['Beginner', 'Intermediate', 'Advanced'];
  const experienceLevel = validLevels.includes(req.body.experience_level) ? req.body.experience_level : (req.user.experience_level || 'Intermediate');
  const bio = typeof req.body.bio === 'string' ? req.body.bio.trim().slice(0, 300) : req.user.bio;
  const name = typeof req.body.name === 'string' && req.body.name.trim() !== '' ? req.body.name.trim().slice(0, 80) : req.user.name;

  let rawSkills = req.body.skills;
  let formattedSkills = null;
  if (rawSkills !== undefined) {
    if (typeof rawSkills === 'string') {
      rawSkills = rawSkills.split(',').map(s => s.trim()).filter(Boolean);
    } else if (Array.isArray(rawSkills)) {
      rawSkills = rawSkills.map(s => String(s).trim()).filter(Boolean);
    } else {
      rawSkills = [];
    }
    if (rawSkills.length === 0) {
      rawSkills = ['JavaScript'];
    }
    formattedSkills = rawSkills.map(skillName => ({
      name: skillName,
      color: SKILL_PALETTE[skillName] || '#818cf8'
    }));
  }

  const updated = updateUserProfile(req.user.id, {
    name,
    bio,
    skills: formattedSkills,
    experience_level: experienceLevel,
    is_onboarded: 1
  });

  logActivity(req.user.id, 'PROFILE_UPDATE', req.user.username, 'Updated developer profile and skill preferences');

  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.json({ success: true, user: { id: updated.id, username: updated.username, name: updated.name, bio: updated.bio, experience_level: updated.experience_level, skills: JSON.parse(updated.skills || '[]') } });
  }

  res.redirect('/dashboard?profileUpdated=1');
}

router.get('/onboarding', handleGetOnboarding);
router.post('/onboarding', handlePostOnboarding);
router.post('/profile', requireAuth, handlePostProfile);

// Admin Form Login Handler
function handleAdminLogin(req, res) {
  const username = (req.body && req.body.username ? req.body.username : '').trim();
  const password = req.body && req.body.password ? req.body.password : '';

  if (!username || !password) {
    return res.status(403).render('admin-forbidden', {
      siteName: 'DevNexus',
      activePage: 'admin',
      isAdmin: false,
      error: 'Please provide both administrator username and password.'
    });
  }

  const user = findUserByUsername(username);

  if (!user || user.role !== 'admin' || user.status !== 'active') {
    recordFailedLoginAttempt(req);
    logActivity(null, 'ADMIN_LOGIN_FAIL', username, 'Failed admin login attempt: invalid credentials or insufficient permissions');
    return res.status(403).render('admin-forbidden', {
      siteName: 'DevNexus',
      activePage: 'admin',
      isAdmin: false,
      error: 'Invalid administrator credentials. Access forbidden.'
    });
  }

  if (!user.password_hash || !verifyPassword(password, user.password_hash, user.password_salt)) {
    recordFailedLoginAttempt(req);
    logActivity(user.id, 'ADMIN_LOGIN_FAIL', username, 'Failed admin login attempt: password mismatch');
    return res.status(403).render('admin-forbidden', {
      siteName: 'DevNexus',
      activePage: 'admin',
      isAdmin: false,
      error: 'Invalid administrator credentials. Access forbidden.'
    });
  }

  // Automatic bcrypt upgrade if stored with legacy format
  if (!user.password_hash.startsWith('$2a$') && !user.password_hash.startsWith('$2b$') && !user.password_hash.startsWith('$2y$')) {
    const { hash, salt } = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, user.id);
  }

  clearLoginAttempts(req);
  if (req.session.regenerate) req.session.regenerate();
  req.session.userId = user.id;
  req.session.save();

  logActivity(user.id, 'ADMIN_LOGIN_SUCCESS', username, 'Administrator authenticated successfully via bcrypt verification');
  res.redirect('/admin');
}

router.post('/admin/login', loginRateLimiter, handleAdminLogin);

// Logout
router.get('/logout', (req, res) => {
  if (req.user) {
    logActivity(req.user.id, 'LOGOUT', req.user.username, 'User logged out');
  }
  req.session.destroy();
  res.redirect('/');
});

// Admin Logout alias
router.get('/admin/logout', (req, res) => {
  if (req.user) {
    logActivity(req.user.id, 'LOGOUT', req.user.username, 'Admin logged out');
  }
  req.session.destroy();
  res.redirect('/admin/login');
});

module.exports = router;
module.exports.handleGetLogin = handleGetLogin;
module.exports.handleGetSignup = handleGetSignup;
module.exports.handlePostLogin = handlePostLogin;
module.exports.handlePostSignup = handlePostSignup;
module.exports.handleForgotPassword = handleForgotPassword;
module.exports.handleGetOnboarding = handleGetOnboarding;
module.exports.handlePostOnboarding = handlePostOnboarding;
module.exports.handlePostProfile = handlePostProfile;
module.exports.handleAdminLogin = handleAdminLogin;
