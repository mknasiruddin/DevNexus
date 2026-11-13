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

const {
  calculateRepositoryHealth,
  calculateContributionReadiness,
  evaluateIssueReadiness
} = require('./saanviModulesService');

const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'DevNexus-Platform/1.0.0 (Node.js/Express; Educational Capstone)';

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
async function safeGithubFetch(url, token = null) {
  try {
    let res = await fetch(url, { headers: getHeaders(token, true) });
    if (res.status === 401 && getEffectiveToken(token)) {
      res = await fetch(url, { headers: getHeaders(null, false) });
    }
    return { res, networkError: null };
  } catch (err) {
    return { res: null, networkError: err };
  }
}

// Parse rate limit headers
function parseRateLimit(headers) {
  if (!headers) return null;
  const limit = parseInt(headers.get ? headers.get('x-ratelimit-limit') : headers['x-ratelimit-limit'] || '60', 10);
  const remaining = parseInt(headers.get ? headers.get('x-ratelimit-remaining') : headers['x-ratelimit-remaining'] || '60', 10);
  const resetEpoch = parseInt(headers.get ? headers.get('x-ratelimit-reset') : headers['x-ratelimit-reset'] || '0', 10);
  const used = parseInt(headers.get ? headers.get('x-ratelimit-used') : headers['x-ratelimit-used'] || '0', 10);
  const resource = headers.get ? headers.get('x-ratelimit-resource') : headers['x-ratelimit-resource'] || 'core';

  const resetMs = resetEpoch ? resetEpoch * 1000 : Date.now();
  const resetInMinutes = Math.max(0, Math.ceil((resetMs - Date.now()) / 60000));

  return {
    limit,
    remaining,
    used,
    resetEpoch,
    resetInMinutes,
    resource,
    isExhausted: remaining <= 0
  };
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
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  return Boolean(clientId && clientSecret && clientId.trim() !== '' && clientSecret.trim() !== '');
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
      code,
      redirect_uri: callbackUrl
    })
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
  }

  return data; // { access_token, token_type, scope }
}

// ----------------------------------------------------
// 2. Profile & Repository Retrieval
// ----------------------------------------------------

async function getAuthenticatedUser(accessToken) {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: getHeaders(accessToken)
  });

  const rateLimit = parseRateLimit(res.headers);
  if (!res.ok) {
    throw new Error(`Failed to fetch authenticated GitHub user (HTTP ${res.status})`);
  }

  const user = await res.json();

  // Try to retrieve primary verified email if private
  let email = user.email;
  if (!email && accessToken) {
    try {
      const emailRes = await fetch(`${GITHUB_API_BASE}/user/emails`, {
        headers: getHeaders(accessToken)
      });
      if (emailRes.ok) {
        const emails = await emailRes.json();
        const primary = emails.find(e => e.primary && e.verified);
        if (primary) email = primary.email;
      }
    } catch (e) {
      // Non-critical email retrieval failure
    }
  }

  return { user: { ...user, email }, rateLimit };
}

async function getUserProfile(username, token = null) {
  const cleanUser = String(username || '').trim();
  if (!cleanUser) {
    return { user: null, rateLimit: null, error: 'INVALID_USERNAME' };
  }
  const cacheKey = `user_profile:${cleanUser.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return { user: cached.data, rateLimit: cached.headers.rateLimit || null, cached: true };
  }

  const { res, networkError } = await safeGithubFetch(`${GITHUB_API_BASE}/users/${encodeURIComponent(cleanUser)}`, token);
  if (networkError || !res) {
    return { user: null, rateLimit: null, error: 'NETWORK_ERROR' };
  }

  const rateLimit = parseRateLimit(res.headers);
  if (res.status === 404) {
    return { user: null, rateLimit, error: 'NOT_FOUND' };
  }
  if (!res.ok) {
    return { user: null, rateLimit, error: `HTTP_${res.status}` };
  }

  const user = await res.json();
  setCache(cacheKey, user, { rateLimit }, 600); // 10 min cache
  return { user, rateLimit, cached: false };
}

async function getUserRepositories(username, token = null, { sort = 'updated', perPage = 6 } = {}) {
  const cleanUser = String(username || '').trim();
  const cacheKey = `user_repos:${cleanUser.toLowerCase()}:${perPage}`;
  const cached = getCached(cacheKey);
  if (cached) {
    const enrichedCached = (Array.isArray(cached.data) ? cached.data : []).map(r => ({
      ...r,
      health: r.health || calculateRepositoryHealth({
        ...r,
        updated_at: r.updatedAt,
        stargazers_count: r.stars,
        forks_count: r.forks,
        open_issues_count: r.openIssues
      })
    }));
    return { repos: enrichedCached, rateLimit: cached.headers.rateLimit || null, cached: true };
  }

  const { res, networkError } = await safeGithubFetch(`${GITHUB_API_BASE}/users/${encodeURIComponent(cleanUser)}/repos?sort=${sort}&per_page=${perPage}&type=owner`, token);
  if (networkError || !res) {
    return { repos: [], rateLimit: null, error: 'NETWORK_ERROR' };
  }

  const rateLimit = parseRateLimit(res.headers);
  if (!res.ok) {
    return { repos: [], rateLimit, error: `HTTP_${res.status}` };
  }

  const repos = await res.json();
  const sanitized = (Array.isArray(repos) ? repos : []).map(r => ({
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

  setCache(cacheKey, sanitized, { rateLimit }, 300);
  return { repos: sanitized, rateLimit, cached: false };
}

async function getUserEvents(username, token = null, { perPage = 8 } = {}) {
  const cleanUser = String(username || '').trim();
  const cacheKey = `user_events:${cleanUser.toLowerCase()}:${perPage}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return { events: cached.data, rateLimit: cached.headers.rateLimit || null, cached: true };
  }

  const { res, networkError } = await safeGithubFetch(`${GITHUB_API_BASE}/users/${encodeURIComponent(cleanUser)}/events/public?per_page=${perPage}`, token);
  if (networkError || !res) {
    return { events: [], rateLimit: null, error: 'NETWORK_ERROR' };
  }

  const rateLimit = parseRateLimit(res.headers);
  if (!res.ok) {
    return { events: [], rateLimit, error: `HTTP_${res.status}` };
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

  setCache(cacheKey, events, { rateLimit }, 180);
  return { events, rateLimit, cached: false };
}

