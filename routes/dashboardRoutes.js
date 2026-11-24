/**
 * DevNexus Developer Dashboard Routes
 * Connects the Developer Dashboard to real GitHub REST API endpoints and SQLite database.
 */

const express = require('express');
const router = express.Router();

const {
  getUserProfile,
  getUserRepositories,
  getUserEvents,
  searchIssues,
  searchRepositories,
  isOAuthConfigured
} = require('../services/githubService');

const {
  addBookmark,
  removeBookmark,
  getUserBookmarks,
  isBookmarked,
  findUserById,
  findUserByUsername
} = require('../db/database');

const {
  calculateContributionReadiness,
  evaluateIssueReadiness,
  getRoadmapStagesWithProgress,
  calculateRepositoryHealth
} = require('../services/saanviModulesService');

const {
  parseUserSkills,
  buildReadinessContext
} = require('../services/readinessHelper');

const {
  synchronizeUserGitHubActivity,
  syncIfStale,
  getUserDashboardSyncData
} = require('../services/githubSyncService');

const { getUserRepositoryStats } = require('../services/repoStatsService');

const streakService = require('../services/streakService');
const badgeService = require('../services/badgeService');

const { requireAuth } = require('../services/authService');
const authRoutes = require('./authRoutes');

function resolveTargetDeveloperProfile(req, rawUsernameQuery = '') {
  const loggedInUser = (req.user && req.user.id)
    ? (findUserById(req.user.id) || req.user)
    : req.user;
  const rawRequestedUsername = String(rawUsernameQuery || '').trim().replace(/^@/, '');
  const validRequested = (rawRequestedUsername && /^[a-zA-Z0-9_-]{1,39}$/.test(rawRequestedUsername))
    ? rawRequestedUsername
    : '';

  const isSameAsLoggedIn = !validRequested ||
    validRequested.toLowerCase() === String(loggedInUser.username || '').toLowerCase();

  if (isSameAsLoggedIn) {
    return {
      targetUsername: loggedInUser.username,
      isSelf: true,
      isRegisteredDevNexusUser: true,
      targetUser: loggedInUser,
      userSkills: parseUserSkills(loggedInUser),
      roadmapProgress: getRoadmapStagesWithProgress(loggedInUser.id)
    };
  }

  const registeredTarget = findUserByUsername(validRequested);
  if (registeredTarget) {
    return {
      targetUsername: registeredTarget.username,
      isSelf: false,
      isRegisteredDevNexusUser: true,
      targetUser: registeredTarget,
      userSkills: parseUserSkills(registeredTarget),
      roadmapProgress: getRoadmapStagesWithProgress(registeredTarget.id)
    };
  }

  return {
    targetUsername: validRequested,
    isSelf: false,
    isRegisteredDevNexusUser: false,
    targetUser: {
      id: null,
      username: validRequested,
      name: '',
      bio: '',
      skills: '[]',
      experience_level: null,
      is_onboarded: 0
    },
    userSkills: [],
    roadmapProgress: {
      stages: [],
      totalStages: 14,
      completedCount: 0,
      percentage: 0
    }
  };
}

async function getTargetRepositoriesSnapshot(targetCtx, sessionGithubToken = null) {
  const { targetUser, targetUsername, isSelf, isRegisteredDevNexusUser } = targetCtx;
  if (isRegisteredDevNexusUser) {
    if (!targetUser || !targetUser.github_id) {
      return {
        repos: [],
        languageDistribution: [],
        syncState: null,
        source: 'unconnected'
      };
    }
    const synced = getUserDashboardSyncData(targetUser.id, targetUser.github_id, {
      isSelf,
      repoLimit: null,
      activityLimit: 0
    });
    return {
      repos: (synced && Array.isArray(synced.repos)) ? synced.repos : [],
      languageDistribution: (synced && synced.syncState && synced.syncState.languageDistribution) || [],
      syncState: (synced && synced.syncState) || null,
      source: 'synced'
    };
  }
  const repoRes = await getUserRepositories(targetUsername, null, { sort: 'updated', perPage: 30 })
    .catch(() => ({ repos: [] }));
  return {
    repos: repoRes.repos || [],
    languageDistribution: [],
    syncState: null,
    source: repoRes.cached ? 'cached' : 'live'
  };
}

