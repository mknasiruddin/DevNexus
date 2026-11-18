/**
 * DevNexus Official GitHub REST API Integration Service
 *
 * Complies with official GitHub REST API v3 specs:
 * https://docs.github.com/en/rest
 *
 * Features:
 * - GitHub OAuth authorize URL generator and OAuth code exchange
 * - Authenticated and public profile discovery
 * - Repository & live open-source issue search with language, label & pagination
 * - Rate-limit header extraction and SQLite disk-caching to preserve API quotas
 * - Algorithmic skill-based compatibility scoring based on live issue metadata
 */

try {
  require('dotenv').config();
} catch (e) {
  // Ignore if dotenv is not present
}

const crypto = require('node:crypto');
const {
  getCached,
  setCache,
  upsertContributor,
  recordContributorActivity,
  getLeaderboardStats,
  getUserBookmarks,
  findUserByUsername,
  getAllUsers
} = require('../db/database');
const { SKILL_ALIASES } = require('./techCatalog');

const {
  calculateRepositoryHealth,
  calculateContributionReadiness,
  evaluateIssueReadiness
} = require('./saanviModulesService');

const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'DevNexus-Platform/1.0.0 (Node.js/Express; Educational Capstone)';
const inFlightRequests = new Map();

function readHeader(headers, name) {
  if (!headers) return null;
  const lower = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const val = headers.get(lower);
    if (val !== undefined && val !== null && val !== '') return val;
    const exact = headers.get(name);
    return (exact !== undefined && exact !== null && exact !== '') ? exact : null;
  }
  const direct = headers[lower] ?? headers[name];
  return (direct !== undefined && direct !== null && direct !== '') ? String(direct) : null;
}

function getTokenScopeKey(token = null) {
  const effective = getEffectiveToken(token);
  if (!effective) return 'public';
  return 'tok_' + crypto.createHash('sha256').update(String(effective)).digest('hex').slice(0, 12);
}

function withInFlightDedupe(key, factory) {
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      inFlightRequests.delete(key);
    });
  inFlightRequests.set(key, promise);
  return promise;
}

function parseRetryAfterSeconds(rawRetryAfter) {
  if (!rawRetryAfter) return null;
  const trimmed = String(rawRetryAfter).trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(1, parseInt(trimmed, 10));
  }
  const parsedDateMs = Date.parse(trimmed);
  if (Number.isFinite(parsedDateMs)) {
    return Math.max(1, Math.ceil((parsedDateMs - Date.now()) / 1000));
  }
  return null;
}

// Parse actual GitHub rate limit headers (returns null for missing fields — never fabricates fake quota)
function parseRateLimit(headers) {
  if (!headers) return null;
  const rawLimit = readHeader(headers, 'x-ratelimit-limit');
  const rawRemaining = readHeader(headers, 'x-ratelimit-remaining');
  const rawReset = readHeader(headers, 'x-ratelimit-reset');
  const rawUsed = readHeader(headers, 'x-ratelimit-used');
  const rawResource = readHeader(headers, 'x-ratelimit-resource');
  const rawRetryAfter = readHeader(headers, 'retry-after');

  const limit = rawLimit !== null && Number.isFinite(Number(rawLimit)) ? Number(rawLimit) : null;
  const remaining = rawRemaining !== null && Number.isFinite(Number(rawRemaining)) ? Number(rawRemaining) : null;
  const resetEpoch = rawReset !== null && Number.isFinite(Number(rawReset)) ? Number(rawReset) : null;
  const used = rawUsed !== null && Number.isFinite(Number(rawUsed)) ? Number(rawUsed) : null;
  const retryAfterSeconds = parseRetryAfterSeconds(rawRetryAfter);

  if (limit === null && remaining === null && resetEpoch === null && retryAfterSeconds === null) {
    return null;
  }

  let resetMs = resetEpoch ? resetEpoch * 1000 : null;
  if (!resetMs && retryAfterSeconds !== null) {
    resetMs = Date.now() + retryAfterSeconds * 1000;
  }
  const effectiveResetEpoch = resetMs ? Math.ceil(resetMs / 1000) : resetEpoch;
  const resetInSeconds = resetMs ? Math.max(0, Math.ceil((resetMs - Date.now()) / 1000)) : null;
  const resetInMinutes = resetInSeconds !== null ? Math.max(0, Math.ceil(resetInSeconds / 60)) : null;

  return {
    limit,
    remaining,
    used,
    resetEpoch: effectiveResetEpoch,
    resetAtIso: resetMs ? new Date(resetMs).toISOString() : null,
    resetInSeconds,
    resetInMinutes,
    retryAfterSeconds,
    resource: rawResource || null,
    isExhausted: remaining !== null ? remaining <= 0 : false,
    source: 'github_headers'
  };
}

function classifyRateLimitResponse(statusCode, rateLimit, bodyPayload = null) {
  if (statusCode !== 403 && statusCode !== 429) {
    return { isRateLimited: false, rateLimitType: null, resetEpoch: null, resetAtIso: null, message: null };
  }

  const bodyMsg = String((bodyPayload && (bodyPayload.message || bodyPayload.error)) || '');
  const isSecondaryMessage = /secondary rate limit|abuse detection|temporarily throttled|wait a few minutes/i.test(bodyMsg);
  const isPrimaryMessage = /api rate limit exceeded|rate limit exceeded/i.test(bodyMsg) && !isSecondaryMessage;

  const hasRetryAfter = Boolean(rateLimit && rateLimit.retryAfterSeconds !== null);
  const remainingZero = Boolean(rateLimit && rateLimit.remaining !== null && rateLimit.remaining <= 0);

  let rateLimitType = null;
  if (remainingZero || isPrimaryMessage) {
    rateLimitType = 'primary';
  } else if (hasRetryAfter || isSecondaryMessage || statusCode === 429) {
    rateLimitType = 'secondary';
  } else {
    // 403 without remaining===0 or rate-limit message is normal auth/permission 403 unless Retry-After present
    return { isRateLimited: false, rateLimitType: null, resetEpoch: null, resetAtIso: null, message: bodyMsg || null };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let waitSeconds = 60;
  if (rateLimitType === 'secondary') {
    waitSeconds = (rateLimit && rateLimit.retryAfterSeconds) ? Math.max(1, rateLimit.retryAfterSeconds) : 60;
  } else if (rateLimit && rateLimit.resetEpoch && rateLimit.resetEpoch > nowSec) {
    waitSeconds = rateLimit.resetEpoch - nowSec;
  } else if (rateLimit && rateLimit.retryAfterSeconds) {
    waitSeconds = Math.max(1, rateLimit.retryAfterSeconds);
  }

  const resetEpoch = (rateLimitType === 'primary' && rateLimit && rateLimit.resetEpoch && rateLimit.resetEpoch > nowSec)
    ? rateLimit.resetEpoch
    : nowSec + waitSeconds;
  const resetAtIso = new Date(resetEpoch * 1000).toISOString();

  const label = rateLimitType === 'secondary' ? 'GitHub secondary rate limit' : 'GitHub primary API rate limit';
  const resetTimeText = new Date(resetEpoch * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const friendlyMessage = `${label} reached. GitHub requests paused until reset at ${resetTimeText} (~${Math.max(1, Math.ceil(waitSeconds / 60))}m).`;

  return {
    isRateLimited: true,
    rateLimitType,
    waitSeconds,
    resetEpoch,
    resetAtIso,
    message: friendlyMessage
  };
}

function getActiveRateLimitBlock(bucket = 'core', token = null) {
  const scope = getTokenScopeKey(token);
  const blockKey = `rl_block:${bucket}:${scope}`;
  const entry = getCached(blockKey, { allowStale: false });
  if (!entry || !entry.data) return null;
  const resetEpoch = Number(entry.data.resetEpoch || 0);
  if (resetEpoch * 1000 <= Date.now()) {
    return null;
  }
  const remainingSec = Math.max(1, Math.ceil((resetEpoch * 1000 - Date.now()) / 1000));
  return {
    ...entry.data,
    resetInSeconds: remainingSec,
    resetInMinutes: Math.max(1, Math.ceil(remainingSec / 60))
  };
}

function recordRateLimitBlock(bucket = 'core', token = null, classification = null, rateLimit = null) {
  if (!classification || !classification.isRateLimited) return null;
  const scope = getTokenScopeKey(token);
  const blockKey = `rl_block:${bucket}:${scope}`;
  const ttlSeconds = Math.max(5, Math.min(3600, classification.waitSeconds || 60));
  const payload = {
    bucket,
    rateLimitType: classification.rateLimitType,
    resetEpoch: classification.resetEpoch,
    resetAtIso: classification.resetAtIso,
    limit: rateLimit ? rateLimit.limit : null,
    remaining: rateLimit ? rateLimit.remaining : 0,
    resource: rateLimit ? rateLimit.resource : bucket,
    message: classification.message
  };
  setCache(blockKey, payload, { cachedAt: new Date().toISOString() }, ttlSeconds);
  return payload;
}

// Helper to get effective GitHub auth token
function getEffectiveToken(sessionToken) {
  return sessionToken || process.env.GITHUB_TOKEN || null;
}

// Helper to construct request headers
function getHeaders(token, includeAuth = true) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': USER_AGENT
  };
  if (includeAuth) {
    const activeToken = getEffectiveToken(token);
    if (activeToken) {
      headers['Authorization'] = `Bearer ${activeToken}`;
    }
  }
  return headers;
}

