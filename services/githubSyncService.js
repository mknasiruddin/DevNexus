/**
 * DevNexus GitHub Activity Synchronization Service
 *
 * Synchronizes authenticated developer GitHub accounts (strictly keyed by user_id + github_id):
 * - Fetches user profile, paginated repositories, language distribution, commits (90-day window),
 *   pull requests (created & merged), issues (opened & closed), branches, and releases.
 * - Integrates verified GitHub repository metadata directly with Repository Health Score.
 * - Respects GitHub API rate limits, avoids duplicate/concurrent calls, encrypts OAuth tokens at rest,
 *   never exposes tokens to the frontend, and enforces strict per-user private repo isolation.
 */

const {
  findUserById,
  getUserGithubSyncToken,
  clearUserGithubSyncToken,
  markGithubSyncStatus,
  upsertGithubSyncState,
  getUserGithubSyncState,
  replaceUserSyncedRepos,
  getUserSyncedRepos,
  upsertUserSyncedActivities,
  getUserSyncedActivities,
  getScheduledGithubSyncUsers,
  logActivity,
  getCached,
  setCache
} = require('../db/database');

const {
  parseRateLimit,
  classifyRateLimitResponse,
  getActiveRateLimitBlock,
  recordRateLimitBlock,
  LANGUAGE_COLORS
} = require('./githubService');

const {
  calculateRepositoryHealth
} = require('./saanviModulesService');

const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'DevNexus-Platform/1.0.0 (Node.js/Express; GitHub-Sync)';
const COMMIT_PERIOD_DAYS = 90;
const AUTO_SYNC_STALE_MS = 15 * 60 * 1000;
const MANUAL_SYNC_COOLDOWN_MS = 60 * 1000;
const ERROR_RETRY_BACKOFF_MS = 2 * 60 * 1000;
const MAX_REPO_PAGES = 25;

const inFlightSyncs = new Map();
let schedulerTimer = null;

function formatRelativeTime(isoDate) {
  if (!isoDate) return 'recently';
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  if (mins > 0) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  return 'just now';
}

function buildGithubHeaders(token = null, accept = 'application/vnd.github.v3+json') {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function hasNextPageLink(headers) {
  if (!headers || typeof headers.get !== 'function') return false;
  const link = headers.get('link') || '';
  return link.includes('rel="next"');
}

function parseRepoNameFromApiUrl(repositoryUrl) {
  const match = String(repositoryUrl || '').match(/repos\/(.+?\/.+?)$/);
  return match ? match[1] : '';
}

function computeLanguageDistribution(repos = []) {
  const counts = new Map();
  let totalWithLang = 0;

  for (const repo of repos) {
    const lang = repo && repo.language && repo.language !== 'Other' ? String(repo.language).trim() : null;
    if (!lang) continue;
    totalWithLang++;
    counts.set(lang, (counts.get(lang) || 0) + 1);
  }

  if (totalWithLang === 0) return [];

  return Array.from(counts.entries())
    .map(([language, count]) => ({
      language,
      count,
      percentage: Math.round((count / totalWithLang) * 100),
      color: LANGUAGE_COLORS[language.toLowerCase()] || '#818CF8'
    }))
    .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language))
    .slice(0, 8);
}

function isOwnedByAuthenticatedUser(repo, targetGithubId, githubLogin) {
  if (!repo || repo.id === undefined || repo.id === null) return false;

  const expectedId = String(targetGithubId || '').trim();
  const expectedLogin = String(githubLogin || '').trim().toLowerCase();

  // Reject organization-owned repositories explicitly
  if (repo.owner && repo.owner.type && String(repo.owner.type).toLowerCase() !== 'user') {
    return false;
  }

  // Primary identity check: exact numeric/string GitHub owner ID match
  if (repo.owner && repo.owner.id !== undefined && repo.owner.id !== null) {
    return Boolean(expectedId) && String(repo.owner.id) === expectedId;
  }

  // Secondary identity check: owner login match
  if (repo.owner && repo.owner.login) {
    return Boolean(expectedLogin) && String(repo.owner.login).toLowerCase() === expectedLogin;
  }

  // Fallback for minimal fixtures lacking an owner sub-object: verify owner segment of full_name
  if (repo.full_name && String(repo.full_name).includes('/')) {
    const [ownerPart] = String(repo.full_name).split('/');
    return Boolean(expectedLogin) && ownerPart.toLowerCase() === expectedLogin;
  }

  return false;
}

function mapRawRepoToSynced(r) {
  const lang = r.language || 'Other';
  const langColor = LANGUAGE_COLORS[String(lang).toLowerCase()] || '#818CF8';
  const health = calculateRepositoryHealth({
    ...r,
    pushed_at: r.pushed_at || r.updated_at || null,
    updated_at: r.updated_at || r.pushed_at || null,
    open_issues_count: r.open_issues_count,
    stargazers_count: r.stargazers_count,
    forks_count: r.forks_count,
    has_issues: r.has_issues,
    archived: r.archived
  });

  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name || r.name,
    htmlUrl: r.html_url,
    description: r.description || 'No description provided.',
    language: lang,
    languageColor: langColor,
    isPrivate: Boolean(r.private),
    isFork: Boolean(r.fork),
    stars: r.stargazers_count || 0,
    forks: r.forks_count || 0,
    openIssues: r.open_issues_count || 0,
    license: r.license ? (typeof r.license === 'string' ? r.license : (r.license.spdx_id || r.license.name)) : null,
    topics: Array.isArray(r.topics) ? r.topics.slice(0, 6) : [],
    homepage: r.homepage || '',
    hasIssues: r.has_issues !== undefined ? Boolean(r.has_issues) : true,
    archived: Boolean(r.archived),
    pushedAt: r.pushed_at || null,
    updatedAt: r.updated_at || r.pushed_at || null,
    updatedAtExact: r.updated_at || r.pushed_at || null,
    health
  };
}