// Developer Dashboard View (Protected)
router.get('/', requireAuth, async (req, res) => {
  try {
    const githubToken = req.session.githubToken || null;
    const targetCtx = resolveTargetDeveloperProfile(req, req.query.username);
    const {
      targetUsername,
      isSelf,
      isRegisteredDevNexusUser,
      targetUser,
      userSkills,
      roadmapProgress
    } = targetCtx;
    const query = (req.query.q || '').trim();
    const label = (req.query.label || 'all').trim();
    const language = (req.query.language || 'all').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);

    // 1. Trigger bounded automatic GitHub sync if self & OAuth-connected user's snapshot is stale (> 15 min)
    const activityFilter = ['all', 'commit', 'repo', 'pr', 'issue', 'branch', 'release'].includes(req.query.activity)
      ? req.query.activity
      : 'all';
    const hasGithubAccount = Boolean(targetUser && targetUser.github_id);

    if (isSelf && hasGithubAccount) {
      await Promise.race([
        syncIfStale(targetUser.id, { sessionToken: githubToken }).catch(() => null),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    }

    const syncedData = hasGithubAccount
      ? getUserDashboardSyncData(
          targetUser.id,
          targetUser.github_id,
          {
            isSelf,
            activityCategory: activityFilter,
            repoLimit: null,
            activityLimit: 15
          }
        )
      : { isConnected: false, syncState: null, counts: { total: 0, public: 0, private: 0, storedInSqlite: 0 }, repos: [], publicRepoList: [], privateRepoList: [], activities: [] };
    const repoStats = isRegisteredDevNexusUser
      ? getUserRepositoryStats(targetUser.id, { isSelf })
      : null;

    // 2. Fetch GitHub Profile ONLY when target is connected to GitHub or explicitly inspecting an external GitHub handle
    let profileData = null;
    let profileRateLimit = null;
    let profileError = null;
    let profileRes = { cached: false, stale: false };

    if (hasGithubAccount || !isRegisteredDevNexusUser) {
      const ghProfileHandle = (hasGithubAccount && syncedData.syncState && syncedData.syncState.githubUsername)
        ? syncedData.syncState.githubUsername
        : targetUsername;
      profileRes = await getUserProfile(ghProfileHandle, isSelf ? githubToken : null);
      profileData = profileRes.user || null;
      profileRateLimit = profileRes.rateLimit || null;
      profileError = profileRes.error || null;
    }

    // Personalized repository recommendations evaluated strictly for targetUser's skills
    let recommendedRepositories = [];
    let recommendationRateLimit = null;

    if (userSkills.length > 0) {
      const recommendationResults = await searchRepositories({
        query: 'stars:>=10',
        sort: 'stars',
        order: 'desc',
        page: 1,
        perPage: 12,
        userSkills,
        preferUserLanguages: true
      }, githubToken);

      recommendationRateLimit = recommendationResults.rateLimit || null;
      recommendedRepositories = (recommendationResults.repositories || [])
        .filter(repo => repo.compatibilityScore > 0)
        .slice(0, 6);
    }

    // 3. Synchronized Repositories (0 repos for unconnected DevNexus accounts; external public lookup ONLY for unregistered handles)
    let displayRepos = [];
    let reposRateLimit = null;
    if (hasGithubAccount) {
      displayRepos = (syncedData.repos || []).map(r => ({
        ...r,
        health: r.health || calculateRepositoryHealth({
          ...r,
          pushed_at: r.pushedAt || r.updatedAtExact,
          updated_at: r.updatedAtExact || r.updatedAt,
          stargazers_count: r.stars,
          forks_count: r.forks,
          open_issues_count: r.openIssues,
          has_issues: r.hasIssues
        })
      }));
    } else if (!isRegisteredDevNexusUser) {
      const repoRes = await getUserRepositories(targetUsername, null, { sort: 'updated', perPage: 100 });
      displayRepos = repoRes.repos || [];
      reposRateLimit = repoRes.rateLimit || null;
    }

    // 4. Recent GitHub Events fallback ONLY for unregistered external handle inspection
    let events = [];
    let eventsRateLimit = null;
    if (!isRegisteredDevNexusUser) {
      const evRes = await getUserEvents(targetUsername, null, { perPage: 8 });
      events = evRes.events || [];
      eventsRateLimit = evRes.rateLimit || null;
    }

    // 4. Fetch Real Open-Source Issues from GitHub Search API (scored strictly for target profile)
    const issueSearchResults = await searchIssues(
      { query, label, language, page, perPage: 8 },
      userSkills,
      githubToken
    );

    // 5. Fetch Logged-In User's Persistent Bookmarks from SQLite
    const userId = req.user.id;
    const dbBookmarks = getUserBookmarks(userId);

    const baseReadinessCtx = buildReadinessContext({
      isRegisteredDevNexusUser,
      githubConnected: hasGithubAccount,
      roadmapProgress,
      repos: displayRepos,
      languageDistribution: syncedData.syncState ? syncedData.syncState.languageDistribution : [],
      syncState: syncedData.syncState || null,
      issueRes: issueSearchResults,
      language,
      source: hasGithubAccount && syncedData.syncState ? 'synced' : (issueSearchResults.cached ? 'cached' : 'live')
    });

    // Mark bookmarked issues and attach per-issue readiness evaluation for targetUser
    const issuesWithBookmarkState = (issueSearchResults.issues || []).map(iss => ({
      ...iss,
      isBookmarked: isBookmarked(userId, iss.htmlUrl),
      readiness: evaluateIssueReadiness(targetUser, iss, baseReadinessCtx)
    }));

    // 6. Calculate Rule-Based Contribution Readiness Score for targetUser
    const readinessScore = calculateContributionReadiness(targetUser, issuesWithBookmarkState, baseReadinessCtx);

    // Real GitHub REST API quota strictly from genuine headers (never fabricated values)
    const realRateLimits = [
      issueSearchResults.rateLimit,
      profileRateLimit,
      reposRateLimit,
      eventsRateLimit,
      recommendationRateLimit
    ].filter(rl => rl && rl.limit !== null && rl.limit !== undefined && rl.remaining !== null && rl.remaining !== undefined);

    let rateLimit = realRateLimits.find(rl => rl.resource === 'core') || realRateLimits[0] || null;
    if (!rateLimit && syncedData.syncState && syncedData.syncState.rateLimitLimit !== null && syncedData.syncState.rateLimitRemaining !== null && syncedData.syncState.rateLimitLimit > 0) {
      const resetEpoch = syncedData.syncState.rateLimitResetEpoch || null;
      const resetInSeconds = resetEpoch ? Math.max(0, resetEpoch - Math.floor(Date.now() / 1000)) : null;
      rateLimit = {
        limit: syncedData.syncState.rateLimitLimit,
        remaining: syncedData.syncState.rateLimitRemaining,
        resetEpoch,
        resetAtIso: resetEpoch ? new Date(resetEpoch * 1000).toISOString() : null,
        resetInSeconds,
        resetInMinutes: resetInSeconds !== null ? Math.max(0, Math.ceil(resetInSeconds / 60)) : null,
        resource: 'core',
        isExhausted: syncedData.syncState.rateLimitRemaining === 0
      };
    }

    const devnexusCacheInfo = {
      issueSearchCached: Boolean(issueSearchResults.cached),
      issueSearchStale: Boolean(issueSearchResults.stale),
      profileCached: Boolean(profileRes && profileRes.cached),
      profileStale: Boolean(profileRes && profileRes.stale),
      syncStatus: syncedData.syncState ? syncedData.syncState.lastSyncStatus : null,
      lastSyncedAt: syncedData.syncState ? syncedData.syncState.lastSyncedAt : null,
      nextAllowedSyncAt: syncedData.syncState ? syncedData.syncState.nextAllowedSyncAt : null,
      rateLimited: Boolean(
        issueSearchResults.error === 'RATE_LIMIT_EXCEEDED' ||
        (syncedData.syncState && syncedData.syncState.lastSyncStatus === 'rate_limited')
      ),
      rateLimitType: issueSearchResults.rateLimitType || null,
      rateLimitResetAtIso:
        issueSearchResults.rateLimitResetAtIso ||
        (syncedData.syncState && syncedData.syncState.rateLimitResetEpoch
          ? new Date(syncedData.syncState.rateLimitResetEpoch * 1000).toISOString()
          : null)
    };

    // 7. Retrieve contribution streak metrics (read-only on page visits; advanced by real contributions)
    let streak = null;
    try {
      streak = streakService.getStreakSummary(req.user.id);
    } catch (e) {
      console.warn('[DevNexus] Streak summary skipped:', e.message);
    }

    // 8. Retrieve achievement badges summary (Member 3)
    let badgeStats = null;
    try {
      const badgeRes = badgeService.evaluateUserBadges(req.user.id);
      badgeStats = badgeRes ? badgeRes.summary : null;
    } catch (e) {
      console.warn('[DevNexus] Badge evaluation skipped:', e.message);
    }

    res.render('dashboard', {
      siteName: 'DevNexus',
      activePage: 'dashboard',
      user: targetCtx.isSelf ? targetUser : (req.user || null),
      inspectedUser: targetUser,
      isInspecting: !isSelf,
      isRegisteredTarget: isRegisteredDevNexusUser,
      userSkills,
      recommendedRepositories,
      targetUsername,
      profileUpdated: req.query.profileUpdated === '1',
      githubDisconnected: req.query.githubDisconnected === '1',
      profile: profileData || {
        name: isSelf ? (targetUser.name || targetUsername) : targetUsername,
        login: targetUsername,
        avatar_url: isSelf && targetUser.avatar_url ? targetUser.avatar_url : 'https://avatars.githubusercontent.com/u/9919?v=4',
        bio: isSelf && targetUser.bio ? targetUser.bio : 'Open source developer exploring community projects.',
        public_repos: 0,
        followers: 0,
        following: 0,
        created_at: targetUser.created_at || new Date().toISOString()
      },
      profileError,
      repos: displayRepos || [],
      events: events || [],
      syncState: syncedData.syncState,
      repoStats,
      syncedActivities: syncedData.activities || [],
      isGithubConnected: Boolean(targetUser && targetUser.github_id),
      activeActivityFilter: activityFilter,
      issues: issuesWithBookmarkState,
      totalIssuesCount: issueSearchResults.totalCount || 0,
      currentPage: issueSearchResults.page || 1,
      totalPages: issueSearchResults.totalPages || 1,
      rateLimit,
      devnexusCacheInfo,
      issueError: issueSearchResults.error || null,
      issueErrorMessage: issueSearchResults.errorMessage || null,
      bookmarks: dbBookmarks,
      readinessScore,
      roadmapProgress,
      streak,
      badgeStats,
      activeQuery: query,
      activeLabel: label,
      activeLanguage: language,
      isOAuthConfigured: isOAuthConfigured()
    });
  } catch (err) {
    console.error('Developer Dashboard Error:', err);
    res.status(500).render('error', {
      siteName: 'DevNexus',
      title: 'Dashboard Error',
      message: 'Failed to retrieve live GitHub data. Please verify your connection.',
      actionUrl: '/dashboard',
      actionText: 'Retry'
    });
  }
});

// JSON API: Manual GitHub Activity Synchronization (Protected, Ownership-Checked, Token-Safe)
router.post('/api/sync', requireAuth, async (req, res) => {
  try {
    if (req.body && req.body.userId && Number(req.body.userId) !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'You can only synchronize your own GitHub account.'
      });
    }

    if (!req.user.github_id) {
      return res.status(400).json({
        success: false,
        reason: 'GITHUB_NOT_CONNECTED',
        connectUrl: '/auth/github',
        message: 'Connect your GitHub account via OAuth before synchronizing activity.'
      });
    }

    const force = Boolean(req.body && req.body.bypassCooldown === true);
    const syncRes = await synchronizeUserGitHubActivity(req.user.id, {
      sessionToken: req.session.githubToken || null,
      force,
      respectManualCooldown: true,
      cooldownMs: 60000
    });

    if (!syncRes.ok) {
      const statusCode = syncRes.rateLimited ? 429 : (syncRes.reason === 'GITHUB_NOT_CONNECTED' ? 400 : 502);
      return res.status(statusCode).json({
        success: false,
        rateLimited: Boolean(syncRes.rateLimited),
        rateLimitType: syncRes.rateLimitType || null,
        resetEpoch: syncRes.resetEpoch || null,
        resetAtIso: syncRes.resetAtIso || null,
        rateLimit: syncRes.rateLimit || null,
        reason: syncRes.reason || 'SYNC_FAILED',
        message: syncRes.message || 'Unable to synchronize GitHub activity right now. Preserving your last synced metrics.',
        syncState: syncRes.syncState || null
      });
    }

    const syncedData = getUserDashboardSyncData(req.user.id, req.user.github_id, {
      isSelf: true,
      repoLimit: null,
      activityLimit: 15
    });

    const freshUser = findUserById(req.user.id) || req.user;
    const userSkills = parseUserSkills(freshUser);
    const roadmapProgress = getRoadmapStagesWithProgress(freshUser.id);
    const issueRes = await searchIssues(
      { query: '', label: 'all', language: 'all', page: 1, perPage: 8 },
      userSkills,
      req.session.githubToken || null,
      { cacheOnly: true }
    ).catch(() => ({ issues: [] }));

    const readinessScore = calculateContributionReadiness(
      freshUser,
      issueRes.issues || [],
      buildReadinessContext({
        isRegisteredDevNexusUser: true,
        githubConnected: Boolean(freshUser.github_id),
        roadmapProgress,
        repos: syncedData.repos || [],
        languageDistribution: syncedData.syncState ? syncedData.syncState.languageDistribution : [],
        syncState: syncedData.syncState || null,
        issueRes,
        source: 'synced'
      })
    );

    const syncedStreak = streakService.getStreakSummary(req.user.id);
    const analyticsSummary = syncRes.analyticsSync || null;

    return res.json({
      success: true,
      cached: Boolean(syncRes.cached),
      cooldownActive: Boolean(syncRes.cooldownActive),
      retryAfterSeconds: syncRes.retryAfterSeconds || 0,
      nextAllowedSyncAt: syncRes.nextAllowedSyncAt || (syncedData.syncState && syncedData.syncState.nextAllowedSyncAt) || null,
      rateLimit: syncRes.rateLimit || null,
      message: syncRes.message,
      syncState: syncedData.syncState,
      counts: syncedData.counts,
      repos: syncedData.repos,
      publicRepoList: syncedData.publicRepoList,
      privateRepoList: syncedData.privateRepoList,
      activities: syncedData.activities,
      readinessScore,
      streak: syncedStreak,
      analyticsSync: analyticsSummary
    });
  } catch (err) {
    console.error('[DevNexus GitHub Sync API Error]', err.message);
    return res.status(500).json({
      success: false,
      error: 'SYNC_ERROR',
      message: 'Failed to synchronize GitHub activity. Existing synced snapshot was preserved.'
    });
  }
});