// Resilient fetch wrapper: catches network errors and retries unauthenticated if a configured token is invalid (401)
async function safeGithubFetch(url, token = null, fetchImpl = fetch) {
  try {
    let res = await fetchImpl(url, { headers: getHeaders(token, true) });
    if (res.status === 401 && getEffectiveToken(token)) {
      res = await fetchImpl(url, { headers: getHeaders(null, false) });
    }
    return { res, networkError: null };
  } catch (err) {
    return { res: null, networkError: err };
  }
}

// ----------------------------------------------------
// 1. GitHub OAuth Methods
// ----------------------------------------------------

function getCallbackUrl(req = null) {
  if (process.env.GITHUB_CALLBACK_URL && process.env.GITHUB_CALLBACK_URL.trim() !== '') {
    return process.env.GITHUB_CALLBACK_URL.trim();
  }
  if (process.env.APP_URL && process.env.APP_URL.trim() !== '') {
    const base = process.env.APP_URL.trim().replace(/\/+$/, '');
    return `${base}/auth/github/callback`;
  }
  if (req) {
    const proto = req.headers ? (req.headers['x-forwarded-proto'] || req.protocol || 'http') : 'http';
    const host = req.get ? req.get('host') : (req.headers ? req.headers.host : null);
    if (host) {
      return `${proto}://${host}/auth/github/callback`;
    }
  }
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/auth/github/callback`;
}

function isOAuthConfigured() {
  const clientId = (process.env.GITHUB_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GITHUB_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return false;
  if (/^your_github_/i.test(clientId) || /^your_github_/i.test(clientSecret)) return false;
  return true;
}

function getOAuthAuthorizeUrl(state, req = null) {
  if (!isOAuthConfigured()) return null;
  const clientId = process.env.GITHUB_CLIENT_ID.trim();
  const callbackUrl = getCallbackUrl(req);
  const scope = 'read:user,user:email';
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`;
}

async function exchangeOAuthCode(code, req = null) {
  if (!isOAuthConfigured()) {
    throw new Error('GitHub OAuth is not configured in environment variables.');
  }
  if (!code || typeof code !== 'string') {
    throw new Error('GitHub OAuth authorization code is missing.');
  }

  const clientId = process.env.GITHUB_CLIENT_ID.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET.trim();
  const callbackUrl = getCallbackUrl(req);

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code: code.trim(),
      redirect_uri: callbackUrl
    })
  });

  const rawText = await response.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`GitHub OAuth token exchange returned an invalid response (HTTP ${response.status}).`);
  }

  if (!response.ok || data.error) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error || `HTTP ${response.status}`}`);
  }
  if (!data.access_token || typeof data.access_token !== 'string') {
    throw new Error('GitHub OAuth token exchange did not return an access token.');
  }

  return data; // { access_token, token_type, scope }
}

// ----------------------------------------------------
// 2. Profile & Repository Retrieval
// ----------------------------------------------------

async function getAuthenticatedUser(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('A valid GitHub OAuth access token is required.');
  }

  const oauthHeaders = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': USER_AGENT,
    'Authorization': `Bearer ${accessToken}`
  };

  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: oauthHeaders
  });

  const rateLimit = parseRateLimit(res.headers);
  if (!res.ok) {
    throw new Error(`Failed to fetch authenticated GitHub user (HTTP ${res.status})`);
  }

  const user = await res.json();
  if (!user || !user.id || !user.login) {
    throw new Error('GitHub user profile response was incomplete.');
  }

  // Try to retrieve primary verified email if private
  let email = user.email || null;
  if (!email) {
    try {
      const emailRes = await fetch(`${GITHUB_API_BASE}/user/emails`, {
        headers: oauthHeaders
      });
      if (emailRes.ok) {
        const emails = await emailRes.json();
        if (Array.isArray(emails)) {
          const best = emails.find(e => e.primary && e.verified) || emails.find(e => e.verified) || emails[0];
          if (best && best.email) email = best.email;
        }
      }
    } catch (e) {
      // Non-critical email retrieval failure
    }
  }

  return { user: { ...user, email }, rateLimit };
}

async function getUserProfile(username, token = null, { fetchImpl = fetch } = {}) {
  const cleanUser = String(username || '').trim();
  if (!cleanUser) {
    return { user: null, rateLimit: null, error: 'INVALID_USERNAME' };
  }
  const cacheKey = `user_profile:${cleanUser.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return {
      user: cached.data,
      rateLimit: cached.headers.rateLimit || null,
      cached: true,
      stale: false,
      cachedAt: cached.headers.cachedAt || null
    };
  }

  return withInFlightDedupe(cacheKey, async () => {
    const activeBlock = getActiveRateLimitBlock('core', token);
    if (activeBlock) {
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        user: stale ? stale.data : null,
        rateLimit: {
          limit: activeBlock.limit,
          remaining: activeBlock.remaining,
          resetEpoch: activeBlock.resetEpoch,
          resetAtIso: activeBlock.resetAtIso,
          resetInMinutes: activeBlock.resetInMinutes,
          resource: 'core',
          rateLimitType: activeBlock.rateLimitType,
          isExhausted: true
        },
        cached: Boolean(stale),
        stale: Boolean(stale),
        rateLimited: true,
        rateLimitType: activeBlock.rateLimitType,
        error: 'RATE_LIMIT_EXCEEDED',
        errorMessage: activeBlock.message
      };
    }

    const { res, networkError } = await safeGithubFetch(`${GITHUB_API_BASE}/users/${encodeURIComponent(cleanUser)}`, token, fetchImpl);
    if (networkError || !res) {
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        user: stale ? stale.data : null,
        rateLimit: stale ? (stale.headers.rateLimit || null) : null,
        cached: Boolean(stale),
        stale: Boolean(stale),
        error: 'NETWORK_ERROR',
        errorMessage: 'GitHub profile request failed cleanly.'
      };
    }

    const rateLimit = parseRateLimit(res.headers);
    if (res.status === 404) {
      return { user: null, rateLimit, error: 'NOT_FOUND' };
    }
    if (!res.ok) {
      let errBody = null;
      if (res.status === 403 || res.status === 429) {
        try { errBody = await res.json(); } catch (e) {}
      }
      const rlClass = classifyRateLimitResponse(res.status, rateLimit, errBody);
      if (rlClass.isRateLimited) {
        recordRateLimitBlock('core', token, rlClass, rateLimit);
        const stale = getCached(cacheKey, { allowStale: true });
        return {
          user: stale ? stale.data : null,
          rateLimit: rateLimit ? { ...rateLimit, resetEpoch: rlClass.resetEpoch, resetAtIso: rlClass.resetAtIso, rateLimitType: rlClass.rateLimitType } : null,
          cached: Boolean(stale),
          stale: Boolean(stale),
          rateLimited: true,
          rateLimitType: rlClass.rateLimitType,
          error: 'RATE_LIMIT_EXCEEDED',
          errorMessage: rlClass.message
        };
      }
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        user: stale ? stale.data : null,
        rateLimit,
        cached: Boolean(stale),
        stale: Boolean(stale),
        error: `HTTP_${res.status}`
      };
    }

    const user = await res.json();
    setCache(cacheKey, user, { rateLimit }, 600); // 10 min cache
    return { user, rateLimit, cached: false, stale: false };
  });
}

