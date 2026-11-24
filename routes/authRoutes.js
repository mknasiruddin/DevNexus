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
  validateRegistrationInput,
  upsertGithubUser,
  findOrCreateDemoUser,
  registerLocalUser,
  authenticateLocalUser,
  authenticateLocalUserWithStatus,
  updateUserProfile,
  logActivity,
  saveUserGithubToken,
  findUserByGithubId,
  linkGithubAccountToUser,
  disconnectGithubAccount
} = require('../db/database');

const { synchronizeUserGitHubActivity } = require('../services/githubSyncService');
const { syncUserAnalyticsAndLeaderboard } = require('../services/analyticsService');

const {
  requireAuth,
  loginRateLimiter,
  recordFailedLoginAttempt,
  clearLoginAttempts
} = require('../services/authService');

const { TECH_CATEGORIES, getSkillColor } = require('../services/techCatalog');

function parseSubmittedSkills(rawSkills, rawCustomSkills) {
  const combined = [];
  const pushList = (val) => {
    if (!val) return;
    if (typeof val === 'string') {
      val.split(',').forEach(s => combined.push(s));
    } else if (Array.isArray(val)) {
      val.forEach(item => {
        if (typeof item === 'string') {
          item.split(',').forEach(s => combined.push(s));
        } else if (item != null) {
          combined.push(String(item));
        }
      });
    }
  };
  pushList(rawSkills);
  pushList(rawCustomSkills);

  const seen = new Set();
  const clean = [];
  for (const raw of combined) {
    const trimmed = String(raw || '').trim().slice(0, 50);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (key === 'other') continue;
    if (!seen.has(key)) {
      seen.add(key);
      clean.push(trimmed);
    }
    if (clean.length >= 60) break;
  }
  return clean;
}

function formatSkillsWithColors(skillNames) {
  return skillNames.map(skillName => ({
    name: skillName,
    color: getSkillColor(skillName)
  }));
}

function wantsJson(req) {
  return Boolean(
    req.xhr ||
    (req.headers && req.headers.accept && req.headers.accept.includes('application/json')) ||
    (typeof req.is === 'function' && req.is('application/json'))
  );
}

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
    oauthOnly: req.query.oauthOnly === '1',
    error: req.query.error || null,
    success: req.query.success || null,
    formValues: { username: req.query.username || '', email: '' }
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
    success: req.query.success || null,
    formValues: {
      username: req.query.username || '',
      email: req.query.email || ''
    }
  });
}