function normalizeGithubEvent(ev) {
  if (!ev || !ev.id) return null;
  const repoName = ev.repo?.name || '';
  const repoUrl = repoName ? `https://github.com/${repoName}` : 'https://github.com';
  const isPrivate = ev.public === false;
  const ts = ev.created_at || new Date().toISOString();

  if (ev.type === 'PushEvent') {
    const commitCount = Math.max(1, Number(ev.payload?.size ?? ev.payload?.distinct_size ?? ev.payload?.commits?.length ?? 1) || 1);
    const branch = String(ev.payload?.ref || '').replace(/^refs\/heads\//, '') || 'main';
    const headSha = ev.payload?.head || '';
    const targetUrl = headSha && repoName
      ? `${repoUrl}/commit/${headSha}`
      : (repoName ? `${repoUrl}/commits/${encodeURIComponent(branch)}` : repoUrl);

    return {
      eventId: `gh_ev_${ev.id}`,
      category: 'commit',
      eventType: 'PushEvent',
      action: 'pushed',
      title: `Pushed ${commitCount} commit${commitCount === 1 ? '' : 's'} to ${branch}`,
      repoName,
      repoUrl,
      targetUrl,
      commitCount,
      branchOrTag: branch,
      eventTimestamp: ts,
      isPrivate
    };
  }

  if (ev.type === 'PullRequestEvent') {
    const pr = ev.payload?.pull_request || {};
    const action = ev.payload?.action || 'opened';
    const merged = action === 'closed' && Boolean(pr.merged);
    const displayAction = merged ? 'merged' : action;
    const prNum = ev.payload?.number || pr.number || '';
    const prTitle = pr.title ? `: "${String(pr.title).slice(0, 75)}"` : '';

    return {
      eventId: `gh_ev_${ev.id}`,
      category: 'pr',
      eventType: 'PullRequestEvent',
      action: displayAction,
      title: `${displayAction.charAt(0).toUpperCase() + displayAction.slice(1)} Pull Request${prNum ? ` #${prNum}` : ''}${prTitle}`,
      repoName,
      repoUrl,
      targetUrl: pr.html_url || (repoName && prNum ? `${repoUrl}/pull/${prNum}` : repoUrl),
      commitCount: 0,
      branchOrTag: pr.head?.ref || '',
      eventTimestamp: ts,
      isPrivate
    };
  }

  if (ev.type === 'IssuesEvent') {
    const issue = ev.payload?.issue || {};
    const action = ev.payload?.action || 'opened';
    const issueNum = issue.number || '';
    const issueTitle = issue.title ? `: "${String(issue.title).slice(0, 75)}"` : '';

    return {
      eventId: `gh_ev_${ev.id}`,
      category: 'issue',
      eventType: 'IssuesEvent',
      action,
      title: `${action.charAt(0).toUpperCase() + action.slice(1)} Issue${issueNum ? ` #${issueNum}` : ''}${issueTitle}`,
      repoName,
      repoUrl,
      targetUrl: issue.html_url || (repoName && issueNum ? `${repoUrl}/issues/${issueNum}` : repoUrl),
      commitCount: 0,
      branchOrTag: '',
      eventTimestamp: ts,
      isPrivate
    };
  }

  if (ev.type === 'CreateEvent') {
    const refType = ev.payload?.ref_type || 'branch';
    const refName = ev.payload?.ref || '';
    if (refType === 'repository') {
      return {
        eventId: `gh_ev_${ev.id}`,
        category: 'repo',
        eventType: 'CreateEvent',
        action: 'created',
        title: `Created repository ${repoName}`,
        repoName,
        repoUrl,
        targetUrl: repoUrl,
        commitCount: 0,
        branchOrTag: '',
        eventTimestamp: ts,
        isPrivate
      };
    }

    return {
      eventId: `gh_ev_${ev.id}`,
      category: 'branch',
      eventType: 'CreateEvent',
      action: 'created',
      title: `Created ${refType}${refName ? ` "${refName}"` : ''}`,
      repoName,
      repoUrl,
      targetUrl: refName && repoName ? `${repoUrl}/tree/${encodeURIComponent(refName)}` : repoUrl,
      commitCount: 0,
      branchOrTag: refName,
      eventTimestamp: ts,
      isPrivate
    };
  }

  if (ev.type === 'ReleaseEvent') {
    const rel = ev.payload?.release || {};
    const action = ev.payload?.action || 'published';
    const tag = rel.tag_name || rel.name || '';
    return {
      eventId: `gh_ev_${ev.id}`,
      category: 'release',
      eventType: 'ReleaseEvent',
      action,
      title: `${action.charAt(0).toUpperCase() + action.slice(1)} release ${tag || 'version'}`,
      repoName,
      repoUrl,
      targetUrl: rel.html_url || `${repoUrl}/releases`,
      commitCount: 0,
      branchOrTag: tag,
      eventTimestamp: ts,
      isPrivate
    };
  }

  return null;
}

async function fetchJsonWithRateLimit(fetchImpl, url, token = null, accept = 'application/vnd.github.v3+json', bucket = 'core') {
  const activeBlock = getActiveRateLimitBlock(bucket, token);
  if (activeBlock) {
    return {
      ok: false,
      status: 403,
      rateLimited: true,
      rateLimitType: activeBlock.rateLimitType || 'primary',
      rateLimitMessage: activeBlock.message,
      rateLimit: {
        limit: activeBlock.limit,
        remaining: activeBlock.remaining,
        resetEpoch: activeBlock.resetEpoch,
        resetAtIso: activeBlock.resetAtIso,
        resetInSeconds: activeBlock.resetInSeconds,
        resetInMinutes: activeBlock.resetInMinutes,
        resource: bucket,
        isExhausted: true
      },
      data: null
    };
  }

  try {
    const res = await fetchImpl(url, { headers: buildGithubHeaders(token, accept) });
    const rateLimit = parseRateLimit(res.headers);
    if (res.status === 401) {
      return { ok: false, status: 401, unauthorized: true, rateLimit, data: null };
    }
    if (res.status === 403 || res.status === 429) {
      let errBody = null;
      try { errBody = await res.json(); } catch (e) {}
      const rlClass = classifyRateLimitResponse(res.status, rateLimit, errBody);
      if (rlClass.isRateLimited) {
        recordRateLimitBlock(bucket, token, rlClass, rateLimit);
        const enrichedRl = {
          ...(rateLimit || {}),
          limit: rateLimit ? rateLimit.limit : null,
          remaining: rateLimit ? rateLimit.remaining : 0,
          resetEpoch: rlClass.resetEpoch,
          resetAtIso: rlClass.resetAtIso,
          resetInSeconds: rlClass.waitSeconds,
          resetInMinutes: Math.max(1, Math.ceil(rlClass.waitSeconds / 60)),
          resource: (rateLimit && rateLimit.resource) || bucket,
          rateLimitType: rlClass.rateLimitType,
          isExhausted: true
        };
        return {
          ok: false,
          status: res.status,
          rateLimited: true,
          rateLimitType: rlClass.rateLimitType,
          rateLimitMessage: rlClass.message,
          rateLimit: enrichedRl,
          data: null
        };
      }
      return { ok: false, status: res.status, rateLimit, data: null };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, rateLimit, data: null };
    }
    const data = await res.json();
    return { ok: true, status: res.status, rateLimit, headers: res.headers, data };
  } catch (err) {
    return { ok: false, status: 0, networkError: err.message, rateLimit: null, data: null };
  }
}

