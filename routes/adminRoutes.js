/**
 * DevNexus Admin Dashboard Routes
 * Protected with server-side authorization. Connects to real SQLite database records
 * for user management, bookmark statistics, and application activity logs.
 */

const express = require('express');
const router = express.Router();

const { requireAdmin } = require('../services/authService');
const {
  countUsers,
  getAllUsers,
  updateUserRole,
  toggleUserStatus,
  getBookmarkStats,
  getRecentActivities,
  logActivity
} = require('../db/database');

// Helper to inspect live Node.js process runtime status
function getSystemStatus() {
  const uptimeSec = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSec / 3600);
  const minutes = Math.floor((uptimeSec % 3600) / 60);
  const seconds = uptimeSec % 60;
  const mem = process.memoryUsage();
  return {
    nodeVersion: process.version,
    platform: `${process.platform} (${process.arch})`,
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
    heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`
  };
}

// Admin Login GET view (unprotected)
router.get('/login', (req, res) => {
  if (req.user && req.user.role === 'admin') {
    return res.redirect('/admin');
  }
  res.render('admin-forbidden', {
    siteName: 'DevNexus',
    activePage: 'admin',
    isAdmin: false,
    error: null
  });
});

// Admin Login POST handler (unprotected)
const { handleAdminLogin } = require('./authRoutes');
router.post('/login', handleAdminLogin);

// Admin Logout
router.get('/logout', (req, res) => {
  if (req.user) {
    logActivity(req.user.id, 'LOGOUT', req.user.username, 'Admin logged out');
  }
  req.session.destroy();
  res.redirect('/admin/login');
});

// Apply server-side authorization check to all subsequent administrative routes
router.use(requireAdmin);

// Admin Dashboard Main View
router.get('/', (req, res) => {
  const userStats = countUsers();
  const allUsers = getAllUsers();
  const bookmarkStats = getBookmarkStats();
  const recentActivities = getRecentActivities(25);
  const systemStatus = getSystemStatus();

  res.render('admin', {
    siteName: 'DevNexus',
    activePage: 'admin',
    isAdmin: true,
    currentUser: req.user,
    userStats,
    users: allUsers,
    bookmarkStats,
    activities: recentActivities,
    systemStatus,
    dataSources: {
      users: 'SQLite database (users table)',
      bookmarks: 'SQLite database (bookmarks table)',
      activity: 'SQLite database (activity_logs table)',
      system: 'Live Node.js process.memoryUsage() & process.uptime()'
    }
  });
});

// User Management: Update Role
router.post('/users/:id/role', (req, res) => {
  const targetUserId = parseInt(req.params.id, 10);
  const { role } = req.body;

  if (!['contributor', 'maintainer', 'admin'].includes(role)) {
    return res.status(400).json({ success: false, error: 'Invalid role specified.' });
  }

  // Prevent self-demotion of the primary administrator
  if (req.user.id === targetUserId && role !== 'admin') {
    return res.status(400).json({ success: false, error: 'Administrators cannot remove their own administrator privileges.' });
  }

  try {
    updateUserRole(targetUserId, role);
    logActivity(req.user.id, 'USER_ROLE_UPDATE', `User #${targetUserId}`, `Updated role to ${role}`);
    res.json({ success: true, role });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// User Management: Toggle Status (Active / Suspended)
router.post('/users/:id/toggle-status', (req, res) => {
  const targetUserId = parseInt(req.params.id, 10);

  if (req.user.id === targetUserId) {
    return res.status(400).json({ success: false, error: 'Administrators cannot suspend their own account.' });
  }

  try {
    const newStatus = toggleUserStatus(targetUserId);
    logActivity(req.user.id, 'USER_STATUS_TOGGLE', `User #${targetUserId}`, `Toggled status to ${newStatus}`);
    res.json({ success: true, status: newStatus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
