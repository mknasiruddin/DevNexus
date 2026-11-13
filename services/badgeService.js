'use strict';

const {
  findUserById,
  findUserByUsername,
  getUserBookmarks,
  getUserRoadmapProgress,
  getUserStreakData,
  getUserUnlockedBadges,
  awardUserBadge
} = require('../db/database');

const BADGE_DEFINITIONS = [
  {
    id: 'hello-world',
    title: 'Hello World',
    icon: '🌱',
    category: 'onboarding',
    tier: 'Bronze',
    description: 'Joined DevNexus and initialized your contributor profile.',
    check: (data) => Boolean(data.user && (data.user.is_onboarded || data.user.created_at)),
    progress: () => ({ current: 1, target: 1, percent: 100 })
  },
  {
    id: 'first-bookmark',
    title: 'Issue Scout',
    icon: '📌',
    category: 'discovery',
    tier: 'Bronze',
    description: 'Saved your first open-source issue to your developer dashboard.',
    check: (data) => (data.bookmarksCount || 0) >= 1,
    progress: (data) => ({ current: Math.min(1, data.bookmarksCount || 0), target: 1, percent: Math.min(100, Math.round(((data.bookmarksCount || 0) / 1) * 100)) })
  },
  {
    id: 'bookmark-collector',
    title: 'Issue Curator',
    icon: '📚',
    category: 'discovery',
    tier: 'Silver',
    description: 'Bookmarked 5 or more open-source issues across community repositories.',
    check: (data) => (data.bookmarksCount || 0) >= 5,
    progress: (data) => ({ current: Math.min(5, data.bookmarksCount || 0), target: 5, percent: Math.min(100, Math.round(((data.bookmarksCount || 0) / 5) * 100)) })
  },
  {
    id: 'roadmap-pioneer',
    title: 'Roadmap Pioneer',
    icon: '🗺️',
    category: 'roadmap',
    tier: 'Bronze',
    description: 'Completed your first stage on the 14-stage First Contribution Roadmap.',
    check: (data) => (data.roadmapCount || 0) >= 1,
    progress: (data) => ({ current: Math.min(1, data.roadmapCount || 0), target: 1, percent: Math.min(100, Math.round(((data.roadmapCount || 0) / 1) * 100)) })
  },
  {
    id: 'roadmap-halfway',
    title: 'Steadfast Contributor',
    icon: '⚡',
    category: 'roadmap',
    tier: 'Silver',
    description: 'Reached the halfway milestone (at least 7 stages completed).',
    check: (data) => (data.roadmapCount || 0) >= 7,
    progress: (data) => ({ current: Math.min(7, data.roadmapCount || 0), target: 7, percent: Math.min(100, Math.round(((data.roadmapCount || 0) / 7) * 100)) })
  },
  {
    id: 'roadmap-champion',
    title: 'Pull Request Ready',
    icon: '🚀',
    category: 'roadmap',
    tier: 'Gold',
    description: 'Mastered all 14 stages of the First Contribution Roadmap.',
    check: (data) => (data.roadmapCount || 0) >= 14,
    progress: (data) => ({ current: Math.min(14, data.roadmapCount || 0), target: 14, percent: Math.min(100, Math.round(((data.roadmapCount || 0) / 14) * 100)) })
  },
  {
    id: 'streak-starter',
    title: 'Flame Ignited',
    icon: '🔥',
    category: 'streaks',
    tier: 'Bronze',
    description: 'Maintained a 3-day unbroken contribution streak.',
    check: (data) => (data.longestStreak || 0) >= 3,
    progress: (data) => ({ current: Math.min(3, data.longestStreak || 0), target: 3, percent: Math.min(100, Math.round(((data.longestStreak || 0) / 3) * 100)) })
  },
  {
    id: 'streak-titan',
    title: 'Weekly Titan',
    icon: '👑',
    category: 'streaks',
    tier: 'Gold',
    description: 'Achieved a full 7-day unbroken contribution streak.',
    check: (data) => (data.longestStreak || 0) >= 7,
    progress: (data) => ({ current: Math.min(7, data.longestStreak || 0), target: 7, percent: Math.min(100, Math.round(((data.longestStreak || 0) / 7) * 100)) })
  },
  {
    id: 'polyglot',
    title: 'Polyglot Developer',
    icon: '🌐',
    category: 'skills',
    tier: 'Silver',
    description: 'Declared 3 or more technical skills in your developer profile.',
    check: (data) => (data.skillsCount || 0) >= 3,
    progress: (data) => ({ current: Math.min(3, data.skillsCount || 0), target: 3, percent: Math.min(100, Math.round(((data.skillsCount || 0) / 3) * 100)) })
  },
  {
    id: 'shield-bearer',
    title: 'Shield Bearer',
    icon: '🛡️',
    category: 'streaks',
    tier: 'Bronze',
    description: 'Holds or preserved a streak freeze shield.',
    check: (data) => (data.streakFreezeCount || 0) >= 1,
    progress: (data) => ({ current: Math.min(1, data.streakFreezeCount || 0), target: 1, percent: Math.min(100, Math.round(((data.streakFreezeCount || 0) / 1) * 100)) })
  }
];

