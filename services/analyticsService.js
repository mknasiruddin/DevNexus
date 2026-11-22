'use strict';

const {
  findUserById,
  findUserByUsername,
  getAllUserSyncedActivities,
  getUserSyncedRepos,
  getUserGithubSyncState,
  getSyncedUsersNeedingLeaderboardSync,
  upsertContributor,
  recordContributorActivity,
  replaceContributorSyncedActivities,
  getLeaderboard,
  recordPlatformActivityRow,
  getUserPlatformActivities,
  replaceUserDailyActivitySummaries,
  getUserDailyActivitySummaries,
  upsertUserProductivityStatistic,
  getUserProductivityStatistics
} = require('../db/database');
const streakService = require('./streakService');
const scoringService = require('./scoringService');
const { getUserRepositoryStats } = require('./repoStatsService');

const ACTIVITY_POINT_RULES = {
  get commit() { return scoringService.getPointsForActivity('commit', 1); },
  get pr_created() { return scoringService.getPointsForActivity('pr_created', 1); },
  get pr_merged() { return scoringService.getPointsForActivity('pr_merged', 1); },
  get pr_closed() { return scoringService.getPointsForActivity('pr_closed', 1); },
  get issue_opened() { return scoringService.getPointsForActivity('issue_opened', 1); },
  get issue_closed() { return scoringService.getPointsForActivity('issue_closed', 1); },
  get pr_review() { return scoringService.getPointsForActivity('pr_review', 1); },
  get repo_contribution() { return scoringService.getPointsForActivity('repo_contribution', 1); },
  get roadmap_stage() { return scoringService.getPointsForActivity('roadmap_stage', 1); },
  get skill_task() { return scoringService.getPointsForActivity('skill_task', 1); },
  get contribution_milestone() { return scoringService.getPointsForActivity('contribution_milestone', 1); }
};

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const SHORT_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const METHODOLOGY_DISCLAIMER =
  'Analytics reflect verified GitHub contribution timestamps and active contribution days, not logged working hours.';

function toUtcDateKey(input = new Date()) {
  return streakService.formatLocalDate(input);
}

function getDaysBetweenInclusive(startDateStr, endDateStr) {
  if (!startDateStr || !endDateStr || endDateStr < startDateStr) return 0;
  const [y1, m1, d1] = startDateStr.split('-').map(Number);
  const [y2, m2, d2] = endDateStr.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.max(0, Math.round((t2 - t1) / 86400000) + 1);
}

function getMonthBounds(year, month) {
  const safeYear = Math.max(2008, Math.min(2100, parseInt(year, 10) || new Date().getUTCFullYear()));
  const safeMonth = Math.max(1, Math.min(12, parseInt(month, 10) || (new Date().getUTCMonth() + 1)));
  const totalDays = new Date(Date.UTC(safeYear, safeMonth, 0)).getUTCDate();
  const mm = String(safeMonth).padStart(2, '0');
  return {
    year: safeYear,
    month: safeMonth,
    label: `${MONTH_NAMES[safeMonth - 1]} ${safeYear}`,
    shortLabel: `${SHORT_MONTH_NAMES[safeMonth - 1]} ${safeYear}`,
    startDate: `${safeYear}-${mm}-01`,
    endDate: `${safeYear}-${mm}-${String(totalDays).padStart(2, '0')}`,
    totalDays
  };
}

function getQuarterBounds(year, quarter) {
  const safeYear = Math.max(2008, Math.min(2100, parseInt(year, 10) || new Date().getUTCFullYear()));
  const safeQuarter = Math.max(1, Math.min(4, parseInt(quarter, 10) || (Math.floor(new Date().getUTCMonth() / 3) + 1)));
  const startMonth = ((safeQuarter - 1) * 3) + 1;
  const endMonth = startMonth + 2;
  const first = getMonthBounds(safeYear, startMonth);
  const last = getMonthBounds(safeYear, endMonth);
  return {
    year: safeYear,
    quarter: safeQuarter,
    label: `Q${safeQuarter} ${safeYear}`,
    startDate: first.startDate,
    endDate: last.endDate,
    months: [startMonth, startMonth + 1, startMonth + 2],
    totalDays: getDaysBetweenInclusive(first.startDate, last.endDate)
  };
}

function getHalfYearBounds(year, half) {
  const safeYear = Math.max(2008, Math.min(2100, parseInt(year, 10) || new Date().getUTCFullYear()));
  const safeHalf = parseInt(half, 10) === 2 ? 2 : 1;
  const startMonth = safeHalf === 1 ? 1 : 7;
  const endMonth = safeHalf === 1 ? 6 : 12;
  const first = getMonthBounds(safeYear, startMonth);
  const last = getMonthBounds(safeYear, endMonth);
  return {
    year: safeYear,
    half: safeHalf,
    label: `H${safeHalf} ${safeYear} (${safeHalf === 1 ? 'Jan–Jun' : 'Jul–Dec'})`,
    shortLabel: `H${safeHalf} ${safeYear}`,
    startDate: first.startDate,
    endDate: last.endDate,
    months: safeHalf === 1 ? [1, 2, 3, 4, 5, 6] : [7, 8, 9, 10, 11, 12],
    quarters: safeHalf === 1 ? [1, 2] : [3, 4],
    totalDays: getDaysBetweenInclusive(first.startDate, last.endDate)
  };
}

function getYearBounds(year) {
  const safeYear = Math.max(2008, Math.min(2100, parseInt(year, 10) || new Date().getUTCFullYear()));
  const startDate = `${safeYear}-01-01`;
  const endDate = `${safeYear}-12-31`;
  return {
    year: safeYear,
    label: String(safeYear),
    startDate,
    endDate,
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    totalDays: getDaysBetweenInclusive(startDate, endDate)
  };
}

function computeEligibleCalendarDays(startDate, endDate, referenceToday = toUtcDateKey()) {
  if (!startDate || !endDate) return 0;
  if (startDate > referenceToday) return 0;
  const effectiveEnd = endDate <= referenceToday ? endDate : referenceToday;
  return getDaysBetweenInclusive(startDate, effectiveEnd);
}

function classifyActivityKind(act) {
  const cat = String(act.category || '').toLowerCase();
  const type = String(act.eventType || '').toLowerCase();
  const action = String(act.action || '').toLowerCase();

  if (cat === 'commit' || type === 'pushevent' || type === 'commitsearch') {
    return 'commit';
  }
  if (cat === 'review' || type.includes('review')) {
    return 'pr_review';
  }
  if (cat === 'pr' || type.includes('pullrequest')) {
    if (action === 'merged') return 'pr_merged';
    if (action === 'closed') return 'pr_closed';
    return 'pr_created';
  }
  if (cat === 'issue' || type.includes('issue')) {
    if (action === 'closed') return 'issue_closed';
    return 'issue_opened';
  }
  return 'repo_contribution';
}

function computeActivityPoints(act, kind = classifyActivityKind(act)) {
  if (kind === 'commit') {
    const units = Math.max(1, Number(act.commitCount) || 1);
    return scoringService.getPointsForActivity('commit', units);
  }
  const dynamicPts = scoringService.getPointsForActivity(kind, 1);
  return dynamicPts > 0 ? dynamicPts : scoringService.getPointsForActivity('repo_contribution', 1);
}

function getActivityUnits(act, kind = classifyActivityKind(act)) {
  if (kind === 'commit') {
    return Math.max(1, Number(act.commitCount) || 1);
  }
  return 1;
}