async function getUserRepositories(username, token = null, { sort = 'updated', perPage = 6, fetchImpl = fetch } = {}) {
  const cleanUser = String(username || '').trim();
  if (!cleanUser) {
    return { repos: [], rateLimit: null, error: 'INVALID_USERNAME' };
  }
  const cacheKey = `user_repos:${cleanUser.toLowerCase()}:${sort}:${perPage}`;

  const hydrateRepos = (rawList) => (Array.isArray(rawList) ? rawList : []).map(r => ({
    ...r,
    health: r.health || calculateRepositoryHealth({
      ...r,
      updated_at: r.updatedAt,
      stargazers_count: r.stars,
      forks_count: r.forks,
      open_issues_count: r.openIssues
    })
  }));

  const cached = getCached(cacheKey);
  if (cached) {
    return {
      repos: hydrateRepos(cached.data),
      rateLimit: cached.headers.rateLimit || null,
      cached: true,
      stale: false,
      cachedAt: cached.headers.cachedAt || null
    };
  }

  return withInFlightDedupe(cacheKey, async () => {
    const activeBlock = getActiveRateLimitBlock('core', token);
    if (activeBlock) {
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        repos: stale ? hydrateRepos(stale.data) : [],
        rateLimit: {
          limit: activeBlock.limit,
          remaining: activeBlock.remaining,
          resetEpoch: activeBlock.resetEpoch,
          resetAtIso: activeBlock.resetAtIso,
          resetInMinutes: activeBlock.resetInMinutes,
          resource: 'core',
          rateLimitType: activeBlock.rateLimitType,
          isExhausted: true
        },
        cached: Boolean(stale),
        stale: Boolean(stale),
        rateLimited: true,
        rateLimitType: activeBlock.rateLimitType,
        error: 'RATE_LIMIT_EXCEEDED',
        errorMessage: activeBlock.message
      };
    }

    const { res, networkError } = await safeGithubFetch(`${GITHUB_API_BASE}/users/${encodeURIComponent(cleanUser)}/repos?sort=${sort}&per_page=${perPage}&type=owner`, token, fetchImpl);
    if (networkError || !res) {
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        repos: stale ? hydrateRepos(stale.data) : [],
        rateLimit: stale ? (stale.headers.rateLimit || null) : null,
        cached: Boolean(stale),
        stale: Boolean(stale),
        error: 'NETWORK_ERROR'
      };
    }

    const rateLimit = parseRateLimit(res.headers);
    if (!res.ok) {
      let errBody = null;
      if (res.status === 403 || res.status === 429) {
        try { errBody = await res.json(); } catch (e) {}
      }
      const rlClass = classifyRateLimitResponse(res.status, rateLimit, errBody);
      if (rlClass.isRateLimited) {
        recordRateLimitBlock('core', token, rlClass, rateLimit);
        const stale = getCached(cacheKey, { allowStale: true });
        return {
          repos: stale ? hydrateRepos(stale.data) : [],
          rateLimit: rateLimit ? { ...rateLimit, resetEpoch: rlClass.resetEpoch, resetAtIso: rlClass.resetAtIso, rateLimitType: rlClass.rateLimitType } : null,
          cached: Boolean(stale),
          stale: Boolean(stale),
          rateLimited: true,
          rateLimitType: rlClass.rateLimitType,
          error: 'RATE_LIMIT_EXCEEDED',
          errorMessage: rlClass.message
        };
      }
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        repos: stale ? hydrateRepos(stale.data) : [],
        rateLimit,
        cached: Boolean(stale),
        stale: Boolean(stale),
        error: `HTTP_${res.status}`
      };
    }

    const repos = await res.json();
    const seenIds = new Set();
    const cleanUserLower = cleanUser.toLowerCase();
    const sanitized = (Array.isArray(repos) ? repos : [])
      .filter(r => {
        if (!r || r.id === undefined || r.id === null) return false;
        if (r.owner && r.owner.type && String(r.owner.type).toLowerCase() !== 'user') return false;
        if (r.owner && r.owner.login && String(r.owner.login).toLowerCase() !== cleanUserLower) return false;
        const key = String(r.id);
        if (seenIds.has(key)) return false;
        seenIds.add(key);
        return true;
      })
      .map(r => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        description: r.description || 'No description provided.',
        htmlUrl: r.html_url,
        language: r.language || 'Markdown',
        stars: r.stargazers_count,
        forks: r.forks_count,
        openIssues: r.open_issues_count,
        updatedAt: r.updated_at,
        license: r.license ? (r.license.spdx_id || r.license.name) : null,
        topics: Array.isArray(r.topics) ? r.topics.slice(0, 6) : [],
        health: calculateRepositoryHealth(r)
      }));

    setCache(cacheKey, sanitized, { rateLimit }, 600);
    return { repos: sanitized, rateLimit, cached: false, stale: false };
  });
}

