'use strict';

const { findUserById } = require('../db/database');
const {
  calculateContributionReadiness,
  evaluateIssueReadiness,
  getRoadmapStagesWithProgress
} = require('./saanviModulesService');
const { getUserDashboardSyncData } = require('./githubSyncService');
const { searchIssues } = require('./githubService');

function parseUserSkills(user) {
  if (!user || !user.skills) return [];
  if (Array.isArray(user.skills)) return user.skills;
  try {
    const parsed = JSON.parse(user.skills);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function buildReadinessContext({
  isRegisteredDevNexusUser = false,
  githubConnected = false,
  roadmapProgress = null,
  repos = [],
  languageDistribution = [],
  syncState = null,
  issueRes = null,
  language = 'all',
  source = null,
  selectedIssue = null
} = {}) {
  const safeRepos = Array.isArray(repos) ? repos : [];
  const hasIssues = Boolean(issueRes && Array.isArray(issueRes.issues) && issueRes.issues.length > 0);
  const resolvedSource = source || (issueRes && issueRes.stale ? 'cached_stale' : (issueRes && issueRes.cached ? 'cached' : 'live'));
  return {
    githubConnected: Boolean(githubConnected),
    roadmapCompletedCount: roadmapProgress ? roadmapProgress.completedCount : 0,
    roadmapVerified: Boolean(isRegisteredDevNexusUser),
    repositories: safeRepos,
    languageDistribution: Array.isArray(languageDistribution) ? languageDistribution : [],
    syncState: syncState || null,
    language: language !== 'all' ? language : null,
    githubSource: resolvedSource,
    isStale: Boolean(issueRes && issueRes.stale),
    githubError: (issueRes && issueRes.error) || null,
    githubDataAvailable: Boolean(hasIssues || safeRepos.length > 0),
    issue: selectedIssue || null
  };
}

/**
 * Computes a consistent Contribution Readiness Score snapshot for any user across
 * Dashboard, Portfolio/Profile, Roadmap APIs, and Landing Page.
 */
async function computeUserReadinessSnapshot(userOrId, {
  isSelf = true,
  githubToken = null,
  cacheOnly = false,
  issuesOverride = null,
  issueQuery = { query: '', label: 'all', language: 'all', page: 1, perPage: 8 },
  selectedIssue = null,
  reposOverride = undefined,
  syncStateOverride = undefined
} = {}) {
  let freshUser = null;
  if (typeof userOrId === 'number' || (typeof userOrId === 'string' && /^\d+$/.test(userOrId))) {
    freshUser = findUserById(Number(userOrId));
  } else if (userOrId && typeof userOrId === 'object') {
    freshUser = userOrId.id ? (findUserById(userOrId.id) || userOrId) : userOrId;
  }

  if (!freshUser) {
    freshUser = { id: null, username: '', skills: '[]', experience_level: null, is_onboarded: 0 };
  }

  const isRegistered = Boolean(freshUser.id);
  const githubConnected = Boolean(freshUser.github_id);
  const userSkills = parseUserSkills(freshUser);
  const roadmapProgress = isRegistered
    ? getRoadmapStagesWithProgress(freshUser.id)
    : { stages: [], totalStages: 14, completedCount: 0, percentage: 0 };

  let syncedData = null;
  if (githubConnected && isRegistered) {
    syncedData = getUserDashboardSyncData(freshUser.id, freshUser.github_id, {
      isSelf,
      repoLimit: null,
      activityLimit: 0
    });
  }

  const repos = Array.isArray(reposOverride)
    ? reposOverride
    : (syncedData ? (syncedData.repos || []) : []);
  const syncState = syncStateOverride !== undefined
    ? syncStateOverride
    : (syncedData ? syncedData.syncState : null);
  const languageDistribution = syncState && Array.isArray(syncState.languageDistribution)
    ? syncState.languageDistribution
    : [];

  let issueRes = null;
  if (Array.isArray(issuesOverride)) {
    issueRes = { issues: issuesOverride, cached: false, stale: false };
  } else {
    issueRes = await searchIssues(issueQuery, userSkills, githubToken, { cacheOnly })
      .catch(() => ({ issues: [] }));
  }

  const ctx = buildReadinessContext({
    isRegisteredDevNexusUser: isRegistered,
    githubConnected,
    roadmapProgress,
    repos,
    languageDistribution,
    syncState,
    issueRes,
    language: issueQuery.language || 'all',
    source: githubConnected && syncState ? 'synced' : (issueRes && issueRes.cached ? 'cached' : 'live'),
    selectedIssue
  });

  const issues = issueRes && Array.isArray(issueRes.issues) ? issueRes.issues : [];
  const readiness = selectedIssue
    ? evaluateIssueReadiness(freshUser, selectedIssue, ctx)
    : calculateContributionReadiness(freshUser, issues, ctx);

  return {
    user: freshUser,
    userSkills,
    roadmapProgress,
    syncedData,
    repos,
    syncState,
    issueRes,
    readiness
  };
}

module.exports = {
  parseUserSkills,
  buildReadinessContext,
  computeUserReadinessSnapshot
};