function normalizeAndDeduplicateActivities(rawActivities = []) {
  const byKey = new Map();
  const canonicalSignatureSet = new Set();

  // Pass 1: index all canonical records first so legacy null-canonicalKey duplicates cannot double-count
  for (const raw of rawActivities) {
    if (!raw || !raw.eventTimestamp || !raw.canonicalKey) continue;
    const kind = classifyActivityKind(raw);
    const dateKey = toUtcDateKey(raw.activityDate || raw.eventTimestamp);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
    const repoLower = String(raw.repoName || '').trim().toLowerCase();
    canonicalSignatureSet.add(`${kind}|${repoLower}|${dateKey}`);
    const numMatch = String(raw.title || '').match(/#(\d+)/);
    if (numMatch) canonicalSignatureSet.add(`${kind}|${repoLower}|#${numMatch[1]}`);
  }

  for (const raw of rawActivities) {
    if (!raw || !raw.eventTimestamp) continue;
    const kind = classifyActivityKind(raw);
    const dateKey = toUtcDateKey(raw.activityDate || raw.eventTimestamp);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;

    const repoLower = String(raw.repoName || '').trim().toLowerCase();

    if (!raw.canonicalKey) {
      const numMatch = String(raw.title || '').match(/#(\d+)/);
      if (
        canonicalSignatureSet.has(`${kind}|${repoLower}|${dateKey}`) ||
        (numMatch && canonicalSignatureSet.has(`${kind}|${repoLower}|#${numMatch[1]}`))
      ) {
        continue;
      }
    }

    const fallbackKey = `legacy|${kind}|${repoLower}|${String(raw.eventTimestamp).slice(0, 16)}|${String(raw.title || '').slice(0, 50).toLowerCase()}`;
    const dedupeKey = raw.canonicalKey ? `canon|${raw.canonicalKey}` : fallbackKey;

    const computedPts = computeActivityPoints(raw, kind);
    const points = computedPts > 0 ? computedPts : (Number(raw.points) || 0);
    const units = getActivityUnits(raw, kind);
    const normalized = {
      ...raw,
      kind,
      units,
      points,
      activityDate: dateKey
    };

    const existing = byKey.get(dedupeKey);
    if (!existing) {
      byKey.set(dedupeKey, normalized);
    } else {
      // Prefer richer record (with repoId, canonicalKey, or explicit targetUrl)
      const existingScore = (existing.canonicalKey ? 4 : 0) + (existing.repoId ? 2 : 0) + (existing.targetUrl && !existing.targetUrl.endsWith(existing.repoName) ? 1 : 0);
      const nextScore = (normalized.canonicalKey ? 4 : 0) + (normalized.repoId ? 2 : 0) + (normalized.targetUrl && !normalized.targetUrl.endsWith(normalized.repoName) ? 1 : 0);
      if (nextScore > existingScore) {
        byKey.set(dedupeKey, normalized);
      }
    }
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const tA = String(a.eventTimestamp || '');
    const tB = String(b.eventTimestamp || '');
    return tB.localeCompare(tA);
  });
}

function computePercentageChange(current, previous) {
  const curr = Number(current) || 0;
  const prev = Number(previous) || 0;
  const delta = curr - prev;

  if (prev === 0) {
    if (curr === 0) {
      return {
        current: 0,
        previous: 0,
        delta: 0,
        percentageChange: 0,
        comparisonAvailable: true,
        trendDirection: 'neutral',
        displayText: '0.0%'
      };
    }
    return {
      current: curr,
      previous: 0,
      delta,
      percentageChange: null,
      comparisonAvailable: false,
      trendDirection: 'up',
      displayText: `+${curr} vs 0 prior`
    };
  }

  const pct = round2(((curr - prev) / prev) * 100);
  const trendDirection = pct > 0 ? 'up' : (pct < 0 ? 'down' : 'neutral');
  return {
    current: curr,
    previous: prev,
    delta,
    percentageChange: pct,
    comparisonAvailable: true,
    trendDirection,
    displayText: `${pct > 0 ? '+' : ''}${pct}%`
  };
}

function buildMetricsComparison(currentMetrics, previousMetrics) {
  return {
    totalContributions: computePercentageChange(currentMetrics.totalContributions, previousMetrics.totalContributions),
    commits: computePercentageChange(currentMetrics.commits, previousMetrics.commits),
    prsCreated: computePercentageChange(currentMetrics.prsCreated, previousMetrics.prsCreated),
    prsMerged: computePercentageChange(currentMetrics.prsMerged, previousMetrics.prsMerged),
    prsClosed: computePercentageChange(currentMetrics.prsClosed, previousMetrics.prsClosed),
    issuesOpened: computePercentageChange(currentMetrics.issuesOpened, previousMetrics.issuesOpened),
    issuesClosed: computePercentageChange(currentMetrics.issuesClosed, previousMetrics.issuesClosed),
    reviews: computePercentageChange(currentMetrics.reviews, previousMetrics.reviews),
    activeRepositories: computePercentageChange(currentMetrics.activeRepositories, previousMetrics.activeRepositories),
    uniqueActiveDays: computePercentageChange(currentMetrics.uniqueActiveDays, previousMetrics.uniqueActiveDays),
    activityPercentage: computePercentageChange(currentMetrics.activityPercentage, previousMetrics.activityPercentage),
    contributionPoints: computePercentageChange(currentMetrics.contributionPoints, previousMetrics.contributionPoints)
  };
}

function computePeriodMetrics(normalizedActivities, startDate, endDate, referenceToday = toUtcDateKey(), platformActivities = []) {
  const periodActivities = (Array.isArray(normalizedActivities) ? normalizedActivities : []).filter(
    a => a.activityDate >= startDate && a.activityDate <= endDate
  );
  const periodPlatform = (Array.isArray(platformActivities) ? platformActivities : []).filter(
    p => p.activityDate >= startDate && p.activityDate <= endDate
  );

  let commits = 0;
  let prsCreated = 0;
  let prsMerged = 0;
  let prsClosed = 0;
  let issuesOpened = 0;
  let issuesClosed = 0;
  let reviews = 0;
  let repoContributions = 0;
  let githubPoints = 0;

  let roadmapStagesCompleted = 0;
  let skillTasksCompleted = 0;
  let milestoneBadgesCompleted = 0;
  let platformPoints = 0;

  const repoSet = new Set();
  const activeDaysSet = new Set();

  for (const act of periodActivities) {
    if (act.repoName) repoSet.add(act.repoName);
    activeDaysSet.add(act.activityDate);
    githubPoints += act.points;

    switch (act.kind) {
      case 'commit':
        commits += act.units;
        break;
      case 'pr_created':
        prsCreated += 1;
        break;
      case 'pr_merged':
        prsMerged += 1;
        break;
      case 'pr_closed':
        prsClosed += 1;
        break;
      case 'issue_opened':
        issuesOpened += 1;
        break;
      case 'issue_closed':
        issuesClosed += 1;
        break;
      case 'pr_review':
        reviews += 1;
        break;
      default:
        repoContributions += 1;
        break;
    }
  }

  for (const plat of periodPlatform) {
    activeDaysSet.add(plat.activityDate);
    const dynamicPlatPts = scoringService.getPointsForActivity(plat.activityType, 1);
    const pts = dynamicPlatPts > 0 ? dynamicPlatPts : (Number(plat.points) || 0);
    platformPoints += pts;

    if (plat.activityType === 'roadmap_stage') roadmapStagesCompleted += 1;
    else if (plat.activityType === 'skill_task') skillTasksCompleted += 1;
    else milestoneBadgesCompleted += 1;
  }

  const totalPullRequests = prsCreated + prsMerged + prsClosed;
  const totalIssues = issuesOpened + issuesClosed;
  const totalContributions =
    commits +
    prsCreated +
    prsMerged +
    prsClosed +
    issuesOpened +
    issuesClosed +
    reviews +
    repoContributions;

  const platformActivitiesCount = periodPlatform.length;
  const contributionPoints = githubPoints + platformPoints;

  const totalPeriodDays = getDaysBetweenInclusive(startDate, endDate);
  const eligibleCalendarDays = computeEligibleCalendarDays(startDate, endDate, referenceToday);
  const uniqueActiveDays = activeDaysSet.size;
  const activityPercentage = eligibleCalendarDays > 0
    ? Math.min(100, round2((uniqueActiveDays / eligibleCalendarDays) * 100))
    : 0;

  return {
    startDate,
    endDate,
    totalContributions,
    eventCount: periodActivities.length,
    commits,
    prsCreated,
    prsMerged,
    prsClosed,
    totalPullRequests,
    issuesOpened,
    issuesClosed,
    issuesResolved: issuesClosed,
    totalIssues,
    reviews,
    repoContributions,
    platformActivitiesCount,
    platformBreakdown: {
      roadmapStages: roadmapStagesCompleted,
      skillTasks: skillTasksCompleted,
      contributionMilestones: milestoneBadgesCompleted
    },
    activeRepositories: repoSet.size,
    activeRepoNames: Array.from(repoSet).sort(),
    uniqueActiveDays,
    activeDaysList: Array.from(activeDaysSet).sort(),
    eligibleCalendarDays,
    totalPeriodDays,
    activityPercentage,
    githubPoints,
    platformPoints,
    contributionPoints
  };
}

function buildRepositoryBreakdown(periodActivities, userRepos = []) {
  const repoMetaByFullName = new Map();
  for (const r of userRepos) {
    if (!r || !r.fullName) continue;
    repoMetaByFullName.set(String(r.fullName).toLowerCase(), r);
  }

  const map = new Map();
  for (const act of periodActivities) {
    const key = (act.repoName || 'unknown').toLowerCase();
    let entry = map.get(key);
    if (!entry) {
      const meta = repoMetaByFullName.get(key);
      entry = {
        repoName: act.repoName || 'unknown',
        repoId: act.repoId || (meta ? String(meta.id) : ''),
        repoUrl: act.repoUrl || (meta ? meta.htmlUrl : `https://github.com/${act.repoName || ''}`),
        language: meta && meta.language ? meta.language : 'Unknown',
        isPrivate: Boolean(act.isPrivate || (meta && meta.isPrivate)),
        commits: 0,
        prsCreated: 0,
        prsMerged: 0,
        prsClosed: 0,
        issuesOpened: 0,
        issuesClosed: 0,
        reviews: 0,
        repoContributions: 0,
        totalContributions: 0,
        points: 0,
        lastActivityAt: act.eventTimestamp || null
      };
      map.set(key, entry);
    }

    entry.points += act.points;
    if (act.eventTimestamp && (!entry.lastActivityAt || act.eventTimestamp > entry.lastActivityAt)) {
      entry.lastActivityAt = act.eventTimestamp;
    }

    switch (act.kind) {
      case 'commit':
        entry.commits += act.units;
        entry.totalContributions += act.units;
        break;
      case 'pr_created':
        entry.prsCreated += 1;
        entry.totalContributions += 1;
        break;
      case 'pr_merged':
        entry.prsMerged += 1;
        entry.totalContributions += 1;
        break;
      case 'pr_closed':
        entry.prsClosed += 1;
        entry.totalContributions += 1;
        break;
      case 'issue_opened':
        entry.issuesOpened += 1;
        entry.totalContributions += 1;
        break;
      case 'issue_closed':
        entry.issuesClosed += 1;
        entry.totalContributions += 1;
        break;
      case 'pr_review':
        entry.reviews += 1;
        entry.totalContributions += 1;
        break;
      default:
        entry.repoContributions += 1;
        entry.totalContributions += 1;
        break;
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (b.totalContributions !== a.totalContributions) return b.totalContributions - a.totalContributions;
    return b.points - a.points;
  });
}

function buildLanguageDistribution(userRepos = []) {
  const counts = {};
  let totalWithLanguage = 0;

  for (const repo of userRepos) {
    if (!repo || !repo.language) continue;
    const lang = String(repo.language).trim();
    if (!lang || lang.toLowerCase() === 'other' || lang.toLowerCase() === 'unknown') continue;
    counts[lang] = (counts[lang] || 0) + 1;
    totalWithLanguage += 1;
  }

  if (totalWithLanguage === 0) return [];

  return Object.entries(counts)
    .map(([language, count]) => ({
      language,
      count,
      percentage: Math.round((count / totalWithLanguage) * 1000) / 10
    }))
    .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));
}