// JSON API: User-Isolated GitHub Sync Snapshot & Paginated Repos/Timeline
router.get('/api/sync/status', requireAuth, (req, res) => {
  if (req.query.userId && Number(req.query.userId) !== req.user.id) {
    return res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
      message: 'Access denied: cannot view another developer’s private GitHub sync state.'
    });
  }

  const activityCategory = ['all', 'commit', 'repo', 'pr', 'issue', 'review', 'branch', 'release'].includes(req.query.activity)
    ? req.query.activity
    : 'all';
  const repoPage = Math.max(1, parseInt(req.query.repoPage || '1', 10) || 1);
  const activityPage = Math.max(1, parseInt(req.query.activityPage || '1', 10) || 1);
  const hasExplicitRepoLimit = req.query.repoLimit !== undefined && req.query.repoLimit !== '';
  const repoLimit = hasExplicitRepoLimit
    ? Math.max(1, Math.min(5000, parseInt(req.query.repoLimit, 10) || 5000))
    : null;
  const activityLimit = 15;

  const syncedData = getUserDashboardSyncData(req.user.id, req.user.github_id, {
    isSelf: true,
    activityCategory,
    repoLimit,
    repoOffset: repoLimit ? (repoPage - 1) * repoLimit : 0,
    activityLimit,
    activityOffset: (activityPage - 1) * activityLimit
  });

  return res.json({
    success: true,
    isConnected: syncedData.isConnected,
    syncState: syncedData.syncState,
    counts: syncedData.counts,
    repos: syncedData.repos,
    publicRepoList: syncedData.publicRepoList,
    privateRepoList: syncedData.privateRepoList,
    activities: syncedData.activities
  });
});