// POST /login (Local credential authentication)
function handlePostLogin(req, res) {
  const body = req.body || {};
  const rawIdentifier = body.username || body.email || body.identifier || '';
  const username = typeof rawIdentifier === 'string' ? rawIdentifier.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const isJson = wantsJson(req);

  if (!username || !password) {
    const msg = 'Please enter both username and password';
    if (isJson) {
      return res.status(400).json({ success: false, error: 'MISSING_CREDENTIALS', message: msg });
    }
    const params = new URLSearchParams({ error: msg });
    if (username) params.set('username', username);
    return res.redirect(`/login?${params.toString()}`);
  }

  try {
    const authResult = authenticateLocalUserWithStatus(username, password);
    if (!authResult.ok) {
      if (authResult.reason === 'OAUTH_ONLY') {
        logActivity(authResult.user ? authResult.user.id : null, 'USER_LOGIN_OAUTH_NOTICE', username, 'Guided GitHub OAuth account to Continue with GitHub');
        const oauthMsg = 'This account signs in with GitHub. Use Continue with GitHub to access your account — no separate DevNexus password is needed.';
        if (isJson) {
          return res.status(400).json({ success: false, error: 'OAUTH_ONLY', oauthUrl: '/auth/github', message: oauthMsg });
        }
        const params = new URLSearchParams({ oauthOnly: '1', username });
        return res.redirect(`/login?${params.toString()}`);
      }

      recordFailedLoginAttempt(req);
      let errorMsg = 'Invalid username or password';
      let logDetails = 'Failed user login: invalid credentials';

      if (authResult.reason === 'NO_PASSWORD') {
        errorMsg = 'This sandbox account does not have a password set. Sign up or use Demo Login / GitHub OAuth.';
        logDetails = 'Failed user login: passwordless account attempted password login';
      } else if (authResult.reason === 'ACCOUNT_SUSPENDED') {
        errorMsg = 'This account has been suspended. Please contact an administrator.';
        logDetails = 'Failed user login: account suspended';
      }

      logActivity(authResult.user ? authResult.user.id : null, 'USER_LOGIN_FAIL', username, logDetails);

      if (isJson) {
        return res.status(401).json({ success: false, error: authResult.reason || 'INVALID_CREDENTIALS', message: errorMsg });
      }
      const params = new URLSearchParams({ error: errorMsg });
      params.set('username', username);
      return res.redirect(`/login?${params.toString()}`);
    }

    const user = authResult.user;
    clearLoginAttempts(req);
    if (req.session && typeof req.session.regenerate === 'function') {
      req.session.regenerate();
    }
    req.session.userId = user.id;
    if (req.session && typeof req.session.save === 'function') {
      req.session.save();
    }

    logActivity(user.id, 'USER_LOGIN', user.username, 'Authenticated via local credentials');

    const redirectUrl = user.is_onboarded ? '/dashboard' : '/onboarding';
    if (isJson) {
      return res.json({
        success: true,
        redirectUrl,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          email: user.email,
          role: user.role,
          is_onboarded: Boolean(user.is_onboarded)
        }
      });
    }
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('[DevNexus Login Database Error]', err.message);
    const dbMsg = 'Sign-in is temporarily unavailable due to a database error. Please try again later.';
    if (isJson) {
      return res.status(503).json({ success: false, error: 'DATABASE_ERROR', message: dbMsg });
    }
    return res.status(503).render('login', {
      siteName: 'DevNexus',
      activePage: 'login',
      mode: 'login',
      isOAuthConfigured: isOAuthConfigured(),
      error: dbMsg,
      success: null,
      formValues: { username, email: '' }
    });
  }
}

