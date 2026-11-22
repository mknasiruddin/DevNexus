/**
 * DevNexus Developer Portfolio Routes
 * Public and authenticated routes for the Developer Portfolio feature.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../services/authService');
const portfolioService = require('../services/portfolioService');

function wantsJson(req) {
  return Boolean(
    req.xhr ||
    (req.headers && req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.query.format === 'json' ||
    (req.originalUrl && req.originalUrl.startsWith('/api/portfolio'))
  );
}

// GET /portfolio — Logged-in user's own portfolio
router.get('/', async (req, res) => {
  if (!req.user) {
    if (wantsJson(req)) {
      return res.status(401).json({ success: false, error: 'AUTHENTICATION_REQUIRED' });
    }
    return res.redirect('/login');
  }
  try {
    const portfolio = await portfolioService.getDeveloperPortfolio(
      req.user.username,
      req.session.githubToken,
      { viewerUserId: req.user.id }
    );
    if (wantsJson(req)) {
      return res.json({
        success: true,
        isOwnPortfolio: true,
        portfolio: {
          user: { id: portfolio.user.id, username: portfolio.user.username, name: portfolio.user.name, experience_level: portfolio.user.experience_level, is_onboarded: Boolean(portfolio.user.is_onboarded), githubConnected: Boolean(portfolio.user.github_id) },
          syncState: portfolio.syncState,
          repoStats: portfolio.repoStats,
          allReposCount: portfolio.allReposCount,
          totalStars: portfolio.totalStars,
          repos: portfolio.repos,
          featuredRepos: portfolio.featuredRepos,
          leaderboardRank: portfolio.leaderboardRank,
          skillTreeSummary: portfolio.skillTreeSummary,
          badges: portfolio.badges,
          readinessScore: portfolio.readinessScore,
          roadmapProgress: portfolio.roadmapProgress
        }
      });
    }
    res.render('portfolio', {
      siteName: 'DevNexus',
      activePage: 'portfolio',
      user: req.user,
      isAdmin: req.user.role === 'admin',
      isOwnPortfolio: true,
      portfolio
    });
  } catch (err) {
    console.error('[DevNexus] Portfolio error:', err);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, error: 'Failed to load portfolio.' });
    }
    res.status(500).render('error', {
      siteName: 'DevNexus',
      title: 'Portfolio Error',
      message: 'Failed to load your portfolio. Please try again.',
      actionUrl: '/portfolio',
      actionText: 'Retry'
    });
  }
});

// GET /portfolio/:username — Public view of any user's portfolio
router.get('/:username', async (req, res) => {
  try {
    const githubToken = req.session ? req.session.githubToken : null;
    const portfolio = await portfolioService.getDeveloperPortfolio(
      req.params.username,
      githubToken,
      { viewerUserId: req.user ? req.user.id : null }
    );

    if (!portfolio.user) {
      if (wantsJson(req)) {
        return res.status(404).json({ success: false, error: 'PORTFOLIO_NOT_FOUND' });
      }
      return res.status(404).render('error', {
        siteName: 'DevNexus',
        title: 'Portfolio Not Found',
        message: `No portfolio found for user "${req.params.username}".`,
        actionUrl: '/projects',
        actionText: 'Explore Projects'
      });
    }

    const isOwn = Boolean(req.user && req.user.id === portfolio.user.id);
    if (wantsJson(req)) {
      return res.json({
        success: true,
        isOwnPortfolio: isOwn,
        portfolio: {
          user: { id: portfolio.user.id, username: portfolio.user.username, name: portfolio.user.name, experience_level: portfolio.user.experience_level, is_onboarded: Boolean(portfolio.user.is_onboarded), githubConnected: Boolean(portfolio.user.github_id) },
          syncState: portfolio.syncState,
          repoStats: portfolio.repoStats,
          allReposCount: portfolio.allReposCount,
          totalStars: portfolio.totalStars,
          repos: portfolio.repos,
          featuredRepos: portfolio.featuredRepos,
          leaderboardRank: portfolio.leaderboardRank,
          skillTreeSummary: portfolio.skillTreeSummary,
          badges: portfolio.badges,
          readinessScore: portfolio.readinessScore,
          roadmapProgress: portfolio.roadmapProgress
        }
      });
    }

    res.render('portfolio', {
      siteName: 'DevNexus',
      activePage: 'portfolio',
      user: req.user || null,
      isAdmin: req.user && req.user.role === 'admin',
      isOwnPortfolio: isOwn,
      portfolio
    });
  } catch (err) {
    console.error('[DevNexus] Portfolio error:', err);
    if (wantsJson(req)) {
      return res.status(500).json({ success: false, error: 'Failed to load portfolio.' });
    }
    res.status(500).render('error', {
      siteName: 'DevNexus',
      title: 'Portfolio Error',
      message: 'Failed to load this portfolio. Please try again.',
      actionUrl: '/projects',
      actionText: 'Explore Projects'
    });
  }
});

// POST /portfolio/api/update or /api/portfolio/update — Update portfolio settings (auth required)
router.post(['/api/update', '/update'], requireAuth, async (req, res) => {
  try {
    await portfolioService.updatePortfolioSettings(req.user.id, req.body);
    res.json({ success: true });
  } catch (err) {
    console.error('[DevNexus] Portfolio update error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to update portfolio settings.' });
  }
});

// POST /portfolio/api/sync or /api/portfolio/sync — Sync portfolio from GitHub (auth required)
router.post(['/api/sync', '/sync'], requireAuth, async (req, res) => {
  try {
    const result = await portfolioService.syncPortfolioFromGitHub(req.user.id, req.session.githubToken);
    if (!result.success) {
      return res.status(result.reason === 'GITHUB_NOT_CONNECTED' ? 400 : 502).json(result);
    }
    res.json({ success: true, message: result.message || 'Portfolio synced with GitHub', syncState: result.syncState });
  } catch (err) {
    console.error('[DevNexus] Portfolio sync error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to sync portfolio from GitHub.' });
  }
});

module.exports = router;