function buildRateLimitResult(existingState, rateLimit, rateLimitType = 'primary', customMsg = null) {
  const resetEpoch = (rateLimit && rateLimit.resetEpoch) || (existingState && existingState.rateLimitResetEpoch) || null;
  const resetAtIso = resetEpoch ? new Date(resetEpoch * 1000).toISOString() : null;
  const resetText = resetEpoch
    ? `at ${new Date(resetEpoch * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    : 'after GitHub window reset';
  const kindLabel = rateLimitType === 'secondary' ? 'secondary rate limit' : 'rate limit';
  const msg = customMsg || `GitHub API ${kindLabel} reached. Preserving your last synced metrics until reset ${resetText}.`;

  return {
    ok: false,
    rateLimited: true,
    rateLimitType,
    reason: 'RATE_LIMIT_EXCEEDED',
    resetEpoch,
    resetAtIso,
    message: msg,
    rateLimit: rateLimit || null,
    syncState: existingState || null
  };
}

async function synchronizeUserGitHubActivity(userId, options = {}) {
  const numericUserId = Number(userId);
  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    return { ok: false, reason: 'INVALID_USER', message: 'Valid user ID required.' };
  }

  if (inFlightSyncs.has(numericUserId)) {
    return inFlightSyncs.get(numericUserId);
  }

  const syncPromise = executeSyncForUser(numericUserId, options).finally(() => {
    inFlightSyncs.delete(numericUserId);
  });
  inFlightSyncs.set(numericUserId, syncPromise);
  return syncPromise;
}

async function executeSyncForUser(userId, {
  sessionToken = null,
  force = false,
  respectManualCooldown = false,
  cooldownMs = MANUAL_SYNC_COOLDOWN_MS,
  fetchImpl = fetch
} = {}) {
  const user = findUserById(userId);
  if (!user) {
    return { ok: false, reason: 'USER_NOT_FOUND', message: 'Developer account not found.' };
  }

  if (!user.github_id) {
    return {
      ok: false,
      reason: 'GITHUB_NOT_CONNECTED',
      message: 'Connect your GitHub account via OAuth to synchronize personal GitHub activity.'
    };
  }

  const targetGithubId = String(user.github_id);
  const existingState = getUserGithubSyncState(user.id, targetGithubId);

  // Respect active GitHub rate-limit reset window strictly (prevents repeated retries before reset)
  if (existingState && existingState.lastSyncStatus === 'rate_limited' && existingState.rateLimitResetEpoch) {
    const resetMs = existingState.rateLimitResetEpoch * 1000;
    if (Date.now() < resetMs) {
      const resetMinutes = Math.max(1, Math.ceil((resetMs - Date.now()) / 60000));
      const resetClock = new Date(resetMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      return {
        ok: false,
        rateLimited: true,
        reason: 'RATE_LIMIT_EXCEEDED',
        resetEpoch: existingState.rateLimitResetEpoch,
        resetAtIso: new Date(resetMs).toISOString(),
        message: `GitHub API rate limit reached. Preserving your last synced metrics until reset at ${resetClock} (~${resetMinutes}m).`,
        syncState: existingState,
        cached: true
      };
    }
  }

  // Enforce manual sync cooldown (for interactive Sync GitHub button)
  if (respectManualCooldown && existingState && existingState.nextAllowedSyncAt) {
    const nextMs = new Date(existingState.nextAllowedSyncAt).getTime();
    if (Number.isFinite(nextMs) && nextMs > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((nextMs - Date.now()) / 1000));
      return {
        ok: true,
        cached: true,
        cooldownActive: true,
        retryAfterSeconds,
        nextAllowedSyncAt: existingState.nextAllowedSyncAt,
        message: `GitHub was synced recently. Manual sync available again in ${retryAfterSeconds}s.`,
        syncState: existingState
      };
    }
  }

  // Cooldown guard for automatic / non-manual refreshes
  if (!force && !respectManualCooldown && cooldownMs > 0 && existingState && existingState.lastSyncedAt) {
    const elapsedMs = Date.now() - new Date(existingState.lastSyncedAt).getTime();
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < cooldownMs) {
      return {
        ok: true,
        cached: true,
        skippedCooldown: true,
        message: 'Using recently synchronized GitHub activity.',
        syncState: existingState
      };
    }
  }

  const storedUserToken = getUserGithubSyncToken(user.id, targetGithubId);
  let activeToken = sessionToken || storedUserToken || process.env.GITHUB_TOKEN || null;
  let hasPersonalOAuthToken = Boolean(sessionToken || storedUserToken);

  markGithubSyncStatus(user.id, targetGithubId, user.username, { status: 'syncing' });

  let latestRateLimit = null;
  let ghProfile = null;

  // 1. Identify & verify the GitHub user strictly by GitHub ID
  if (hasPersonalOAuthToken) {
    const meRes = await fetchJsonWithRateLimit(fetchImpl, `${GITHUB_API_BASE}/user`, activeToken, 'application/vnd.github.v3+json', 'core');
    if (meRes.rateLimit) latestRateLimit = meRes.rateLimit;

    if (meRes.unauthorized) {
      clearUserGithubSyncToken(user.id);
      hasPersonalOAuthToken = false;
      activeToken = process.env.GITHUB_TOKEN || null;
    } else if (meRes.rateLimited) {
      const rateMsg = meRes.rateLimitMessage || 'GitHub API rate limit exceeded while verifying your profile.';
      markGithubSyncStatus(user.id, targetGithubId, user.username, {
        status: 'rate_limited',
        error: rateMsg,
        rateLimit: latestRateLimit,
        nextAllowedSyncAt: latestRateLimit?.resetAtIso || null
      });
      return buildRateLimitResult(getUserGithubSyncState(user.id, targetGithubId), latestRateLimit, meRes.rateLimitType || 'primary', rateMsg);
    } else if (meRes.ok && meRes.data) {
      if (String(meRes.data.id) !== targetGithubId) {
        clearUserGithubSyncToken(user.id);
        const mismatchMsg = 'Authenticated GitHub token belongs to a different GitHub ID. Please re-authenticate via GitHub OAuth.';
        markGithubSyncStatus(user.id, targetGithubId, user.username, {
          status: 'error',
          error: mismatchMsg,
          nextAllowedSyncAt: new Date(Date.now() + ERROR_RETRY_BACKOFF_MS).toISOString()
        });
        return { ok: false, reason: 'GITHUB_ID_MISMATCH', message: mismatchMsg };
      }
      ghProfile = meRes.data;
    }
  }

  if (!ghProfile) {
    let pubRes = await fetchJsonWithRateLimit(
      fetchImpl,
      `${GITHUB_API_BASE}/users/${encodeURIComponent(user.username)}`,
      activeToken,
      'application/vnd.github.v3+json',
      'core'
    );
    if (pubRes.unauthorized && activeToken) {
      activeToken = null;
      pubRes = await fetchJsonWithRateLimit(
        fetchImpl,
        `${GITHUB_API_BASE}/users/${encodeURIComponent(user.username)}`,
        null,
        'application/vnd.github.v3+json',
        'core'
      );
    }
    if (pubRes.rateLimit) latestRateLimit = pubRes.rateLimit;

    if (pubRes.rateLimited) {
      const rateMsg = pubRes.rateLimitMessage || 'GitHub API rate limit exceeded. Preserving your last synced metrics until reset.';
      markGithubSyncStatus(user.id, targetGithubId, user.username, {
        status: 'rate_limited',
        error: rateMsg,
        rateLimit: latestRateLimit,
        nextAllowedSyncAt: latestRateLimit?.resetAtIso || null
      });
      return buildRateLimitResult(getUserGithubSyncState(user.id, targetGithubId), latestRateLimit, pubRes.rateLimitType || 'primary', rateMsg);
    }

    if (!pubRes.ok || !pubRes.data) {
      const errMsg = pubRes.networkError
        ? 'Network error contacting GitHub API. Existing synced data preserved.'
        : `GitHub API returned HTTP ${pubRes.status} during profile lookup.`;
      markGithubSyncStatus(user.id, targetGithubId, user.username, {
        status: 'error',
        error: errMsg,
        rateLimit: latestRateLimit,
        nextAllowedSyncAt: new Date(Date.now() + ERROR_RETRY_BACKOFF_MS).toISOString()
      });
      return {
        ok: false,
        reason: pubRes.networkError ? 'NETWORK_ERROR' : 'API_ERROR',
        message: errMsg,
        syncState: getUserGithubSyncState(user.id, targetGithubId)
      };
    }

    if (String(pubRes.data.id) !== targetGithubId) {
      const mismatchMsg = `GitHub account ID mismatch for @${user.username}. Please reconnect via GitHub OAuth.`;
      markGithubSyncStatus(user.id, targetGithubId, user.username, {
        status: 'error',
        error: mismatchMsg,
        rateLimit: latestRateLimit,
        nextAllowedSyncAt: new Date(Date.now() + ERROR_RETRY_BACKOFF_MS).toISOString()
      });
      return { ok: false, reason: 'GITHUB_ID_MISMATCH', message: mismatchMsg };
    }
    ghProfile = pubRes.data;
  }

  const githubLogin = ghProfile.login || user.username;

  // 2. Paginated Owned Repository Retrieval (GET /user/repos?type=owner&per_page=100, deduplicated by repo ID)
  const dedupedReposById = new Map();
  let repoFetchFailed = false;
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    if (latestRateLimit && latestRateLimit.remaining <= 2) break;
    const repoUrl = hasPersonalOAuthToken
      ? `${GITHUB_API_BASE}/user/repos?type=owner&per_page=100&sort=updated&page=${page}`
      : `${GITHUB_API_BASE}/users/${encodeURIComponent(githubLogin)}/repos?type=owner&per_page=100&sort=updated&page=${page}`;

    const repoRes = await fetchJsonWithRateLimit(fetchImpl, repoUrl, activeToken);
    if (repoRes.rateLimit) latestRateLimit = repoRes.rateLimit;

    if (repoRes.rateLimited) {
      const rateMsg = 'GitHub API rate limit reached while loading repositories.';
      markGithubSyncStatus(user.id, targetGithubId, githubLogin, {
        status: 'rate_limited',
        error: rateMsg,
        rateLimit: latestRateLimit
      });
      return {
        ok: false,
        rateLimited: true,
        reason: 'RATE_LIMIT_EXCEEDED',
        message: rateMsg,
        syncState: getUserGithubSyncState(user.id, targetGithubId)
      };
    }

    if (!repoRes.ok || !Array.isArray(repoRes.data)) {
      if (page === 1) repoFetchFailed = true;
      break;
    }

    if (repoRes.data.length === 0) {
      break;
    }

    for (const repo of repoRes.data) {
      if (!isOwnedByAuthenticatedUser(repo, targetGithubId, githubLogin)) {
        continue;
      }
      const uniqueRepoKey = String(repo.id);
      if (!dedupedReposById.has(uniqueRepoKey)) {
        dedupedReposById.set(uniqueRepoKey, repo);
      }
    }

    const linkHeader = repoRes.headers && typeof repoRes.headers.get === 'function'
      ? (repoRes.headers.get('link') || '')
      : '';
    const hasNext = hasNextPageLink(repoRes.headers);
    if (linkHeader && !hasNext) {
      break;
    }
    if (repoRes.data.length < 100 && !hasNext) {
      break;
    }
  }

  if (repoFetchFailed && dedupedReposById.size === 0) {
    const errMsg = 'Unable to retrieve repositories from GitHub API. Previous synced snapshot preserved.';
    markGithubSyncStatus(user.id, targetGithubId, githubLogin, {
      status: 'error',
      error: errMsg,
      rateLimit: latestRateLimit
    });
    return {
      ok: false,
      reason: 'REPO_FETCH_FAILED',
      message: errMsg,
      syncState: getUserGithubSyncState(user.id, targetGithubId)
    };
  }

  const syncedRepos = Array.from(dedupedReposById.values()).map(mapRawRepoToSynced);
  const languageDistribution = computeLanguageDistribution(syncedRepos);

  const publicRepos = syncedRepos.filter(r => !r.isPrivate).length;
  const privateRepos = syncedRepos.filter(r => r.isPrivate).length;
  const totalRepos = syncedRepos.length;

  // 3. Paginated Events & Timeline Normalization (last 90 days counting window, up to 3 pages x 100)
  const periodCutoffMs = Date.now() - COMMIT_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const rawEvents = [];
  for (let page = 1; page <= 3; page++) {
    if (latestRateLimit && latestRateLimit.remaining <= 2) break;
    const evUrl = hasPersonalOAuthToken
      ? `${GITHUB_API_BASE}/users/${encodeURIComponent(githubLogin)}/events?per_page=100&page=${page}`
      : `${GITHUB_API_BASE}/users/${encodeURIComponent(githubLogin)}/events/public?per_page=100&page=${page}`;

    const evRes = await fetchJsonWithRateLimit(fetchImpl, evUrl, activeToken);
    if (evRes.rateLimit) latestRateLimit = evRes.rateLimit;
    if (evRes.rateLimited || !evRes.ok || !Array.isArray(evRes.data) || evRes.data.length === 0) {
      break;
    }
    rawEvents.push(...evRes.data);
    const oldestTs = new Date(evRes.data[evRes.data.length - 1]?.created_at || Date.now()).getTime();
    if (evRes.data.length < 100 || (Number.isFinite(oldestTs) && oldestTs < periodCutoffMs)) {
      break;
    }
  }

  const normalizedActivities = [];
  let pushCommits90d = 0;
  let eventContributions90d = 0;
  let fallbackPrsCreated = 0;
  let fallbackPrsMerged = 0;
  let fallbackIssuesCreated = 0;
  let fallbackIssuesClosed = 0;

  for (const ev of rawEvents) {
    const evTime = new Date(ev.created_at || 0).getTime();
    const inPeriod = Number.isFinite(evTime) && evTime >= periodCutoffMs;
    if (inPeriod) {
      eventContributions90d++;
    }

    if (ev.type === 'PushEvent' && inPeriod) {
      pushCommits90d += Math.max(1, Number(ev.payload?.size ?? ev.payload?.distinct_size ?? ev.payload?.commits?.length ?? 1) || 1);
    } else if (ev.type === 'PullRequestEvent') {
      const action = ev.payload?.action;
      if (action === 'opened') fallbackPrsCreated++;
      if (action === 'closed' && ev.payload?.pull_request?.merged) fallbackPrsMerged++;
    } else if (ev.type === 'IssuesEvent') {
      const action = ev.payload?.action;
      if (action === 'opened') fallbackIssuesCreated++;
      if (action === 'closed') fallbackIssuesClosed++;
    }

    const norm = normalizeGithubEvent(ev);
    if (norm) normalizedActivities.push(norm);
  }

  // 4. Authoritative PRs, Issues & 90-day Commit Search (respecting Search bucket quota & caching 10 min on live calls)
  let prsCreated = fallbackPrsCreated;
  let prsMerged = fallbackPrsMerged;
  let issuesCreated = fallbackIssuesCreated;
  let issuesClosed = fallbackIssuesClosed;
  let totalCommits90d = pushCommits90d;

  const searchSummaryCacheKey = `sync_search_summary:${user.id}:${targetGithubId}:${githubLogin}`;
  const isLiveFetch = fetchImpl === fetch;
  const cachedSearchSummary = (!force && isLiveFetch) ? getCached(searchSummaryCacheKey) : null;
  const searchBlocked = Boolean(getActiveRateLimitBlock('search', activeToken));
  const coreLow = latestRateLimit && latestRateLimit.remaining !== null && latestRateLimit.remaining < 6;

  if (cachedSearchSummary && cachedSearchSummary.data) {
    prsCreated = Math.max(fallbackPrsCreated, cachedSearchSummary.data.prsCreated || 0);
    prsMerged = Math.max(fallbackPrsMerged, cachedSearchSummary.data.prsMerged || 0);
    issuesCreated = Math.max(fallbackIssuesCreated, cachedSearchSummary.data.issuesCreated || 0);
    issuesClosed = Math.max(fallbackIssuesClosed, cachedSearchSummary.data.issuesClosed || 0);
    totalCommits90d = Math.max(pushCommits90d, cachedSearchSummary.data.totalCommits90d || 0);
  } else if (!searchBlocked && !coreLow) {
    const prCreatedRes = await fetchJsonWithRateLimit(
      fetchImpl,
      `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(`author:${githubLogin} type:pr`)}&sort=updated&order=desc&per_page=15`,
      activeToken,
      'application/vnd.github.v3+json',
      'search'
    );
    if (prCreatedRes.ok && prCreatedRes.data) {
      prsCreated = Math.max(fallbackPrsCreated, Number(prCreatedRes.data.total_count) || 0);
      for (const item of (prCreatedRes.data.items || [])) {
        const repoName = parseRepoNameFromApiUrl(item.repository_url);
        const isMerged = Boolean(item.pull_request?.merged_at);
        const action = isMerged ? 'merged' : (item.state === 'closed' ? 'closed' : 'opened');
        normalizedActivities.push({
          eventId: `gh_pr_${item.id}`,
          category: 'pr',
          eventType: 'PullRequestSearch',
          action,
          title: `${action.charAt(0).toUpperCase() + action.slice(1)} Pull Request #${item.number}: "${String(item.title || '').slice(0, 75)}"`,
          repoName,
          repoUrl: repoName ? `https://github.com/${repoName}` : item.html_url,
          targetUrl: item.html_url,
          commitCount: 0,
          branchOrTag: '',
          eventTimestamp: item.pull_request?.merged_at || item.closed_at || item.updated_at || item.created_at,
          isPrivate: false
        });
      }
    }

    if (!prCreatedRes.rateLimited) {
      const prMergedRes = await fetchJsonWithRateLimit(
        fetchImpl,
        `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(`author:${githubLogin} type:pr is:merged`)}&per_page=1`,
        activeToken,
        'application/vnd.github.v3+json',
        'search'
      );
      if (prMergedRes.ok && prMergedRes.data) {
        prsMerged = Math.max(fallbackPrsMerged, Number(prMergedRes.data.total_count) || 0);
      }

      if (!prMergedRes.rateLimited) {
        const issuesRes = await fetchJsonWithRateLimit(
          fetchImpl,
          `${GITHUB_API_BASE}/search/issues?q=${encodeURIComponent(`author:${githubLogin} type:issue`)}&sort=updated&order=desc&per_page=15`,
          activeToken,
          'application/vnd.github.v3+json',
          'search'
        );
        if (issuesRes.ok && issuesRes.data) {
          issuesCreated = Math.max(fallbackIssuesCreated, Number(issuesRes.data.total_count) || 0);
          for (const item of (issuesRes.data.items || [])) {
            const repoName = parseRepoNameFromApiUrl(item.repository_url);
            const action = item.state === 'closed' ? 'closed' : 'opened';
            if (action === 'closed') issuesClosed++;
            normalizedActivities.push({
              eventId: `gh_iss_${item.id}`,
              category: 'issue',
              eventType: 'IssueSearch',
              action,
              title: `${action.charAt(0).toUpperCase() + action.slice(1)} Issue #${item.number}: "${String(item.title || '').slice(0, 75)}"`,
              repoName,
              repoUrl: repoName ? `https://github.com/${repoName}` : item.html_url,
              targetUrl: item.html_url,
              commitCount: 0,
              branchOrTag: '',
              eventTimestamp: item.closed_at || item.updated_at || item.created_at,
              isPrivate: false
            });
          }
        }

        if (!issuesRes.rateLimited) {
          const sinceIsoDate = new Date(periodCutoffMs).toISOString().slice(0, 10);
          const commitsRes = await fetchJsonWithRateLimit(
            fetchImpl,
            `${GITHUB_API_BASE}/search/commits?q=${encodeURIComponent(`author:${githubLogin} author-date:>=${sinceIsoDate}`)}&per_page=1`,
            activeToken,
            'application/vnd.github.cloak-preview+json, application/vnd.github.v3+json',
            'search'
          );
          if (commitsRes.ok && commitsRes.data && Number.isFinite(Number(commitsRes.data.total_count))) {
            totalCommits90d = Math.max(pushCommits90d, Number(commitsRes.data.total_count));
          }
        }
      }

      setCache(
        searchSummaryCacheKey,
        { prsCreated, prsMerged, issuesCreated, issuesClosed, totalCommits90d },
        {},
        600
      );
    }
  } else if (existingState) {
    // Preserve previous authoritative search totals rather than dropping to incomplete event counts
    prsCreated = Math.max(fallbackPrsCreated, existingState.prsCreated || 0);
    prsMerged = Math.max(fallbackPrsMerged, existingState.prsMerged || 0);
    issuesCreated = Math.max(fallbackIssuesCreated, existingState.issuesCreated || 0);
    issuesClosed = Math.max(fallbackIssuesClosed, existingState.issuesClosed || 0);
    totalCommits90d = Math.max(pushCommits90d, existingState.totalCommits || 0);
  }

  // 5. Fetch latest releases from top recently updated repositories (cached 15 min when live)
  const topActiveRepos = syncedRepos.slice(0, 2);
  for (const repo of topActiveRepos) {
    if (latestRateLimit && latestRateLimit.remaining !== null && latestRateLimit.remaining <= 10) break;
    if (!repo.fullName) continue;
    const relCacheKey = `sync_repo_rel:${repo.id}`;
    const cachedRel = (!force && isLiveFetch) ? getCached(relCacheKey) : null;
    let relList = null;

    if (cachedRel && Array.isArray(cachedRel.data)) {
      relList = cachedRel.data;
    } else {
      const relRes = await fetchJsonWithRateLimit(
        fetchImpl,
        `${GITHUB_API_BASE}/repos/${repo.fullName}/releases?per_page=2`,
        activeToken,
        'application/vnd.github.v3+json',
        'core'
      );
      if (relRes.rateLimit) latestRateLimit = relRes.rateLimit;
      if (relRes.ok && Array.isArray(relRes.data)) {
        relList = relRes.data;
        setCache(relCacheKey, relList, {}, 900);
      }
    }

    if (Array.isArray(relList)) {
      for (const rel of relList) {
        normalizedActivities.push({
          eventId: `gh_rel_${repo.id}_${rel.id}`,
          category: 'release',
          eventType: 'ReleaseEvent',
          action: 'published',
          title: `Release ${rel.tag_name || rel.name || 'published'} in ${repo.name}`,
          repoName: repo.fullName,
          repoUrl: repo.htmlUrl,
          targetUrl: rel.html_url || `${repo.htmlUrl}/releases`,
          commitCount: 0,
          branchOrTag: rel.tag_name || '',
          eventTimestamp: rel.published_at || rel.created_at || repo.pushedAt || new Date().toISOString(),
          isPrivate: Boolean(repo.isPrivate)
        });
      }
    }
  }

  // Deduplicate activities by eventId before writing
  const uniqueActivitiesMap = new Map();
  for (const act of normalizedActivities) {
    if (act && act.eventId && !uniqueActivitiesMap.has(act.eventId)) {
      uniqueActivitiesMap.set(act.eventId, act);
    }
  }
  const dedupedActivities = Array.from(uniqueActivitiesMap.values());

  const contributionsCount = Math.max(
    eventContributions90d,
    totalCommits90d + prsCreated + issuesCreated
  );

  // 6. Persist everything strictly scoped to (user.id, targetGithubId)
  replaceUserSyncedRepos(user.id, targetGithubId, syncedRepos);
  upsertUserSyncedActivities(user.id, targetGithubId, dedupedActivities);
  const savedState = upsertGithubSyncState(user.id, targetGithubId, githubLogin, {
    totalRepos,
    publicRepos,
    privateRepos,
    totalCommits: totalCommits90d,
    commitPeriodDays: COMMIT_PERIOD_DAYS,
    prsCreated,
    prsMerged,
    issuesCreated,
    issuesClosed,
    contributionsCount,
    languageDistribution,
    rateLimit: latestRateLimit,
    lastSyncedAt: new Date().toISOString(),
    nextAllowedSyncAt: new Date(Date.now() + MANUAL_SYNC_COOLDOWN_MS).toISOString()
  });

  logActivity(
    user.id,
    'GITHUB_SYNC',
    githubLogin,
    `Synced ${syncedRepos.length} repos, ${totalCommits90d} commits (90d), ${prsCreated} PRs, ${issuesCreated} issues`
  );

  return {
    ok: true,
    cached: false,
    message: `Synchronized ${syncedRepos.length} repositories and recent activity for @${githubLogin}.`,
    syncState: savedState,
    rateLimit: latestRateLimit
  };
}