async function getUserEvents(username, token = null, { perPage = 8, fetchImpl = fetch } = {}) {
  const cleanUser = String(username || '').trim();
  if (!cleanUser) {
    return { events: [], rateLimit: null, error: 'INVALID_USERNAME' };
  }
  const cacheKey = `user_events:${cleanUser.toLowerCase()}:${perPage}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return {
      events: cached.data,
      rateLimit: cached.headers.rateLimit || null,
      cached: true,
      stale: false,
      cachedAt: cached.headers.cachedAt || null
    };
  }

  return withInFlightDedupe(cacheKey, async () => {
    const activeBlock = getActiveRateLimitBlock('core', token);
    if (activeBlock) {
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        events: stale ? stale.data : [],
        rateLimit: {
          limit: activeBlock.limit,
          remaining: activeBlock.remaining,
          resetEpoch: activeBlock.resetEpoch,
          resetAtIso: activeBlock.resetAtIso,
          resetInMinutes: activeBlock.resetInMinutes,
          resource: 'core',
          rateLimitType: activeBlock.rateLimitType,
          isExhausted: true
        },
        cached: Boolean(stale),
        stale: Boolean(stale),
        rateLimited: true,
        rateLimitType: activeBlock.rateLimitType,
        error: 'RATE_LIMIT_EXCEEDED',
        errorMessage: activeBlock.message
      };
    }

    const { res, networkError } = await safeGithubFetch(`${GITHUB_API_BASE}/users/${encodeURIComponent(cleanUser)}/events/public?per_page=${perPage}`, token, fetchImpl);
    if (networkError || !res) {
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        events: stale ? stale.data : [],
        rateLimit: stale ? (stale.headers.rateLimit || null) : null,
        cached: Boolean(stale),
        stale: Boolean(stale),
        error: 'NETWORK_ERROR'
      };
    }

    const rateLimit = parseRateLimit(res.headers);
    if (!res.ok) {
      let errBody = null;
      if (res.status === 403 || res.status === 429) {
        try { errBody = await res.json(); } catch (e) {}
      }
      const rlClass = classifyRateLimitResponse(res.status, rateLimit, errBody);
      if (rlClass.isRateLimited) {
        recordRateLimitBlock('core', token, rlClass, rateLimit);
        const stale = getCached(cacheKey, { allowStale: true });
        return {
          events: stale ? stale.data : [],
          rateLimit: rateLimit ? { ...rateLimit, resetEpoch: rlClass.resetEpoch, resetAtIso: rlClass.resetAtIso, rateLimitType: rlClass.rateLimitType } : null,
          cached: Boolean(stale),
          stale: Boolean(stale),
          rateLimited: true,
          rateLimitType: rlClass.rateLimitType,
          error: 'RATE_LIMIT_EXCEEDED',
          errorMessage: rlClass.message
        };
      }
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        events: stale ? stale.data : [],
        rateLimit,
        cached: Boolean(stale),
        stale: Boolean(stale),
        error: `HTTP_${res.status}`
      };
    }

    const rawEvents = await res.json();
    const events = (Array.isArray(rawEvents) ? rawEvents : []).map(ev => {
      let actionTitle = 'Activity in repository';
      let type = 'general';
      let status = 'Logged';

      if (ev.type === 'PushEvent') {
        type = 'push';
        const commitCount = ev.payload?.commits?.length || 1;
        actionTitle = `Pushed ${commitCount} commit${commitCount > 1 ? 's' : ''}`;
        status = 'Committed';
      } else if (ev.type === 'PullRequestEvent') {
        type = 'pr';
        const action = ev.payload?.action || 'opened';
        actionTitle = `Pull Request ${action}: "${(ev.payload?.pull_request?.title || '').slice(0, 50)}"`;
        status = action === 'closed' && ev.payload?.pull_request?.merged ? 'Merged' : action;
      } else if (ev.type === 'IssuesEvent') {
        type = 'issue';
        const action = ev.payload?.action || 'opened';
        actionTitle = `Issue ${action}: "${(ev.payload?.issue?.title || '').slice(0, 50)}"`;
        status = action;
      } else if (ev.type === 'IssueCommentEvent') {
        type = 'comment';
        actionTitle = `Commented on issue #${ev.payload?.issue?.number || ''}`;
        status = 'Commented';
      } else if (ev.type === 'WatchEvent') {
        type = 'star';
        actionTitle = 'Starred repository';
        status = 'Starred';
      }

      return {
        id: ev.id,
        type,
        repo: ev.repo?.name || '',
        repoUrl: `https://github.com/${ev.repo?.name || ''}`,
        title: actionTitle,
        status,
        timestamp: formatRelativeTime(ev.created_at)
      };
    });

    setCache(cacheKey, events, { rateLimit }, 300);
    return { events, rateLimit, cached: false, stale: false };
  });
}

// ----------------------------------------------------
// 3. Issue Discovery & Live Search
// ----------------------------------------------------

function enrichIssueForUser(issue, userSkills = []) {
  const compat = calculateCompatibility(
    {
      title: issue.title,
      body: issue.body || '',
      comments: issue.commentsCount ?? issue.comments ?? 0,
      created_at: issue.createdAtExact || issue.created_at || null
    },
    issue.repoName || '',
    issue.labels || [],
    userSkills
  );

  return {
    ...issue,
    compatibilityScore: compat.score,
    compatibilityBreakdown: compat.breakdown
  };
}

