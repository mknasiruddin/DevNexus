/**
 * DevNexus Content & Navigation Routes
 * Connects all informational, educational, and community navigation destinations.
 */

const express = require('express');
const router = express.Router();
const {
  getLeaderboard,
  getLeaderboardStats,
  setRoadmapStepStatus,
  resetUserRoadmapProgress
} = require('../db/database');
const { syncContributorFromGitHub } = require('../services/githubService');
const {
  getRoadmapStagesWithProgress,
  calculateContributionReadiness
} = require('../services/saanviModulesService');


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

router.post('/api/roadmap/step', (req, res) => {
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
    const updatedRoadmap = getRoadmapStagesWithProgress(req.user.id);
    const readiness = calculateContributionReadiness(req.user, [], {
      roadmapCompletedCount: updatedRoadmap.completedCount
    });
    return res.json({
      success: true,
      stepNumber: parsedStep,
      completed,
      ...updatedRoadmap,
      readinessScore: readiness.score
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || 'Could not update roadmap progress.'
    });
  }
});

router.post('/api/roadmap/reset', (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required to reset roadmap progress.'
    });
  }
  try {
    resetUserRoadmapProgress(req.user.id);
    const updatedRoadmap = getRoadmapStagesWithProgress(req.user.id);
    return res.json({
      success: true,
      ...updatedRoadmap
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
    const time = ['all-time', 'this-month', 'this-week'].includes(rawTime) ? rawTime : 'all-time';

    const search = (req.query.q || req.query.search || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const stats = getLeaderboardStats();

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

// Sync or Index Any Genuine GitHub Contributor Live
router.post('/leaderboard/sync', async (req, res) => {
  const username = (req.body && req.body.username ? req.body.username : '').trim().replace(/^@/, '');
  const category = req.body.category || 'top';
  const time = req.body.time || 'all-time';

  if (!username) {
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(400).json({ success: false, error: 'Please enter a valid GitHub username.' });
    }
    if (req.session) req.session.flashError = 'Please enter a valid GitHub username to index.';
    return res.redirect(`/leaderboard?category=${category}&time=${time}`);
  }

  try {
    const token = req.session ? req.session.githubAccessToken : null;
    const syncResult = await syncContributorFromGitHub(username, token);

    const message = `Successfully indexed @${syncResult.contributor.username}! Verified ${syncResult.totalEventsFound} GitHub event(s).`;

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.json({
        success: true,
        message,
        contributor: syncResult.contributor,
        eventsCount: syncResult.totalEventsFound
      });
    }

    if (req.session) req.session.flashSuccess = message;
    return res.redirect(`/leaderboard?category=${category}&time=${time}&q=${encodeURIComponent(username)}&synced=${encodeURIComponent(username)}`);
  } catch (err) {
    console.warn(`[Leaderboard Sync Error] for @${username}:`, err.message);
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (req.session) req.session.flashError = err.message;
    return res.redirect(`/leaderboard?category=${category}&time=${time}&q=${encodeURIComponent(username)}`);
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
