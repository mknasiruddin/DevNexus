'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../services/authService');
const streakService = require('../services/streakService');
const { findUserByUsername } = require('../db/database');

function isJsonRequest(req) {
  return Boolean(
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.query.format === 'json' ||
    req.path.startsWith('/api') ||
    req.originalUrl.includes('/api/streak')
  );
}

router.get('/', async (req, res) => {
  if (!req.user) {
    if (isJsonRequest(req)) return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Sign in to access your contribution streak.' });
    return res.redirect('/login');
  }
  try {
    const streak = await streakService.recordActivity(req.user.id, 'streak_page_visit');
    if (isJsonRequest(req)) {
      return res.json({ success: true, user: { id: req.user.id, username: req.user.username, name: req.user.name || req.user.username }, streak });
    }
    res.render('streak', { siteName: 'DevNexus', activePage: 'streak', user: req.user, streak });
  } catch (err) {
    console.error('[DevNexus Streak Error]:', err);
    if (isJsonRequest(req)) return res.status(500).json({ success: false, error: 'Failed to retrieve streak metrics.' });
    res.status(500).render('error', { siteName: 'DevNexus', activePage: 'streak', statusCode: 500, title: 'Streak Service Error', message: 'Failed to retrieve your contribution streak. Please try again.', actionUrl: '/dashboard', actionText: 'Return to Dashboard' });
  }
});

router.post(['/ping', '/api/ping'], requireAuth, async (req, res) => {
  try {
    const activityType = (req.body && req.body.activityType) ? String(req.body.activityType).slice(0, 50) : 'manual_checkin';
    const streak = await streakService.recordActivity(req.user.id, activityType);
    res.json({ success: true, message: 'Contribution activity recorded successfully.', streak });
  } catch (err) {
    console.error('[DevNexus Streak Ping Error]:', err);
    res.status(500).json({ success: false, error: 'Failed to record streak activity.' });
  }
});

router.post(['/freeze', '/api/freeze'], requireAuth, async (req, res) => {
  try {
    const result = streakService.useStreakFreeze(req.user.id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[DevNexus Streak Freeze Error]:', err);
    res.status(500).json({ success: false, error: 'Failed to activate streak freeze shield.' });
  }
});

router.get('/:username', async (req, res) => {
  const username = (req.params.username || '').trim();
  const publicData = streakService.getPublicStreak(username);
  if (!publicData) {
    if (isJsonRequest(req)) return res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: `User @${username} not found.` });
    return res.status(404).render('error', { siteName: 'DevNexus', activePage: 'streak', statusCode: 404, title: 'Developer Not Found', message: `No developer with username @${username} exists on DevNexus.`, actionUrl: '/leaderboard', actionText: 'View Leaderboard' });
  }
  if (isJsonRequest(req)) return res.json({ success: true, ...publicData });
  res.render('streak', { siteName: 'DevNexus', activePage: 'streak', user: req.user || null, targetUser: publicData.user, streak: publicData.streak });
});

module.exports = router;
