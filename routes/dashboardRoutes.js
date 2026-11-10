/**
 * DevNexus Developer Dashboard Routes
 * Connects the Developer Dashboard to real GitHub REST API endpoints and SQLite database.
 */

const express = require('express');
const router = express.Router();

const {
  getUserProfile,
  getUserRepositories,
  getUserEvents,
  searchIssues,
  isOAuthConfigured
} = require('../services/githubService');

const {
  addBookmark,
  removeBookmark,
  getUserBookmarks,
  isBookmarked
} = require('../db/database');

const { requireAuth } = require('../services/authService');

// Developer Dashboard View (Protected)
router.get('/', requireAuth, async (req, res) => {
  try {
    const githubToken = req.session.githubToken || null;
    const targetUsername = req.user.username;
    const query = req.query.q || '';
    const label = req.query.label || 'all';
    const language = req.query.language || 'all';
    const page = parseInt(req.query.page || '1', 10);

    // 1. Fetch Real GitHub Profile
    const { user: profileData, rateLimit: profileRateLimit, error: profileError } = await getUserProfile(targetUsername, githubToken);

    // Get skills from the logged-in user's profile
    const userSkills = req.user.skills
     ? JSON.parse(req.user.skills)
     : [];
    // 2. Fetch Real GitHub Repositories
    const { repos, rateLimit: reposRateLimit } = await getUserRepositories(targetUsername, githubToken, { sort: 'updated', perPage: 6 });

    // 3. Fetch Real GitHub Events / Activity
    const { events, rateLimit: eventsRateLimit } = await getUserEvents(targetUsername, githubToken, { perPage: 6 });

    // 4. Fetch Real Open-Source Issues from GitHub Search API
    const issueSearchResults = await searchIssues(
      { query, label, language, page, perPage: 8 },
      userSkills,
      githubToken
    );

    // 5. Fetch User's Real Persistent Bookmarks from SQLite
    const userId = req.user.id;
    const dbBookmarks = getUserBookmarks(userId);

    // Mark bookmarked issues
    const issuesWithBookmarkState = (issueSearchResults.issues || []).map(iss => ({
      ...iss,
      isBookmarked: isBookmarked(userId, iss.htmlUrl)
    }));

    // Choose most relevant rate limit indicator
    const rateLimit = issueSearchResults.rateLimit || profileRateLimit || reposRateLimit || eventsRateLimit;

    res.render('dashboard', {
      siteName: 'DevNexus',
      activePage: 'dashboard',
      user: req.user || null,
      targetUsername,
      profile: profileData || {
        name: targetUsername,
        login: targetUsername,
        avatar_url: 'https://avatars.githubusercontent.com/u/9919?v=4',
        bio: 'Open source enthusiast',
        public_repos: 0,
        followers: 0,
        following: 0,
        created_at: new Date().toISOString()
      },
      profileError,
      repos: repos || [],
      events: events || [],
      issues: issuesWithBookmarkState,
      totalIssuesCount: issueSearchResults.totalCount || 0,
      currentPage: issueSearchResults.page || 1,
      totalPages: issueSearchResults.totalPages || 1,
      rateLimit,
      issueError: issueSearchResults.error || null,
      issueErrorMessage: issueSearchResults.errorMessage || null,
      bookmarks: dbBookmarks,
      activeQuery: query,
      activeLabel: label,
      activeLanguage: language,
      isOAuthConfigured: isOAuthConfigured()
    });
  } catch (err) {
    console.error('Developer Dashboard Error:', err);
    res.status(500).render('error', {
      title: 'Dashboard Error',
      message: 'Failed to retrieve live GitHub data. Please verify your connection.',
      actionUrl: '/dashboard',
      actionText: 'Retry'
    });
  }
});

// JSON API: Search and filter issues asynchronously
router.get('/api/issues', requireAuth, async (req, res) => {
  try {
    const githubToken = req.session.githubToken || null;
    const query = req.query.q || '';
    const label = req.query.label || 'all';
    const language = req.query.language || 'all';
    const page = parseInt(req.query.page || '1', 10);
    const userId = req.user.id;

    const userSkills = req.user && req.user.skills ? JSON.parse(req.user.skills) : ['javascript', 'python', 'typescript'];

    const results = await searchIssues(
      { query, label, language, page, perPage: 8 },
      userSkills,
      githubToken
    );

    const issuesWithBookmarkState = (results.issues || []).map(iss => ({
      ...iss,
      isBookmarked: isBookmarked(userId, iss.htmlUrl)
    }));

    res.json({
      success: true,
      ...results,
      issues: issuesWithBookmarkState
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// JSON API: Add persistent bookmark to SQLite database
router.post('/api/bookmarks', requireAuth, (req, res) => {
  const userId = req.user.id;
  const bookmarkData = req.body;

  if (!bookmarkData.html_url) {
    return res.status(400).json({ success: false, error: 'Missing required bookmark html_url.' });
  }

  try {
    addBookmark(userId, bookmarkData);
    const userBookmarks = getUserBookmarks(userId);
    res.json({ success: true, count: userBookmarks.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// JSON API: Remove persistent bookmark from SQLite database
router.delete('/api/bookmarks', requireAuth, (req, res) => {
  const userId = req.user.id;
  const { html_url } = req.body;

  if (!html_url) {
    return res.status(400).json({ success: false, error: 'Missing html_url.' });
  }

  try {
    removeBookmark(userId, html_url);
    const userBookmarks = getUserBookmarks(userId);
    res.json({ success: true, count: userBookmarks.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