// POST /signup (Local developer registration)
function handlePostSignup(req, res) {
  const body = req.body || {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirmPassword === 'string'
    ? body.confirmPassword
    : (typeof body.confirm_password === 'string' ? body.confirm_password : '');
  const name = typeof body.name === 'string' ? body.name.trim() : null;
  const isJson = wantsJson(req);

  try {
    validateRegistrationInput({
      username,
      email,
      password,
      confirmPassword,
      requireConfirm: true
    });

    const newUser = registerLocalUser({ username, email, password, name });

    if (req.session && typeof req.session.regenerate === 'function') {
      req.session.regenerate();
    }
    req.session.userId = newUser.id;
    if (req.session && typeof req.session.save === 'function') {
      req.session.save();
    }

    logActivity(newUser.id, 'USER_SIGNUP', newUser.username, 'New developer registered via local signup');

    if (isJson) {
      return res.status(201).json({
        success: true,
        message: 'Account created successfully! Redirecting to developer onboarding...',
        redirectUrl: '/onboarding',
        user: {
          id: newUser.id,
          username: newUser.username,
          name: newUser.name,
          email: newUser.email,
          role: newUser.role,
          is_onboarded: Boolean(newUser.is_onboarded)
        }
      });
    }

    return res.redirect('/onboarding');
  } catch (err) {
    if (err && err.isValidationError) {
      const status = err.statusCode || 400;
      if (isJson) {
        return res.status(status).json({
          success: false,
          error: err.code || 'VALIDATION_ERROR',
          message: err.message,
          fieldErrors: err.fieldErrors || (err.field ? { [err.field]: err.message } : {})
        });
      }
      const params = new URLSearchParams({ error: err.message });
      if (username) params.set('username', username);
      if (email) params.set('email', email);
      return res.redirect(`/signup?${params.toString()}`);
    }

    console.error('[DevNexus Signup Database Error]', err);
    const dbErrorMessage = 'Unable to create your account due to a database error. Please try again later.';
    if (isJson) {
      return res.status(503).json({
        success: false,
        error: 'DATABASE_ERROR',
        message: dbErrorMessage
      });
    }

    return res.status(503).render('login', {
      siteName: 'DevNexus',
      activePage: 'signup',
      mode: 'signup',
      isOAuthConfigured: isOAuthConfigured(),
      error: dbErrorMessage,
      success: null,
      formValues: { username, email }
    });
  }
}

// Forgot Password / Account Assistance Handler
function handleForgotPassword(req, res) {
  const identifier = (req.body && req.body.identifier ? req.body.identifier : '').trim();
  if (!identifier) {
    return res.redirect('/login?error=Please+enter+your+registered+username+or+email+address');
  }

  const matchedUser = findUserByUsername(identifier) || (identifier.includes('@') ? findUserByEmail(identifier) : null);
  if (matchedUser && matchedUser.github_id && !matchedUser.password_hash) {
    return res.redirect(`/login?oauthOnly=1&username=${encodeURIComponent(identifier)}`);
  }
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

  // Ensure session cookie is issued on the exact host/port configured in GITHUB_CALLBACK_URL (e.g. localhost vs 127.0.0.1)
  try {
    const callbackUrl = new URL(getCallbackUrl(req));
    const reqHost = req.headers && req.headers.host ? req.headers.host : '';
    const reqPort = reqHost.includes(':') ? reqHost.split(':')[1] : '';
    const cbPort = callbackUrl.port || (callbackUrl.protocol === 'https:' ? '443' : '80');
    if (reqHost && reqPort === cbPort && reqHost !== callbackUrl.host) {
      return res.redirect(`${callbackUrl.origin}/auth/github`);
    }
  } catch (e) {
    // Proceed with default authorize flow if URL parsing fails
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  if (typeof req.session.save === 'function') {
    req.session.save();
  }

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

  if (!req.session || !req.session.oauthState || !state || req.session.oauthState !== state) {
    if (req.session && req.session.oauthState) {
      req.session.oauthState = null;
      try { if (typeof req.session.save === 'function') req.session.save(); } catch (e) {}
    }
    return res.status(403).render('error', {
      siteName: 'DevNexus',
      activePage: 'login',
      statusCode: 403,
      title: 'State Mismatch (CSRF Protected)',
      message: 'State verification token did not match or your session expired. Please restart the sign-in process from DevNexus.',
      actionUrl: '/auth/github',
      actionText: 'Retry GitHub Sign In'
    });
  }

  try {
    // 1. Secure backend authorization code exchange
    const tokenData = await exchangeOAuthCode(code, req);
    const accessToken = tokenData.access_token;
    const exchangeScope = typeof tokenData.scope === 'string' ? tokenData.scope.trim() : '';

    // 2. Fetch authenticated GitHub user profile + OAuth scopes header
    const { user: githubProfile, scopes: headerScopes } = await getAuthenticatedUser(accessToken);
    const effectiveScopes = (Array.isArray(headerScopes) && headerScopes.length > 0)
      ? headerScopes.join(', ')
      : exchangeScope;

    // 3. Associate GitHub account cleanly without cross-account hijacking
    let localUser = null;
    let isNew = false;

    if (req.user && req.user.id) {
      try {
        localUser = linkGithubAccountToUser(req.user.id, githubProfile);
      } catch (linkErr) {
        if (linkErr && linkErr.code === 'GITHUB_ALREADY_LINKED') {
          return res.status(409).render('error', {
            siteName: 'DevNexus',
            activePage: 'login',
            statusCode: 409,
            title: 'GitHub Account Already Connected',
            message: 'This GitHub account is already connected to a different DevNexus account. Please disconnect it there or sign out before signing in with this GitHub account.',
            actionUrl: '/dashboard',
            actionText: 'Return to Dashboard'
          });
        }
        throw linkErr;
      }
    } else {
      const upserted = upsertGithubUser(githubProfile);
      localUser = upserted.user;
      isNew = upserted.isNew;
    }

    if (!localUser || localUser.status !== 'active') {
      logActivity(localUser ? localUser.id : null, 'USER_LOGIN_FAIL', githubProfile.login, 'GitHub OAuth login blocked: account suspended');
      return res.redirect('/login?error=' + encodeURIComponent('This account has been suspended. Please contact an administrator.'));
    }

    // 4. Create or update user in MongoDB if configured & save encrypted token + granted scopes
    await upsertMongoUser(githubProfile, localUser);
    saveUserGithubToken(localUser.id, githubProfile.id, githubProfile.login, accessToken, effectiveScopes || null);

    // 5. Establish secure regenerated session
    if (req.session.regenerate) req.session.regenerate();
    req.session.userId = localUser.id;
    req.session.githubAccessToken = accessToken;
    req.session.githubToken = accessToken;
    req.session.githubScope = effectiveScopes || null;
    req.session.oauthState = null;
    req.session.save();

    logActivity(localUser.id, isNew ? 'USER_SIGNUP' : 'USER_LOGIN', localUser.username, 'Authenticated via GitHub OAuth');

    // Trigger initial GitHub activity sync (wait briefly so immediate dashboard/portfolio visits see fresh repos)
    await Promise.race([
      synchronizeUserGitHubActivity(localUser.id, {
        sessionToken: accessToken,
        force: true
      }).catch(err => {
        console.warn('[DevNexus OAuth Initial Sync] Skipped:', err.message);
      }),
      new Promise(resolve => setTimeout(resolve, 10000))
    ]);

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
      message: 'Unable to complete GitHub authentication. Please try signing in again.',
      actionUrl: '/login',
      actionText: 'Return to Sign In'
    });
  }
});

