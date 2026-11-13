/**
 * DevNexus Portfolio Service
 *
 * Provides aggregated data for the Developer Portfolio feature:
 * - getDeveloperPortfolio: consolidated view of user's public profile, GitHub data,
 *   leaderboard rank, XP, skill tree progress, and recent activity.
 * - updatePortfolioSettings: validated/sanitized upsert of portfolio_settings row.
 * - syncPortfolioFromGitHub: refreshes GitHub profile + repos for the user.
 */

'use strict';

const {
  findUserByUsername,
  findUserById,
  getPortfolioSettings,
  upsertPortfolioSettings,
  getLeaderboard,
  getLeaderboardStats,
  getSkillTreeProgress,
  getUserXP,
  getUserRecentActivity
} = require('../db/database');

const {
  getUserProfile,
  getUserRepositories
} = require('./githubService');

const { SKILL_TREE_GRAPH } = require('./skillTreeService');

// ---------------------------------------------------------------------------
// getDeveloperPortfolio
// ---------------------------------------------------------------------------

/**
 * Returns a consolidated portfolio object for the given user.
 * @param {string|number} usernameOrId - GitHub username or numeric DB user id
 * @param {string|null}   githubToken  - Optional GitHub OAuth token for authenticated requests
 */
async function getDeveloperPortfolio(usernameOrId, githubToken = null) {
  // 1. Resolve user from SQLite
  let user = null;
  if (typeof usernameOrId === 'number' || /^\d+$/.test(String(usernameOrId))) {
    user = findUserById(Number(usernameOrId));
  }
  if (!user) {
    user = findUserByUsername(String(usernameOrId));
  }
  if (!user) {
    return { error: 'USER_NOT_FOUND', user: null };
  }

  const userId = user.id;
  const username = user.username;

  // 2. Portfolio settings
  const settings = getPortfolioSettings(userId);

  // Parse featured_repos from JSON if stored as string
  let featuredRepoNames = [];
  try {
    const raw = settings.featured_repos || '[]';
    featuredRepoNames = Array.isArray(raw) ? raw : JSON.parse(raw);
  } catch (e) {
    featuredRepoNames = [];
  }

  // 3. GitHub profile + repos (same call pattern as dashboardRoutes.js)
  const { user: profile, error: profileError } = await getUserProfile(username, githubToken);
  const { repos } = await getUserRepositories(username, githubToken, { sort: 'updated', perPage: 30 });

  // Top 6 by updated (already sorted, just slice)
  const topRepos = (Array.isArray(repos) ? repos : []).slice(0, 6);

  // Featured repos filtered by settings
  const featuredRepos = featuredRepoNames.length > 0
    ? (Array.isArray(repos) ? repos : []).filter(r => featuredRepoNames.includes(r.name || r.fullName))
    : [];

  // 4. Leaderboard rank — search full leaderboard for this user
  let leaderboardRank = null;
  try {
    const lb = getLeaderboard({ page: 1, perPage: 500 });
    const entry = (lb.contributors || []).find(
      c => c.username && c.username.toLowerCase() === username.toLowerCase()
    );
    if (entry) {
      leaderboardRank = entry.rank;
    }
  } catch (e) {
    // non-fatal
  }

  // 5. Skill tree progress + XP
  const skillNodes = getSkillTreeProgress(userId);
  const xpRow = getUserXP(userId);

  const unlockedNodes = skillNodes.filter(n => n.status === 'unlocked');

  const tracksProgress = {
    frontend: {
      xp: xpRow.frontend_xp || 0,
      unlockedCount: unlockedNodes.filter(n => n.node_id.startsWith('fe-')).length,
      totalNodes: 4
    },
    backend: {
      xp: xpRow.backend_xp || 0,
      unlockedCount: unlockedNodes.filter(n => n.node_id.startsWith('be-')).length,
      totalNodes: 4
    },
    devops: {
      xp: xpRow.devops_xp || 0,
      unlockedCount: unlockedNodes.filter(n => n.node_id.startsWith('db-')).length,
      totalNodes: 4
    },
    opensource: {
      xp: xpRow.opensource_xp || 0,
      unlockedCount: unlockedNodes.filter(n => n.node_id.startsWith('os-')).length,
      totalNodes: 4
    }
  };

  const skillTreeSummary = {
    totalXP: xpRow.total_xp,
    level: xpRow.level,
    tracksProgress
  };

  // 6. Recent activity (last 10 activity_logs for this user)
  const recentActivity = getUserRecentActivity(userId, 10);

  // 7. Badges derived from unlocked skill nodes
  const badges = unlockedNodes.map(n => {
    const nodeDef = SKILL_TREE_GRAPH.find(g => g.id === n.node_id);
    return {
      nodeId: n.node_id,
      title: nodeDef ? nodeDef.title : n.node_id,
      icon: nodeDef ? nodeDef.icon : '🏅',
      description: nodeDef ? nodeDef.criteriaDescription : '',
      xpEarned: n.xp_earned,
      unlockedAt: n.unlocked_at
    };
  });

  return {
    user,
    settings,
    profile: profile || null,
    repos: topRepos,
    featuredRepos,
    leaderboardRank,
    skillTreeSummary,
    recentActivity,
    badges
  };
}

