'use strict';

const {
  getUserStreakData,
  upsertUserStreak,
  recordStreakActivityDate,
  getUserStreakActivities,
  getUserTotalActiveDays,
  consumeStreakFreeze,
  logActivity,
  findUserById,
  findUserByUsername
} = require('../db/database');

const STREAK_MILESTONES = [
  { days: 1,   id: 'streak-1',   title: 'First Flame',        icon: '🌱', tier: 'Bronze',   description: 'Began your open-source journey with your first active day.' },
  { days: 3,   id: 'streak-3',   title: 'Code Spark',         icon: '⚡', tier: 'Bronze',   description: '3 consecutive days of open-source momentum and learning.' },
  { days: 7,   id: 'streak-7',   title: 'Weekly Warrior',     icon: '🔥', tier: 'Silver',   description: 'A full 7-day unbroken contribution streak!' },
  { days: 14,  id: 'streak-14',  title: 'Fortnight Champion', icon: '🚀', tier: 'Silver',   description: '14 consecutive days of community collaboration.' },
  { days: 30,  id: 'streak-30',  title: 'Open Source Titan',  icon: '👑', tier: 'Gold',     description: '30 straight days of passion, commits, and problem solving.' },
  { days: 100, id: 'streak-100', title: 'Centurion Legend',   icon: '💎', tier: 'Platinum', description: 'Triple-digit mastery: 100 consecutive days of contributions.' }
];

function formatLocalDate(d = new Date()) {
  if (typeof d === 'string') return d.slice(0, 10);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getShiftedDate(baseDateStr, daysDelta) {
  const parts = baseDateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + daysDelta);
  return formatLocalDate(d);
}

function getDayName(dateStr) {
  const parts = dateStr.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

function getDaysBetween(dateStr1, dateStr2) {
  const [y1, m1, d1] = dateStr1.split('-').map(Number);
  const [y2, m2, d2] = dateStr2.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round(Math.abs(t1 - t2) / (1000 * 60 * 60 * 24));
}

function computeStreakState(activeDatesList, storedStreak, referenceDate = null) {
  const today = referenceDate ? formatLocalDate(referenceDate) : formatLocalDate();
  const yesterday = getShiftedDate(today, -1);
  const activeSet = new Set(activeDatesList.map(a => typeof a === 'string' ? a : a.activity_date));

  const activeToday = activeSet.has(today);
  const activeYesterday = activeSet.has(yesterday);

  let currentStreak = 0;
  if (activeToday) {
    let checkDate = today;
    while (activeSet.has(checkDate)) { currentStreak++; checkDate = getShiftedDate(checkDate, -1); }
  } else if (activeYesterday) {
    let checkDate = yesterday;
    while (activeSet.has(checkDate)) { currentStreak++; checkDate = getShiftedDate(checkDate, -1); }
  }

  const storedLongest = storedStreak ? (storedStreak.longest_streak || 0) : 0;
  const longestStreak = Math.max(storedLongest, currentStreak);
  const totalActiveDays = activeSet.size;

  let statusMessage = '';
  if (activeToday) {
    statusMessage = currentStreak === 1
      ? '🔥 Day 1 complete! You have started your contribution streak.'
      : `🔥 On fire! You have maintained an active ${currentStreak}-day streak today.`;
  } else if (activeYesterday) {
    statusMessage = `⚡ Keep your ${currentStreak}-day streak alive! Make a contribution today.`;
  } else {
    statusMessage = '🌱 Start a new contribution streak today with your next action!';
  }

  const evaluatedMilestones = STREAK_MILESTONES.map(m => ({
    ...m,
    unlocked: longestStreak >= m.days,
    progress: Math.min(100, Math.round((currentStreak / m.days) * 100))
  }));

  const nextMilestone = evaluatedMilestones.find(m => currentStreak < m.days) || null;
  const nextMilestoneInfo = nextMilestone ? {
    days: nextMilestone.days,
    title: nextMilestone.title,
    icon: nextMilestone.icon,
    daysLeft: nextMilestone.days - currentStreak,
    percent: Math.min(100, Math.round((currentStreak / nextMilestone.days) * 100))
  } : null;

  const recentWeek = [];
  for (let i = 6; i >= 0; i--) {
    const dStr = getShiftedDate(today, -i);
    recentWeek.push({ date: dStr, dayName: getDayName(dStr), active: activeSet.has(dStr), isToday: dStr === today });
  }

  const recentMonth = [];
  for (let i = 29; i >= 0; i--) {
    const dStr = getShiftedDate(today, -i);
    recentMonth.push({ date: dStr, dayName: getDayName(dStr), active: activeSet.has(dStr), isToday: dStr === today });
  }

  return {
    current_streak: currentStreak,
    longest_streak: longestStreak,
    total_active_days: totalActiveDays,
    last_active_date: activeToday ? today : (activeYesterday ? yesterday : (storedStreak ? storedStreak.last_active_date : null)),
    streak_freeze_count: storedStreak && storedStreak.streak_freeze_count !== undefined ? storedStreak.streak_freeze_count : 1,
    activeToday,
    activeYesterday,
    statusMessage,
    milestones: evaluatedMilestones,
    nextMilestone: nextMilestoneInfo,
    recentWeek,
    recentMonth,
    today
  };
}

async function recordActivity(userId, activityType = 'general', customDate = null) {
  if (!userId) return null;
  const targetDate = customDate ? formatLocalDate(customDate) : formatLocalDate();
  recordStreakActivityDate(userId, targetDate, activityType);
  const activities = getUserStreakActivities(userId, 365);
  const stored = getUserStreakData(userId);
  const computed = computeStreakState(activities, stored, customDate);
  upsertUserStreak(userId, {
    current_streak: computed.current_streak,
    longest_streak: computed.longest_streak,
    last_active_date: targetDate,
    total_active_days: computed.total_active_days,
    streak_freeze_count: computed.streak_freeze_count
  });
  logActivity(userId, 'STREAK_ACTIVE', targetDate, `Contribution streak: ${computed.current_streak} days (${activityType})`);
  return computed;
}

function getStreakSummary(userId, referenceDate = null) {
  if (!userId) return null;
  const activities = getUserStreakActivities(userId, 365);
  const stored = getUserStreakData(userId);
  return computeStreakState(activities, stored, referenceDate);
}

function useStreakFreeze(userId, referenceDate = null) {
  if (!userId) return { success: false, message: 'User ID required' };
  const stored = getUserStreakData(userId);
  if (!stored || stored.streak_freeze_count <= 0) {
    return { success: false, message: 'No streak freeze shields remaining.' };
  }
  const today = referenceDate ? formatLocalDate(referenceDate) : formatLocalDate();
  const yesterday = getShiftedDate(today, -1);
  recordStreakActivityDate(userId, yesterday, 'streak_freeze_shield');
  consumeStreakFreeze(userId);
  logActivity(userId, 'STREAK_FREEZE_USED', yesterday, 'Protected contribution streak using freeze shield');
  const updatedSummary = getStreakSummary(userId, referenceDate);
  return { success: true, message: 'Streak freeze shield activated! Your contribution streak was protected.', streak: updatedSummary };
}

function getPublicStreak(username) {
  const user = findUserByUsername(username);
  if (!user) return null;
  const summary = getStreakSummary(user.id);
  return {
    user: { id: user.id, username: user.username, name: user.name || user.username, avatar_url: user.avatar_url },
    streak: summary
  };
}

module.exports = {
  STREAK_MILESTONES,
  formatLocalDate,
  getShiftedDate,
  computeStreakState,
  recordActivity,
  getStreakSummary,
  useStreakFreeze,
  getPublicStreak
};