function loadUserAnalyticsContext(userId, { includePrivate = true, referenceDate = null } = {}) {
  const user = findUserById(userId);
  const referenceToday = referenceDate ? toUtcDateKey(referenceDate) : toUtcDateKey();

  if (!user) {
    return {
      user: null,
      referenceToday,
      activities: [],
      platformActivities: [],
      repos: [],
      repoCounts: { total: 0, publicCount: 0, privateCount: 0 },
      streak: null
    };
  }

  const rawActivities = getAllUserSyncedActivities(user.id, user.github_id || null, {
    includePrivate: Boolean(includePrivate)
  });
  const activities = normalizeAndDeduplicateActivities(rawActivities);
  const platformActivities = getUserPlatformActivities(user.id, { limit: 2000 });
  const repos = getUserSyncedRepos(user.id, user.github_id || null, {
    includePrivate: Boolean(includePrivate),
    limit: null,
    offset: 0
  });
  const repoCounts = getUserRepositoryStats(user.id, { includePrivate: Boolean(includePrivate) });
  const streak = streakService.getStreakSummary(user.id, referenceToday);

  return {
    user,
    referenceToday,
    activities,
    platformActivities,
    repos,
    repoCounts,
    streak
  };
}

function getPreviousMonthParams(year, month) {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function getPreviousQuarterParams(year, quarter) {
  if (quarter === 1) return { year: year - 1, quarter: 4 };
  return { year, quarter: quarter - 1 };
}

function getPreviousHalfParams(year, half) {
  if (half === 1) return { year: year - 1, half: 2 };
  return { year, half: 1 };
}

function getMonthlyAnalytics(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const refParts = ctx.referenceToday.split('-').map(Number);
  const targetYear = parseInt(options.year, 10) || refParts[0];
  const targetMonth = parseInt(options.month, 10) || refParts[1];
  const bounds = getMonthBounds(targetYear, targetMonth);

  const periodActivities = ctx.activities.filter(
    a => a.activityDate >= bounds.startDate && a.activityDate <= bounds.endDate
  );
  const periodPlatform = ctx.platformActivities.filter(
    p => p.activityDate >= bounds.startDate && p.activityDate <= bounds.endDate
  );
  const metrics = computePeriodMetrics(ctx.activities, bounds.startDate, bounds.endDate, ctx.referenceToday, ctx.platformActivities);

  const prevParams = getPreviousMonthParams(bounds.year, bounds.month);
  const prevBounds = getMonthBounds(prevParams.year, prevParams.month);
  const previousMetrics = computePeriodMetrics(ctx.activities, prevBounds.startDate, prevBounds.endDate, ctx.referenceToday, ctx.platformActivities);

  // Build day-by-day series for every calendar day of the month
  const dailyMap = new Map();
  for (let day = 1; day <= bounds.totalDays; day++) {
    const dateKey = `${bounds.year}-${String(bounds.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    dailyMap.set(dateKey, {
      date: dateKey,
      day,
      commits: 0,
      prsCreated: 0,
      prsMerged: 0,
      prsClosed: 0,
      issuesOpened: 0,
      issuesClosed: 0,
      reviews: 0,
      repoContributions: 0,
      total: 0,
      points: 0
    });
  }

  for (const act of periodActivities) {
    const slot = dailyMap.get(act.activityDate);
    if (!slot) continue;
    slot.points += act.points;
    if (act.kind === 'commit') {
      slot.commits += act.units;
      slot.total += act.units;
    } else if (act.kind === 'pr_created') {
      slot.prsCreated += 1;
      slot.total += 1;
    } else if (act.kind === 'pr_merged') {
      slot.prsMerged += 1;
      slot.total += 1;
    } else if (act.kind === 'pr_closed') {
      slot.prsClosed += 1;
      slot.total += 1;
    } else if (act.kind === 'issue_opened') {
      slot.issuesOpened += 1;
      slot.total += 1;
    } else if (act.kind === 'issue_closed') {
      slot.issuesClosed += 1;
      slot.total += 1;
    } else if (act.kind === 'pr_review') {
      slot.reviews += 1;
      slot.total += 1;
    } else {
      slot.repoContributions += 1;
      slot.total += 1;
    }
  }

  const dailyBreakdown = Array.from(dailyMap.values());
  const topRepositories = buildRepositoryBreakdown(periodActivities, ctx.repos).slice(0, 10);

  return {
    periodType: 'monthly',
    year: bounds.year,
    month: bounds.month,
    label: bounds.label,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    metrics,
    dailyBreakdown,
    previousPeriod: {
      year: prevBounds.year,
      month: prevBounds.month,
      label: prevBounds.label,
      metrics: previousMetrics
    },
    comparison: buildMetricsComparison(metrics, previousMetrics),
    topRepositories,
    activities: periodActivities.slice(0, 50),
    platformActivities: periodPlatform.slice(0, 30),
    hasData: metrics.totalContributions > 0 || metrics.platformActivitiesCount > 0,
    disclaimer: METHODOLOGY_DISCLAIMER
  };
}

function getQuarterlyAnalytics(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const refParts = ctx.referenceToday.split('-').map(Number);
  const targetYear = parseInt(options.year, 10) || refParts[0];
  const defaultQuarter = Math.floor((refParts[1] - 1) / 3) + 1;
  const targetQuarter = parseInt(options.quarter, 10) || defaultQuarter;
  const bounds = getQuarterBounds(targetYear, targetQuarter);

  const periodActivities = ctx.activities.filter(
    a => a.activityDate >= bounds.startDate && a.activityDate <= bounds.endDate
  );
  const metrics = computePeriodMetrics(ctx.activities, bounds.startDate, bounds.endDate, ctx.referenceToday, ctx.platformActivities);

  const prevParams = getPreviousQuarterParams(bounds.year, bounds.quarter);
  const prevBounds = getQuarterBounds(prevParams.year, prevParams.quarter);
  const previousMetrics = computePeriodMetrics(ctx.activities, prevBounds.startDate, prevBounds.endDate, ctx.referenceToday, ctx.platformActivities);

  const monthBreakdown = bounds.months.map((m, idx) => {
    const mBounds = getMonthBounds(bounds.year, m);
    const mMetrics = computePeriodMetrics(ctx.activities, mBounds.startDate, mBounds.endDate, ctx.referenceToday, ctx.platformActivities);
    let momComparison = null;
    if (idx > 0) {
      const prevM = getMonthBounds(bounds.year, bounds.months[idx - 1]);
      const prevMMetrics = computePeriodMetrics(ctx.activities, prevM.startDate, prevM.endDate, ctx.referenceToday, ctx.platformActivities);
      momComparison = computePercentageChange(mMetrics.totalContributions, prevMMetrics.totalContributions);
    }
    return {
      month: m,
      year: bounds.year,
      label: mBounds.shortLabel,
      fullLabel: mBounds.label,
      ...mMetrics,
      monthOverMonth: momComparison
    };
  });

  const mostActiveMonth = monthBreakdown.reduce(
    (best, curr) => (curr.totalContributions > (best ? best.totalContributions : -1) ? curr : best),
    null
  );

  // All 4 quarters of target year for quarterly comparison bar chart
  const yearQuarters = [1, 2, 3, 4].map(q => {
    const qb = getQuarterBounds(bounds.year, q);
    const qm = computePeriodMetrics(ctx.activities, qb.startDate, qb.endDate, ctx.referenceToday, ctx.platformActivities);
    return {
      quarter: q,
      year: bounds.year,
      label: `Q${q}`,
      fullLabel: qb.label,
      ...qm
    };
  });

  return {
    periodType: 'quarterly',
    year: bounds.year,
    quarter: bounds.quarter,
    label: bounds.label,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    metrics,
    monthBreakdown,
    yearQuarters,
    mostActiveMonth: mostActiveMonth && mostActiveMonth.totalContributions > 0 ? mostActiveMonth : null,
    previousPeriod: {
      year: prevBounds.year,
      quarter: prevBounds.quarter,
      label: prevBounds.label,
      metrics: previousMetrics
    },
    comparison: buildMetricsComparison(metrics, previousMetrics),
    topRepositories: buildRepositoryBreakdown(periodActivities, ctx.repos).slice(0, 10),
    hasData: metrics.totalContributions > 0 || metrics.platformActivitiesCount > 0,
    disclaimer: METHODOLOGY_DISCLAIMER
  };
}

function getHalfYearlyAnalytics(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const refParts = ctx.referenceToday.split('-').map(Number);
  const targetYear = parseInt(options.year, 10) || refParts[0];
  const defaultHalf = refParts[1] <= 6 ? 1 : 2;
  const targetHalf = parseInt(options.half, 10) || defaultHalf;
  const bounds = getHalfYearBounds(targetYear, targetHalf);

  const periodActivities = ctx.activities.filter(
    a => a.activityDate >= bounds.startDate && a.activityDate <= bounds.endDate
  );
  const metrics = computePeriodMetrics(ctx.activities, bounds.startDate, bounds.endDate, ctx.referenceToday, ctx.platformActivities);

  const prevParams = getPreviousHalfParams(bounds.year, bounds.half);
  const prevBounds = getHalfYearBounds(prevParams.year, prevParams.half);
  const previousMetrics = computePeriodMetrics(ctx.activities, prevBounds.startDate, prevBounds.endDate, ctx.referenceToday, ctx.platformActivities);

  const monthBreakdown = bounds.months.map(m => {
    const mb = getMonthBounds(bounds.year, m);
    return {
      month: m,
      year: bounds.year,
      label: SHORT_MONTH_NAMES[m - 1],
      fullLabel: mb.label,
      ...computePeriodMetrics(ctx.activities, mb.startDate, mb.endDate, ctx.referenceToday, ctx.platformActivities)
    };
  });

  const quarterBreakdown = bounds.quarters.map(q => {
    const qb = getQuarterBounds(bounds.year, q);
    return {
      quarter: q,
      year: bounds.year,
      label: `Q${q}`,
      fullLabel: qb.label,
      ...computePeriodMetrics(ctx.activities, qb.startDate, qb.endDate, ctx.referenceToday, ctx.platformActivities)
    };
  });

  const mostActiveMonth = monthBreakdown.reduce(
    (best, curr) => (curr.totalContributions > (best ? best.totalContributions : -1) ? curr : best),
    null
  );

  return {
    periodType: 'half-yearly',
    year: bounds.year,
    half: bounds.half,
    label: bounds.label,
    shortLabel: bounds.shortLabel,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    metrics,
    monthBreakdown,
    quarterBreakdown,
    mostActiveMonth: mostActiveMonth && mostActiveMonth.totalContributions > 0 ? mostActiveMonth : null,
    previousPeriod: {
      year: prevBounds.year,
      half: prevBounds.half,
      label: prevBounds.label,
      metrics: previousMetrics
    },
    comparison: buildMetricsComparison(metrics, previousMetrics),
    topRepositories: buildRepositoryBreakdown(periodActivities, ctx.repos).slice(0, 10),
    hasData: metrics.totalContributions > 0 || metrics.platformActivitiesCount > 0,
    disclaimer: METHODOLOGY_DISCLAIMER
  };
}

function getYearlyAnalytics(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const refParts = ctx.referenceToday.split('-').map(Number);
  const targetYear = parseInt(options.year, 10) || refParts[0];
  const bounds = getYearBounds(targetYear);

  const periodActivities = ctx.activities.filter(
    a => a.activityDate >= bounds.startDate && a.activityDate <= bounds.endDate
  );
  const metrics = computePeriodMetrics(ctx.activities, bounds.startDate, bounds.endDate, ctx.referenceToday, ctx.platformActivities);

  const prevBounds = getYearBounds(bounds.year - 1);
  const previousMetrics = computePeriodMetrics(ctx.activities, prevBounds.startDate, prevBounds.endDate, ctx.referenceToday, ctx.platformActivities);

  const monthBreakdown = [];
  for (let idx = 0; idx < 12; idx++) {
    const m = idx + 1;
    const mb = getMonthBounds(bounds.year, m);
    const mMetrics = computePeriodMetrics(ctx.activities, mb.startDate, mb.endDate, ctx.referenceToday, ctx.platformActivities);
    const growthFromPreviousMonth = idx > 0
      ? computePercentageChange(mMetrics.totalContributions, monthBreakdown[idx - 1].totalContributions)
      : null;

    monthBreakdown.push({
      month: m,
      year: bounds.year,
      label: SHORT_MONTH_NAMES[idx],
      fullLabel: mb.label,
      ...mMetrics,
      growthFromPreviousMonth
    });
  }

  const quarterBreakdown = [1, 2, 3, 4].map(q => {
    const qb = getQuarterBounds(bounds.year, q);
    return {
      quarter: q,
      year: bounds.year,
      label: `Q${q}`,
      fullLabel: qb.label,
      ...computePeriodMetrics(ctx.activities, qb.startDate, qb.endDate, ctx.referenceToday, ctx.platformActivities)
    };
  });

  const halfBreakdown = [1, 2].map(h => {
    const hb = getHalfYearBounds(bounds.year, h);
    return {
      half: h,
      year: bounds.year,
      label: `H${h}`,
      fullLabel: hb.label,
      ...computePeriodMetrics(ctx.activities, hb.startDate, hb.endDate, ctx.referenceToday, ctx.platformActivities)
    };
  });

  // Compute average monthly activity using elapsed months in targetYear
  let elapsedMonths = 12;
  if (bounds.year === refParts[0]) {
    elapsedMonths = Math.max(1, refParts[1]);
  } else if (bounds.year > refParts[0]) {
    elapsedMonths = 0;
  }
  const averageMonthlyContributions = elapsedMonths > 0
    ? Math.round((metrics.totalContributions / elapsedMonths) * 10) / 10
    : 0;

  const mostProductiveMonth = monthBreakdown.reduce(
    (best, curr) => (curr.totalContributions > (best ? best.totalContributions : -1) ? curr : best),
    null
  );
  const mostActiveQuarter = quarterBreakdown.reduce(
    (best, curr) => (curr.totalContributions > (best ? best.totalContributions : -1) ? curr : best),
    null
  );

  const longestStreakInYear = streakService.computeLongestRun(new Set(metrics.activeDaysList));

  return {
    periodType: 'yearly',
    year: bounds.year,
    label: bounds.label,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    metrics,
    averageMonthlyContributions,
    longestStreakInYear,
    mostProductiveMonth: mostProductiveMonth && mostProductiveMonth.totalContributions > 0 ? mostProductiveMonth : null,
    mostActiveQuarter: mostActiveQuarter && mostActiveQuarter.totalContributions > 0 ? mostActiveQuarter : null,
    monthBreakdown,
    quarterBreakdown,
    halfBreakdown,
    previousPeriod: {
      year: prevBounds.year,
      label: prevBounds.label,
      metrics: previousMetrics
    },
    comparison: buildMetricsComparison(metrics, previousMetrics),
    topRepositories: buildRepositoryBreakdown(periodActivities, ctx.repos).slice(0, 10),
    hasData: metrics.totalContributions > 0,
    disclaimer: METHODOLOGY_DISCLAIMER
  };
}

function getActivityHeatmap(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const refParts = ctx.referenceToday.split('-').map(Number);

  let startDate;
  let endDate;
  let yearLabel;

  if (options.year) {
    const yb = getYearBounds(options.year);
    startDate = yb.startDate;
    endDate = yb.endDate;
    yearLabel = yb.year;
  } else {
    // Trailing 365 days ending referenceToday
    endDate = ctx.referenceToday;
    startDate = streakService.getShiftedDate(endDate, -364);
    yearLabel = refParts[0];
  }

  const dailyBuckets = new Map();
  function ensureBucket(dateKey) {
    let b = dailyBuckets.get(dateKey);
    if (!b) {
      b = {
        date: dateKey,
        count: 0,
        points: 0,
        commits: 0,
        prs: 0,
        issues: 0,
        reviews: 0,
        repoContributions: 0,
        platformActivities: 0
      };
      dailyBuckets.set(dateKey, b);
    }
    return b;
  }

  for (const act of ctx.activities) {
    if (act.activityDate < startDate || act.activityDate > endDate) continue;
    const bucket = ensureBucket(act.activityDate);
    bucket.count += act.units;
    bucket.points += act.points;
    if (act.kind === 'commit') bucket.commits += act.units;
    else if (act.kind === 'pr_created' || act.kind === 'pr_merged' || act.kind === 'pr_closed') bucket.prs += 1;
    else if (act.kind === 'issue_opened' || act.kind === 'issue_closed') bucket.issues += 1;
    else if (act.kind === 'pr_review') bucket.reviews += 1;
    else bucket.repoContributions += 1;
  }

  for (const plat of ctx.platformActivities) {
    if (plat.activityDate < startDate || plat.activityDate > endDate) continue;
    const bucket = ensureBucket(plat.activityDate);
    bucket.count += 1;
    bucket.platformActivities += 1;
    const dynamicPlatPts = scoringService.getPointsForActivity(plat.activityType, 1);
    bucket.points += dynamicPlatPts > 0 ? dynamicPlatPts : (Number(plat.points) || 0);
  }

  let maxDailyCount = 0;
  let totalContributions = 0;
  for (const entry of dailyBuckets.values()) {
    if (entry.count > maxDailyCount) maxDailyCount = entry.count;
    totalContributions += entry.count;
  }

  function resolveLevel(count) {
    if (!count || count <= 0) return 0;
    if (maxDailyCount <= 4) return Math.min(4, count);
    const ratio = count / maxDailyCount;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  const days = [];
  const totalSpanDays = getDaysBetweenInclusive(startDate, endDate);
  for (let i = 0; i < totalSpanDays; i++) {
    const dateKey = streakService.getShiftedDate(startDate, i);
    const b = dailyBuckets.get(dateKey);
    const count = b ? b.count : 0;
    const [y, m, d] = dateKey.split('-').map(Number);
    const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
    days.push({
      date: dateKey,
      dayOfWeek,
      count,
      level: resolveLevel(count),
      points: b ? b.points : 0,
      commits: b ? b.commits : 0,
      prs: b ? b.prs : 0,
      issues: b ? b.issues : 0,
      reviews: b ? b.reviews : 0,
      repoContributions: b ? b.repoContributions : 0,
      platformActivities: b ? b.platformActivities : 0
    });
  }

  return {
    year: yearLabel,
    startDate,
    endDate,
    totalDays: days.length,
    activeDays: dailyBuckets.size,
    totalContributions,
    maxDailyContributions: maxDailyCount,
    days
  };
}

function getActivityPercentagesSummary(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const [y, m] = ctx.referenceToday.split('-').map(Number);
  const currentYear = parseInt(options.year, 10) || y;
  const currentMonth = parseInt(options.month, 10) || m;
  const currentQuarter = parseInt(options.quarter, 10) || (Math.floor((currentMonth - 1) / 3) + 1);
  const currentHalf = parseInt(options.half, 10) || (currentMonth <= 6 ? 1 : 2);

  const weekStart = streakService.getShiftedDate(ctx.referenceToday, -6);
  const weekMetrics = computePeriodMetrics(ctx.activities, weekStart, ctx.referenceToday, ctx.referenceToday, ctx.platformActivities);

  const mb = getMonthBounds(currentYear, currentMonth);
  const monthMetrics = computePeriodMetrics(ctx.activities, mb.startDate, mb.endDate, ctx.referenceToday, ctx.platformActivities);

  const qb = getQuarterBounds(currentYear, currentQuarter);
  const quarterMetrics = computePeriodMetrics(ctx.activities, qb.startDate, qb.endDate, ctx.referenceToday, ctx.platformActivities);

  const hb = getHalfYearBounds(currentYear, currentHalf);
  const halfMetrics = computePeriodMetrics(ctx.activities, hb.startDate, hb.endDate, ctx.referenceToday, ctx.platformActivities);

  const yb = getYearBounds(currentYear);
  const yearMetrics = computePeriodMetrics(ctx.activities, yb.startDate, yb.endDate, ctx.referenceToday, ctx.platformActivities);

  function toSummarySlice(label, mObj) {
    return {
      label,
      startDate: mObj.startDate,
      endDate: mObj.endDate,
      activeDays: mObj.uniqueActiveDays,
      eligibleDays: mObj.eligibleCalendarDays,
      totalPeriodDays: mObj.totalPeriodDays,
      activityPercentage: mObj.activityPercentage,
      totalContributions: mObj.totalContributions
    };
  }

  return {
    referenceDate: ctx.referenceToday,
    weekly: toSummarySlice('Last 7 Days', weekMetrics),
    monthly: toSummarySlice(mb.label, monthMetrics),
    quarterly: toSummarySlice(qb.label, quarterMetrics),
    halfYearly: toSummarySlice(hb.shortLabel, halfMetrics),
    yearly: toSummarySlice(yb.label, yearMetrics)
  };
}

function getRepositoryAnalytics(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  let filtered = ctx.activities;
  if (options.fromDate) {
    const f = String(options.fromDate).slice(0, 10);
    filtered = filtered.filter(a => a.activityDate >= f);
  }
  if (options.toDate) {
    const t = String(options.toDate).slice(0, 10);
    filtered = filtered.filter(a => a.activityDate <= t);
  }

  const repositories = buildRepositoryBreakdown(filtered, ctx.repos);
  const languageDistribution = buildLanguageDistribution(ctx.repos);

  return {
    totalSyncedRepos: ctx.repoCounts.total || 0,
    publicSyncedRepos: ctx.repoCounts.public || 0,
    privateSyncedRepos: ctx.repoCounts.private || 0,
    storedInSqlite: ctx.repoCounts.storedInSqlite || 0,
    privateAccessGranted: Boolean(ctx.repoCounts.privateAccessGranted),
    privateAccessNote: ctx.repoCounts.privateAccessNote || null,
    counts: ctx.repoCounts,
    activeReposCount: repositories.length,
    repositories,
    languageDistribution
  };
}

function getActivityHistory(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const category = String(options.category || 'all').toLowerCase();
  const repoFilter = options.repoName ? String(options.repoName).trim().toLowerCase() : null;
  const fromDate = options.fromDate ? String(options.fromDate).slice(0, 10) : null;
  const toDate = options.toDate ? String(options.toDate).slice(0, 10) : null;

  const filtered = ctx.activities.filter(act => {
    if (category && category !== 'all') {
      if (category === 'pr_review' || category === 'review') {
        if (act.kind !== 'pr_review') return false;
      } else if (category === 'pr_created') {
        if (act.kind !== 'pr_created') return false;
      } else if (category === 'pr_merged') {
        if (act.kind !== 'pr_merged') return false;
      } else if (category === 'pr_closed') {
        if (act.kind !== 'pr_closed') return false;
      } else if (category === 'issue_opened') {
        if (act.kind !== 'issue_opened') return false;
      } else if (category === 'issue_closed') {
        if (act.kind !== 'issue_closed') return false;
      } else if (act.category !== category && act.kind !== category) {
        return false;
      }
    }
    if (repoFilter && String(act.repoName || '').toLowerCase() !== repoFilter) return false;
    if (fromDate && act.activityDate < fromDate) return false;
    if (toDate && act.activityDate > toDate) return false;
    return true;
  });

  const safeLimit = Math.max(1, Math.min(200, parseInt(options.limit, 10) || 50));
  const safeOffset = Math.max(0, parseInt(options.offset, 10) || 0);

  return {
    total: filtered.length,
    limit: safeLimit,
    offset: safeOffset,
    activities: filtered.slice(safeOffset, safeOffset + safeLimit)
  };
}

function resolveConsistencyRating(activityPercentage, totalContributions) {
  if (!totalContributions) return 'No Verified Activity';
  if (activityPercentage >= 75) return 'Exceptional Consistency';
  if (activityPercentage >= 50) return 'Strong Momentum';
  if (activityPercentage >= 25) return 'Steady Cadence';
  return 'Emerging Consistency';
}

function getProductivityReport(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const userSyncState = (ctx.user && ctx.user.github_id)
    ? getUserGithubSyncState(ctx.user.id, String(ctx.user.github_id))
    : null;
  const resolvedGithubUsername = (userSyncState && userSyncState.githubUsername) || null;
  const period = String(options.period || 'monthly').toLowerCase();

  let reportData;
  if (period === 'quarterly') {
    reportData = getQuarterlyAnalytics(userId, options);
  } else if (period === 'half-yearly' || period === 'halfyearly' || period === 'half') {
    reportData = getHalfYearlyAnalytics(userId, options);
  } else if (period === 'yearly') {
    reportData = getYearlyAnalytics(userId, options);
  } else {
    reportData = getMonthlyAnalytics(userId, options);
  }

  // Peak contribution day inside selected period
  const periodActivities = ctx.activities.filter(
    a => a.activityDate >= reportData.startDate && a.activityDate <= reportData.endDate
  );
  const dailyTotals = new Map();
  for (const act of periodActivities) {
    dailyTotals.set(act.activityDate, (dailyTotals.get(act.activityDate) || 0) + act.units);
  }
  let peakDay = null;
  for (const [date, count] of dailyTotals.entries()) {
    if (!peakDay || count > peakDay.count) {
      peakDay = { date, count };
    }
  }

  const languageDistribution = buildLanguageDistribution(ctx.repos);
  const lbTime = period === 'quarterly' ? 'quarterly' : (period === 'yearly' ? 'yearly' : (period === 'monthly' ? 'monthly' : 'all-time'));
  const leaderboard = getLeaderboard({ time: lbTime, perPage: 100, page: 1 });
  const myLeaderboardEntry = leaderboard.contributors.find(
    c => (c.userId && ctx.user && Number(c.userId) === Number(ctx.user.id)) ||
         (resolvedGithubUsername && c.username.toLowerCase() === resolvedGithubUsername.toLowerCase()) ||
         (ctx.user && c.username.toLowerCase() === String(ctx.user.username || '').toLowerCase())
  ) || null;

  return {
    generatedAt: new Date().toISOString(),
    periodType: reportData.periodType,
    periodLabel: reportData.label,
    startDate: reportData.startDate,
    endDate: reportData.endDate,
    user: ctx.user ? {
      id: ctx.user.id,
      username: ctx.user.username,
      name: ctx.user.name || ctx.user.username,
      githubUsername: resolvedGithubUsername
    } : null,
    summary: {
      totalContributions: reportData.metrics.totalContributions,
      commits: reportData.metrics.commits,
      prsCreated: reportData.metrics.prsCreated,
      prsMerged: reportData.metrics.prsMerged,
      prsClosed: reportData.metrics.prsClosed,
      issuesOpened: reportData.metrics.issuesOpened,
      issuesClosed: reportData.metrics.issuesClosed,
      issuesResolved: reportData.metrics.issuesClosed,
      reviews: reportData.metrics.reviews,
      repoContributions: reportData.metrics.repoContributions,
      platformActivitiesCount: reportData.metrics.platformActivitiesCount,
      platformBreakdown: reportData.metrics.platformBreakdown,
      activeRepositories: reportData.metrics.activeRepositories,
      uniqueActiveDays: reportData.metrics.uniqueActiveDays,
      eligibleCalendarDays: reportData.metrics.eligibleCalendarDays,
      activityPercentage: reportData.metrics.activityPercentage,
      githubPoints: reportData.metrics.githubPoints,
      platformPoints: reportData.metrics.platformPoints,
      contributionPoints: reportData.metrics.contributionPoints,
      consistencyRating: resolveConsistencyRating(
        reportData.metrics.activityPercentage,
        reportData.metrics.totalContributions + (reportData.metrics.platformActivitiesCount || 0)
      )
    },
    scoringRules: scoringService.getScoringRules(),
    previousPeriod: reportData.previousPeriod,
    comparison: reportData.comparison,
    highlights: {
      peakDay,
      mostProductiveMonth: reportData.mostProductiveMonth || reportData.mostActiveMonth || null,
      mostActiveQuarter: reportData.mostActiveQuarter || null,
      averageMonthlyContributions: reportData.averageMonthlyContributions || null,
      longestStreak: ctx.streak ? ctx.streak.longest_streak : 0,
      currentStreak: ctx.streak ? ctx.streak.current_streak : 0,
      leaderboardRank: myLeaderboardEntry ? myLeaderboardEntry.rank : null,
      leaderboardTotal: leaderboard.totalCount
    },
    mostActiveRepositories: reportData.topRepositories.slice(0, 5),
    languageDistribution: languageDistribution.slice(0, 8),
    hasData: reportData.hasData,
    disclaimer: METHODOLOGY_DISCLAIMER
  };
}

function getComparisonsPayload(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const [y, m] = ctx.referenceToday.split('-').map(Number);
  const year = parseInt(options.year, 10) || y;
  const month = parseInt(options.month, 10) || m;
  const quarter = parseInt(options.quarter, 10) || (Math.floor((month - 1) / 3) + 1);
  const half = parseInt(options.half, 10) || (month <= 6 ? 1 : 2);

  const monthly = getMonthlyAnalytics(userId, { ...options, year, month });
  const quarterly = getQuarterlyAnalytics(userId, { ...options, year, quarter });
  const halfYearly = getHalfYearlyAnalytics(userId, { ...options, year, half });
  const yearly = getYearlyAnalytics(userId, { ...options, year });

  return {
    monthly: { label: monthly.label, previousLabel: monthly.previousPeriod.label, comparison: monthly.comparison },
    quarterly: { label: quarterly.label, previousLabel: quarterly.previousPeriod.label, comparison: quarterly.comparison },
    halfYearly: { label: halfYearly.label, previousLabel: halfYearly.previousPeriod.label, comparison: halfYearly.comparison },
    yearly: { label: yearly.label, previousLabel: yearly.previousPeriod.label, comparison: yearly.comparison }
  };
}

function getFullAnalyticsDashboardPayload(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const [y, m] = ctx.referenceToday.split('-').map(Number);
  const year = parseInt(options.year, 10) || y;
  const month = parseInt(options.month, 10) || m;
  const quarter = parseInt(options.quarter, 10) || (Math.floor((month - 1) / 3) + 1);
  const half = parseInt(options.half, 10) || (month <= 6 ? 1 : 2);
  const period = String(options.period || 'monthly').toLowerCase();

  const monthly = getMonthlyAnalytics(userId, { ...options, year, month });
  const quarterly = getQuarterlyAnalytics(userId, { ...options, year, quarter });
  const halfYearly = getHalfYearlyAnalytics(userId, { ...options, year, half });
  const yearly = getYearlyAnalytics(userId, { ...options, year });
  const heatmap = getActivityHeatmap(userId, { ...options, year });
  const activityPercentages = getActivityPercentagesSummary(userId, { ...options, year, month, quarter, half });
  const repositories = getRepositoryAnalytics(userId, options);
  const report = getProductivityReport(userId, { ...options, period, year, month, quarter, half });
  const hasCustomDates = Boolean((options.fromDate && /^\d{4}-\d{2}-\d{2}/.test(String(options.fromDate))) || (options.toDate && /^\d{4}-\d{2}-\d{2}/.test(String(options.toDate))));
  const cleanFrom = hasCustomDates && options.fromDate ? String(options.fromDate).slice(0, 10) : null;
  const cleanTo = hasCustomDates && options.toDate ? String(options.toDate).slice(0, 10) : null;
  const effectiveRepoStart = cleanFrom || report.startDate;
  const effectiveRepoEnd = cleanTo || report.endDate;
  const periodScopedActs = ctx.activities.filter(
    a => (!effectiveRepoStart || a.activityDate >= effectiveRepoStart) && (!effectiveRepoEnd || a.activityDate <= effectiveRepoEnd)
  );
  const periodRepositories = buildRepositoryBreakdown(periodScopedActs, ctx.repos);
  const customFromBound = hasCustomDates
    ? (cleanFrom || ctx.activities.reduce((min, a) => (!min || a.activityDate < min ? a.activityDate : min), null) || report.startDate)
    : null;
  const customToBound = hasCustomDates ? (cleanTo || ctx.referenceToday) : null;
  const customRange = hasCustomDates ? {
    fromDate: customFromBound,
    toDate: customToBound,
    metrics: computePeriodMetrics(
      ctx.activities,
      customFromBound,
      customToBound,
      ctx.referenceToday,
      ctx.platformActivities
    ),
    repositoriesCount: periodRepositories.length
  } : null;

  const leaderboard = getLeaderboard({
    category: options.leaderboardCategory || 'top',
    time: options.leaderboardTime || 'all-time',
    page: 1,
    perPage: 10
  });

  // Determine available year options cleanly from user activities + current & previous calendar year
  const yearsSet = new Set([y, y - 1, year]);
  for (const act of ctx.activities) {
    const ay = parseInt(act.activityDate.slice(0, 4), 10);
    if (ay >= 2008 && ay <= 2100) yearsSet.add(ay);
  }
  const availableYears = Array.from(yearsSet).sort((a, b) => b - a);

  return {
    referenceDate: ctx.referenceToday,
    availableYears,
    streak: ctx.streak,
    activityPercentages,
    monthly,
    quarterly,
    halfYearly,
    yearly,
    heatmap,
    repositories,
    periodRepositories,
    customRange,
    platformActivities: ctx.platformActivities.slice(0, 40),
    scoringRules: scoringService.getScoringRules(),
    report,
    leaderboard,
    disclaimer: METHODOLOGY_DISCLAIMER
  };
}

function buildDailySummariesFromSources(normalizedGithub = [], platformActivities = []) {
  const byDate = new Map();
  function ensureDay(dateKey) {
    let slot = byDate.get(dateKey);
    if (!slot) {
      slot = {
        summaryDate: dateKey,
        githubContributions: 0,
        commitsCount: 0,
        prsCreated: 0,
        prsMerged: 0,
        prsClosed: 0,
        issuesOpened: 0,
        issuesClosed: 0,
        reviewsCount: 0,
        repoContributions: 0,
        platformActivitiesCount: 0,
        githubPoints: 0,
        platformPoints: 0,
        totalPoints: 0,
        isQualifyingDay: 1
      };
      byDate.set(dateKey, slot);
    }
    return slot;
  }

  for (const act of normalizedGithub) {
    if (!act || !act.activityDate) continue;
    const d = ensureDay(act.activityDate);
    d.githubPoints += Number(act.points) || 0;
    if (act.kind === 'commit') {
      d.commitsCount += act.units;
      d.githubContributions += act.units;
    } else if (act.kind === 'pr_created') {
      d.prsCreated += 1;
      d.githubContributions += 1;
    } else if (act.kind === 'pr_merged') {
      d.prsMerged += 1;
      d.githubContributions += 1;
    } else if (act.kind === 'pr_closed') {
      d.prsClosed += 1;
      d.githubContributions += 1;
    } else if (act.kind === 'issue_opened') {
      d.issuesOpened += 1;
      d.githubContributions += 1;
    } else if (act.kind === 'issue_closed') {
      d.issuesClosed += 1;
      d.githubContributions += 1;
    } else if (act.kind === 'pr_review') {
      d.reviewsCount += 1;
      d.githubContributions += 1;
    } else {
      d.repoContributions += 1;
      d.githubContributions += 1;
    }
  }

  for (const plat of platformActivities) {
    if (!plat || !plat.activityDate) continue;
    const d = ensureDay(plat.activityDate);
    const dynamicPts = scoringService.getPointsForActivity(plat.activityType, 1);
    const pts = dynamicPts > 0 ? dynamicPts : (Number(plat.points) || 0);
    d.platformActivitiesCount += 1;
    d.platformPoints += pts;
  }

  const result = [];
  for (const day of byDate.values()) {
    day.totalPoints = day.githubPoints + day.platformPoints;
    day.isQualifyingDay = (day.githubContributions > 0 || day.platformActivitiesCount > 0) ? 1 : 0;
    result.push(day);
  }
  return result.sort((a, b) => b.summaryDate.localeCompare(a.summaryDate));
}

function persistPeriodStatisticsSnapshots(userId, normalizedGithub, platformActivities, referenceToday) {
  const [y, m] = referenceToday.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) + 1;

  const weekStart = streakService.getShiftedDate(referenceToday, -6);
  const weekMetrics = computePeriodMetrics(normalizedGithub, weekStart, referenceToday, referenceToday, platformActivities);
  const mb = getMonthBounds(y, m);
  const monthMetrics = computePeriodMetrics(normalizedGithub, mb.startDate, mb.endDate, referenceToday, platformActivities);
  const qb = getQuarterBounds(y, q);
  const quarterMetrics = computePeriodMetrics(normalizedGithub, qb.startDate, qb.endDate, referenceToday, platformActivities);
  const yb = getYearBounds(y);
  const yearMetrics = computePeriodMetrics(normalizedGithub, yb.startDate, yb.endDate, referenceToday, platformActivities);

  const snapshots = [
    { periodType: 'weekly', periodKey: `W-${referenceToday}`, m: weekMetrics },
    { periodType: 'monthly', periodKey: `${y}-${String(m).padStart(2, '0')}`, m: monthMetrics },
    { periodType: 'quarterly', periodKey: `${y}-Q${q}`, m: quarterMetrics },
    { periodType: 'yearly', periodKey: String(y), m: yearMetrics }
  ];

  for (const snap of snapshots) {
    upsertUserProductivityStatistic(userId, {
      periodType: snap.periodType,
      periodKey: snap.periodKey,
      startDate: snap.m.startDate,
      endDate: snap.m.endDate,
      activeDays: snap.m.uniqueActiveDays,
      eligibleDays: snap.m.eligibleCalendarDays,
      activityPercentage: snap.m.activityPercentage,
      totalContributions: snap.m.totalContributions,
      platformActivitiesCount: snap.m.platformActivitiesCount,
      commitsCount: snap.m.commits,
      prsCreated: snap.m.prsCreated,
      prsMerged: snap.m.prsMerged,
      issuesOpened: snap.m.issuesOpened,
      issuesClosed: snap.m.issuesClosed,
      reviewsCount: snap.m.reviews,
      githubPoints: snap.m.githubPoints,
      platformPoints: snap.m.platformPoints,
      contributionPoints: snap.m.contributionPoints
    });
  }
}

/**
 * Automatically updates daily summaries, productivity snapshots, contribution streaks,
 * and leaderboard rankings whenever a user synchronizes GitHub or completes DevNexus activities.
 */
function syncUserAnalyticsAndLeaderboard(userId, { profile = null, referenceDate = null } = {}) {
  const user = findUserById(userId);
  if (!user) return null;

  const referenceToday = referenceDate ? toUtcDateKey(referenceDate) : toUtcDateKey();
  const rawActivities = getAllUserSyncedActivities(user.id, user.github_id || null, {
    includePrivate: true
  });
  const normalized = normalizeAndDeduplicateActivities(rawActivities);
  const platformActivities = getUserPlatformActivities(user.id, { limit: 2000 });

  // 1. Persist daily activity summaries & productivity statistic snapshots in SQLite
  const dailySummaries = buildDailySummariesFromSources(normalized, platformActivities);
  replaceUserDailyActivitySummaries(user.id, dailySummaries);
  persistPeriodStatisticsSnapshots(user.id, normalized, platformActivities, referenceToday);

  // 2. Automatically synchronize streak from ALL verified contribution dates (GitHub + DevNexus platform)
  const qualifyingDates = dailySummaries.filter(d => d.isQualifyingDay === 1).map(d => d.summaryDate);
  const streak = streakService.syncVerifiedContributionDates(user.id, qualifyingDates, referenceDate);

  // 3. Sync contributor profile & verified activities (GitHub + DevNexus platform) into leaderboard tables
  const syncState = user.github_id ? getUserGithubSyncState(user.id, String(user.github_id)) : null;
  const githubLogin = ((profile && profile.login) || (syncState && syncState.githubUsername) || '').trim();
  if (!githubLogin && normalized.length === 0 && platformActivities.length === 0) {
    return { streak, contributorId: null, syncedActivityCount: 0, dailySummariesCount: dailySummaries.length };
  }

  const repoStats = getUserRepositoryStats(user.id, { isSelf: true });
  const publicReposCount = repoStats.isConnected
    ? repoStats.public
    : 0;
  const followersCount = profile && typeof profile.followers === 'number'
    ? profile.followers
    : 0;

  const contributor = upsertContributor({
    user_id: user.id,
    github_id: user.github_id || (profile && profile.id ? String(profile.id) : null),
    username: githubLogin || user.username,
    name: (profile && profile.name) || user.name || user.username,
    avatar_url: (profile && profile.avatar_url) || user.avatar_url || '',
    bio: (profile && profile.bio) || user.bio || '',
    html_url: (profile && profile.html_url) || (githubLogin ? `https://github.com/${githubLogin}` : ''),
    public_repos: publicReposCount,
    followers: followersCount,
    current_streak: streak ? streak.current_streak : 0,
    longest_streak: streak ? streak.longest_streak : 0,
    total_active_days: streak ? streak.total_active_days : 0
  });

  const desiredActivities = [];
  for (const act of normalized) {
    // Protect private repository names when populating shared public leaderboard tables
    const publicSafeRepoName = act.isPrivate ? 'Private Repository' : (act.repoName || 'GitHub Repository');
    const canonicalIdentifier = act.canonicalKey || act.id;
    desiredActivities.push({
      event_id: `usr_${user.id}_${canonicalIdentifier}`,
      event_type: act.eventType || 'GitHubActivity',
      action_kind: act.kind,
      commit_count: act.kind === 'commit' ? act.units : 0,
      repo_name: publicSafeRepoName,
      action_summary: act.isPrivate ? `${act.kind.replace('_', ' ')} in private repository` : `${act.action || act.kind} ${act.title || ''}`.trim().slice(0, 140),
      points: act.points,
      source: 'github',
      event_timestamp: act.eventTimestamp
    });
  }

  for (const plat of platformActivities) {
    const dynamicPlatPts = scoringService.getPointsForActivity(plat.activityType, 1);
    const pts = dynamicPlatPts > 0 ? dynamicPlatPts : (Number(plat.points) || 0);
    desiredActivities.push({
      event_id: `dn_${user.id}_${plat.uniqueKey}`,
      event_type: `Platform_${plat.activityType}`,
      action_kind: plat.activityType,
      commit_count: 0,
      repo_name: 'DevNexus Platform',
      action_summary: plat.title,
      points: pts,
      source: 'devnexus',
      event_timestamp: plat.eventTimestamp
    });
  }

  const syncedActivityCount = replaceContributorSyncedActivities(contributor.id, desiredActivities);

  return {
    streak,
    contributorId: contributor.id,
    syncedActivityCount,
    dailySummariesCount: dailySummaries.length
  };
}

