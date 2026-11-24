'use strict';

const {
  db,
  findUserById,
  getUserGithubSyncState
} = require('../db/database');

function buildEmptyRepositoryStats() {
  return {
    isConnected: false,
    total: 0,
    public: 0,
    private: 0,
    publicCount: 0,
    privateCount: 0,
    storedInSqlite: 0,
    ownedCount: 0,
    collaboratorCount: 0,
    organizationCount: 0,
    privateAccessGranted: false,
    privateAccessNote: null,
    grantedScopes: null,
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null
  };
}

/**
 * Single authoritative service for per-user GitHub repository counts & synchronization statistics.
 * Enforces Total = Public + Private, strict isolation per (user_id, github_id),
 * zero global/fallback leaks for unconnected users, and accurate private permission status.
 */
function getUserRepositoryStats(userId, { isSelf = true, includePrivate = undefined } = {}) {
  const numericUserId = Number(userId);
  const showPrivate = includePrivate !== undefined ? Boolean(includePrivate) : Boolean(isSelf);

  if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
    return buildEmptyRepositoryStats();
  }

  const user = findUserById(numericUserId);
  if (!user || !user.github_id) {
    return buildEmptyRepositoryStats();
  }

  const githubId = String(user.github_id);
  const syncState = getUserGithubSyncState(user.id, githubId);
  const githubUsernameLower = String((syncState && syncState.githubUsername) || user.username || '').trim().toLowerCase();

  const privacyFilter = showPrivate ? '' : 'AND is_private = 0';
  const row = db.prepare(`
    SELECT
      COUNT(*) AS storedTotal,
      COALESCE(SUM(CASE WHEN is_private = 0 THEN 1 ELSE 0 END), 0) AS publicCount,
      COALESCE(SUM(CASE WHEN is_private = 1 THEN 1 ELSE 0 END), 0) AS privateCount,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(owner_type, 'User')) = 'organization' THEN 1 ELSE 0 END), 0) AS organizationCount,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(owner_type, 'User')) != 'organization' AND LOWER(COALESCE(owner_login, '')) = ? THEN 1 ELSE 0 END), 0) AS ownedCount,
      COALESCE(SUM(CASE WHEN LOWER(COALESCE(owner_type, 'User')) != 'organization' AND LOWER(COALESCE(owner_login, '')) != ? AND LOWER(COALESCE(owner_login, '')) != '' THEN 1 ELSE 0 END), 0) AS collaboratorCount
    FROM github_synced_repos
    WHERE user_id = ? AND github_id = ? ${privacyFilter}
  `).get(githubUsernameLower, githubUsernameLower, user.id, githubId);

  const sqliteFullRow = showPrivate
    ? row
    : db.prepare(`
        SELECT COUNT(*) AS storedTotal,
               COALESCE(SUM(CASE WHEN is_private = 0 THEN 1 ELSE 0 END), 0) AS publicCount
        FROM github_synced_repos
        WHERE user_id = ? AND github_id = ?
      `).get(user.id, githubId);

  const publicCount = Number(row && row.publicCount) || 0;
  const privateCount = showPrivate ? (Number(row && row.privateCount) || 0) : 0;
  const totalCount = publicCount + privateCount;
  const storedInSqlite = showPrivate
    ? (Number(row && row.storedTotal) || 0)
    : (Number(sqliteFullRow && sqliteFullRow.publicCount) || 0);

  return {
    isConnected: true,
    userId: user.id,
    githubId,
    githubUsername: (syncState && syncState.githubUsername) || user.username,
    total: totalCount,
    public: publicCount,
    private: privateCount,
    publicCount,
    privateCount,
    storedInSqlite,
    ownedCount: Number(row && row.ownedCount) || 0,
    collaboratorCount: Number(row && row.collaboratorCount) || 0,
    organizationCount: Number(row && row.organizationCount) || 0,
    privateAccessGranted: showPrivate && syncState ? Boolean(syncState.privateAccessGranted) : false,
    privateAccessNote: showPrivate && syncState ? (syncState.privateAccessNote || null) : null,
    grantedScopes: showPrivate && syncState ? (syncState.grantedScopes || null) : null,
    lastSyncedAt: syncState ? (syncState.lastSyncedAt || null) : null,
    lastSyncStatus: syncState ? (syncState.lastSyncStatus || null) : null,
    lastSyncError: syncState ? (syncState.lastSyncError || null) : null
  };
}

module.exports = {
  getUserRepositoryStats
};