// ----------------------------------------------------
// 3. Issue Discovery & Live Search
// ----------------------------------------------------

async function searchIssues({ query = '', label = 'all', language = 'all', difficulty = 'all', page = 1, perPage = 10 } = {}, userSkills = [], token = null) {
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

  // Check cache (5 min TTL)
  const cached = getCached(cacheKey);
  if (cached) {
    return {
      ...cached.data,
      rateLimit: cached.headers.rateLimit || null,
      cached: true
    };
  }

  const url = `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(queryString)}&sort=updated&order=desc&page=${safePage}&per_page=${safePerPage}`;
  const { res, networkError } = await safeGithubFetch(url, token);

  if (networkError || !res) {
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

  if (res.status === 403) {
    return {
      issues: [],
      totalCount: 0,
      page: safePage,
      perPage: safePerPage,
      totalPages: 0,
      rateLimit,
      error: 'RATE_LIMIT_EXCEEDED',
      errorMessage: `GitHub API search rate limit reached. Limit resets in ${rateLimit ? rateLimit.resetInMinutes : 1} minute(s).`
    };
  }

  if (!res.ok) {
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

  // Process & enrich issue items with compatibility scores
  const issues = (data.items || []).map(item => {
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

    // Algorithmic compatibility scoring based on real issue metadata and user profile
    const compat = calculateCompatibility(item, repoName, labels, userSkills);

    return {
      id: item.id,
      number: item.number,
      title: item.title,
      htmlUrl: item.html_url,
      repoName,
      repoUrl: `https://github.com/${repoName}`,
      labels,
      category,
      difficulty: isGoodFirst ? 'Beginner' : isHelpWanted ? 'Intermediate' : 'Advanced',
      commentsCount: item.comments || 0,
      createdAt: formatRelativeTime(item.created_at),
      compatibilityScore: compat.score,
      compatibilityBreakdown: compat.breakdown,
      author: item.user ? item.user.login : 'unknown'
    };
  });

  const payload = {
    issues,
    totalCount,
    page: safePage,
    perPage: safePerPage,
    totalPages
  };

  setCache(cacheKey, payload, { rateLimit }, 300); // 5 min cache
  return { ...payload, rateLimit, cached: false };
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

  const skillAliases = {
    js: ['javascript', 'js'],
    javascript: ['javascript', 'js', 'node.js', 'nodejs'],
    ts: ['typescript', 'ts'],
    typescript: ['typescript', 'ts'],
    py: ['python', 'py'],
    python: ['python', 'py'],
    react: ['react', 'react.js'],
    'react.js': ['react', 'react.js'],
    node: ['node', 'node.js', 'nodejs'],
    'node.js': ['node', 'node.js', 'nodejs'],
    'c++': ['c++', 'cpp'],
    cpp: ['cpp', 'c++'],
    'c#': ['c#', 'csharp'],
    csharp: ['csharp', 'c#'],
    go: ['golang', 'go'],
    golang: ['golang', 'go']
  };

  const matchedSkills = skills.filter(skill => {
    const terms = skillAliases[skill] || [skill];

    return terms.some(term => {
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const pattern = new RegExp(
        `(^|[^a-z0-9+#])${escapedTerm}($|[^a-z0-9+#])`,
        'i'
      );

      return pattern.test(textCorpus);
    });
  });

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

  const skillAliases = {
    js: ['javascript', 'js'],
    javascript: ['javascript', 'js', 'node.js', 'nodejs'],
    ts: ['typescript', 'ts'],
    typescript: ['typescript', 'ts'],
    py: ['python', 'py'],
    python: ['python', 'py'],
    react: ['react', 'react.js'],
    'react.js': ['react', 'react.js'],
    node: ['node', 'node.js', 'nodejs'],
    'node.js': ['node', 'node.js', 'nodejs'],
    'c++': ['c++', 'cpp'],
    cpp: ['cpp', 'c++'],
    'c#': ['c#', 'csharp'],
    csharp: ['csharp', 'c#'],
    go: ['golang', 'go'],
    golang: ['golang', 'go']
  };

  const matchedSkills = skills.filter(skill => {
    const terms = skillAliases[skill] || [skill];

    return terms.some(term => {
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `(^|[^a-z0-9+#])${escapedTerm}($|[^a-z0-9+#])`,
        'i'
      );

      return pattern.test(repositoryText);
    });
  });

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
} = {}, token = null) {
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

  // Include user skills in cache key to prevent mixing personalized results.
  const cacheKey = `repo_search:${queryString}:${sort}:${order}:${safePage}:${safePerPage}:${skillCacheKey}`;

  // Check cache (5 min TTL)
  const cached = getCached(cacheKey);

  if (cached) {
    const cachedRepos = Array.isArray(cached.data?.repositories)
      ? cached.data.repositories.map(r => {
          const compatibility = calculateRepositoryCompatibility(
            r,
            normalizedUserSkills
          );

          return {
            ...r,
            compatibilityScore: compatibility.score,
            matchedSkills: compatibility.matchedSkills,
            totalSkills: compatibility.totalSkills,
            health: r.health || calculateRepositoryHealth({
              ...r,
              updated_at: r.updatedAtExact,
              stargazers_count: r.stars,
              forks_count: r.forks,
              open_issues_count: r.openIssues
            })
          };
        })
      : [];

    cachedRepos.sort(
      (a, b) => b.compatibilityScore - a.compatibilityScore
    );

    return {
      ...cached.data,
      repositories: cachedRepos,
      rateLimit: cached.headers?.rateLimit || null,
      cached: true
    };
  }

  let sortParam = '';

  if (['stars', 'forks', 'updated'].includes(sort)) {
    sortParam = `&sort=${sort}&order=${order === 'asc' ? 'asc' : 'desc'}`;
  }

  const url = `${GITHUB_API_BASE}/search/repositories?q=${encodeURIComponent(queryString)}${sortParam}&page=${safePage}&per_page=${safePerPage}`;

  const { res, networkError } = await safeGithubFetch(url, token);

  if (networkError || !res) {
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

  if (res.status === 403) {
    return {
      repositories: [],
      totalCount: 0,
      page: safePage,
      perPage: safePerPage,
      totalPages: 0,
      rateLimit,
      error: 'RATE_LIMIT_EXCEEDED',
      errorMessage: `GitHub API search rate limit reached. Limit resets in ${rateLimit ? rateLimit.resetInMinutes : 1} minute(s).`
    };
  }

  if (!res.ok) {
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

  const repositories = (data.items || []).map(item => {
    const langKey = (item.language || '').toLowerCase();
    const langColor = LANGUAGE_COLORS[langKey] || '#818CF8';
    const health = calculateRepositoryHealth(item);

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
      updatedAt: formatRelativeTime(item.updated_at),
      updatedAtExact: item.updated_at,
      health
    };

    const compatibility = calculateRepositoryCompatibility(
      repository,
      normalizedUserSkills
    );

    return {
      ...repository,
      compatibilityScore: compatibility.score,
      matchedSkills: compatibility.matchedSkills,
      totalSkills: compatibility.totalSkills
    };
  });

  // Show repositories with the highest skill compatibility first.
  repositories.sort(
    (a, b) => b.compatibilityScore - a.compatibilityScore
  );

  const payload = {
    repositories,
    totalCount,
    page: safePage,
    perPage: safePerPage,
    totalPages
  };

  setCache(cacheKey, payload, { rateLimit }, 300);

  return {
    ...payload,
    rateLimit,
    cached: false
  };
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
  LANGUAGE_COLORS,
  syncContributorFromGitHub,
  seedInitialContributors,
  calculateRepositoryHealth,
  calculateContributionReadiness,
  evaluateIssueReadiness
};