// Profile Update via Dashboard
router.post('/profile', requireAuth, authRoutes.handlePostProfile);

// JSON API: Contribution Readiness Score evaluation (reflects target developer profile & optional issue context)
router.get('/api/readiness', requireAuth, async (req, res) => {
  try {
    const githubToken = req.session.githubToken || null;
    const query = (req.query.q || '').trim();
    const language = (req.query.language || 'all').trim();
    const label = (req.query.label || 'all').trim();
    const issueUrl = (req.query.issueUrl || '').trim();
    const targetCtx = resolveTargetDeveloperProfile(req, req.query.username);
    const { targetUser, targetUsername, isSelf, isRegisteredDevNexusUser, userSkills, roadmapProgress } = targetCtx;

    const [issueRes, repoSnap] = await Promise.all([
      searchIssues({ query, label, language, page: 1, perPage: 8 }, userSkills, githubToken),
      getTargetRepositoriesSnapshot(targetCtx, githubToken)
    ]);

    const issuesList = issueRes.issues || [];
    const selectedIssue = issueUrl
      ? issuesList.find(iss => iss.htmlUrl === issueUrl) || null
      : null;

    const ctx = buildReadinessContext({
      isRegisteredDevNexusUser,
      githubConnected: Boolean(targetUser && targetUser.github_id),
      roadmapProgress,
      repos: repoSnap.repos,
      languageDistribution: repoSnap.languageDistribution,
      syncState: repoSnap.syncState || null,
      issueRes,
      language,
      source: repoSnap.source,
      selectedIssue
    });

    const readiness = selectedIssue
      ? evaluateIssueReadiness(targetUser, selectedIssue, ctx)
      : calculateContributionReadiness(targetUser, issuesList, ctx);

    res.json({
      success: true,
      targetUsername,
      isSelf,
      readiness,
      rateLimit: issueRes.rateLimit || null,
      cacheInfo: {
        cached: Boolean(issueRes.cached),
        stale: Boolean(issueRes.stale),
        rateLimited: issueRes.error === 'RATE_LIMIT_EXCEEDED',
        rateLimitType: issueRes.rateLimitType || null,
        rateLimitResetAtIso: issueRes.rateLimitResetAtIso || null
      },
      roadmapProgress: {
        completedCount: roadmapProgress.completedCount,
        totalStages: roadmapProgress.totalStages,
        percentage: roadmapProgress.percentage
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to evaluate contribution readiness score.' });
  }
});

// JSON API: Search and filter issues asynchronously
router.get('/api/issues', requireAuth, async (req, res) => {
  try {
    const githubToken = req.session.githubToken || null;
    const query = (req.query.q || '').trim();
    const label = (req.query.label || 'all').trim();
    const language = (req.query.language || 'all').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const userId = req.user.id;

    const targetCtx = resolveTargetDeveloperProfile(req, req.query.username);
    const { targetUser, targetUsername, isSelf, isRegisteredDevNexusUser, userSkills, roadmapProgress } = targetCtx;

    const [results, repoSnap] = await Promise.all([
      searchIssues({ query, label, language, page, perPage: 8 }, userSkills, githubToken),
      getTargetRepositoriesSnapshot(targetCtx, githubToken)
    ]);

    const readinessCtx = buildReadinessContext({
      isRegisteredDevNexusUser,
      githubConnected: Boolean(targetUser && targetUser.github_id),
      roadmapProgress,
      repos: repoSnap.repos,
      languageDistribution: repoSnap.languageDistribution,
      syncState: repoSnap.syncState || null,
      issueRes: results,
      language,
      source: repoSnap.source
    });

    const issuesWithBookmarkState = (results.issues || []).map(iss => ({
      ...iss,
      isBookmarked: isBookmarked(userId, iss.htmlUrl),
      readiness: evaluateIssueReadiness(targetUser, iss, readinessCtx)
    }));

    const readinessScore = calculateContributionReadiness(targetUser, issuesWithBookmarkState, readinessCtx);

    res.json({
      success: true,
      targetUsername,
      isSelf,
      ...results,
      issues: issuesWithBookmarkState,
      readinessScore
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to search issues.' });
  }
});

// JSON API: Add persistent bookmark to SQLite database
router.post('/api/bookmarks', requireAuth, (req, res) => {
  const userId = req.user.id;
  const bookmarkData = req.body || {};

  if (!bookmarkData.html_url || typeof bookmarkData.html_url !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing required bookmark html_url.' });
  }

  try {
    addBookmark(userId, bookmarkData);
    const userBookmarks = getUserBookmarks(userId);
    res.json({ success: true, count: userBookmarks.length });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to save bookmark.' });
  }
});

// JSON API: Remove persistent bookmark from SQLite database
router.delete('/api/bookmarks', requireAuth, (req, res) => {
  const userId = req.user.id;
  const { html_url } = req.body || {};

  if (!html_url || typeof html_url !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing html_url.' });
  }

  try {
    removeBookmark(userId, html_url);
    const userBookmarks = getUserBookmarks(userId);
    res.json({ success: true, count: userBookmarks.length });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to remove bookmark.' });
  }
});

module.exports = router;
