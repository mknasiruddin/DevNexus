'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../services/authService');
const streakService = require('../services/streakService');
const { getActivityBreakdown, getDailyActivityCounts, getUserBookmarks, getUserRoadmapProgress, getUserUnlockedBadges } = require('../db/database');

router.get('/', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const streak = streakService.getStreakSummary(userId);
    const breakdown = getActivityBreakdown(userId, 90);
    const daily = getDailyActivityCounts(userId, 90);
    const bookmarks = getUserBookmarks(userId) || [];
    const roadmap = getUserRoadmapProgress(userId) || [];
    const badges = getUserUnlockedBadges(userId) || [];

    res.render('stats', {
      siteName: 'DevNexus',
      activePage: 'stats',
      user: req.user,
      streak,
      breakdown,
      daily,
      bookmarksCount: bookmarks.length,
      roadmapCount: roadmap.length,
      badgesCount: badges.length
    });
  } catch (err) {
    console.error('[DevNexus Stats Error]:', err);
    res.status(500).render('error', {
      siteName: 'DevNexus',
      title: 'Stats Error',
      message: 'Failed to load your stats.',
      actionUrl: '/dashboard',
      actionText: 'Return to Dashboard'
    });
  }
});

router.get('/api', requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const breakdown = getActivityBreakdown(userId, 90);
    const daily = getDailyActivityCounts(userId, 90);
    const streak = streakService.getStreakSummary(userId);
    res.json({ success: true, breakdown, daily, streak });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load stats.' });
  }
});

module.exports = router;
