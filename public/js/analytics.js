/**
 * DevNexus Developer Productivity & Activity Analytics Controller
 * Drives period filtering, API queries, all 12 visualizations, and Productivity Report.
 */
(function (global) {
  'use strict';

  var root = document.getElementById('developer-analytics-module');
  if (!root) {
    global.DevNexusAnalytics = { refresh: function () {} };
    return;
  }

  var state = {
    period: 'monthly',
    year: new Date().getUTCFullYear(),
    month: new Date().getUTCMonth() + 1,
    quarter: Math.floor(new Date().getUTCMonth() / 3) + 1,
    half: new Date().getUTCMonth() < 6 ? 1 : 2,
    fromDate: '',
    toDate: '',
    leaderboardTime: 'all-time',
    lastPayload: null
  };

  function $(id) { return document.getElementById(id); }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDeltaBadge(comp) {
    if (!comp) return '<span class="dn-delta neutral">0.0%</span>';
    if (comp.comparisonAvailable === false) {
      return '<span class="dn-delta ' + esc(comp.trendDirection || 'neutral') + '">' + esc(comp.displayText || ('+' + comp.current + ' vs 0 prior')) + '</span>';
    }
    return '<span class="dn-delta ' + esc(comp.trendDirection || 'neutral') + '">' + esc(comp.displayText || '0.0%') + '</span>';
  }

  function toggleFilterPickers() {
    var mWrap = $('analytics-month-wrap');
    var qWrap = $('analytics-quarter-wrap');
    var hWrap = $('analytics-half-wrap');
    if (mWrap) mWrap.style.display = state.period === 'monthly' ? '' : 'none';
    if (qWrap) qWrap.style.display = state.period === 'quarterly' ? '' : 'none';
    if (hWrap) hWrap.style.display = state.period === 'half-yearly' ? '' : 'none';
  }

  function setLoading(isLoading) {
    var statusEl = $('analytics-loading-state');
    if (statusEl) statusEl.style.display = isLoading ? 'flex' : 'none';
  }

  function showError(msg) {
    var errEl = $('analytics-error-banner');
    if (!errEl) return;
    if (!msg) {
      errEl.style.display = 'none';
      errEl.innerHTML = '';
      return;
    }
    errEl.style.display = 'flex';
    errEl.innerHTML =
      '<span>' + esc(msg) + '</span>' +
      '<button type="button" class="btn btn-sm" id="analytics-retry-btn">Retry</button>';
    var retryBtn = $('analytics-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () { loadAnalytics(); });
    }
  }

  function populateYearOptions(years) {
    var sel = $('analytics-year-select');
    if (!sel || !Array.isArray(years) || years.length === 0) return;
    var existingVals = Array.from(sel.options).map(function (o) { return Number(o.value); });
    if (years.every(function (y) { return existingVals.includes(y); }) && existingVals.length === years.length) {
      return;
    }
    sel.innerHTML = years.map(function (y) {
      return '<option value="' + y + '"' + (Number(state.year) === y ? ' selected' : '') + '>' + y + '</option>';
    }).join('');
  }

  function syncSidebarStreakWidget(streak) {
    if (!streak) return;
    var countEl = document.getElementById('streak-count-display');
    var subEl = document.querySelector('#sidebar-streak-card .streak-sub-title');
    var motivEl = document.querySelector('#sidebar-streak-card .streak-motivation');
    if (countEl) {
      countEl.textContent = (streak.current_streak || 0) + ' Day Streak';
    }
    if (subEl) {
      subEl.textContent = 'Best: ' + (streak.longest_streak || 0) + 'd \u2022 ' + (streak.total_active_days || 0) + ' total days';
    }
    if (motivEl && streak.statusMessage) {
      motivEl.textContent = streak.statusMessage;
    }
  }

  function renderActivityPercentagesGrid(pctSummary) {
    var host = $('analytics-pct-breakdown');
    if (!host || !pctSummary) return;
    var rows = [
      { key: 'Weekly', obj: pctSummary.weekly },
      { key: 'Monthly', obj: pctSummary.monthly },
      { key: 'Quarterly', obj: pctSummary.quarterly },
      { key: 'Half-Yearly', obj: pctSummary.halfYearly },
      { key: 'Yearly', obj: pctSummary.yearly }
    ];
    host.innerHTML = rows.map(function (r) {
      var o = r.obj || {};
      var pctFormatted = Number(o.activityPercentage || 0).toFixed(2).replace(/\.00$/, '');
      return '<div class="dn-pct-pill">' +
        '<div class="dn-pct-head"><span>' + esc(r.key) + '</span><strong>' + pctFormatted + '%</strong></div>' +
        '<div class="dn-pct-sub">' + (o.activeDays || 0) + ' / ' + (o.eligibleDays || 0) + ' eligible days (' + (o.totalContributions || 0) + ' GitHub' + ((o.platformActivitiesCount || 0) > 0 ? ' + ' + o.platformActivitiesCount + ' platform' : '') + ')</div>' +
        '</div>';
    }).join('');
  }

  function renderProductivityReport(report) {
    var container = $('analytics-report-container');
    if (!container || !report) return;
    var s = report.summary || {};
    var h = report.highlights || {};
    var c = report.comparison || {};
    var prev = report.previousPeriod || {};
    var pb = s.platformBreakdown || {};
    var pctFormatted = Number(s.activityPercentage || 0).toFixed(2).replace(/\.00$/, '');

    var cardsHtml =
      '<div class="dn-report-kpis">' +
        '<div class="dn-report-kpi"><div class="lbl">Total Contributions</div><div class="val">' + (s.totalContributions || 0) + '</div><div class="sub">vs ' + esc(prev.label || 'prior') + ': ' + formatDeltaBadge(c.totalContributions) + '</div></div>' +
        '<div class="dn-report-kpi"><div class="lbl">Commits</div><div class="val">' + (s.commits || 0) + '</div><div class="sub">' + formatDeltaBadge(c.commits) + '</div></div>' +
        '<div class="dn-report-kpi"><div class="lbl">PRs Created / Merged</div><div class="val">' + (s.prsCreated || 0) + ' / ' + (s.prsMerged || 0) + '</div><div class="sub">Closed unmerged: ' + (s.prsClosed || 0) + '</div></div>' +
        '<div class="dn-report-kpi"><div class="lbl">Issues Opened / Closed</div><div class="val">' + (s.issuesOpened || 0) + ' / ' + (s.issuesClosed || 0) + '</div><div class="sub">Resolved delta: ' + formatDeltaBadge(c.issuesClosed) + '</div></div>' +
        '<div class="dn-report-kpi"><div class="lbl">Reviews &amp; DevNexus Tasks</div><div class="val">' + (s.reviews || 0) + ' rev / ' + (s.platformActivitiesCount || 0) + ' tasks</div><div class="sub">' + (s.contributionPoints || 0) + ' pts (' + (s.githubPoints || 0) + ' GH + ' + (s.platformPoints || 0) + ' DevNexus)</div></div>' +
        '<div class="dn-report-kpi"><div class="lbl">Activity Percentage</div><div class="val">' + pctFormatted + '%</div><div class="sub">' + (s.uniqueActiveDays || 0) + ' / ' + (s.eligibleCalendarDays || 0) + ' eligible days \u2022 ' + esc(s.consistencyRating || '') + '</div></div>' +
      '</div>';

    var rulesChips = Array.isArray(report.scoringRules) && report.scoringRules.length > 0
      ? '<div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; font-size:11px;">' +
        '<strong style="color:var(--text);">Scoring Weights:</strong> ' +
        report.scoringRules.map(function (r) {
          return '<span class="dn-hbar-badge">' + esc(r.label) + ': +' + Number(r.points) + ' pts</span>';
        }).join('') +
        '</div>'
      : '';

    var highlightsHtml =
      '<div class="dn-report-highlights">' +
        '<div><strong>Period:</strong> ' + esc(report.periodLabel) + ' (' + esc(report.startDate) + ' to ' + esc(report.endDate) + ')</div>' +
        '<div><strong>Peak Contribution Day:</strong> ' + (h.peakDay ? esc(h.peakDay.date) + ' (' + h.peakDay.count + ' actions)' : 'No activity in range') + '</div>' +
        '<div><strong>Top Active Month:</strong> ' + (h.mostProductiveMonth ? esc(h.mostProductiveMonth.fullLabel || h.mostProductiveMonth.label) + ' (' + h.mostProductiveMonth.totalContributions + ')' : 'N/A') + '</div>' +
        '<div><strong>DevNexus Milestones:</strong> Roadmap ' + (pb.roadmapStages || 0) + ' \u2022 Skills ' + (pb.skillTasks || 0) + ' \u2022 Badges ' + (pb.contributionMilestones || 0) + '</div>' +
        '<div><strong>Active Repositories:</strong> ' + (s.activeRepositories || 0) + '</div>' +
        '<div><strong>Streak &amp; Rank:</strong> ' + (h.currentStreak || 0) + 'd current / ' + (h.longestStreak || 0) + 'd best' + (h.leaderboardRank ? ' \u2022 Leaderboard #' + h.leaderboardRank : '') + '</div>' +
      '</div>';

    var disclaimerHtml =
      '<div class="dn-report-disclaimer">' +
      esc(report.disclaimer || 'Analytics reflect verified GitHub contribution timestamps and active contribution days, not logged working hours.') +
      rulesChips +
      '</div>';

    container.innerHTML = cardsHtml + highlightsHtml + disclaimerHtml;
  }

  function buildWeeklyBucketsFromMonth(dailyBreakdown) {
    if (!Array.isArray(dailyBreakdown) || dailyBreakdown.length === 0) return [];
    var ranges = [
      { label: 'W1 (1–7)', fullLabel: 'Days 1–7', min: 1, max: 7 },
      { label: 'W2 (8–14)', fullLabel: 'Days 8–14', min: 8, max: 14 },
      { label: 'W3 (15–21)', fullLabel: 'Days 15–21', min: 15, max: 21 },
      { label: 'W4 (22–28)', fullLabel: 'Days 22–28', min: 22, max: 28 },
      { label: 'W5 (29+)', fullLabel: 'Days 29–31', min: 29, max: 31 }
    ];
    return ranges
      .map(function (rg) {
        var slice = dailyBreakdown.filter(function (d) { return d.day >= rg.min && d.day <= rg.max; });
        if (slice.length === 0) return null;
        return slice.reduce(function (acc, d) {
          acc.commits += Number(d.commits) || 0;
          acc.prsCreated += Number(d.prsCreated) || 0;
          acc.prsMerged += Number(d.prsMerged) || 0;
          acc.issuesOpened += Number(d.issuesOpened) || 0;
          acc.issuesClosed += Number(d.issuesClosed) || 0;
          acc.reviews += Number(d.reviews) || 0;
          return acc;
        }, {
          label: rg.label,
          fullLabel: rg.fullLabel,
          commits: 0,
          prsCreated: 0,
          prsMerged: 0,
          issuesOpened: 0,
          issuesClosed: 0,
          reviews: 0
        });
      })
      .filter(Boolean);
  }

  function renderAnalyticsHeroKpis(payload) {
    var kpiHost = $('analytics-hero-kpis');
    if (!kpiHost || !payload) return;
    var report = payload.report || {};
    var summary = report.summary || {};
    var streak = payload.streak || {};
    var repos = payload.repositories || {};
    var periodRepos = Array.isArray(payload.periodRepositories) ? payload.periodRepositories : (repos.repositories || []);
    var customRange = payload.customRange || null;

    var activeSummary = customRange && customRange.metrics ? customRange.metrics : summary;
    var pct = Number(activeSummary.activityPercentage || 0).toFixed(2).replace(/\.00$/, '');
    var rangeLabel = customRange
      ? (customRange.fromDate + ' to ' + customRange.toDate)
      : (report.periodLabel || 'Current Period');

    kpiHost.innerHTML =
      '<div class="dn-kpi-card">' +
        '<div class="dn-kpi-lbl">Verified Activity (' + esc(rangeLabel) + ')</div>' +
        '<div class="dn-kpi-val">' + (activeSummary.totalContributions || 0) + '</div>' +
        '<div class="dn-kpi-sub">' + (activeSummary.commits || 0) + ' commits \u2022 ' + ((activeSummary.prsCreated || 0) + (activeSummary.prsMerged || 0)) + ' PR events \u2022 ' + (activeSummary.reviews || 0) + ' reviews</div>' +
      '</div>' +
      '<div class="dn-kpi-card">' +
        '<div class="dn-kpi-lbl">Developer Activity Rate</div>' +
        '<div class="dn-kpi-val">' + pct + '%</div>' +
        '<div class="dn-kpi-sub">' + (activeSummary.uniqueActiveDays || 0) + ' / ' + (activeSummary.eligibleCalendarDays || 0) + ' eligible calendar days</div>' +
      '</div>' +
      '<div class="dn-kpi-card">' +
        '<div class="dn-kpi-lbl">Current / Longest Streak</div>' +
        '<div class="dn-kpi-val">' + (streak.current_streak || 0) + 'd / ' + (streak.longest_streak || 0) + 'd</div>' +
        '<div class="dn-kpi-sub">' + (streak.total_active_days || 0) + ' total qualifying days \u2022 ' + (streak.streak_freeze_count || 0) + ' freezes</div>' +
      '</div>' +
      '<div class="dn-kpi-card">' +
        '<div class="dn-kpi-lbl">Total Repositories</div>' +
        '<div class="dn-kpi-val">' + (repos.totalSyncedRepos || 0) + '</div>' +
        '<div class="dn-kpi-sub">' + (repos.publicSyncedRepos || 0) + ' public \u2022 ' + (repos.privateSyncedRepos || 0) + ' private \u2022 ' + periodRepos.length + ' active in period</div>' +
        ((repos.privateAccessGranted === false && repos.privateAccessNote)
          ? '<div class="dn-kpi-sub analytics-private-warn">' + esc(repos.privateAccessNote) + ' <a href="/auth/github">Authorize Private Repos \u2192</a></div>'
          : '') +
      '</div>';
  }

  function renderHorizonReportCards(payload) {
    var host = $('analytics-horizon-cards');
    if (!host || !payload) return;
    var items = [
      { key: 'monthly', title: 'Monthly Report', obj: payload.monthly, meta: function (o) { return (o.topRepositories || []).length + ' active repos'; } },
      { key: 'quarterly', title: 'Quarterly Report', obj: payload.quarterly, meta: function (o) { return o.mostActiveMonth ? 'Peak: ' + o.mostActiveMonth.fullLabel : 'No peak month yet'; } },
      { key: 'half-yearly', title: 'Half-Yearly Report', obj: payload.halfYearly, meta: function (o) { return o.mostActiveMonth ? 'Top Month: ' + o.mostActiveMonth.fullLabel : '6-month rollup'; } },
      { key: 'yearly', title: 'Yearly Report', obj: payload.yearly, meta: function (o) { return 'Avg ' + (o.averageMonthlyContributions || 0) + '/mo \u2022 Max streak ' + (o.longestStreakInYear || 0) + 'd'; } }
    ];

    host.innerHTML = items.map(function (it) {
      var o = it.obj || {};
      var m = o.metrics || {};
      var comp = o.comparison && o.comparison.totalContributions ? o.comparison.totalContributions : null;
      var prev = o.previousPeriod || {};
      var isSelected = state.period === it.key;
      return '<article class="dn-horizon-card' + (isSelected ? ' is-selected' : '') + '" data-horizon-period="' + esc(it.key) + '">' +
        '<div class="dn-horizon-top">' +
          '<span class="dn-horizon-tag">' + esc(it.title) + '</span>' +
          '<span class="dn-horizon-period">' + esc(o.label || '') + '</span>' +
        '</div>' +
        '<div class="dn-horizon-num">' + (m.totalContributions || 0) + ' <span>contributions</span></div>' +
        '<div class="dn-horizon-delta">vs ' + esc(prev.label || 'prior') + ': ' + formatDeltaBadge(comp) + '</div>' +
        '<div class="dn-horizon-grid">' +
          '<span>Commits: <strong>' + (m.commits || 0) + '</strong></span>' +
          '<span>PRs C/M: <strong>' + (m.prsCreated || 0) + '/' + (m.prsMerged || 0) + '</strong></span>' +
          '<span>Issues O/C: <strong>' + (m.issuesOpened || 0) + '/' + (m.issuesClosed || 0) + '</strong></span>' +
          '<span>Activity: <strong>' + Number(m.activityPercentage || 0).toFixed(2).replace(/\.00$/, '') + '%</strong></span>' +
        '</div>' +
        '<div class="dn-horizon-foot">' + esc(it.meta(o)) + ' \u2022 ' + (m.contributionPoints || 0) + ' pts</div>' +
      '</article>';
    }).join('');

    host.querySelectorAll('[data-horizon-period]').forEach(function (card) {
      card.addEventListener('click', function () {
        var nextPeriod = card.getAttribute('data-horizon-period');
        if (!nextPeriod || nextPeriod === state.period) return;
        state.period = nextPeriod;
        root.querySelectorAll('.dn-period-btn').forEach(function (b) {
          b.classList.toggle('active', b.dataset.period === nextPeriod);
        });
        loadAnalytics();
      });
    });
  }

  function renderPeriodComparisonsPanel(payload) {
    var compHost = $('analytics-period-comparisons');
    var chartHost = $('chart-period-compare-bars');
    if (!payload) return;

    function buildCompBlock(title, periodObj) {
      if (!periodObj || !periodObj.metrics) return '';
      var curr = periodObj.metrics;
      var prev = (periodObj.previousPeriod && periodObj.previousPeriod.metrics) || {};
      var c = periodObj.comparison || {};
      var rows = [
        { label: 'Total Contributions', currVal: curr.totalContributions || 0, prevVal: prev.totalContributions || 0, comp: c.totalContributions },
        { label: 'Commits', currVal: curr.commits || 0, prevVal: prev.commits || 0, comp: c.commits },
        { label: 'PRs Created', currVal: curr.prsCreated || 0, prevVal: prev.prsCreated || 0, comp: c.prsCreated },
        { label: 'PRs Merged', currVal: curr.prsMerged || 0, prevVal: prev.prsMerged || 0, comp: c.prsMerged },
        { label: 'Issues Closed', currVal: curr.issuesClosed || 0, prevVal: prev.issuesClosed || 0, comp: c.issuesClosed },
        { label: 'PR Reviews', currVal: curr.reviews || 0, prevVal: prev.reviews || 0, comp: c.reviews }
      ];
      return '<div class="dn-comp-card">' +
        '<div class="dn-comp-head">' +
          '<strong>' + esc(title) + '</strong>' +
          '<span>' + esc(periodObj.label || '') + ' vs ' + esc((periodObj.previousPeriod && periodObj.previousPeriod.label) || 'Prior') + '</span>' +
        '</div>' +
        '<div class="dn-comp-rows">' +
        rows.map(function (r) {
          return '<div class="dn-comp-row">' +
            '<span class="lbl">' + esc(r.label) + '</span>' +
            '<span class="vals"><strong>' + r.currVal + '</strong> <small>vs ' + r.prevVal + '</small></span>' +
            '<span class="pct">' + formatDeltaBadge(r.comp) + '</span>' +
          '</div>';
        }).join('') +
        '</div>' +
      '</div>';
    }

    if (compHost) {
      compHost.innerHTML =
        buildCompBlock('Monthly Productivity Comparison', payload.monthly) +
        buildCompBlock('Quarterly Productivity Comparison', payload.quarterly);
    }

    if (chartHost && global.DevNexusCharts) {
      var mObj = payload.monthly || {};
      var qObj = payload.quarterly || {};
      var compareGroups = [
        {
          label: mObj.label || 'Current Mo',
          fullLabel: 'Monthly: ' + (mObj.label || ''),
          commits: (mObj.metrics && mObj.metrics.commits) || 0,
          prs: ((mObj.metrics && mObj.metrics.prsCreated) || 0) + ((mObj.metrics && mObj.metrics.prsMerged) || 0),
          issues: ((mObj.metrics && mObj.metrics.issuesOpened) || 0) + ((mObj.metrics && mObj.metrics.issuesClosed) || 0)
        },
        {
          label: (mObj.previousPeriod && mObj.previousPeriod.label) || 'Prior Mo',
          fullLabel: 'Prior Month: ' + ((mObj.previousPeriod && mObj.previousPeriod.label) || ''),
          commits: (mObj.previousPeriod && mObj.previousPeriod.metrics && mObj.previousPeriod.metrics.commits) || 0,
          prs: ((mObj.previousPeriod && mObj.previousPeriod.metrics && mObj.previousPeriod.metrics.prsCreated) || 0) + ((mObj.previousPeriod && mObj.previousPeriod.metrics && mObj.previousPeriod.metrics.prsMerged) || 0),
          issues: ((mObj.previousPeriod && mObj.previousPeriod.metrics && mObj.previousPeriod.metrics.issuesOpened) || 0) + ((mObj.previousPeriod && mObj.previousPeriod.metrics && mObj.previousPeriod.metrics.issuesClosed) || 0)
        },
        {
          label: qObj.label || 'Current Qtr',
          fullLabel: 'Quarterly: ' + (qObj.label || ''),
          commits: (qObj.metrics && qObj.metrics.commits) || 0,
          prs: ((qObj.metrics && qObj.metrics.prsCreated) || 0) + ((qObj.metrics && qObj.metrics.prsMerged) || 0),
          issues: ((qObj.metrics && qObj.metrics.issuesOpened) || 0) + ((qObj.metrics && qObj.metrics.issuesClosed) || 0)
        },
        {
          label: (qObj.previousPeriod && qObj.previousPeriod.label) || 'Prior Qtr',
          fullLabel: 'Prior Quarter: ' + ((qObj.previousPeriod && qObj.previousPeriod.label) || ''),
          commits: (qObj.previousPeriod && qObj.previousPeriod.metrics && qObj.previousPeriod.metrics.commits) || 0,
          prs: ((qObj.previousPeriod && qObj.previousPeriod.metrics && qObj.previousPeriod.metrics.prsCreated) || 0) + ((qObj.previousPeriod && qObj.previousPeriod.metrics && qObj.previousPeriod.metrics.prsMerged) || 0),
          issues: ((qObj.previousPeriod && qObj.previousPeriod.metrics && qObj.previousPeriod.metrics.issuesOpened) || 0) + ((qObj.previousPeriod && qObj.previousPeriod.metrics && qObj.previousPeriod.metrics.issuesClosed) || 0)
        }
      ];
      global.DevNexusCharts.renderGroupedBarChart(
        chartHost,
        compareGroups,
        [
          { key: 'commits', label: 'Commits', color: '#22d3ee' },
          { key: 'prs', label: 'Pull Requests', color: '#6366f1' },
          { key: 'issues', label: 'Issues', color: '#10b981' }
        ],
        {
          emptyTitle: 'No monthly or quarterly comparison activity',
          emptySub: 'Sync GitHub to compare current vs previous months and quarters.'
        }
      );
    }
  }

  function renderRepositoryActivityTable(repoList, periodLabel) {
    var host = $('analytics-repo-activity-list');
    if (!host) return;
    if (!Array.isArray(repoList) || repoList.length === 0) {
      host.innerHTML =
        '<div class="dn-chart-empty">' +
          '<div class="dn-chart-empty-title">No repository activity in ' + esc(periodLabel || 'selected range') + '</div>' +
          '<div class="dn-chart-empty-sub">Connect GitHub and synchronize activity or widen your date/period filter to view repository-wise contributions.</div>' +
        '</div>';
      return;
    }

    var totalActivity = repoList.reduce(function (s, r) { return s + (Number(r.totalContributions) || 0); }, 0);
    host.innerHTML =
      '<div class="dn-table-wrap">' +
        '<table class="dn-repo-table">' +
          '<thead><tr>' +
            '<th>Repository</th>' +
            '<th>Language</th>' +
            '<th>Commits</th>' +
            '<th>PRs (C/M)</th>' +
            '<th>Issues (O/C)</th>' +
            '<th>Reviews</th>' +
            '<th>Share</th>' +
            '<th>Points</th>' +
          '</tr></thead>' +
          '<tbody>' +
          repoList.map(function (r) {
            var share = totalActivity > 0 ? (Math.round(((Number(r.totalContributions) || 0) / totalActivity) * 1000) / 10) : 0;
            return '<tr>' +
              '<td><strong>' + esc(r.repoName) + '</strong>' + (r.isPrivate ? ' <span class="dn-hbar-badge">Private</span>' : '') + '</td>' +
              '<td>' + esc(r.language || 'Unknown') + '</td>' +
              '<td>' + (r.commits || 0) + '</td>' +
              '<td>' + (r.prsCreated || 0) + ' / ' + (r.prsMerged || 0) + '</td>' +
              '<td>' + (r.issuesOpened || 0) + ' / ' + (r.issuesClosed || 0) + '</td>' +
              '<td>' + (r.reviews || 0) + '</td>' +
              '<td>' + share + '% (' + (r.totalContributions || 0) + ')</td>' +
              '<td><strong>' + (r.points || 0) + '</strong></td>' +
            '</tr>';
          }).join('') +
          '</tbody>' +
        '</table>' +
      '</div>';
  }

  function renderEmptyAccountBanner(payload) {
    var banner = $('analytics-empty-banner');
    if (!banner || !payload) return;
    var hasSyncedRepos = Number((payload.repositories && payload.repositories.totalSyncedRepos) || 0) > 0;
    var hasHeatmapActs = Number((payload.heatmap && payload.heatmap.totalContributions) || 0) > 0;
    var hasPlatformActs = Array.isArray(payload.platformActivities) && payload.platformActivities.length > 0;
    var isConnected = banner.getAttribute('data-github-connected') === 'true';
    banner.style.display = (!isConnected || (!hasSyncedRepos && !hasHeatmapActs && !hasPlatformActs)) ? 'flex' : 'none';
  }

  function renderAllVisualizations(payload) {
    state.lastPayload = payload;
    populateYearOptions(payload.availableYears);
    syncSidebarStreakWidget(payload.streak);
    renderAnalyticsHeroKpis(payload);
    renderHorizonReportCards(payload);
    renderPeriodComparisonsPanel(payload);
    renderEmptyAccountBanner(payload);

    var Charts = global.DevNexusCharts;
    if (!Charts) return;

    var monthly = payload.monthly || {};
    var quarterly = payload.quarterly || {};
    var halfYearly = payload.halfYearly || {};
    var yearly = payload.yearly || {};
    var heatmap = payload.heatmap || {};
    var repos = payload.repositories || {};
    var report = payload.report || {};
    var pctSummary = payload.activityPercentages || {};

    // Header period summary badge
    var badgeEl = $('analytics-active-period-badge');
    if (badgeEl && report) {
      if (payload.customRange && payload.customRange.metrics) {
        badgeEl.textContent = 'Custom Range (' + payload.customRange.fromDate + ' to ' + payload.customRange.toDate + ') \u2022 ' + payload.customRange.metrics.totalContributions + ' contributions';
      } else {
        badgeEl.textContent = report.periodLabel + ' \u2022 ' + (report.summary ? report.summary.totalContributions : 0) + ' contributions';
      }
    }

    // 1. Monthly Activity Bar Chart (day-by-day for selected month)
    var mSub = $('chart-monthly-sub');
    if (mSub && monthly.metrics) {
      mSub.textContent = (monthly.label || '') + ' \u2022 ' + monthly.metrics.totalContributions + ' total (' + monthly.metrics.uniqueActiveDays + ' active days)';
    }
    var dailyItems = (monthly.dailyBreakdown || []).map(function (d) {
      return {
        label: String(d.day),
        value: d.total,
        tipTitle: d.date,
        tipLines: [
          'Total: ' + d.total + ' contributions (' + d.points + ' pts)',
          'Commits: ' + d.commits + ' | PRs Created: ' + d.prsCreated + ' | Merged: ' + d.prsMerged,
          'Issues Opened: ' + d.issuesOpened + ' | Closed: ' + d.issuesClosed + ' | Reviews: ' + d.reviews
        ]
      };
    });
    Charts.renderBarChart($('chart-monthly-bar'), dailyItems, {
      color: 'var(--accent-solid)',
      emptyTitle: 'No activity in ' + (monthly.label || 'selected month'),
      emptySub: 'Select another month/year or click Sync GitHub.'
    });

    // 2. Quarterly Comparison Chart (Q1-Q4 of selected year + active quarter highlighted)
    var qSub = $('chart-quarterly-sub');
    if (qSub && quarterly.metrics) {
      qSub.textContent = (quarterly.label || '') + ': ' + quarterly.metrics.totalContributions + ' total' +
        (quarterly.previousPeriod ? ' vs ' + quarterly.previousPeriod.label + ' (' + quarterly.previousPeriod.metrics.totalContributions + ')' : '');
    }
    var qItems = (quarterly.yearQuarters || []).map(function (q) {
      return {
        label: q.label + ' ' + q.year,
        value: q.totalContributions,
        active: Number(q.quarter) === Number(quarterly.quarter),
        tipTitle: q.fullLabel,
        tipLines: [
          'Total: ' + q.totalContributions + ' (' + q.activityPercentage + '% active days)',
          'Commits: ' + q.commits + ' | PRs Created: ' + q.prsCreated + ' | Merged: ' + q.prsMerged,
          'Issues Closed: ' + q.issuesClosed + ' | Reviews: ' + q.reviews
        ]
      };
    });
    Charts.renderBarChart($('chart-quarterly-bar'), qItems, {
      color: '#6366f1',
      highlightColor: '#22d3ee',
      showValueLabels: true,
      emptyTitle: 'No quarterly activity in ' + (quarterly.year || state.year),
      emptySub: 'Contributions across Q1\u2013Q4 will appear here after GitHub sync.'
    });

    // 3. Yearly Trend Line Chart (12 months Jan-Dec)
    var ySub = $('chart-yearly-sub');
    if (ySub && yearly.metrics) {
      ySub.textContent = (yearly.label || '') + ': ' + yearly.metrics.totalContributions + ' total \u2022 Avg ' + (yearly.averageMonthlyContributions || 0) + '/mo';
    }
    var yPoints = (yearly.monthBreakdown || []).map(function (m) {
      return {
        label: m.label,
        value: m.totalContributions,
        tipTitle: m.fullLabel,
        tipLines: [
          'Total Contributions: ' + m.totalContributions + ' (' + m.contributionPoints + ' pts)',
          'Commits: ' + m.commits + ' | PRs: ' + m.totalPullRequests + ' | Issues: ' + m.totalIssues,
          'Active Days: ' + m.uniqueActiveDays + '/' + m.eligibleCalendarDays + ' (' + m.activityPercentage + '%)'
        ]
      };
    });
    Charts.renderLineTrendChart($('chart-yearly-line'), yPoints, {
      emptyTitle: 'No yearly trend data for ' + (yearly.year || state.year),
      emptySub: 'Historical commits, PRs, and issues will plot across Jan\u2013Dec.'
    });

    // 4. Commits vs Pull Requests Chart (Responds dynamically to Monthly / Quarterly / Half-Yearly / Yearly filter)
    var seriesSource = state.period === 'monthly'
      ? buildWeeklyBucketsFromMonth(monthly.dailyBreakdown || [])
      : (state.period === 'half-yearly'
        ? (halfYearly.monthBreakdown || [])
        : (state.period === 'quarterly' ? (quarterly.monthBreakdown || []) : (yearly.monthBreakdown || [])));
    Charts.renderGroupedBarChart(
      $('chart-commits-prs'),
      seriesSource,
      [
        { key: 'commits', label: 'Commits', color: '#22d3ee' },
        { key: 'prsCreated', label: 'PRs Created', color: '#6366f1' },
        { key: 'prsMerged', label: 'PRs Merged', color: '#22c55e' }
      ],
      {
        emptyTitle: 'No commit or PR activity in selected range',
        emptySub: 'Sync GitHub or select another period to compare commits against pull requests.'
      }
    );

    // 5. Issues Opened vs Closed Chart
    Charts.renderGroupedBarChart(
      $('chart-issues-io'),
      seriesSource,
      [
        { key: 'issuesOpened', label: 'Issues Opened', color: '#f59e0b' },
        { key: 'issuesClosed', label: 'Issues Closed', color: '#10b981' },
        { key: 'reviews', label: 'PR Reviews', color: '#a855f7' }
      ],
      {
        emptyTitle: 'No issue or review activity in selected range',
        emptySub: 'Opened/closed issues and code reviews in the selected range appear here.'
      }
    );

    // 6. GitHub Contribution Heatmap
    var hSub = $('chart-heatmap-sub');
    if (hSub && heatmap) {
      hSub.textContent = heatmap.year + ' \u2022 ' + heatmap.totalContributions + ' contributions \u2022 ' + heatmap.activeDays + ' active days';
    }
    Charts.renderHeatmap($('chart-heatmap'), heatmap);

    // 7. Repository-wise Activity & Repository Distribution Doughnut
    var activeReposList = Array.isArray(payload.periodRepositories)
      ? payload.periodRepositories
      : (repos.repositories || []);
    var repoScopeLabel = payload.customRange
      ? (payload.customRange.fromDate + ' to ' + payload.customRange.toDate)
      : (report.periodLabel || 'selected period');
    var repoSubEl = $('chart-repo-sub');
    if (repoSubEl) {
      repoSubEl.textContent = repoScopeLabel + ' \u2022 ' + activeReposList.length + ' active repo' + (activeReposList.length === 1 ? '' : 's');
    }

    var repoRows = activeReposList.slice(0, 8).map(function (r) {
      return {
        label: r.repoName,
        badge: r.isPrivate ? 'Private' : (r.language && r.language !== 'Unknown' ? r.language : ''),
        value: r.totalContributions,
        valueText: r.totalContributions + ' (' + r.points + ' pts)',
        color: r.isPrivate ? 'linear-gradient(90deg, #7c3aed, #a855f7)' : 'linear-gradient(90deg, #4338ca, #22d3ee)',
        sub: 'Commits: ' + r.commits + ' \u2022 PRs: ' + (r.prsCreated + r.prsMerged) + ' \u2022 Issues: ' + (r.issuesOpened + r.issuesClosed) + ' \u2022 Reviews: ' + r.reviews,
        tipTitle: r.repoName,
        tipLines: [
          'Total Contributions: ' + r.totalContributions + ' (' + r.points + ' pts)',
          'Commits: ' + r.commits + ' | PRs Created: ' + r.prsCreated + ' | Merged: ' + r.prsMerged,
          'Issues Opened: ' + r.issuesOpened + ' | Closed: ' + r.issuesClosed + ' | Reviews: ' + r.reviews
        ]
      };
    });
    Charts.renderHorizontalBarChart($('chart-repo-breakdown'), repoRows, {
      emptyTitle: 'No repository contributions tracked in ' + repoScopeLabel,
      emptySub: 'Push commits or open PRs/issues in connected repositories, or widen your filter.'
    });

    if ($('chart-repo-donut') && Charts.renderDoughnutChart) {
      var repoTotalContribs = activeReposList.reduce(function (s, r) { return s + (Number(r.totalContributions) || 0); }, 0);
      var repoDonutSegments = activeReposList.slice(0, 8).map(function (r) {
        var count = Number(r.totalContributions) || 0;
        var pct = repoTotalContribs > 0 ? Math.round((count / repoTotalContribs) * 1000) / 10 : 0;
        return {
          label: r.repoName,
          count: count,
          percentage: pct,
          tooltipTitle: r.repoName,
          tooltipLines: [
            count + ' contributions (' + pct + '%) \u2022 ' + (r.points || 0) + ' pts',
            'Commits: ' + (r.commits || 0) + ' | PRs: ' + ((r.prsCreated || 0) + (r.prsMerged || 0))
          ]
        };
      });
      Charts.renderDoughnutChart($('chart-repo-donut'), repoDonutSegments, {
        centerCount: activeReposList.length,
        centerSubLabel: 'repos',
        countUnitSingular: 'contribution',
        countUnitPlural: 'contributions',
        emptyTitle: 'No repository distribution for ' + repoScopeLabel,
        emptySub: 'Verified commits, PRs, issues, or reviews per repository will distribute here.'
      });
    }

    renderRepositoryActivityTable(activeReposList, repoScopeLabel);

    // 8. Activity Percentage Gauge + 5-Period Matrix
    var activePctSlice = state.period === 'yearly'
      ? pctSummary.yearly
      : (state.period === 'half-yearly'
        ? pctSummary.halfYearly
        : (state.period === 'quarterly' ? pctSummary.quarterly : pctSummary.monthly));
    Charts.renderGaugeChart($('chart-activity-gauge'), activePctSlice);
    renderActivityPercentagesGrid(pctSummary);

    // 9. Monthly Productivity Growth Chart (MoM delta across selected year)
    var growthItems = (yearly.monthBreakdown || []).map(function (m) {
      var g = m.growthFromPreviousMonth;
      return {
        label: m.label,
        current: m.totalContributions,
        previous: g ? g.previous : 0,
        percentageChange: g ? g.percentageChange : (m.totalContributions > 0 ? null : 0),
        displayText: g ? g.displayText : (m.totalContributions + ' baseline')
      };
    });
    Charts.renderGrowthDeltaChart($('chart-monthly-growth'), growthItems, {
      emptyTitle: 'No month-over-month growth data yet',
      emptySub: 'Multi-month contribution deltas for ' + (yearly.year || state.year) + ' render here.'
    });

    // 10. Contribution Streak History
    Charts.renderStreakHistory($('chart-streak-history'), payload.streak);

    // 11. Developer Leaderboard Chart
    renderLeaderboardChart(payload.leaderboard);

    // 12. Programming Language Distribution Donut
    Charts.renderLanguageDonut($('chart-lang-donut'), repos.languageDistribution || []);

    // Executive Productivity Report
    renderProductivityReport(report);
  }

  function renderLeaderboardChart(lb) {
    var Charts = global.DevNexusCharts;
    if (!Charts) return;
    var rows = ((lb && lb.contributors) || []).slice(0, 8).map(function (c) {
      return {
        label: '#' + c.rank + ' @' + c.username,
        badge: Number(c.currentStreak || 0) > 0 ? c.currentStreak + 'd streak' : '',
        value: c.totalPoints || c.score || 0,
        valueText: (c.totalPoints || 0) + ' pts',
        color: c.rank === 1 ? 'linear-gradient(90deg, #f59e0b, #fbbf24)' : 'linear-gradient(90deg, #4f46e5, #22d3ee)',
        sub: (c.activityPercentage || 0) + '% active \u2022 ' + (c.commitsCount || 0) + ' commits \u2022 ' + (c.prsCreated || 0) + ' PRs \u2022 ' + (c.reviewsCount || 0) + ' reviews',
        tipTitle: '@' + c.username + ' (Rank #' + c.rank + ')',
        tipLines: [
          'Points: ' + (c.totalPoints || 0) + ' | Activity: ' + (c.activityPercentage || 0) + '% (' + (c.activeDays || 0) + '/' + (c.eligibleDays || 0) + 'd)',
          'Commits: ' + (c.commitsCount || 0) + ' | PRs Merged: ' + (c.prsMerged || 0) + ' | Issues Resolved: ' + (c.issuesResolved || 0)
        ]
      };
    });
    Charts.renderHorizontalBarChart($('chart-leaderboard-mini'), rows, {
      emptyTitle: 'No verified contributors on leaderboard yet',
      emptySub: 'Synchronize GitHub activity to appear on the DevNexus rankings.'
    });
  }

  async function refreshLeaderboardOnly() {
    try {
      var res = await fetch('/api/analytics/leaderboard?time=' + encodeURIComponent(state.leaderboardTime), {
        headers: { 'Accept': 'application/json' }
      });
      var data = await res.json();
      if (data && data.success) {
        renderLeaderboardChart(data);
      }
    } catch (err) {
      // ignore quietly on mini filter
    }
  }

  async function loadAnalytics() {
    toggleFilterPickers();
    setLoading(true);
    showError('');

    var params = new URLSearchParams({
      period: state.period,
      year: String(state.year),
      month: String(state.month),
      quarter: String(state.quarter),
      half: String(state.half),
      leaderboardTime: state.leaderboardTime
    });
    if (state.fromDate) params.set('from', state.fromDate);
    if (state.toDate) params.set('to', state.toDate);

    try {
      var res = await fetch('/api/analytics/summary?' + params.toString(), {
        headers: { 'Accept': 'application/json' }
      });
      var data = await res.json();
      setLoading(false);
      if (!res.ok || !data || !data.success) {
        showError((data && data.message) || 'Could not load developer analytics.');
        return;
      }
      renderAllVisualizations(data);
    } catch (err) {
      setLoading(false);
      showError('Unable to fetch developer analytics right now.');
    }
  }

  function wireControls() {
    var periodBtns = root.querySelectorAll('.dn-period-btn');
    periodBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.period = btn.dataset.period || 'monthly';
        periodBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        loadAnalytics();
      });
    });

    var ySel = $('analytics-year-select');
    var mSel = $('analytics-month-select');
    var qSel = $('analytics-quarter-select');
    var hSel = $('analytics-half-select');
    var lbSel = $('analytics-lb-time-select');
    var fromInput = $('analytics-from-date');
    var toInput = $('analytics-to-date');
    var resetBtn = $('analytics-reset-filters-btn');

    if (fromInput) {
      fromInput.addEventListener('change', function () {
        state.fromDate = fromInput.value || '';
        loadAnalytics();
      });
    }
    if (toInput) {
      toInput.addEventListener('change', function () {
        state.toDate = toInput.value || '';
        loadAnalytics();
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        var d = new Date();
        state.period = 'monthly';
        state.year = d.getUTCFullYear();
        state.month = d.getUTCMonth() + 1;
        state.quarter = Math.floor(d.getUTCMonth() / 3) + 1;
        state.half = d.getUTCMonth() < 6 ? 1 : 2;
        state.fromDate = '';
        state.toDate = '';
        if (ySel) ySel.value = String(state.year);
        if (mSel) mSel.value = String(state.month);
        if (qSel) qSel.value = String(state.quarter);
        if (hSel) hSel.value = String(state.half);
        if (fromInput) fromInput.value = '';
        if (toInput) toInput.value = '';
        periodBtns.forEach(function (b) { b.classList.toggle('active', b.dataset.period === 'monthly'); });
        loadAnalytics();
      });
    }

    if (ySel) {
      ySel.value = String(state.year);
      ySel.addEventListener('change', function () {
        state.year = parseInt(ySel.value, 10) || state.year;
        loadAnalytics();
      });
    }
    if (mSel) {
      mSel.value = String(state.month);
      mSel.addEventListener('change', function () {
        state.month = parseInt(mSel.value, 10) || state.month;
        loadAnalytics();
      });
    }
    if (qSel) {
      qSel.value = String(state.quarter);
      qSel.addEventListener('change', function () {
        state.quarter = parseInt(qSel.value, 10) || state.quarter;
        loadAnalytics();
      });
    }
    if (hSel) {
      hSel.value = String(state.half);
      hSel.addEventListener('change', function () {
        state.half = parseInt(hSel.value, 10) || state.half;
        loadAnalytics();
      });
    }
    if (lbSel) {
      lbSel.addEventListener('change', function () {
        state.leaderboardTime = lbSel.value || 'all-time';
        refreshLeaderboardOnly();
      });
    }

    var exportBtn = $('analytics-export-report-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        if (!state.lastPayload || !state.lastPayload.report) return;
        var jsonStr = JSON.stringify(state.lastPayload.report, null, 2);
        var blob = new Blob([jsonStr], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'devnexus-productivity-report-' + state.period + '-' + state.year + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      });
    }
  }

  wireControls();
  loadAnalytics();

  global.DevNexusAnalytics = {
    refresh: loadAnalytics
  };
})(window);