// Onboarding Handlers (Shared with top-level /onboarding)
function handleGetOnboarding(req, res) {
  if (!req.user) {
    return res.redirect('/login?error=Please+sign+in+to+continue');
  }

  // Allow editing profile preferences when ?edit=1 is passed
  if (req.user.is_onboarded && req.query.edit !== '1') {
    return res.redirect('/dashboard');
  }

  let existingSkills = [];
  try {
    const parsed = JSON.parse(req.user.skills || '[]');
    existingSkills = parsed.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean);
  } catch (e) {
    existingSkills = [];
  }

  res.render('onboarding', {
    user: req.user,
    existingSkills,
    techCategories: TECH_CATEGORIES,
    isEditing: req.query.edit === '1',
    error: req.query.error || null,
    siteName: 'DevNexus',
    activePage: 'onboarding'
  });
}

function handlePostOnboarding(req, res) {
  if (!req.user) {
    if (wantsJson(req)) {
      return res.status(401).json({ success: false, error: 'AUTHENTICATION_REQUIRED', message: 'Please sign in to continue.' });
    }
    return res.redirect('/login?error=Please+sign+in+to+continue');
  }

  const body = req.body || {};
  const validLevels = ['Beginner', 'Intermediate', 'Advanced'];
  const experienceLevel = validLevels.includes(body.experience_level)
    ? body.experience_level
    : (validLevels.includes(req.user.experience_level) ? req.user.experience_level : null);
  const bio = typeof body.bio === 'string' ? body.bio.trim().slice(0, 300) : undefined;
  const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 80) : undefined;

  const rawSkills = parseSubmittedSkills(body.skills, body.custom_skills);
  if (rawSkills.length === 0) {
    if (wantsJson(req)) {
      return res.status(400).json({ success: false, error: 'SKILLS_REQUIRED', message: 'Please select at least one technology or language.' });
    }
    return res.status(400).render('onboarding', {
      user: { ...req.user, name: name || req.user.name, bio: bio !== undefined ? bio : req.user.bio, experience_level: experienceLevel },
      existingSkills: [],
      techCategories: TECH_CATEGORIES,
      isEditing: false,
      error: 'Please select at least one technology or language.',
      siteName: 'DevNexus',
      activePage: 'onboarding'
    });
  }

  const formattedSkills = formatSkillsWithColors(rawSkills);

  try {
    updateUserProfile(req.user.id, {
      name,
      bio,
      skills: formattedSkills,
      experience_level: experienceLevel,
      is_onboarded: 1
    });

    logActivity(req.user.id, 'ONBOARDING_COMPLETE', req.user.username, `Updated developer profile with ${rawSkills.length} skills (${experienceLevel})`);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('[DevNexus Onboarding Database Error]', err.message);
    return res.status(503).render('onboarding', {
      user: req.user,
      existingSkills: rawSkills,
      techCategories: TECH_CATEGORIES,
      isEditing: false,
      error: 'Unable to save your onboarding preferences due to a database error. Please try again.',
      siteName: 'DevNexus',
      activePage: 'onboarding'
    });
  }
}

