/**
 * DevNexus Developer Portfolio Routes
 * Public and authenticated routes for the Developer Portfolio feature.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../services/authService');
const portfolioService = require('../services/portfolioService');
const { getUserRepositories } = require('../services/githubService');

// GET /portfolio — Logged-in user's own portfolio
router.get('/', async (req, res) => {
  if (!req.user) {
    return res.redirect('/login');
  }
  try {
    const portfolio = await portfolioService.getDeveloperPortfolio(
      req.user.username,
      req.session.githubToken
    );
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
      githubToken
    );

    if (!portfolio.user) {
      return res.status(404).render('error', {
        siteName: 'DevNexus',
        title: 'Portfolio Not Found',
        message: `No portfolio found for user "${req.params.username}".`,
        actionUrl: '/projects',
        actionText: 'Explore Projects'
      });
    }

    res.render('portfolio', {
      siteName: 'DevNexus',
      activePage: 'portfolio',
      user: req.user || null,
      isAdmin: req.user && req.user.role === 'admin',
      isOwnPortfolio: req.user && req.user.username === portfolio.user.username,
      portfolio
    });
  } catch (err) {
    console.error('[DevNexus] Portfolio error:', err);
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
    await portfolioService.syncPortfolioFromGitHub(req.user.id, req.session.githubToken);
    res.json({ success: true, message: 'Portfolio synced with GitHub' });
  } catch (err) {
    console.error('[DevNexus] Portfolio sync error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to sync portfolio from GitHub.' });
  }
});

module.exports = router;