// ---------------------------------------------------------------------------
// updatePortfolioSettings
// ---------------------------------------------------------------------------

const URL_MAX = 300;
const HEADLINE_MAX = 120;
const LOCATION_MAX = 80;

function sanitizeUrl(val) {
  if (!val || typeof val !== 'string') return '';
  const trimmed = val.trim();
  // Basic URL validation — allow empty strings
  if (trimmed === '') return '';
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed.slice(0, URL_MAX);
}

/**
 * Validates and persists portfolio settings for a user.
 * @param {number} userId
 * @param {object} payload
 */
function updatePortfolioSettings(userId, payload) {
  if (!userId) throw new Error('userId is required');
  if (!payload || typeof payload !== 'object') throw new Error('payload must be an object');

  const headline = typeof payload.headline === 'string'
    ? payload.headline.trim().slice(0, HEADLINE_MAX)
    : '';

  const location = typeof payload.location === 'string'
    ? payload.location.trim().slice(0, LOCATION_MAX)
    : '';

  const github_url   = sanitizeUrl(payload.github_url);
  const linkedin_url = sanitizeUrl(payload.linkedin_url);
  const website_url  = sanitizeUrl(payload.website_url);
  const twitter_url  = sanitizeUrl(payload.twitter_url);

  // featured_repos must be an array of strings
  let featured_repos = [];
  if (Array.isArray(payload.featured_repos)) {
    featured_repos = payload.featured_repos
      .filter(r => typeof r === 'string')
      .map(r => r.trim())
      .filter(Boolean);
  }

  upsertPortfolioSettings(userId, {
    headline,
    location,
    github_url,
    linkedin_url,
    website_url,
    twitter_url,
    featured_repos: JSON.stringify(featured_repos)
  });

  return { success: true };
}

// ---------------------------------------------------------------------------
// syncPortfolioFromGitHub
// ---------------------------------------------------------------------------

/**
 * Fetches fresh GitHub profile and repositories for the given user and returns them.
 * Does not persist; callers may choose to cache or store as needed.
 * @param {number} userId
 * @param {string|null} githubToken
 */
async function syncPortfolioFromGitHub(userId, githubToken = null) {
  const user = findUserById(userId);
  if (!user) return { success: false, error: 'USER_NOT_FOUND' };

  const { user: profile, error: profileError } = await getUserProfile(user.username, githubToken);
  const { repos, error: reposError } = await getUserRepositories(user.username, githubToken, { sort: 'updated', perPage: 30 });

  return {
    success: true,
    profile: profile || null,
    repos: Array.isArray(repos) ? repos : []
  };
}

module.exports = {
  getDeveloperPortfolio,
  updatePortfolioSettings,
  syncPortfolioFromGitHub
};