/**
 * Records a verified DevNexus platform activity idempotently (never double-rewards repeated toggles)
 * and automatically updates daily summaries, streaks, activity percentages, and leaderboard.
 */
function recordPlatformActivity(userId, {
  activityType,
  uniqueKey,
  referenceId = '',
  title,
  metadata = {},
  activityDate = null,
  eventTimestamp = null,
  referenceDate = null
} = {}) {
  if (!userId || !uniqueKey || !activityType || !title) {
    return { inserted: false, alreadyRewarded: false, streak: null };
  }
  const points = scoringService.getPointsForActivity(activityType, 1);
  const tsIso = eventTimestamp ? new Date(eventTimestamp).toISOString() : new Date().toISOString();
  const dateKey = activityDate ? toUtcDateKey(activityDate) : toUtcDateKey(tsIso);

  const persisted = recordPlatformActivityRow({
    userId,
    uniqueKey,
    activityType,
    referenceId,
    title,
    points,
    activityDate: dateKey,
    eventTimestamp: tsIso,
    metadata
  });

  if (!persisted.inserted) {
    return {
      inserted: false,
      alreadyRewarded: true,
      pointsAwarded: 0,
      activity: persisted.row,
      streak: streakService.getStreakSummary(userId, referenceDate)
    };
  }

  const syncResult = syncUserAnalyticsAndLeaderboard(userId, { referenceDate });
  return {
    inserted: true,
    alreadyRewarded: false,
    pointsAwarded: points,
    activity: persisted.row,
    streak: syncResult ? syncResult.streak : streakService.getStreakSummary(userId, referenceDate),
    syncResult
  };
}

