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
  isOAuthConfigured
} = require('../services/githubService');

const {
  addBookmark,
  removeBookmark,
  getUserBookmarks,
  isBookmarked
} = require('../db/database');

const {
  calculateContributionReadiness,
  evaluateIssueReadiness,
  getRoadmapStagesWithProgress
} = require('../services/saanviModulesService');

const streakService = require('../services/streakService');
const badgeService = require('../services/badgeService');

const { requireAuth } = require('../services/authService');
const authRoutes = require('./authRoutes');

function parseUserSkills(user) {
  if (!user || !user.skills) return [];
  try {
    const parsed = JSON.parse(user.skills);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Developer Dashboard View (Protected)
router.get('/', requireAuth, async (req, res) => {
  try {
    const githubToken = req.session.githubToken || null;
    const rawRequestedUsername = (req.query.username || '').trim().replace(/^@/, '');
    const targetUsername = (rawRequestedUsername && /^[a-zA-Z0-9_-]{1,39}$/.test(rawRequestedUsername))
      ? rawRequestedUsername
      : req.user.username;
    const query = (req.query.q || '').trim();
    const label = (req.query.label || 'all').trim();
    const language = (req.query.language || 'all').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);

    // 1. Fetch Real GitHub Profile
    const { user: profileData, rateLimit: profileRateLimit, error: profileError } = await getUserProfile(targetUsername, githubToken);

    // Get skills from the logged-in user's profile
    const userSkills = parseUserSkills(req.user);

    // 2. Fetch Real GitHub Repositories
    const { repos, rateLimit: reposRateLimit } = await getUserRepositories(targetUsername, githubToken, { sort: 'updated', perPage: 6 });

    // 3. Fetch Real GitHub Events / Activity
    const { events, rateLimit: eventsRateLimit } = await getUserEvents(targetUsername, githubToken, { perPage: 6 });

    // 4. Fetch Real Open-Source Issues from GitHub Search API
    const issueSearchResults = await searchIssues(
      { query, label, language, page, perPage: 8 },
      userSkills,
      githubToken
    );

    // 5. Fetch User's Real Persistent Bookmarks & Roadmap Progress from SQLite
    const userId = req.user.id;
    const dbBookmarks = getUserBookmarks(userId);
    const roadmapProgress = getRoadmapStagesWithProgress(userId);

    // Mark bookmarked issues and attach per-issue readiness evaluation
    const issuesWithBookmarkState = (issueSearchResults.issues || []).map(iss => ({
      ...iss,
      isBookmarked: isBookmarked(userId, iss.htmlUrl),
      readiness: evaluateIssueReadiness(req.user, iss)
    }));

    // 6. Calculate Rule-Based Contribution Readiness Score
    const readinessScore = calculateContributionReadiness(req.user, issuesWithBookmarkState, {
      roadmapCompletedCount: roadmapProgress.completedCount,
      language: language !== 'all' ? language : null
    });

    // Choose most relevant rate limit indicator
    const rateLimit = issueSearchResults.rateLimit || profileRateLimit || reposRateLimit || eventsRateLimit;

    // 7. Auto-record daily contribution streak & retrieve metrics (Member 3)
    let streak = null;
    try {
      streak = await streakService.recordActivity(req.user.id, 'dashboard_visit');
    } catch (e) {
      console.warn('[DevNexus] Streak auto-record skipped:', e.message);
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
      user: req.user || null,
      userSkills,
      targetUsername,
      profileUpdated: req.query.profileUpdated === '1',
      profile: profileData || {
        name: targetUsername === req.user.username ? (req.user.name || targetUsername) : targetUsername,
        login: targetUsername,
        avatar_url: targetUsername === req.user.username && req.user.avatar_url ? req.user.avatar_url : 'https://avatars.githubusercontent.com/u/9919?v=4',
        bio: targetUsername === req.user.username && req.user.bio ? req.user.bio : 'Open source enthusiast',
        public_repos: 0,
        followers: 0,
        following: 0,
        created_at: new Date().toISOString()
      },
      profileError,
      repos: repos || [],
      events: events || [],
      issues: issuesWithBookmarkState,
      totalIssuesCount: issueSearchResults.totalCount || 0,
      currentPage: issueSearchResults.page || 1,
      totalPages: issueSearchResults.totalPages || 1,
      rateLimit,
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

// Profile Update via Dashboard
router.post('/profile', requireAuth, authRoutes.handlePostProfile);

// JSON API: Contribution Readiness Score evaluation (reflects current profile & optional issue context)
router.get('/api/readiness', requireAuth, async (req, res) => {
  try {
    const githubToken = req.session.githubToken || null;
    const language = (req.query.language || 'all').trim();
    const label = (req.query.label || 'good-first-issue').trim();
    const userSkills = parseUserSkills(req.user);
    const roadmapProgress = getRoadmapStagesWithProgress(req.user.id);

    const issueRes = await searchIssues(
      { query: '', label, language, page: 1, perPage: 6 },
      userSkills,
      githubToken
    );

    const readiness = calculateContributionReadiness(req.user, issueRes.issues || [], {
      roadmapCompletedCount: roadmapProgress.completedCount,
      language: language !== 'all' ? language : null
    });

    res.json({
      success: true,
      readiness,
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

    const parsedSkills = parseUserSkills(req.user);
    const userSkills = parsedSkills.length > 0 ? parsedSkills : ['javascript', 'python', 'typescript'];

    const results = await searchIssues(
      { query, label, language, page, perPage: 8 },
      userSkills,
      githubToken
    );

    const issuesWithBookmarkState = (results.issues || []).map(iss => ({
      ...iss,
      isBookmarked: isBookmarked(userId, iss.htmlUrl),
      readiness: evaluateIssueReadiness(req.user, iss)
    }));

    const roadmapProgress = getRoadmapStagesWithProgress(userId);
    const readinessScore = calculateContributionReadiness(req.user, issuesWithBookmarkState, {
      roadmapCompletedCount: roadmapProgress.completedCount,
      language: language !== 'all' ? language : null
    });

    res.json({
      success: true,
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
