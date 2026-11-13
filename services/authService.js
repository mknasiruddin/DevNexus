/**
 * DevNexus Authentication and Session Service
 *
 * Implements database-backed session management using Node.js crypto and SQLite.
 * Provides server-side authorization guards for administrative and developer actions.
 */

const crypto = require('node:crypto');
const { createSession, getSession, destroySession, cleanExpiredSessions, findUserById, verifyPassword } = require('../db/database');

const SESSION_COOKIE_NAME = 'devnexus_sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// Periodically purge expired sessions from SQLite (every 30 minutes, unref'd so it never blocks process exit)
const cleanupInterval = setInterval(() => {
  try {
    cleanExpiredSessions();
  } catch (e) {
    // Non-critical background cleanup
  }
}, 1000 * 60 * 30);
if (cleanupInterval.unref) cleanupInterval.unref();

// Parse cookies from HTTP header string
function parseCookies(header = '') {
  const cookies = {};
  header.split(';').forEach(c => {
    const [name, ...val] = c.trim().split('=');
    if (name) {
      try {
        cookies[name] = decodeURIComponent(val.join('='));
      } catch (e) {
        cookies[name] = val.join('=');
      }
    }
  });
  return cookies;
}

// Security Headers Middleware
function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  next();
}

// Lightweight Login Rate Limiter (protects against credential brute-forcing)
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOGIN_ATTEMPTS = 25;

function loginRateLimiter(req, res, next) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1';
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (record) {
    if (now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      loginAttempts.delete(ip);
    } else if (record.count >= MAX_LOGIN_ATTEMPTS) {
      if (req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Too many login attempts. Please try again in 15 minutes.' });
      }
      return res.status(429).render('error', {
        siteName: 'DevNexus',
        activePage: 'login',
        statusCode: 429,
        title: 'Too Many Sign-In Attempts',
        message: 'For your account security, sign-in requests from this address have been temporarily rate-limited. Please wait a few minutes and try again.',
        actionUrl: '/login',
        actionText: 'Return to Sign In'
      });
    }
  }
  next();
}

function recordFailedLoginAttempt(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1';
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || (now - record.firstAttempt > RATE_LIMIT_WINDOW_MS)) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  } else {
    record.count += 1;
  }
}

function clearLoginAttempts(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '127.0.0.1';
  loginAttempts.delete(ip);
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
  function attachHelpers(targetSession) {
    Object.defineProperty(targetSession, 'save', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: function () {
        const userId = targetSession.userId || (req.user ? req.user.id : null);
        createSession(sid, userId, targetSession, SESSION_TTL_MS);
      }
    });

    Object.defineProperty(targetSession, 'regenerate', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: function () {
        const oldSid = sid;
        destroySession(oldSid);
        sid = crypto.randomUUID();
        req.sessionID = sid;
        targetSession.createdAt = Date.now();
        const userId = targetSession.userId || (req.user ? req.user.id : null);
        createSession(sid, userId, targetSession, SESSION_TTL_MS);
        res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${sid}; ${cookieFlags}`);
      }
    });

    Object.defineProperty(targetSession, 'destroy', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: function () {
        destroySession(sid);
        req.session = {};
        req.user = null;
        res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`);
      }
    });
  }

  attachHelpers(req.session);

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
  securityHeadersMiddleware,
  loginRateLimiter,
  recordFailedLoginAttempt,
  clearLoginAttempts,
  requireAdmin,
  requireAuth
};