function getPlatformActivitySummary(userId, options = {}) {
  const ctx = loadUserAnalyticsContext(userId, options);
  const fromDate = options.fromDate ? String(options.fromDate).slice(0, 10) : null;
  const toDate = options.toDate ? String(options.toDate).slice(0, 10) : null;
  const filtered = ctx.platformActivities.filter(p => {
    if (fromDate && p.activityDate < fromDate) return false;
    if (toDate && p.activityDate > toDate) return false;
    return true;
  });
  let totalPoints = 0;
  let roadmapStages = 0;
  let skillTasks = 0;
  let contributionMilestones = 0;
  for (const p of filtered) {
    const pts = scoringService.getPointsForActivity(p.activityType, 1);
    totalPoints += pts > 0 ? pts : (Number(p.points) || 0);
    if (p.activityType === 'roadmap_stage') roadmapStages += 1;
    else if (p.activityType === 'skill_task') skillTasks += 1;
    else contributionMilestones += 1;
  }
  return {
    totalCount: filtered.length,
    totalPoints,
    breakdown: { roadmapStages, skillTasks, contributionMilestones },
    activities: filtered.slice(0, 100)
  };
}

function backfillVerifiedContributorsToLeaderboard(limit = 50) {
  const pendingUserIds = getSyncedUsersNeedingLeaderboardSync(limit);
  let syncedUsers = 0;
  for (const uid of pendingUserIds) {
    try {
      const res = syncUserAnalyticsAndLeaderboard(uid);
      if (res && res.contributorId) syncedUsers += 1;
    } catch (e) {
      // Skip individual failures safely without aborting leaderboard load
    }
  }
  return syncedUsers;
}

module.exports = {
  ACTIVITY_POINT_RULES,
  METHODOLOGY_DISCLAIMER,
  toUtcDateKey,
  getMonthBounds,
  getQuarterBounds,
  getHalfYearBounds,
  getYearBounds,
  computeEligibleCalendarDays,
  classifyActivityKind,
  computeActivityPoints,
  computePercentageChange,
  computePeriodMetrics,
  normalizeAndDeduplicateActivities,
  getMonthlyAnalytics,
  getQuarterlyAnalytics,
  getHalfYearlyAnalytics,
  getYearlyAnalytics,
  getActivityHeatmap,
  getActivityPercentagesSummary,
  getRepositoryAnalytics,
  getActivityHistory,
  getProductivityReport,
  getComparisonsPayload,
  getFullAnalyticsDashboardPayload,
  syncUserAnalyticsAndLeaderboard,
  backfillVerifiedContributorsToLeaderboard,
  recordPlatformActivity,
  getPlatformActivitySummary,
  getUserDailyActivitySummaries,
  getUserProductivityStatistics,
  findUserByUsername
};
