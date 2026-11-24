/**
 * DevNexus Developer Productivity & Activity Analytics API Routes
 *
 * All endpoints enforce authentication via requireAuth and strictly scope
 * analytics queries to the authenticated developer's user ID.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../services/authService');
const {
  getLeaderboard,
  getLeaderboardStats,
  findUserById,
  getUserGithubSyncState
} = require('../db/database');
const analyticsService = require('../services/analyticsService');
const scoringService = require('../services/scoringService');
const { syncIfStale } = require('../services/githubSyncService');
const { getUserRepositoryStats } = require('../services/repoStatsService');
const { isOAuthConfigured } = require('../services/githubService');

router.use(requireAuth);

function isJsonRequest(req) {
  return Boolean(
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.query.format === 'json' ||
    (req.originalUrl && req.originalUrl.startsWith('/api/'))
  );
}

function enforceUserScope(req, res) {
  if (
    req.query.userId !== undefined &&
    String(req.query.userId).trim() !== '' &&
    Number(req.query.userId) !== Number(req.user.id)
  ) {
    res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
      message: 'Access denied: analytics endpoints are strictly scoped to your authenticated account.'
    });
    return false;
  }
  return true;
}

function parsePeriodOptions(req) {
  const q = req.query || {};
  return {
    year: q.year ? parseInt(q.year, 10) : undefined,
    month: q.month ? parseInt(q.month, 10) : undefined,
    quarter: q.quarter ? parseInt(q.quarter, 10) : undefined,
    half: q.half ? parseInt(q.half, 10) : undefined,
    period: q.period ? String(q.period).toLowerCase() : 'monthly',
    category: q.category ? String(q.category).toLowerCase() : 'all',
    repoName: q.repo ? String(q.repo).trim() : (q.repoName ? String(q.repoName).trim() : null),
    fromDate: q.from || q.fromDate || null,
    toDate: q.to || q.toDate || null,
    limit: q.limit ? parseInt(q.limit, 10) : undefined,
    offset: q.offset ? parseInt(q.offset, 10) : undefined,
    leaderboardCategory: q.leaderboardCategory || 'top',
    leaderboardTime: q.leaderboardTime || 'all-time',
    includePrivate: true
  };
}

router.get('/', async (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const freshUser = findUserById(req.user.id) || req.user;
    if (freshUser && freshUser.github_id) {
      await Promise.race([
        syncIfStale(freshUser.id, {
          sessionToken: (req.session && (req.session.githubToken || req.session.githubAccessToken)) || null
        }).catch(() => null),
        new Promise(resolve => setTimeout(resolve, 2500))
      ]);
    }
    analyticsService.backfillVerifiedContributorsToLeaderboard(25);
    const opts = parsePeriodOptions(req);
    const initialPayload = analyticsService.getFullAnalyticsDashboardPayload(freshUser.id, opts);
    if (isJsonRequest(req)) {
      return res.json({ success: true, ...initialPayload });
    }
    const syncState = freshUser.github_id
      ? getUserGithubSyncState(freshUser.id, String(freshUser.github_id))
      : null;
    const repoCounts = getUserRepositoryStats(freshUser.id, { isSelf: true });

    return res.render('analytics', {
      siteName: 'DevNexus',
      activePage: 'analytics',
      user: freshUser,
      isAdmin: freshUser.role === 'admin',
      isGithubConnected: Boolean(freshUser.github_id),
      isOAuthConfigured: isOAuthConfigured(),
      syncState,
      repoCounts,
      initialPayload,
      streak: initialPayload.streak || null
    });
  } catch (err) {
    console.error('[DevNexus Analytics Page Error]:', err.message);
    if (isJsonRequest(req)) {
      return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load developer analytics.' });
    }
    return res.status(500).render('error', {
      siteName: 'DevNexus',
      activePage: 'analytics',
      statusCode: 500,
      title: 'Analytics Error',
      message: 'Failed to retrieve your developer productivity analytics. Please try again.',
      actionUrl: '/dashboard',
      actionText: 'Return to Dashboard'
    });
  }
});

router.get('/summary', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    analyticsService.backfillVerifiedContributorsToLeaderboard(25);
    const opts = parsePeriodOptions(req);
    const payload = analyticsService.getFullAnalyticsDashboardPayload(req.user.id, opts);
    return res.json({ success: true, ...payload });
  } catch (err) {
    console.error('[DevNexus Analytics Summary Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to compute analytics summary.' });
  }
});

router.get('/monthly', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getMonthlyAnalytics(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics Monthly Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load monthly analytics.' });
  }
});

router.get('/quarterly', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getQuarterlyAnalytics(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics Quarterly Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load quarterly analytics.' });
  }
});

router.get('/half-yearly', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getHalfYearlyAnalytics(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics Half-Yearly Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load half-yearly analytics.' });
  }
});

router.get('/yearly', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getYearlyAnalytics(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics Yearly Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load yearly analytics.' });
  }
});

router.get('/activity-history', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getActivityHistory(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics History Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load activity history.' });
  }
});

router.get('/heatmap', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getActivityHeatmap(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics Heatmap Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load contribution heatmap.' });
  }
});

router.get('/activity-percentage', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getActivityPercentagesSummary(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics Percentage Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to calculate activity percentages.' });
  }
});

router.get('/repositories', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getRepositoryAnalytics(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics Repositories Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load repository analytics.' });
  }
});

router.get('/comparisons', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const data = analyticsService.getComparisonsPayload(req.user.id, opts);
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('[DevNexus Analytics Comparisons Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load period comparisons.' });
  }
});

router.get('/leaderboard', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    analyticsService.backfillVerifiedContributorsToLeaderboard(50);
    const rawCat = String(req.query.category || 'top').toLowerCase();
    const category = ['top', 'active', 'rising'].includes(rawCat) ? rawCat : 'top';
    const rawTime = String(req.query.time || 'all-time').toLowerCase();
    const allowedTimes = ['all-time', 'this-week', 'weekly', 'this-month', 'monthly', 'this-quarter', 'quarterly', 'this-year', 'yearly'];
    const time = allowedTimes.includes(rawTime) ? rawTime : 'all-time';
    const search = String(req.query.search || req.query.q || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.max(1, Math.min(50, parseInt(req.query.perPage, 10) || 10));

    const data = getLeaderboard({ category, time, search, page, perPage });
    const stats = getLeaderboardStats({ time });
    const currentUserEntry = data.contributors.find(c => c.userId && Number(c.userId) === Number(req.user.id)) || null;

    return res.json({
      success: true,
      category,
      time,
      search,
      stats,
      currentUserEntry,
      ...data
    });
  } catch (err) {
    console.error('[DevNexus Analytics Leaderboard Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load leaderboard analytics.' });
  }
});

router.get('/report', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    analyticsService.backfillVerifiedContributorsToLeaderboard(25);
    const opts = parsePeriodOptions(req);
    const report = analyticsService.getProductivityReport(req.user.id, opts);
    return res.json({ success: true, ...report });
  } catch (err) {
    console.error('[DevNexus Analytics Report Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to generate productivity report.' });
  }
});

router.get('/scoring-rules', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    return res.json({
      success: true,
      rules: scoringService.getScoringRules(),
      ruleMap: scoringService.getScoringRulesMap()
    });
  } catch (err) {
    console.error('[DevNexus Analytics Scoring Rules Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load scoring rules.' });
  }
});

router.get('/platform-activities', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const summary = analyticsService.getPlatformActivitySummary(req.user.id, opts);
    return res.json({ success: true, ...summary });
  } catch (err) {
    console.error('[DevNexus Analytics Platform Activities Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load platform activities.' });
  }
});

router.get('/daily-summaries', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const summaries = analyticsService.getUserDailyActivitySummaries(req.user.id, opts);
    return res.json({ success: true, summaries });
  } catch (err) {
    console.error('[DevNexus Analytics Daily Summaries Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load daily summaries.' });
  }
});

router.get('/statistics', (req, res) => {
  if (!enforceUserScope(req, res)) return;
  try {
    const opts = parsePeriodOptions(req);
    const statistics = analyticsService.getUserProductivityStatistics(req.user.id, opts);
    return res.json({ success: true, statistics });
  } catch (err) {
    console.error('[DevNexus Analytics Statistics Error]:', err.message);
    return res.status(500).json({ success: false, error: 'ANALYTICS_ERROR', message: 'Failed to load productivity statistics.' });
  }
});

module.exports = router;
