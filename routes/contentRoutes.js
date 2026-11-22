/**
 * DevNexus Content & Navigation Routes
 * Connects all informational, educational, and community navigation destinations.
 */

const express = require('express');
const router = express.Router();
const {
  db,
  getLeaderboard,
  getLeaderboardStats,
  setRoadmapStepStatus,
  resetUserRoadmapProgress,
  findUserByUsername
} = require('../db/database');
const { synchronizeUserGitHubActivity } = require('../services/githubSyncService');
const { getRoadmapStagesWithProgress } = require('../services/saanviModulesService');
const { computeUserReadinessSnapshot } = require('../services/readinessHelper');
const streakService = require('../services/streakService');
const analyticsService = require('../services/analyticsService');

async function computeRoadmapReadiness(req) {
  const { readiness } = await computeUserReadinessSnapshot(req.user, {
    isSelf: true,
    githubToken: req.session ? req.session.githubToken : null,
    cacheOnly: true
  });
  return readiness;
}


// 1. Contribution Guide, First Contribution Roadmap & Learning Hub
router.get(['/learn', '/guide'], (req, res) => {
  const requestedTab = String(req.query.tab || '').toLowerCase();
  const activeTab = ['guide', 'roadmap', 'git', 'conduct'].includes(requestedTab) ? requestedTab : 'guide';
  const roadmap = getRoadmapStagesWithProgress(req.user ? req.user.id : null);
  res.render('guide', {
    siteName: 'DevNexus',
    activePage: 'guide',
    activeTab,
    roadmap,
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

router.get(['/roadmap', '/learn/roadmap'], (req, res) => {
  const roadmap = getRoadmapStagesWithProgress(req.user ? req.user.id : null);
  res.render('guide', {
    siteName: 'DevNexus',
    activePage: 'guide',
    activeTab: 'roadmap',
    roadmap,
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

router.get('/learn/git-basics', (req, res) => {
  const roadmap = getRoadmapStagesWithProgress(req.user ? req.user.id : null);
  res.render('guide', {
    siteName: 'DevNexus',
    activePage: 'guide',
    activeTab: 'git',
    roadmap,
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

router.get('/learn/code-of-conduct', (req, res) => {
  const roadmap = getRoadmapStagesWithProgress(req.user ? req.user.id : null);
  res.render('guide', {
    siteName: 'DevNexus',
    activePage: 'guide',
    activeTab: 'conduct',
    roadmap,
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

// 1b. First Contribution Roadmap JSON API Endpoints (Persistent SQLite Progress)
router.get('/api/roadmap', (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const roadmap = getRoadmapStagesWithProgress(userId);
    res.json({
      success: true,
      authenticated: Boolean(req.user),
      ...roadmap
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to retrieve roadmap progress.' });
  }
});

router.post('/api/roadmap/step', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please sign in to save your roadmap progress.'
    });
  }

  const body = req.body || {};
  const rawStep = body.stepNumber !== undefined ? body.stepNumber : body.step;
  const parsedStep = Number(rawStep);

  if (!Number.isInteger(parsedStep) || parsedStep < 1 || parsedStep > 14) {
    return res.status(400).json({
      success: false,
      error: 'Invalid stepNumber. Must be an integer between 1 and 14.'
    });
  }

  const completed = body.completed === undefined
    ? true
    : (body.completed === true || body.completed === 'true' || body.completed === 1 || body.completed === '1');

  try {
    setRoadmapStepStatus(req.user.id, parsedStep, completed);
    let streak = null;
    let platformActivity = null;
    if (completed) {
      platformActivity = analyticsService.recordPlatformActivity(req.user.id, {
        activityType: 'roadmap_stage',
        uniqueKey: `roadmap_stage:${parsedStep}`,
        referenceId: String(parsedStep),
        title: `Completed Roadmap Stage #${parsedStep}`
      });
      streak = platformActivity.streak;
    } else {
      streak = streakService.getStreakSummary(req.user.id);
    }
    const updatedRoadmap = getRoadmapStagesWithProgress(req.user.id);
    const readiness = await computeRoadmapReadiness(req);
    return res.json({
      success: true,
      stepNumber: parsedStep,
      completed,
      ...updatedRoadmap,
      readinessScore: readiness.score,
      readiness,
      streak,
      platformActivity
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Could not update roadmap progress.'
    });
  }
});

router.post('/api/roadmap/reset', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required to reset roadmap progress.'
    });
  }
  try {
    resetUserRoadmapProgress(req.user.id);
    const updatedRoadmap = getRoadmapStagesWithProgress(req.user.id);
    const readiness = await computeRoadmapReadiness(req);
    return res.json({
      success: true,
      ...updatedRoadmap,
      readinessScore: readiness.score,
      readiness
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Could not reset roadmap progress.'
    });
  }
});

// 2. Search Navigation Jump
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q) {
    return res.redirect(`/projects?q=${encodeURIComponent(q)}`);
  }
  res.redirect('/projects');
});

// 3. Issue and Topic Navigation Shortcuts
router.get('/issues', (req, res) => {
  if (req.user) {
    return res.redirect('/dashboard?label=good-first-issue');
  }
  res.redirect('/projects?topic=good-first-issue');
});

router.get('/topics', (req, res) => {
  res.redirect('/projects');
});

// 4. Documentation
router.get('/docs', (req, res) => {
  res.render('info', {
    siteName: 'DevNexus',
    activePage: 'docs',
    title: 'Platform Documentation & Architecture',
    subtitle: 'Comprehensive guide to DevNexus system architecture, API specifications, and database schema.',
    section: 'docs',
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

// 5. Community Leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const rawCategory = (req.query.category || 'top').toLowerCase();
    const category = ['top', 'active', 'rising'].includes(rawCategory) ? rawCategory : 'top';

    const rawTime = (req.query.time || 'all-time').toLowerCase();
    const allowedTimes = ['all-time', 'this-week', 'weekly', 'this-month', 'monthly', 'this-quarter', 'quarterly', 'this-year', 'yearly'];
    const time = allowedTimes.includes(rawTime) ? rawTime : 'all-time';

    const search = (req.query.q || req.query.search || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    analyticsService.backfillVerifiedContributorsToLeaderboard(50);
    const stats = getLeaderboardStats({ time });

    const leaderboardData = getLeaderboard({
      category,
      time,
      search,
      page,
      perPage: 10
    });

    // Extract top 3 podium contributors when on first page of unfiltered view
    let podium = [];
    if (!search && page === 1 && leaderboardData.contributors.length >= 1) {
      podium = leaderboardData.contributors.slice(0, 3);
    }

    // JSON API response support
    if (req.query.format === 'json' || req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.json({
        category,
        time,
        search,
        stats,
        ...leaderboardData
      });
    }

    const flashSuccess = req.session ? req.session.flashSuccess : null;
    const flashError = req.session ? req.session.flashError : null;
    if (req.session) {
      delete req.session.flashSuccess;
      delete req.session.flashError;
    }

    res.render('leaderboard', {
      siteName: 'DevNexus',
      activePage: 'leaderboard',
      user: req.user || null,
      isAdmin: Boolean(req.user && req.user.role === 'admin'),
      contributors: leaderboardData.contributors,
      totalCount: leaderboardData.totalCount,
      page: leaderboardData.page,
      totalPages: leaderboardData.totalPages,
      category,
      time,
      search,
      stats,
      podium,
      flashSuccess,
      flashError,
      syncedUser: req.query.synced || null
    });
  } catch (err) {
    console.error('[DevNexus Leaderboard Error]', err);
    res.status(500).render('error', {
      siteName: 'DevNexus',
      activePage: 'leaderboard',
      user: req.user || null,
      isAdmin: Boolean(req.user && req.user.role === 'admin'),
      statusCode: 500,
      title: 'Leaderboard Unavailable',
      message: 'Failed to retrieve verified contributor metrics. Please retry in a moment.'
    });
  }
});

// Sync or Refresh a Genuine Registered DevNexus User's GitHub Leaderboard Profile
router.post('/leaderboard/sync', async (req, res) => {
  const username = (req.body && req.body.username ? req.body.username : '').trim().replace(/^@/, '');
  const category = req.body.category || 'top';
  const time = req.body.time || 'all-time';

  const wantsJsonRes = Boolean(req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')));

  if (!req.user) {
    if (wantsJsonRes) return res.status(401).json({ success: false, error: 'Authentication required to refresh contributor rankings.' });
    return res.redirect('/login');
  }

  let targetUser = null;
  if (!username) {
    targetUser = req.user;
  } else {
    targetUser = db.prepare(`
      SELECT u.*
      FROM users u
      LEFT JOIN github_sync_states gss ON (gss.user_id = u.id AND u.github_id IS NOT NULL AND gss.github_id = u.github_id)
      WHERE u.status = 'active'
        AND u.role != 'admin'
        AND COALESCE(u.is_synthetic, 0) = 0
        AND (LOWER(u.username) = LOWER(?) OR LOWER(COALESCE(gss.github_username, '')) = LOWER(?))
      LIMIT 1
    `).get(username, username);
  }

  if (!targetUser || !targetUser.github_id) {
    const errMsg = !targetUser
      ? `No registered DevNexus developer matching "@${username}" was found. Only registered DevNexus users appear on the leaderboard.`
      : `@${targetUser.username} has not connected a GitHub account yet.`;
    if (wantsJsonRes) {
      return res.status(400).json({ success: false, error: errMsg });
    }
    if (req.session) req.session.flashError = errMsg;
    return res.redirect(`/leaderboard?category=${category}&time=${time}${username ? `&q=${encodeURIComponent(username)}` : ''}`);
  }

  try {
    const token = (req.session && targetUser.id === req.user.id)
      ? (req.session.githubAccessToken || req.session.githubToken || null)
      : null;
    const syncRes = await synchronizeUserGitHubActivity(targetUser.id, {
      sessionToken: token,
      respectManualCooldown: true
    });

    if (!syncRes || !syncRes.ok) {
      throw new Error((syncRes && syncRes.message) || 'Unable to synchronize GitHub activity right now.');
    }

    const message = syncRes.message || `Successfully synchronized @${targetUser.username} on DevNexus Leaderboard.`;
    if (wantsJsonRes) {
      return res.json({
        success: true,
        message,
        userId: targetUser.id,
        syncState: syncRes.syncState
      });
    }

    if (req.session) req.session.flashSuccess = message;
    return res.redirect(`/leaderboard?category=${category}&time=${time}&q=${encodeURIComponent(targetUser.username)}&synced=${encodeURIComponent(targetUser.username)}`);
  } catch (err) {
    console.warn(`[Leaderboard Sync Error] for @${username || req.user.username}:`, err.message);
    if (wantsJsonRes) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (req.session) req.session.flashError = err.message;
    return res.redirect(`/leaderboard?category=${category}&time=${time}${username ? `&q=${encodeURIComponent(username)}` : ''}`);
  }
});


// 6. For Maintainers
router.get('/maintainers', (req, res) => {
  res.render('info', {
    siteName: 'DevNexus',
    activePage: 'maintainers',
    title: 'Open-Source Project Maintainers',
    subtitle: 'List your open-source project on DevNexus to attract passionate first-time contributors and mentors.',
    section: 'maintainers',
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

// 7. Community Events
router.get('/events', (req, res) => {
  res.render('info', {
    siteName: 'DevNexus',
    activePage: 'events',
    title: 'Events, Hackathons & Mentoring Sessions',
    subtitle: 'Join collaborative hack days, open-source sprints, and peer-to-peer code review circles.',
    section: 'events',
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

// 8. Legal and About Pages
router.get('/about', (req, res) => {
  res.render('info', {
    siteName: 'DevNexus',
    activePage: 'about',
    title: 'About DevNexus',
    subtitle: 'Bridging the gap between aspiring developers and meaningful open-source contributions.',
    section: 'about',
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

router.get('/privacy', (req, res) => {
  res.render('info', {
    siteName: 'DevNexus',
    activePage: 'privacy',
    title: 'Privacy Policy',
    subtitle: 'How DevNexus securely handles developer data, session cookies, and GitHub OAuth tokens.',
    section: 'privacy',
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

router.get('/terms', (req, res) => {
  res.render('info', {
    siteName: 'DevNexus',
    activePage: 'terms',
    title: 'Terms of Service',
    subtitle: 'Community guidelines and acceptable usage policy for the DevNexus platform.',
    section: 'terms',
    user: req.user || null,
    isAdmin: req.user && req.user.role === 'admin'
  });
});

module.exports = router;
