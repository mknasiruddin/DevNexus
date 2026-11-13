/**
 * DevNexus Achievement Badges Routes (Member 3)
 * Full HTML views and REST API endpoints for developer achievement badges.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../services/authService');
const badgeService = require('../services/badgeService');
const { findUserByUsername } = require('../db/database');

function isJsonRequest(req) {
  return Boolean(
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.query.format === 'json' ||
    req.path.startsWith('/api') ||
    req.originalUrl.includes('/api/badges')
  );
}

// ---------------------------------------------------------------------------
// 1. GET /badges or /api/badges — Authenticated Badge Showcase
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  if (!req.user) {
    if (isJsonRequest(req)) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Sign in to view your achievement badges.' });
    }
    return res.redirect('/login');
  }

  try {
    const result = badgeService.evaluateUserBadges(req.user.id);

    if (isJsonRequest(req)) {
      return res.json({
        success: true,
        user: {
          id: req.user.id,
          username: req.user.username,
          name: req.user.name || req.user.username
        },
        ...result
      });
    }

    res.render('badges', {
      siteName: 'DevNexus',
      activePage: 'badges',
      user: req.user,
      badges: result.badges,
      summary: result.summary
    });
  } catch (err) {
    console.error('[DevNexus Badges Error]:', err);
    if (isJsonRequest(req)) {
      return res.status(500).json({ success: false, error: 'Failed to retrieve achievement badges.' });
    }
    res.status(500).render('error', {
      siteName: 'DevNexus',
      activePage: 'badges',
      statusCode: 500,
      title: 'Badges Error',
      message: 'Failed to load your achievement badges. Please try again.',
      actionUrl: '/dashboard',
      actionText: 'Return to Dashboard'
    });
  }
});

// ---------------------------------------------------------------------------
// 2. POST /api/badges/sync or /badges/sync — Re-evaluate Badges
// ---------------------------------------------------------------------------

router.post(['/sync', '/api/sync'], requireAuth, async (req, res) => {
  try {
    const result = badgeService.evaluateUserBadges(req.user.id);
    res.json({
      success: true,
      message: 'Badges re-evaluated and synchronized successfully.',
      ...result
    });
  } catch (err) {
    console.error('[DevNexus Badges Sync Error]:', err);
    res.status(500).json({ success: false, error: 'Failed to synchronize achievement badges.' });
  }
});

// ---------------------------------------------------------------------------
// 3. GET /badges/:username or /api/badges/:username — Public Developer Badges
// ---------------------------------------------------------------------------

router.get('/:username', async (req, res) => {
  const username = (req.params.username || '').trim();
  const publicData = badgeService.getPublicUserBadges(username);

  if (!publicData) {
    if (isJsonRequest(req)) {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: `User @${username} not found.` });
    }
    return res.status(404).render('error', {
      siteName: 'DevNexus',
      activePage: 'badges',
      statusCode: 404,
      title: 'Developer Not Found',
      message: `No developer with username @${username} exists on DevNexus.`,
      actionUrl: '/leaderboard',
      actionText: 'View Leaderboard'
    });
  }

  if (isJsonRequest(req)) {
    return res.json({
      success: true,
      ...publicData
    });
  }

  res.render('badges', {
    siteName: 'DevNexus',
    activePage: 'badges',
    user: req.user || null,
    targetUser: publicData.user,
    badges: publicData.badges,
    summary: publicData.summary
  });
});

module.exports = router;