function parseSkills(user) {
  if (!user || !user.skills) return [];
  try {
    const parsed = JSON.parse(user.skills);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function evaluateUserBadges(userId) {
  if (!userId) return null;
  const user = findUserById(userId);
  if (!user) return null;

  let bookmarks = [];
  try { bookmarks = getUserBookmarks(userId) || []; } catch (e) { bookmarks = []; }

  let roadmapSteps = [];
  try { roadmapSteps = getUserRoadmapProgress(userId) || []; } catch (e) { roadmapSteps = []; }

  let streakData = null;
  try { streakData = getUserStreakData(userId) || { longest_streak: 0, streak_freeze_count: 1 }; } catch (e) { streakData = { longest_streak: 0, streak_freeze_count: 1 }; }

  const skills = parseSkills(user);
  const context = {
    user,
    bookmarksCount: bookmarks.length,
    roadmapCount: roadmapSteps.length,
    longestStreak: streakData.longest_streak || 0,
    currentStreak: streakData.current_streak || 0,
    streakFreezeCount: streakData.streak_freeze_count !== undefined ? streakData.streak_freeze_count : 1,
    skillsCount: skills.length
  };

  const unlockedRows = getUserUnlockedBadges(userId);
  const unlockedMap = Object.fromEntries(unlockedRows.map(r => [r.badge_id, r.unlocked_at]));

  const evaluated = BADGE_DEFINITIONS.map(badgeDef => {
    const alreadyUnlocked = Boolean(unlockedMap[badgeDef.id]);
    const qualifiesNow = badgeDef.check(context);
    let isUnlocked = alreadyUnlocked || qualifiesNow;
    let unlockedAt = unlockedMap[badgeDef.id] || null;

    if (qualifiesNow && !alreadyUnlocked) {
      awardUserBadge(userId, badgeDef.id);
      unlockedAt = new Date().toISOString();
      isUnlocked = true;
    }

    return {
      id: badgeDef.id,
      title: badgeDef.title,
      icon: badgeDef.icon,
      category: badgeDef.category,
      tier: badgeDef.tier,
      description: badgeDef.description,
      unlocked: isUnlocked,
      unlockedAt,
      progress: badgeDef.progress(context)
    };
  });

  const unlockedCount = evaluated.filter(b => b.unlocked).length;
  const totalCount = evaluated.length;

  return {
    badges: evaluated,
    summary: {
      totalCount,
      unlockedCount,
      lockedCount: totalCount - unlockedCount,
      completionPercent: Math.round((unlockedCount / totalCount) * 100)
    }
  };
}

function getPublicUserBadges(username) {
  const user = findUserByUsername(username);
  if (!user) return null;
  const result = evaluateUserBadges(user.id);
  return {
    user: { id: user.id, username: user.username, name: user.name || user.username, avatar_url: user.avatar_url },
    ...result
  };
}

module.exports = { BADGE_DEFINITIONS, evaluateUserBadges, getPublicUserBadges };