async function syncIfStale(userId, options = {}) {
  const user = findUserById(userId);
  if (!user || !user.github_id) return null;

  const staleMs = Number(options.staleMs) > 0 ? Number(options.staleMs) : AUTO_SYNC_STALE_MS;
  const state = getUserGithubSyncState(user.id, String(user.github_id));
  if (state) {
    // Do not retry before GitHub rate-limit reset time
    if (state.lastSyncStatus === 'rate_limited' && state.rateLimitResetEpoch) {
      const resetMs = state.rateLimitResetEpoch * 1000;
      if (Date.now() < resetMs) {
        return {
          ok: false,
          skipped: true,
          rateLimited: true,
          reason: 'RATE_LIMIT_EXCEEDED',
          resetEpoch: state.rateLimitResetEpoch,
          resetAtIso: new Date(resetMs).toISOString(),
          syncState: state,
          cached: true
        };
      }
    }

    // Respect error backoff window so broken refreshes do not loop external API calls
    if (state.lastSyncStatus === 'error' && state.nextAllowedSyncAt) {
      const retryMs = new Date(state.nextAllowedSyncAt).getTime();
      if (Number.isFinite(retryMs) && retryMs > Date.now()) {
        return { ok: false, skipped: true, reason: 'BACKOFF_ACTIVE', syncState: state, cached: true };
      }
    }

    if (state.lastSyncedAt) {
      const age = Date.now() - new Date(state.lastSyncedAt).getTime();
      if (Number.isFinite(age) && age < staleMs) {
        return { ok: true, skipped: true, cached: true, syncState: state };
      }
    }
  }

  return synchronizeUserGitHubActivity(user.id, {
    sessionToken: options.sessionToken || null,
    force: false,
    cooldownMs: staleMs,
    fetchImpl: options.fetchImpl || fetch
  });
}

