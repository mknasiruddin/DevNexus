/**
 * DevNexus Project Discovery Routes
 * Provides repository discovery backed by official GitHub REST API.
 * Accessible to both authenticated users and public visitors.
 */

const express = require('express');
const router = express.Router();

const { searchRepositories, calculateRepositoryHealth } = require('../services/githubService');

const AVAILABLE_LANGUAGES = [
  'All',
  'JavaScript',
  'TypeScript',
  'Python',
  'Go',
  'Rust',
  'Java',
  'C++',
  'Ruby',
  'PHP'
];

const AVAILABLE_TOPICS = [
  'All',
  'good-first-issue',
  'beginner-friendly',
  'hacktoberfest',
  'web',
  'api',
  'machine-learning',
  'cli',
  'devops',
  'tools'
];

const STAR_OPTIONS = [
  { value: 0, label: 'Any stars' },
  { value: 10, label: '10+ stars' },
  { value: 50, label: '50+ stars' },
  { value: 100, label: '100+ stars' },
  { value: 500, label: '500+ stars' },
  { value: 1000, label: '1,000+ stars' },
  { value: 5000, label: '5,000+ stars' }
];

const SORT_OPTIONS = [
  { value: 'stars', label: 'Most Stars' },
  { value: 'forks', label: 'Most Forks' },
  { value: 'updated', label: 'Recently Updated' }
];

// GET /projects - Project Discovery Page
router.get('/', async (req, res) => {
  try {
    const githubToken = req.session ? req.session.githubToken : null;
    const query = (req.query.q || '').trim();
    const language = (req.query.language || 'all').trim();
    const topic = (req.query.topic || 'all').trim();
    const stars = parseInt(req.query.stars || '0', 10) || 0;
    const sort = ['stars', 'forks', 'updated'].includes(req.query.sort) ? req.query.sort : 'stars';
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);

    const searchResult = await searchRepositories(
      {
        query,
        language,
        topic,
        minStars: stars,
        sort,
        order: 'desc',
        page,
        perPage: 12
      },
      githubToken
    );

    // If client requested JSON
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json')) || req.query.format === 'json') {
      return res.json({
        success: !searchResult.error,
        ...searchResult,
        filters: { query, language, topic, stars, sort, page }
      });
    }

    res.render('projects', {
      siteName: 'DevNexus',
      activePage: 'projects',
      user: req.user || null,
      isAdmin: req.user && req.user.role === 'admin',
      repositories: searchResult.repositories || [],
      totalCount: searchResult.totalCount || 0,
      page: searchResult.page || page,
      perPage: searchResult.perPage || 12,
      totalPages: searchResult.totalPages || 0,
      rateLimit: searchResult.rateLimit || null,
      cached: searchResult.cached || false,
      error: searchResult.error || null,
      errorMessage: searchResult.errorMessage || null,
      // Active filter states
      activeQuery: query,
      activeLanguage: language,
      activeTopic: topic,
      activeStars: stars,
      activeSort: sort,
      // Filter options lists
      availableLanguages: AVAILABLE_LANGUAGES,
      availableTopics: AVAILABLE_TOPICS,
      starOptions: STAR_OPTIONS,
      sortOptions: SORT_OPTIONS
    });
  } catch (err) {
    console.error('[DevNexus] Project discovery error:', err);
    res.status(500).render('error', {
      siteName: 'DevNexus',
      title: 'Project Discovery Unavailable',
      message: 'An unexpected error occurred while communicating with the repository index. Please try again shortly.',
      actionUrl: '/projects',
      actionText: 'Retry Project Discovery'
    });
  }
});

// POST /projects/api/health - Evaluate Repository Health Score from metadata payload
router.post('/api/health', (req, res) => {
  try {
    const repoPayload = req.body && typeof req.body === 'object' ? req.body : null;
    const health = calculateRepositoryHealth(repoPayload);
    res.json({
      success: true,
      health
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: 'Unable to calculate repository health score.'
    });
  }
});

// GET /projects/:owner/:repo - Direct repository jump to GitHub
router.get('/:owner/:repo', (req, res) => {
  const owner = (req.params.owner || '').trim();
  const repo = (req.params.repo || '').trim();
  const validSegment = /^[a-zA-Z0-9._-]{1,100}$/;
  if (!owner || !repo || !validSegment.test(owner) || !validSegment.test(repo)) {
    return res.redirect('/projects');
  }
  res.redirect(`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
});

module.exports = router;