async function searchIssues({ query = '', label = 'all', language = 'all', difficulty = 'all', page = 1, perPage = 10 } = {}, userSkills = [], token = null, { cacheOnly = false, fetchImpl = fetch } = {}) {
  const safePage = Math.max(1, Math.min(100, parseInt(page, 10) || 1));
  const safePerPage = Math.max(1, Math.min(50, parseInt(perPage, 10) || 10));

  // Build GitHub Search Query String
  // Format: is:issue is:open [label:...] [language:...] [keywords]
  let qParts = ['is:issue', 'is:open'];

  if (query && query.trim() !== '') {
    qParts.push(query.trim());
  }

  // Label filtering
  if (label === 'good-first-issue') {
    qParts.push('label:"good first issue"');
  } else if (label === 'help-wanted') {
    qParts.push('label:"help wanted"');
  } else if (label && label !== 'all') {
    qParts.push(`label:"${label}"`);
  }

  // Language filtering
  if (language && language !== 'all') {
    qParts.push(`language:${language.toLowerCase()}`);
  }

  const queryString = qParts.join(' ');
  const cacheKey = `issue_search:${queryString}:${safePage}:${safePerPage}`;

  // Check fresh cache (10 min TTL)
  const cached = getCached(cacheKey);
  if (cached) {
    const cachedIssues = Array.isArray(cached.data?.issues)
      ? cached.data.issues.map(iss => enrichIssueForUser(iss, userSkills))
      : [];
    return {
      ...cached.data,
      issues: cachedIssues,
      rateLimit: cached.headers.rateLimit || null,
      cached: true,
      stale: false,
      cachedAt: cached.headers.cachedAt || null
    };
  }

  if (cacheOnly) {
    const stale = getCached(cacheKey, { allowStale: true });
    if (stale) {
      const staleIssues = Array.isArray(stale.data?.issues)
        ? stale.data.issues.map(iss => enrichIssueForUser(iss, userSkills))
        : [];
      return {
        ...stale.data,
        issues: staleIssues,
        rateLimit: stale.headers.rateLimit || null,
        cached: true,
        stale: true,
        cachedAt: stale.headers.cachedAt || null
      };
    }
    return { issues: [], totalCount: 0, page: safePage, perPage: safePerPage, totalPages: 0, rateLimit: null, cached: false };
  }

  return withInFlightDedupe(cacheKey, async () => {
    const activeBlock = getActiveRateLimitBlock('search', token);
    if (activeBlock) {
      const stale = getCached(cacheKey, { allowStale: true });
      const staleIssues = stale && Array.isArray(stale.data?.issues)
        ? stale.data.issues.map(iss => enrichIssueForUser(iss, userSkills))
        : [];
      return {
        ...(stale ? stale.data : { totalCount: 0, page: safePage, perPage: safePerPage, totalPages: 0 }),
        issues: staleIssues,
        rateLimit: {
          limit: activeBlock.limit,
          remaining: activeBlock.remaining,
          resetEpoch: activeBlock.resetEpoch,
          resetAtIso: activeBlock.resetAtIso,
          resetInMinutes: activeBlock.resetInMinutes,
          resource: 'search',
          rateLimitType: activeBlock.rateLimitType,
          isExhausted: true
        },
        cached: Boolean(stale),
        stale: Boolean(stale),
        rateLimited: true,
        rateLimitType: activeBlock.rateLimitType,
        rateLimitResetAtIso: activeBlock.resetAtIso || null,
        error: 'RATE_LIMIT_EXCEEDED',
        errorMessage: stale ? `${activeBlock.message} Showing cached issues.` : activeBlock.message
      };
    }

    const url = `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(queryString)}&sort=updated&order=desc&page=${safePage}&per_page=${safePerPage}`;
    const { res, networkError } = await safeGithubFetch(url, token, fetchImpl);

    if (networkError || !res) {
      const stale = getCached(cacheKey, { allowStale: true });
      if (stale) {
        return {
          ...stale.data,
          issues: (stale.data?.issues || []).map(iss => enrichIssueForUser(iss, userSkills)),
          rateLimit: stale.headers.rateLimit || null,
          cached: true,
          stale: true,
          error: 'NETWORK_ERROR',
          errorMessage: 'Unable to reach GitHub API. Showing preserved cached issues.'
        };
      }
      return {
        issues: [],
        totalCount: 0,
        page: safePage,
        perPage: safePerPage,
        totalPages: 0,
        rateLimit: null,
        error: 'NETWORK_ERROR',
        errorMessage: 'Unable to reach GitHub API. Please check your internet connection and try again.'
      };
    }

    const rateLimit = parseRateLimit(res.headers);

    if (res.status === 403 || res.status === 429) {
      let errBody = null;
      try { errBody = await res.json(); } catch (e) {}
      const rlClass = classifyRateLimitResponse(res.status, rateLimit, errBody);
      if (rlClass.isRateLimited) {
        recordRateLimitBlock('search', token, rlClass, rateLimit);
      }
      const stale = getCached(cacheKey, { allowStale: true });
      const rlMsg = rlClass.message || `GitHub API search rate limit reached. Limit resets in ${rateLimit?.resetInMinutes ?? 1} minute(s).`;
      return {
        ...(stale ? stale.data : { totalCount: 0, page: safePage, perPage: safePerPage, totalPages: 0 }),
        issues: stale && Array.isArray(stale.data?.issues)
          ? stale.data.issues.map(iss => enrichIssueForUser(iss, userSkills))
          : [],
        rateLimit: rateLimit ? { ...rateLimit, resetEpoch: rlClass.resetEpoch || rateLimit.resetEpoch, resetAtIso: rlClass.resetAtIso || rateLimit.resetAtIso, rateLimitType: rlClass.rateLimitType } : null,
        cached: Boolean(stale),
        stale: Boolean(stale),
        rateLimited: true,
        rateLimitType: rlClass.rateLimitType || 'primary',
        rateLimitResetAtIso: rlClass.resetAtIso || (rateLimit && rateLimit.resetAtIso) || null,
        error: 'RATE_LIMIT_EXCEEDED',
        errorMessage: stale ? `${rlMsg} Showing preserved cached issues.` : rlMsg
      };
    }

    if (!res.ok) {
      const stale = getCached(cacheKey, { allowStale: true });
      if (stale) {
        return {
          ...stale.data,
          issues: (stale.data?.issues || []).map(iss => enrichIssueForUser(iss, userSkills)),
          rateLimit,
          cached: true,
          stale: true,
          error: `API_ERROR_${res.status}`,
          errorMessage: `GitHub API returned HTTP ${res.status}. Showing preserved cached issues.`
        };
      }
      return {
        issues: [],
        totalCount: 0,
        page: safePage,
        perPage: safePerPage,
        totalPages: 0,
        rateLimit,
        error: `API_ERROR_${res.status}`,
        errorMessage: `GitHub API returned error HTTP ${res.status}.`
      };
    }

    const data = await res.json();
    const totalCount = data.total_count || 0;
    const totalPages = Math.min(Math.ceil(totalCount / safePerPage), 100); // GitHub limits search pagination to top 1,000 results

    // Process & normalize raw issue items before applying per-user compatibility scoring
    const baseIssues = (data.items || []).map(item => {
      const repoMatch = (item.repository_url || '').match(/repos\/(.+?\/.+?)$/);
      const repoName = repoMatch ? repoMatch[1] : '';

      // Extract labels
      const labels = (item.labels || []).map(l => ({
        name: l.name,
        color: `#${l.color}`,
        isGfi: l.name.toLowerCase().includes('good first issue') || l.name.toLowerCase().includes('beginner'),
        isHw: l.name.toLowerCase().includes('help wanted')
      }));

      // Categorize
      const isGoodFirst = labels.some(l => l.isGfi);
      const isHelpWanted = labels.some(l => l.isHw);
      const category = isGoodFirst ? 'good-first-issue' : isHelpWanted ? 'help-wanted' : 'recommended';

      return {
        id: item.id,
        number: item.number,
        title: item.title,
        body: item.body ? String(item.body).slice(0, 600) : '',
        htmlUrl: item.html_url,
        repoName,
        repoUrl: `https://github.com/${repoName}`,
        labels,
        category,
        difficulty: isGoodFirst ? 'Beginner' : isHelpWanted ? 'Intermediate' : 'Advanced',
        commentsCount: item.comments || 0,
        createdAt: formatRelativeTime(item.created_at),
        createdAtExact: item.created_at || null,
        author: item.user ? item.user.login : 'unknown'
      };
    });

    const basePayload = {
      issues: baseIssues,
      totalCount,
      page: safePage,
      perPage: safePerPage,
      totalPages
    };

    setCache(cacheKey, basePayload, { rateLimit }, 600); // 10 min cache (user-agnostic base payload)
    const issues = baseIssues.map(iss => enrichIssueForUser(iss, userSkills));
    return { ...basePayload, issues, rateLimit, cached: false, stale: false };
  }).then(result => ({
    ...result,
    issues: Array.isArray(result.issues) ? result.issues.map(iss => enrichIssueForUser(iss, userSkills)) : []
  }));
}

