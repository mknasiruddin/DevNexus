/**
 * DevNexus Skill Tree Routes
 * Authenticated routes for the interactive Skill Tree feature.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../services/authService');
const skillTreeService = require('../services/skillTreeService');
const { getUserRepositories } = require('../services/githubService');

async function handleGetSkillTreeJson(req, res) {
  try {
    const { repos } = await getUserRepositories(
      req.user.username,
      req.session.githubToken,
      { sort: 'updated', perPage: 20 }
    );
    const tree = await skillTreeService.evaluateUserSkillTree(req.user.id, req.user, repos || []);
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
    const { repos } = await getUserRepositories(
      req.user.username,
      req.session.githubToken,
      { sort: 'updated', perPage: 20 }
    );
    const tree = await skillTreeService.evaluateUserSkillTree(req.user.id, req.user, repos || []);
    const result = await skillTreeService.claimSkillNode(req.user.id, req.params.nodeId, tree);
    res.json({
      success: true,
      node: result.node,
      xpEarned: result.xpEarned
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
    const { repos } = await getUserRepositories(
      req.user.username,
      req.session.githubToken,
      { sort: 'updated', perPage: 20 }
    );
    const tree = await skillTreeService.evaluateUserSkillTree(req.user.id, req.user, repos || []);
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
