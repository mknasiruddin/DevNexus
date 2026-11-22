/**
 * DevNexus Skill Tree Routes
 * Authenticated routes for the interactive Skill Tree feature.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../services/authService');
const skillTreeService = require('../services/skillTreeService');
const { getUserDashboardSyncData } = require('../services/githubSyncService');
const analyticsService = require('../services/analyticsService');

function getAuthenticatedUserReposForSkillTree(user) {
  if (!user || !user.id || !user.github_id) {
    return [];
  }
  const synced = getUserDashboardSyncData(user.id, user.github_id, {
    isSelf: true,
    repoLimit: null,
    activityLimit: 0
  });
  return Array.isArray(synced && synced.repos) ? synced.repos : [];
}

async function handleGetSkillTreeJson(req, res) {
  try {
    const repos = getAuthenticatedUserReposForSkillTree(req.user);
    const tree = await skillTreeService.evaluateUserSkillTree(req.user.id, req.user, repos);
    res.json({
      success: true,
      tree,
      graph: skillTreeService.SKILL_TREE_GRAPH
    });
  } catch (err) {
    console.error('[DevNexus] Skill tree API error:', err);
    res.status(500).json({ success: false, error: 'Failed to evaluate skill tree.' });
  }
}

async function handleUnlockNode(req, res) {
  try {
    const repos = getAuthenticatedUserReposForSkillTree(req.user);
    const tree = await skillTreeService.evaluateUserSkillTree(req.user.id, req.user, repos);
    const result = await skillTreeService.claimSkillNode(req.user.id, req.params.nodeId, tree);
    if (!result || !result.success) {
      return res.status(400).json({
        success: false,
        error: (result && result.error) || 'Skill node cannot be unlocked yet.'
      });
    }
    const platformActivity = analyticsService.recordPlatformActivity(req.user.id, {
      activityType: 'skill_task',
      uniqueKey: `skill_task:${result.node.id}`,
      referenceId: result.node.id,
      title: `Completed Skill Task: ${result.node.title}`,
      metadata: { track: result.node.track, xpEarned: result.xpEarned || 0 }
    });
    res.json({
      success: true,
      node: result.node,
      xpEarned: result.xpEarned,
      platformActivity
    });
  } catch (err) {
    console.error('[DevNexus] Skill node unlock error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to unlock skill node.' });
  }
}

// GET /skill-tree — Render the skill tree page (auth required) or JSON if requested
router.get('/', requireAuth, async (req, res) => {
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.query.format === 'json') {
    return handleGetSkillTreeJson(req, res);
  }
  try {
    const repos = getAuthenticatedUserReposForSkillTree(req.user);
    const tree = await skillTreeService.evaluateUserSkillTree(req.user.id, req.user, repos);
    res.render('skill-tree', {
      siteName: 'DevNexus',
      activePage: 'skill-tree',
      user: req.user,
      isAdmin: req.user.role === 'admin',
      tree,
      graph: skillTreeService.SKILL_TREE_GRAPH
    });
  } catch (err) {
    console.error('[DevNexus] Skill tree error:', err);
    res.status(500).render('error', {
      siteName: 'DevNexus',
      title: 'Skill Tree Error',
      message: 'Failed to load your skill tree. Please try again.',
      actionUrl: '/skill-tree',
      actionText: 'Retry'
    });
  }
});

// JSON API routes
router.get(['/api/skill-tree', '/api'], requireAuth, handleGetSkillTreeJson);
router.post(['/api/skill-tree/unlock/:nodeId', '/api/unlock/:nodeId', '/unlock/:nodeId'], requireAuth, handleUnlockNode);

module.exports = router;