// ----------------------------------------------------
// 4. Algorithmic Skill Compatibility Calculator
// ----------------------------------------------------
function normalizeCompatibilitySkills(skills = []) {
  const values = Array.isArray(skills) ? skills : [];

  return [...new Set(
    values
      .map(skill => {
        if (typeof skill === 'string') return skill;
        if (skill && typeof skill.name === 'string') return skill.name;
        return '';
      })
      .map(skill => skill.trim().toLowerCase())
      .filter(Boolean)
  )];
}

const COMPATIBILITY_SKILL_ALIASES = {
  ...SKILL_ALIASES,
  javascript: ['javascript', 'js', 'node.js', 'nodejs'],
  'react.js': ['react', 'react.js']
};

function matchSkillsAgainstCorpus(skills, textCorpus) {
  return skills.filter(skill => {
    const terms = COMPATIBILITY_SKILL_ALIASES[skill] || [skill];
    return terms.some(term => {
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(^|[^a-z0-9+#])${escapedTerm}($|[^a-z0-9+#])`, 'i');
      return pattern.test(textCorpus);
    });
  });
}

function calculateCompatibility(issue, repoName, labels, userSkills = [], requestedDifficulty = 'all') {
  // Weighted profile matching: skills 45%, difficulty 30%, engagement 15%, freshness 10%.
  const skills = normalizeCompatibilitySkills(userSkills);
  const labelNames = (labels || []).map(label => String(label.name || '').toLowerCase());

  const textCorpus = [
    repoName,
    issue.title,
    issue.body,
    ...(labels || []).map(label => label.name)
  ].filter(Boolean).join(' ').toLowerCase();

  const matchedSkills = matchSkillsAgainstCorpus(skills, textCorpus);

  const skillOverlapScore = skills.length === 0
    ? 80
    : Math.round((matchedSkills.length / skills.length) * 100);

  const isGoodFirstIssue = labelNames.some(name =>
    name.includes('good first issue') || name.includes('beginner')
  );

  const isHelpWanted = labelNames.some(name => name.includes('help wanted'));

  let difficultyScore = isGoodFirstIssue ? 95 : isHelpWanted ? 90 : 75;

  const requested = String(requestedDifficulty || 'all').toLowerCase();

  if (requested !== 'all') {
    const issueLevel = isGoodFirstIssue
      ? 'beginner'
      : isHelpWanted
        ? 'intermediate'
        : 'advanced';

    difficultyScore = requested === issueLevel
      ? Math.min(100, difficultyScore + 5)
      : Math.max(40, difficultyScore - 20);
  }

  const comments = Number(issue.comments || 0);

  let engagementScore = 70;

  if (comments >= 1 && comments <= 4) engagementScore = 95;
  else if (comments === 0) engagementScore = 85;
  else if (comments > 10) engagementScore = 65;

  const createdAt = new Date(issue.created_at).getTime();

  const ageDays = Number.isFinite(createdAt)
    ? Math.max(0, (Date.now() - createdAt) / 86400000)
    : 60;

  const recencyScore = ageDays <= 14 ? 98 : ageDays <= 60 ? 85 : 60;

  const finalScore = Math.round(
    skillOverlapScore * 0.45 +
    difficultyScore * 0.30 +
    engagementScore * 0.15 +
    recencyScore * 0.10
  );

  return {
    score: Math.min(99, Math.max(0, finalScore)),
    breakdown: {
      skillOverlap: skillOverlapScore,
      difficultyAlignment: difficultyScore,
      mentorSupport: engagementScore,
      recency: recencyScore,
      matchedSkills
    }
  };
}

// ----------------------------------------------------
// Repository Skill-Based Compatibility Calculator
// ----------------------------------------------------

function calculateRepositoryCompatibility(repository, userSkills = []) {
  const skills = normalizeCompatibilitySkills(userSkills);

  const repositoryText = [
    repository.name,
    repository.description,
    repository.language,
    ...(repository.topics || [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const matchedSkills = matchSkillsAgainstCorpus(skills, repositoryText);

  const score = skills.length === 0
    ? 0
    : Math.round((matchedSkills.length / skills.length) * 100);

  return {
    score,
    matchedSkills,
    totalSkills: skills.length
  };
}


// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
function formatRelativeTime(dateString) {
  if (!dateString) return 'recently';
  const now = Date.now();
  const past = new Date(dateString).getTime();
  const diffSec = Math.floor((now - past) / 1000);

  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.floor(diffMonth / 12)}y ago`;
}

const LANGUAGE_COLORS = {
  javascript: '#f1e05a',
  typescript: '#3178c6',
  python: '#3572A5',
  go: '#00ADD8',
  rust: '#dea584',
  java: '#b07219',
  c: '#555555',
  'c++': '#f34b7d',
  'c#': '#178600',
  ruby: '#701516',
  php: '#4F5D95',
  swift: '#F05138',
  kotlin: '#A97BFF',
  dart: '#00B4AB',
  html: '#e34c26',
  css: '#563d7c',
  shell: '#89e051',
  markdown: '#8b949e',
  docs: '#8b949e'
};

// ----------------------------------------------------
// 5. Repository Discovery & Live Search
// ----------------------------------------------------

async function searchRepositories({
  query = '',
  language = 'all',
  topic = 'all',
  minStars = 0,
  sort = 'stars',
  order = 'desc',
  page = 1,
  perPage = 12,
  userSkills = []
} = {}, token = null, { fetchImpl = fetch } = {}) {
  const safePage = Math.max(1, Math.min(80, parseInt(page, 10) || 1));
  const safePerPage = Math.max(1, Math.min(50, parseInt(perPage, 10) || 12));

  const normalizedUserSkills = normalizeCompatibilitySkills(userSkills);
  const skillCacheKey = normalizedUserSkills.join(',');

  let qParts = [];

  if (query && query.trim() !== '') {
    qParts.push(query.trim());
  }

  if (language && language !== 'all') {
    qParts.push(`language:${language.toLowerCase()}`);
  }

  if (topic && topic !== 'all') {
    qParts.push(`topic:${topic.toLowerCase()}`);
  }

  const numericStars = parseInt(minStars, 10);
  if (!isNaN(numericStars) && numericStars > 0) {
    qParts.push(`stars:>=${numericStars}`);
  }

  if (qParts.length === 0) {
    qParts.push('stars:>=50');
  }

  const queryString = qParts.join(' ');

  // User-agnostic raw search cache key; user-specific compatibility is recomputed dynamically per caller.
  const cacheKey = `repo_search:${queryString}:${sort}:${order}:${safePage}:${safePerPage}`;

function computeNormalizedRepoHealth(repo) {
  return calculateRepositoryHealth({
    ...repo,
    pushed_at: repo.pushedAt || repo.pushed_at || null,
    updated_at: repo.updatedAtExact || repo.updated_at || null,
    stargazers_count: repo.stars !== undefined ? repo.stars : repo.stargazers_count,
    forks_count: repo.forks !== undefined ? repo.forks : repo.forks_count,
    open_issues_count: repo.openIssues !== undefined ? repo.openIssues : repo.open_issues_count,
    has_issues: repo.hasIssues !== undefined ? repo.hasIssues : repo.has_issues,
    archived: Boolean(repo.archived),
    homepage: repo.homepage || ''
  });
}

function personalizeRepoList(rawRepos, skills) {
  const mapped = (Array.isArray(rawRepos) ? rawRepos : []).map(r => {
    const compatibility = calculateRepositoryCompatibility(r, skills);
    return {
      ...r,
      compatibilityScore: compatibility.score,
      matchedSkills: compatibility.matchedSkills,
      totalSkills: compatibility.totalSkills,
      health: computeNormalizedRepoHealth(r)
    };
  });
  mapped.sort((a, b) => b.compatibilityScore - a.compatibilityScore);
  return mapped;
}

  // Check cache (10 min TTL)
  const cached = getCached(cacheKey);
  if (cached) {
    return {
      ...cached.data,
      repositories: personalizeRepoList(cached.data?.repositories, normalizedUserSkills),
      rateLimit: cached.headers?.rateLimit || null,
      cached: true,
      stale: false,
      cachedAt: cached.headers?.cachedAt || null
    };
  }

  return withInFlightDedupe(cacheKey, async () => {
    const activeBlock = getActiveRateLimitBlock('search', token);
    if (activeBlock) {
      const stale = getCached(cacheKey, { allowStale: true });
      return {
        ...(stale ? stale.data : { totalCount: 0, page: safePage, perPage: safePerPage, totalPages: 0 }),
        repositories: stale ? personalizeRepoList(stale.data?.repositories, normalizedUserSkills) : [],
        rateLimit: {
          limit: activeBlock.limit,
          remaining: activeBlock.remaining,
          resetEpoch: activeBlock.resetEpoch,
          resetAtIso: activeBlock.resetAtIso,
          resetInMinutes: activeBlock.resetInMinutes,
          resource: 'search',
          rateLimitType: activeBlock.rateLimitType,
          isExhausted: true
        },
        cached: Boolean(stale),
        stale: Boolean(stale),
        rateLimited: true,
        rateLimitType: activeBlock.rateLimitType,
        error: 'RATE_LIMIT_EXCEEDED',
        errorMessage: stale ? `${activeBlock.message} Showing preserved cached repositories.` : activeBlock.message
      };
    }

    let sortParam = '';
    if (['stars', 'forks', 'updated'].includes(sort)) {
      sortParam = `&sort=${sort}&order=${order === 'asc' ? 'asc' : 'desc'}`;
    }

    const url = `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(queryString)}${sortParam}&page=${safePage}&per_page=${safePerPage}`;
    const { res, networkError } = await safeGithubFetch(url, token, fetchImpl);

    if (networkError || !res) {
      const stale = getCached(cacheKey, { allowStale: true });
      if (stale) {
        return {
          ...stale.data,
          repositories: personalizeRepoList(stale.data?.repositories, normalizedUserSkills),
          rateLimit: stale.headers?.rateLimit || null,
          cached: true,
          stale: true,
          error: 'NETWORK_ERROR',
          errorMessage: 'Unable to reach GitHub API. Showing preserved cached repositories.'
        };
      }
      return {
        repositories: [],
        totalCount: 0,
        page: safePage,
        perPage: safePerPage,
        totalPages: 0,
        rateLimit: null,
        error: 'NETWORK_ERROR',
        errorMessage: 'Unable to reach GitHub API. Please check your internet connection and try again.'
      };
    }

    const rateLimit = parseRateLimit(res.headers);

    if (res.status === 403 || res.status === 429) {
      let errBody = null;
      try { errBody = await res.json(); } catch (e) {}
      const rlClass = classifyRateLimitResponse(res.status, rateLimit, errBody);
      if (rlClass.isRateLimited) {
        recordRateLimitBlock('search', token, rlClass, rateLimit);
      }
      const stale = getCached(cacheKey, { allowStale: true });
      const rlMsg = rlClass.message || `GitHub API search rate limit reached. Limit resets in ${rateLimit?.resetInMinutes ?? 1} minute(s).`;
      return {
        ...(stale ? stale.data : { totalCount: 0, page: safePage, perPage: safePerPage, totalPages: 0 }),
        repositories: stale ? personalizeRepoList(stale.data?.repositories, normalizedUserSkills) : [],
        rateLimit: rateLimit ? { ...rateLimit, resetEpoch: rlClass.resetEpoch || rateLimit.resetEpoch, resetAtIso: rlClass.resetAtIso || rateLimit.resetAtIso, rateLimitType: rlClass.rateLimitType } : null,
        cached: Boolean(stale),
        stale: Boolean(stale),
        rateLimited: true,
        rateLimitType: rlClass.rateLimitType || 'primary',
        error: 'RATE_LIMIT_EXCEEDED',
        errorMessage: stale ? `${rlMsg} Showing preserved cached repositories.` : rlMsg
      };
    }

    if (!res.ok) {
      const stale = getCached(cacheKey, { allowStale: true });
      if (stale) {
        return {
          ...stale.data,
          repositories: personalizeRepoList(stale.data?.repositories, normalizedUserSkills),
          rateLimit,
          cached: true,
          stale: true,
          error: `API_ERROR_${res.status}`,
          errorMessage: `GitHub API returned HTTP ${res.status}. Showing preserved cached repositories.`
        };
      }
      return {
        repositories: [],
        totalCount: 0,
        page: safePage,
        perPage: safePerPage,
        totalPages: 0,
        rateLimit,
        error: `API_ERROR_${res.status}`,
        errorMessage: `GitHub API returned error HTTP ${res.status}.`
      };
    }

    const data = await res.json();
    const totalCount = data.total_count || 0;

    // GitHub limits search pagination to the top 1,000 results.
    const totalPages = Math.min(
      Math.ceil(totalCount / safePerPage),
      Math.floor(1000 / safePerPage)
    );

    const baseRepositories = (data.items || []).map(item => {
      const langKey = (item.language || '').toLowerCase();
      const langColor = LANGUAGE_COLORS[langKey] || '#818CF8';

      const repository = {
        id: item.id,
        name: item.name,
        fullName: item.full_name,
        owner: {
          login: item.owner ? item.owner.login : '',
          avatarUrl: item.owner
            ? item.owner.avatar_url
            : 'https://avatars.githubusercontent.com/u/9919?v=4',
          htmlUrl: item.owner
            ? item.owner.html_url
            : `https://github.com/${item.name}`
        },
        htmlUrl: item.html_url,
        description: item.description || 'No description provided.',
        language: item.language || 'Other',
        languageColor: langColor,
        stars: item.stargazers_count || 0,
        forks: item.forks_count || 0,
        openIssues: item.open_issues_count || 0,
        topics: Array.isArray(item.topics) ? item.topics.slice(0, 6) : [],
        license: item.license
          ? (item.license.spdx_id || item.license.name)
          : null,
        homepage: item.homepage || '',
        archived: Boolean(item.archived),
        hasIssues: item.has_issues !== undefined ? Boolean(item.has_issues) : true,
        pushedAt: item.pushed_at || null,
        updatedAt: formatRelativeTime(item.updated_at),
        updatedAtExact: item.updated_at || null,
        health: null
      };
      repository.health = computeNormalizedRepoHealth(repository);
      return repository;
    });

    const basePayload = {
      repositories: baseRepositories,
      totalCount,
      page: safePage,
      perPage: safePerPage,
      totalPages
    };

    setCache(cacheKey, basePayload, { rateLimit }, 600);

    return {
      ...basePayload,
      repositories: personalizeRepoList(baseRepositories, normalizedUserSkills),
      rateLimit,
      cached: false,
      stale: false
    };
  }).then(result => ({
    ...result,
    repositories: personalizeRepoList(result.repositories, normalizedUserSkills)
  }));
}
// ----------------------------------------------------
// 6. Contributor Leaderboard Synchronization
// ----------------------------------------------------