// Profile Update Handler (POST /profile or POST /dashboard/profile)
function handlePostProfile(req, res) {
  if (!req.user) {
    if (wantsJson(req)) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    return res.redirect('/login');
  }

  const body = req.body || {};

  // Ownership check: if body specifies a userId, it must match req.user.id
  if (body.userId && Number(body.userId) !== req.user.id) {
    return res.status(403).json({ success: false, error: 'Forbidden: You can only edit your own profile.' });
  }

  const validLevels = ['Beginner', 'Intermediate', 'Advanced'];
  const experienceLevel = validLevels.includes(body.experience_level)
    ? body.experience_level
    : (validLevels.includes(req.user.experience_level) ? req.user.experience_level : null);
  const bio = typeof body.bio === 'string' ? body.bio.trim().slice(0, 300) : req.user.bio;
  const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 80) : req.user.name;

  let formattedSkills = null;
  if (body.skills !== undefined || body.custom_skills !== undefined || !wantsJson(req)) {
    const rawSkills = parseSubmittedSkills(body.skills, body.custom_skills);
    if (rawSkills.length === 0) {
      if (wantsJson(req)) {
        return res.status(400).json({ success: false, error: 'Please select at least one technology or language.' });
      }
      return res.status(400).render('onboarding', {
        user: { ...req.user, name, bio, experience_level: experienceLevel },
        existingSkills: [],
        techCategories: TECH_CATEGORIES,
        isEditing: true,
        error: 'Please select at least one technology or language.',
        siteName: 'DevNexus',
        activePage: 'onboarding'
      });
    }
    formattedSkills = formatSkillsWithColors(rawSkills);
  }

  const updated = updateUserProfile(req.user.id, {
    name,
    bio,
    skills: formattedSkills,
    experience_level: experienceLevel,
    is_onboarded: 1
  });

  logActivity(req.user.id, 'PROFILE_UPDATE', req.user.username, 'Updated developer profile and skill preferences');

  if (wantsJson(req)) {
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

// Disconnect GitHub OAuth connection & clear this user's synced GitHub snapshot
router.post('/github/disconnect', requireAuth, (req, res) => {
  try {
    disconnectGithubAccount(req.user.id);
    try {
      syncUserAnalyticsAndLeaderboard(req.user.id);
    } catch (e) {
      // Non-blocking refresh for any remaining DevNexus platform milestones
    }
    if (req.session) {
      req.session.githubAccessToken = null;
      req.session.githubToken = null;
      req.session.githubScope = null;
      if (typeof req.session.save === 'function') {
        req.session.save();
      }
    }
    logActivity(req.user.id, 'GITHUB_DISCONNECT', req.user.username, 'Disconnected GitHub OAuth account and cleared synced repositories');
    if (wantsJson(req)) {
      return res.json({
        success: true,
        message: 'GitHub account disconnected and synced repository cache cleared.'
      });
    }
    return res.redirect('/dashboard?githubDisconnected=1');
  } catch (err) {
    console.error('[DevNexus GitHub Disconnect Error]', err.message);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, error: 'Failed to disconnect GitHub account.' });
    }
    return res.redirect('/dashboard');
  }
});

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
