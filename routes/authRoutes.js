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

const { requireAuth } = require('../services/authService');

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
    logActivity(null, 'USER_LOGIN_FAIL', username, 'Failed user login: invalid credentials');
    return res.redirect('/login?error=Invalid+username+or+password');
  }

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
  const confirmPassword = req.body.confirmPassword || '';

  if (!username || !password) {
    return res.redirect('/signup?error=Username+and+password+are+required');
  }

  if (password !== confirmPassword) {
    return res.redirect('/signup?error=Passwords+do+not+match');
  }

  if (password.length < 6) {
    return res.redirect('/signup?error=Password+must+be+at+least+6+characters');
  }

  try {
    const newUser = registerLocalUser({ username, email, password });

    req.session.userId = newUser.id;
    req.session.save();

    logActivity(newUser.id, 'USER_SIGNUP', newUser.username, 'New developer registered via local signup');
    res.redirect('/onboarding');
  } catch (err) {
    return res.redirect('/signup?error=' + encodeURIComponent(err.message));
  }
}

// Forgot Password Handler
function handleForgotPassword(req, res) {
  const identifier = (req.body && req.body.identifier ? req.body.identifier : '').trim();
  if (!identifier) {
    return res.redirect('/login?error=Please+enter+your+registered+username+or+email+address');
  }
  return res.redirect('/login?success=' + encodeURIComponent(`If an account exists for "${identifier}", password assistance details have been recorded. You can also sign in instantly using GitHub OAuth.`));
}

router.get('/login', handleGetLogin);
router.get('/signup', handleGetSignup);
router.post('/login', handlePostLogin);
router.post('/signup', handlePostSignup);
router.post('/forgot-password', handleForgotPassword);

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

// Student Demo / Offline Sign-in
router.post('/demo-login', async (req, res) => {
  const username = (req.body && req.body.username ? req.body.username : '').trim();
  if (!username) {
    return res.redirect('/auth/login?error=Please+provide+a+valid+GitHub+username');
  }

  try {
    const { user: ghProfile } = await getUserProfile(username);
    const localUser = findOrCreateDemoUser(username, ghProfile ? ghProfile.name : username);

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

    // 5. Establish secure session
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

  if (req.user.is_onboarded) {
    return res.redirect('/dashboard');
  }

  res.render('onboarding', {
    user: req.user,
    siteName: 'DevNexus',
    activePage: 'onboarding'
  });
}

function handlePostOnboarding(req, res) {
  if (!req.user) {
    return res.redirect('/auth/login?error=Please+sign+in+to+continue');
  }

  const experienceLevel = req.body.experience_level || 'Intermediate';
  let rawSkills = req.body.skills || [];
  if (typeof rawSkills === 'string') {
    rawSkills = [rawSkills];
  }

  const skillPalette = {
    'JavaScript': '#f1e05a',
    'TypeScript': '#3178c6',
    'Python': '#3572A5',
    'Node.js': '#339933',
    'Go': '#00ADD8',
    'Rust': '#dea584',
    'React': '#61dafb',
    'Docs': '#8b949e'
  };

  const formattedSkills = rawSkills.map(name => ({
    name: name,
    color: skillPalette[name] || '#818cf8'
  }));

  updateUserProfile(req.user.id, {
    skills: formattedSkills,
    experience_level: experienceLevel,
    is_onboarded: 1
  });

  logActivity(req.user.id, 'ONBOARDING_COMPLETE', req.user.username, `Completed onboarding with ${rawSkills.length} skills`);
  res.redirect('/dashboard');
}

router.get('/onboarding', handleGetOnboarding);
router.post('/onboarding', handlePostOnboarding);

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
    logActivity(null, 'ADMIN_LOGIN_FAIL', username, 'Failed admin login attempt: invalid credentials or insufficient permissions');
    return res.status(403).render('admin-forbidden', {
      siteName: 'DevNexus',
      activePage: 'admin',
      isAdmin: false,
      error: 'Invalid administrator credentials. Access forbidden.'
    });
  }

  if (!user.password_hash || !verifyPassword(password, user.password_hash, user.password_salt)) {
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

  req.session.userId = user.id;
  req.session.save();

  logActivity(user.id, 'ADMIN_LOGIN_SUCCESS', username, 'Administrator authenticated successfully via bcrypt verification');
  res.redirect('/admin');
}

router.post('/admin/login', handleAdminLogin);

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
module.exports.handleAdminLogin = handleAdminLogin;