async function syncContributorFromGitHub(username, token = null) {
  const cleanUsername = (username || '').trim().replace(/^@/, '');
  if (!cleanUsername) {
    throw new Error('A valid GitHub username is required.');
  }

  // 1. Fetch user profile from official GitHub API
  const profileRes = await getUserProfile(cleanUsername, token);
  if (!profileRes.user) {
    if (profileRes.error === 'NOT_FOUND') {
      throw new Error(`GitHub user "@${cleanUsername}" was not found. Please verify the username.`);
    }
    throw new Error(`Unable to fetch profile for "@${cleanUsername}" (GitHub API error: ${profileRes.error}).`);
  }
  const ghUser = profileRes.user;

  // 2. Upsert contributor profile into database
  const contributor = upsertContributor({
    github_id: ghUser.id,
    username: ghUser.login,
    name: ghUser.name || ghUser.login,
    avatar_url: ghUser.avatar_url,
    bio: ghUser.bio || '',
    html_url: ghUser.html_url || `https://github.com/${ghUser.login}`,
    public_repos: ghUser.public_repos || 0,
    followers: ghUser.followers || 0
  });

  // 3. Fetch up to 100 recent public events from official GitHub Events API
  let events = [];
  try {
    const { res } = await safeGithubFetch(`${GITHUB_API_BASE}/users/${encodeURIComponent(cleanUsername)}/events/public?per_page=100`, token);
    if (res && res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        events = data;
      }
    }
  } catch (err) {
    console.warn(`[Leaderboard] Warning: Could not fetch events for @${cleanUsername}:`, err.message);
  }

  // 4. Record verified GitHub activities with points according to transparent rubric
  let recordedCount = 0;
  for (const ev of events) {
    let points = 2;
    let actionSummary = '';

    if (ev.type === 'PullRequestEvent') {
      const action = ev.payload?.action || 'opened';
      const isMerged = Boolean(ev.payload?.pull_request?.merged);
      if (isMerged) {
        points = 12;
        actionSummary = `Merged Pull Request in ${ev.repo?.name || 'repository'}`;
      } else if (action === 'opened') {
        points = 10;
        actionSummary = `Opened Pull Request in ${ev.repo?.name || 'repository'}`;
      } else {
        points = 4;
        actionSummary = `PR ${action} in ${ev.repo?.name || 'repository'}`;
      }
    } else if (ev.type === 'PushEvent') {
      const commitCount = ev.payload?.commits?.length || 1;
      points = Math.min(8, 4 + Math.max(0, commitCount - 1));
      actionSummary = `Pushed ${commitCount} commit${commitCount > 1 ? 's' : ''} to ${ev.repo?.name || 'repository'}`;
    } else if (ev.type === 'IssuesEvent') {
      const action = ev.payload?.action || 'opened';
      points = 5;
      actionSummary = `${action.charAt(0).toUpperCase() + action.slice(1)} issue in ${ev.repo?.name || 'repository'}`;
    } else if (ev.type === 'IssueCommentEvent' || ev.type === 'PullRequestReviewCommentEvent') {
      points = 3;
      actionSummary = `Code review / discussion on ${ev.repo?.name || 'repository'}`;
    } else if (ev.type === 'CreateEvent') {
      points = 2;
      actionSummary = `Created ${ev.payload?.ref_type || 'branch'} in ${ev.repo?.name || 'repository'}`;
    } else if (ev.type === 'WatchEvent' || ev.type === 'ForkEvent') {
      points = 1;
      actionSummary = `${ev.type === 'WatchEvent' ? 'Starred' : 'Forked'} ${ev.repo?.name || 'repository'}`;
    } else {
      points = 1;
      actionSummary = `Activity in ${ev.repo?.name || 'repository'}`;
    }

    const recorded = recordContributorActivity(contributor.id, {
      event_id: String(ev.id),
      event_type: ev.type,
      repo_name: ev.repo?.name || '',
      action_summary: actionSummary,
      points,
      source: 'github',
      event_timestamp: ev.created_at
    });
    if (recorded) recordedCount++;
  }

  // 5. Connect any DevNexus platform activity (bookmarks, issues curated)
  const localUser = findUserByUsername(cleanUsername);
  if (localUser) {
    const bookmarks = getUserBookmarks(localUser.id);
    for (const b of bookmarks) {
      recordContributorActivity(contributor.id, {
        event_id: `devnexus_bm_${localUser.id}_${b.id}`,
        event_type: 'DevNexusBookmark',
        repo_name: b.repo_name,
        action_summary: `Curated issue #${b.issue_number} on DevNexus`,
        points: 1,
        source: 'devnexus',
        event_timestamp: b.created_at
      });
    }
  }

  return {
    contributor,
    totalEventsFound: events.length,
    newActivitiesRecorded: recordedCount
  };
}

// Automatically seed real open source contributors if database is empty
// Sync only contributors registered on DevNexus
async function seedInitialContributors(token = null) {
  const users = getAllUsers();

  for (const user of users) {
    if (!user.username) continue;

    try {
      await syncContributorFromGitHub(user.username, token);
      console.log(`[DevNexus Leaderboard] Synced @${user.username}`);
    } catch (err) {
      console.warn(
        `[DevNexus Leaderboard] Could not sync @${user.username}: ${err.message}`
      );
    }
  }
}

module.exports = {
  isOAuthConfigured,
  getOAuthAuthorizeUrl,
  exchangeOAuthCode,
  getCallbackUrl,
  getAuthenticatedUser,
  getUserProfile,
  getUserRepositories,
  getUserEvents,
  searchIssues,
  searchRepositories,
  parseRateLimit,
  classifyRateLimitResponse,
  getActiveRateLimitBlock,
  recordRateLimitBlock,
  safeGithubFetch,
  LANGUAGE_COLORS,
  syncContributorFromGitHub,
  seedInitialContributors,
  calculateRepositoryHealth,
  calculateContributionReadiness,
  evaluateIssueReadiness,
  calculateCompatibility,
  calculateRepositoryCompatibility
};
