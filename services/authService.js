/**
 * DevNexus Authentication and Session Service
 *
 * Implements database-backed session management using Node.js crypto and SQLite.
 * Provides server-side authorization guards for administrative and developer actions.
 */

const crypto = require('node:crypto');
const { createSession, getSession, destroySession, findUserById, verifyPassword } = require('../db/database');

const SESSION_COOKIE_NAME = 'devnexus_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// Parse cookies from HTTP header string
function parseCookies(header = '') {
  const cookies = {};
  header.split(';').forEach(c => {
    const [name, ...val] = c.trim().split('=');
    if (name) {
      cookies[name] = decodeURIComponent(val.join('='));
    }
  });
  return cookies;
}

// Database-backed Session Middleware
function sessionMiddleware(req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';
  const isSecure = isProduction || (req.headers && req.headers['x-forwarded-proto'] === 'https') || Boolean(req.secure);
  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`;

  const cookies = parseCookies(req.headers.cookie);
  let sid = cookies[SESSION_COOKIE_NAME];
  let sessionData = sid ? getSession(sid) : null;

  if (!sid || !sessionData) {
    sid = crypto.randomUUID();
    sessionData = { createdAt: Date.now() };
    createSession(sid, null, sessionData, SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${sid}; ${cookieFlags}`);
  }

  req.sessionID = sid;
  req.session = sessionData;

  // Session helper to persist modifications
  req.session.save = function () {
    const userId = req.session.userId || (req.user ? req.user.id : null);
    createSession(sid, userId, req.session, SESSION_TTL_MS);
  };

  req.session.destroy = function () {
    destroySession(sid);
    req.session = {};
    req.user = null;
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`);
  };

  // Populate req.user and res.locals if session is authenticated
  if (req.session.userId) {
    const user = findUserById(req.session.userId);
    if (user && user.status === 'active') {
      req.user = user;
      res.locals.user = user;
      res.locals.isAdmin = user.role === 'admin';
    } else {
      req.session.userId = null;
      req.session.save();
      req.user = null;
      res.locals.user = null;
      res.locals.isAdmin = false;
    }
  } else {
    req.user = null;
    res.locals.user = null;
    res.locals.isAdmin = false;
  }

  next();
}

// Server-side Admin Authorization Middleware
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin' && req.user.status === 'active') {
    return next();
  }

  if (req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Administrator privileges required.' });
  }

  // Unauthorized: render 403 Forbidden gateway template
  return res.status(403).render('admin-forbidden', {
    siteName: 'DevNexus',
    activePage: 'admin',
    isAdmin: false,
    error: 'Access denied. Administrator authentication required.'
  });
}

// Authenticated User Middleware
function requireAuth(req, res, next) {
  if (req.user && req.user.status === 'active') {
    return next();
  }

  if (req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('application/json'))) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED', message: 'You must be signed in to perform this action.' });
  }

  return res.redirect('/login');
}

module.exports = {
  sessionMiddleware,
  requireAdmin,
  requireAuth
};