async function runScheduledGithubSyncBatch({ limit = 10, staleMs = AUTO_SYNC_STALE_MS, fetchImpl = fetch, userIds = null } = {}) {
  const fetchLimit = Array.isArray(userIds) && userIds.length > 0 ? Math.max(limit, 100) : limit;
  let candidates = getScheduledGithubSyncUsers({ limit: fetchLimit });
  if (Array.isArray(userIds)) {
    const allowedSet = new Set(userIds.map(Number));
    candidates = candidates.filter(row => allowedSet.has(Number(row.id))).slice(0, limit);
  }
  const results = [];

  for (const row of candidates) {
    if (row.last_synced_at) {
      const age = Date.now() - new Date(row.last_synced_at).getTime();
      if (Number.isFinite(age) && age < staleMs) continue;
    }
    try {
      const res = await synchronizeUserGitHubActivity(row.id, {
        force: false,
        cooldownMs: staleMs,
        fetchImpl
      });
      results.push({ userId: row.id, username: row.username, ok: Boolean(res && res.ok), reason: res?.reason || null });
      if (res && res.rateLimited) {
        // Stop remaining batch jobs immediately if GitHub rate limit is exhausted
        break;
      }
    } catch (err) {
      results.push({ userId: row.id, username: row.username, ok: false, reason: err.message });
    }
  }

  return results;
}

