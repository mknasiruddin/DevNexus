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

const NON_QUALIFYING_STREAK_TYPES = new Set([
  'dashboard_visit',
  'streak_page_visit',
  'login',
  'page_refresh',
  'navigation',
  'view'
]);

function isQualifyingStreakActivity(entry) {
  if (!entry) return false;
  if (typeof entry === 'string') return /^\d{4}-\d{2}-\d{2}/.test(entry.trim());
  if (!entry.activity_date) return false;
  const kind = String(entry.activity_type || 'general').trim().toLowerCase();
  return !NON_QUALIFYING_STREAK_TYPES.has(kind);
}

function formatLocalDate(d = new Date()) {
  if (d === null || d === undefined) d = new Date();
  if (typeof d === 'string') {
    const trimmed = d.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return trimmed.slice(0, 10);
  }
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function getShiftedDate(baseDateStr, daysDelta) {
  const normalized = formatLocalDate(baseDateStr);
  const [year, month, day] = normalized.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + daysDelta));
  return utc.toISOString().slice(0, 10);
}

function getDayName(dateStr) {
  const normalized = formatLocalDate(dateStr);
  const [year, month, day] = normalized.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

function getDaysBetween(dateStr1, dateStr2) {
  const [y1, m1, d1] = formatLocalDate(dateStr1).split('-').map(Number);
  const [y2, m2, d2] = formatLocalDate(dateStr2).split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round(Math.abs(t1 - t2) / (1000 * 60 * 60 * 24));
}

function computeLongestRun(activeSet) {
  if (!activeSet || activeSet.size === 0) return 0;
  const sorted = Array.from(activeSet).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (sorted.length === 0) return 0;
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (getDaysBetween(sorted[i - 1], sorted[i]) === 1) {
      run += 1;
      if (run > longest) longest = run;
    } else if (sorted[i] !== sorted[i - 1]) {
      run = 1;
    }
  }
  return longest;
}

function computeStreakState(activeDatesList, storedStreak, referenceDate = null) {
  const today = referenceDate ? formatLocalDate(referenceDate) : formatLocalDate();
  const yesterday = getShiftedDate(today, -1);
  const activeSet = new Set(
    (Array.isArray(activeDatesList) ? activeDatesList : [])
      .filter(isQualifyingStreakActivity)
      .map(a => formatLocalDate(typeof a === 'string' ? a : a.activity_date))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today)
  );

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

  const maxRun = computeLongestRun(activeSet);
  const storedLongest = storedStreak ? (storedStreak.longest_streak || 0) : 0;
  const longestStreak = Math.max(storedLongest, maxRun, currentStreak);
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
  const normalizedType = String(activityType || 'general').trim().toLowerCase();
  if (NON_QUALIFYING_STREAK_TYPES.has(normalizedType)) {
    return getStreakSummary(userId, customDate);
  }
  const targetDate = customDate ? formatLocalDate(customDate) : formatLocalDate();
  recordStreakActivityDate(userId, targetDate, activityType);
  const activities = getUserStreakActivities(userId, 5000);
  const qualifying = activities.filter(isQualifyingStreakActivity);
  const stored = getUserStreakData(userId);
  const computed = computeStreakState(qualifying, { ...(stored || {}), longest_streak: computeLongestRun(new Set(qualifying.map(a => formatLocalDate(a.activity_date)))) }, customDate);
  upsertUserStreak(userId, {
    current_streak: computed.current_streak,
    longest_streak: computed.longest_streak,
    last_active_date: computed.last_active_date || targetDate,
    total_active_days: computed.total_active_days,
    streak_freeze_count: computed.streak_freeze_count
  });
  logActivity(userId, 'STREAK_ACTIVE', targetDate, `Contribution streak: ${computed.current_streak} days (${activityType})`);
  return computed;
}

function syncVerifiedContributionDates(userId, contributionDates = [], referenceDate = null) {
  if (!userId) return null;
  const uniqueDates = Array.from(new Set(
    (Array.isArray(contributionDates) ? contributionDates : [])
      .map(d => formatLocalDate(d))
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
  ));
  for (const dateKey of uniqueDates) {
    recordStreakActivityDate(userId, dateKey, 'github_contribution');
  }
  const activities = getUserStreakActivities(userId, 5000);
  const qualifying = activities.filter(isQualifyingStreakActivity);
  const stored = getUserStreakData(userId);
  const activeSet = new Set(qualifying.map(a => formatLocalDate(a.activity_date)));
  const computed = computeStreakState(qualifying, { ...(stored || {}), longest_streak: computeLongestRun(activeSet) }, referenceDate);
  upsertUserStreak(userId, {
    current_streak: computed.current_streak,
    longest_streak: computed.longest_streak,
    last_active_date: computed.last_active_date,
    total_active_days: computed.total_active_days,
    streak_freeze_count: computed.streak_freeze_count
  });
  return computed;
}

function getStreakSummary(userId, referenceDate = null) {
  if (!userId) return null;
  const activities = getUserStreakActivities(userId, 5000);
  const qualifying = activities.filter(isQualifyingStreakActivity);
  const stored = getUserStreakData(userId);
  const activeSet = new Set(qualifying.map(a => formatLocalDate(a.activity_date)));
  return computeStreakState(
    qualifying,
    { ...(stored || {}), longest_streak: computeLongestRun(activeSet) },
    referenceDate
  );
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
  if (updatedSummary) {
    upsertUserStreak(userId, {
      current_streak: updatedSummary.current_streak,
      longest_streak: updatedSummary.longest_streak,
      last_active_date: updatedSummary.last_active_date,
      total_active_days: updatedSummary.total_active_days,
      streak_freeze_count: updatedSummary.streak_freeze_count
    });
  }
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
  NON_QUALIFYING_STREAK_TYPES,
  isQualifyingStreakActivity,
  formatLocalDate,
  getShiftedDate,
  computeLongestRun,
  computeStreakState,
  recordActivity,
  syncVerifiedContributionDates,
  getStreakSummary,
  useStreakFreeze,
  getPublicStreak
};