function startGithubSyncScheduler(intervalMs = AUTO_SYNC_STALE_MS) {
  if (schedulerTimer) return schedulerTimer;
  const safeInterval = Math.max(60 * 1000, Number(intervalMs) || AUTO_SYNC_STALE_MS);
  schedulerTimer = setInterval(() => {
    runScheduledGithubSyncBatch().catch(err => {
      console.warn('[DevNexus Scheduled Sync] Background batch skipped:', err.message);
    });
  }, safeInterval);
  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
  return schedulerTimer;
}

function stopGithubSyncScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function getUserDashboardSyncData(targetUserId, targetGithubId, {
  isSelf = false,
  activityCategory = 'all',
  repoLimit = 6,
  repoOffset = 0,
  activityLimit = 15,
  activityOffset = 0
} = {}) {
  if (!targetUserId || !targetGithubId) {
    return {
      isConnected: false,
      syncState: null,
      repos: [],
      activities: []
    };
  }

  const syncState = getUserGithubSyncState(targetUserId, targetGithubId);
  const repos = getUserSyncedRepos(targetUserId, targetGithubId, {
    includePrivate: Boolean(isSelf),
    limit: repoLimit,
    offset: repoOffset
  });
  const activities = getUserSyncedActivities(targetUserId, targetGithubId, {
    includePrivate: Boolean(isSelf),
    category: activityCategory,
    limit: activityLimit,
    offset: activityOffset
  }).map(act => ({
    ...act,
    relativeTime: formatRelativeTime(act.eventTimestamp)
  }));

  // Redact private repo counts and private-only language breakdown if another developer inspects this profile
  let safeLangDist = syncState ? syncState.languageDistribution : [];
  if (syncState && !isSelf && syncState.privateRepos > 0) {
    const publicReposForLang = getUserSyncedRepos(targetUserId, targetGithubId, {
      includePrivate: false,
      limit: 100,
      offset: 0
    });
    safeLangDist = computeLanguageDistribution(publicReposForLang);
  }

  const safeSyncState = syncState
    ? {
        ...syncState,
        privateRepos: isSelf ? syncState.privateRepos : 0,
        totalRepos: isSelf ? syncState.totalRepos : syncState.publicRepos,
        languageDistribution: safeLangDist
      }
    : null;

  return {
    isConnected: true,
    syncState: safeSyncState,
    repos,
    activities
  };
}

module.exports = {
  COMMIT_PERIOD_DAYS,
  AUTO_SYNC_STALE_MS,
  MANUAL_SYNC_COOLDOWN_MS,
  synchronizeUserGitHubActivity,
  syncIfStale,
  runScheduledGithubSyncBatch,
  startGithubSyncScheduler,
  stopGithubSyncScheduler,
  getUserDashboardSyncData,
  computeLanguageDistribution,
  isOwnedByAuthenticatedUser,
  normalizeGithubEvent
};
