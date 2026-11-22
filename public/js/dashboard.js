/**
 * DevNexus Developer Dashboard Client-side Controller
 * Integrates live GitHub issue interactions with persistent SQLite database bookmarking.
 */

(function () {
  'use strict';

  function $(s, ctx) { return (ctx || document).querySelector(s); }
  function $$(s, ctx) { return Array.from((ctx || document).querySelectorAll(s)); }

  // Toast notifications
  var toastEl = $('#toast');
  var toastMsg = $('#toast-msg');
  var toastTimer = null;

  function showToast(msg) {
    if (!toastEl || !toastMsg) return;
    toastMsg.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2800);
  }

  // Fallback theme & mobile menu listeners if not already initialized by dashboard-nav partial
  if (!window.__devnexusNavInit) {
    window.__devnexusNavInit = true;
    var themeToggle = $('#theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', function () {
        var currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        var nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', nextTheme);
        try { localStorage.setItem('theme', nextTheme); } catch (e) {}
      });
    }

    var burger = $('#burger');
    var mobilePanel = $('#mobile-panel');
    if (burger && mobilePanel) {
      burger.addEventListener('click', function () {
        var open = mobilePanel.classList.toggle('open');
        burger.setAttribute('aria-expanded', String(open));
      });
    }
  }

  function updateBookmarkCounts(count) {
    var counts = ['#sidebar-bookmark-count', '#stats-bookmark-count', '#tab-bookmark-count', '#saved-bookmarks-heading-count'];
    counts.forEach(function (sel) {
      var el = $(sel);
      if (el) el.textContent = count;
    });
  }

  // Persistent Database Bookmarking (Issue list ribbon buttons)
  document.addEventListener('click', async function (e) {
    var btn = e.target.closest('.bookmark-btn');
    if (!btn) return;
    e.preventDefault();

    var isBookmarked = btn.classList.contains('active');
    var issueData = {
      issue_id: btn.dataset.issueId,
      issue_number: btn.dataset.number,
      repo_name: btn.dataset.repo,
      title: btn.dataset.title,
      html_url: btn.dataset.htmlUrl,
      difficulty: btn.dataset.difficulty,
      comments_count: btn.dataset.comments
    };

    var endpoint = '/dashboard/api/bookmarks';
    var method = isBookmarked ? 'DELETE' : 'POST';

    try {
      btn.disabled = true;
      var res = await fetch(endpoint, {
        method: method,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(issueData)
      });

      var data = await res.json();
      btn.disabled = false;

      if (data.success) {
        if (isBookmarked) {
          btn.classList.remove('active');
          btn.setAttribute('aria-pressed', 'false');
          showToast('Bookmark removed from SQLite database.');
        } else {
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
          showToast('Saved to persistent SQLite database.');
        }
        updateBookmarkCounts(data.count);
      } else {
        showToast(data.error || 'Failed to update bookmark.');
      }
    } catch (err) {
      btn.disabled = false;
      showToast('Network error while saving bookmark.');
    }
  });

  // Remove Bookmark directly from the Saved Bookmarks container
  document.addEventListener('click', async function (e) {
    var removeBtn = e.target.closest('.remove-saved-bookmark-btn');
    if (!removeBtn) return;
    e.preventDefault();

    var htmlUrl = removeBtn.dataset.htmlUrl;
    if (!htmlUrl) return;

    try {
      removeBtn.disabled = true;
      var res = await fetch('/dashboard/api/bookmarks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ html_url: htmlUrl })
      });
      var data = await res.json();
      removeBtn.disabled = false;

      if (data.success) {
        var row = removeBtn.closest('.issue-row');
        if (row) row.remove();
        updateBookmarkCounts(data.count);

        // Also update corresponding ribbon button in the discovery list if visible
        $$('.bookmark-btn').forEach(function (b) {
          if (b.dataset.htmlUrl === htmlUrl) {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
          }
        });

        showToast('Bookmark removed from SQLite database.');
      } else {
        showToast(data.error || 'Failed to remove bookmark.');
      }
    } catch (err) {
      removeBtn.disabled = false;
      showToast('Network error while removing bookmark.');
    }
  });

  // Toggle View Bookmarks Tab
  var bookmarksTabBtn = $('#view-bookmarks-tab');
  var issuesContainer = $('#issues-list-container');
  var bookmarksContainer = $('#bookmarks-view-container');
  var closeBookmarksBtn = $('#close-bookmarks-view');

  if (bookmarksTabBtn && issuesContainer && bookmarksContainer) {
    bookmarksTabBtn.addEventListener('click', function () {
      $$('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      bookmarksTabBtn.classList.add('active');
      issuesContainer.style.display = 'none';
      bookmarksContainer.style.display = 'block';
    });
  }

  if (closeBookmarksBtn && issuesContainer && bookmarksContainer) {
    closeBookmarksBtn.addEventListener('click', function () {
      bookmarksContainer.style.display = 'none';
      issuesContainer.style.display = 'block';
      $$('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      var firstTab = $('.tab-btn');
      if (firstTab) firstTab.classList.add('active');
    });
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderLanguageDistribution(langDist) {
    var container = $('#sync-language-dist');
    if (!container) return;
    if (!Array.isArray(langDist) || langDist.length === 0) {
      container.innerHTML = '<div style="font-size:12px; font-weight:600; color:var(--muted); margin-bottom:8px;">Repository Language Distribution</div>' +
        '<div style="font-size:12.5px; color:var(--muted);">No detected programming languages in synced repositories yet.</div>';
      return;
    }

    var bars = langDist.map(function (item) {
      var w = Math.max(2, Number(item.percentage) || 0);
      var color = escapeHtml(item.color || '#818CF8');
      var lang = escapeHtml(item.language);
      var cnt = Number(item.count) || 0;
      return '<div style="width:' + w + '%; background-color:' + color + ';" title="' + lang + ': ' + w + '% (' + cnt + ' repos)"></div>';
    }).join('');

    var legend = langDist.map(function (item) {
      var color = escapeHtml(item.color || '#818CF8');
      var lang = escapeHtml(item.language);
      var pct = Number(item.percentage) || 0;
      var cnt = Number(item.count) || 0;
      return '<span style="display:inline-flex; align-items:center; gap:6px;">' +
        '<span style="width:8px; height:8px; border-radius:50%; background-color:' + color + ';"></span>' +
        '<strong style="color:var(--text);">' + lang + '</strong> ' + pct + '% (' + cnt + ')' +
        '</span>';
    }).join('');

    container.innerHTML =
      '<div style="font-size:12px; font-weight:600; color:var(--muted); margin-bottom:8px;">Repository Language Distribution</div>' +
      '<div style="display:flex; height:8px; border-radius:999px; overflow:hidden; background:var(--bg); border:1px solid var(--border); margin-bottom:10px;">' + bars + '</div>' +
      '<div style="display:flex; gap:12px; flex-wrap:wrap; font-size:12px; color:var(--muted);">' + legend + '</div>';
  }

  function renderSyncedRepos(repos) {
    var body = $('#synced-repos-body');
    if (!body) return;
    if (!Array.isArray(repos) || repos.length === 0) {
      body.innerHTML = '<p style="color:var(--muted); font-size:13.5px;">No repositories available for this account.</p>';
      return;
    }

    var cards = repos.map(function (r) {
      var privatePill = r.isPrivate
        ? '<span style="font-size:10.5px; padding:2px 6px; border-radius:4px; border:1px solid var(--border); color:var(--muted);">Private</span>'
        : '';
      var healthBlock = r.health
        ? '<div style="font-size:11.5px; color:var(--muted); display:flex; align-items:center; justify-content:space-between; background:var(--bg); padding:5px 9px; border-radius:6px; border:1px solid var(--border);">' +
          '<span>Repo Health: <strong style="color:var(--text);">' + Number(r.health.score || 0) + '/100</strong></span>' +
          '<span style="color:var(--accent-text); font-weight:600;">' + escapeHtml(r.health.statusLabel) + '</span>' +
          '</div>'
        : '';
      var dateStr = '';
      if (r.pushedAt || r.updatedAt) {
        try {
          dateStr = ' &bull; ' + escapeHtml(new Date(r.pushedAt || r.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        } catch (e) {}
      }

      return '<article class="repo-card">' +
        '<div class="repo-card-head">' +
          '<a href="' + escapeHtml(r.htmlUrl) + '" target="_blank" rel="noopener noreferrer" class="repo-card-title">' + escapeHtml(r.name) + '</a>' +
          '<div style="display:flex; align-items:center; gap:6px;">' + privatePill + '<span>★ ' + Number(r.stars || 0) + '</span></div>' +
        '</div>' +
        '<p class="repo-card-desc">' + escapeHtml(r.description || 'No description provided.') + '</p>' +
        healthBlock +
        '<div class="repo-card-foot" style="display:flex; justify-content:space-between; align-items:center;">' +
          '<span>' + escapeHtml(r.language || 'Other') + dateStr + '</span>' +
          '<a href="' + escapeHtml(r.htmlUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-outline">View Repo &rarr;</a>' +
        '</div>' +
      '</article>';
    }).join('');

    body.innerHTML = '<div class="repo-grid">' + cards + '</div>';
  }

  function renderSyncedActivities(activities) {
    var body = $('#synced-activity-body');
    if (!body) return;
    if (!Array.isArray(activities) || activities.length === 0) {
      body.innerHTML = '<p style="color:var(--muted); font-size:13.5px;">No activity records found for this filter.</p>';
      return;
    }

    var rows = activities.map(function (act) {
      var iconCls = act.category === 'pr' ? 'merged' : (act.category === 'commit' || act.category === 'repo' ? 'opened' : 'comment');
      var privateBadge = act.isPrivate
        ? '<span style="font-size:10.5px; margin-left:6px; padding:1px 6px; border-radius:4px; border:1px solid var(--border); color:var(--muted);">Private</span>'
        : '';
      var formattedDate = '';
      try {
        formattedDate = new Date(act.eventTimestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } catch (e) {}

      return '<li class="activity-item">' +
        '<div class="activity-icon ' + iconCls + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg></div>' +
        '<div class="activity-content">' +
          '<div class="activity-title">' +
            '<a href="' + escapeHtml(act.targetUrl || act.repoUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--text);">' + escapeHtml(act.title) + '</a>' +
            privateBadge +
          '</div>' +
          '<div class="activity-meta">' +
            '<a href="' + escapeHtml(act.repoUrl) + '" target="_blank" rel="noopener noreferrer" style="color:var(--link);">' + escapeHtml(act.repoName) + '</a> &bull; ' +
            escapeHtml(act.relativeTime || 'recently') +
            (formattedDate ? ' &bull; ' + escapeHtml(formattedDate) : '') +
          '</div>' +
        '</div>' +
      '</li>';
    }).join('');

    body.innerHTML = '<ul class="activity-list">' + rows + '</ul>';
  }

  function renderReadinessScore(rs) {
    if (!rs || typeof rs !== 'object') return;
    var sufficient = Boolean(rs.isSufficientData);
    var scoreNum = Number(rs.score || 0);

    var metricVal = $('#metric-readiness-val');
    if (metricVal) metricVal.textContent = sufficient ? (scoreNum + '%') : '--%';
    var metricSub = $('#metric-readiness-sub');
    if (metricSub) metricSub.textContent = rs.readinessLevel || 'Insufficient Data';

    var rVal = $('#readiness-score-value');
    if (rVal) rVal.innerHTML = (sufficient ? scoreNum : '--') + '<span style="font-size:18px; color:var(--muted);">/100</span>';

    var badge = $('#readiness-level-badge');
    if (badge) {
      badge.className = 'readiness-tier-badge ' + (rs.badgeClass || 'insufficient');
      badge.textContent = rs.readinessLevel || 'Insufficient Data';
    }

    var fill = $('#readiness-progress-fill');
    if (fill) fill.style.width = (sufficient ? scoreNum : 0) + '%';

    var expEl = $('#readiness-exp-tier');
    if (expEl) expEl.textContent = rs.experienceLevel || 'Unconfigured';

    var dataStatusEl = $('#readiness-data-status');
    if (dataStatusEl) {
      var st = rs.dataStatus || 'insufficient';
      dataStatusEl.style.color = st === 'insufficient' ? 'var(--warning)' : (st === 'stale_cached' ? 'var(--warning)' : 'var(--success)');
      dataStatusEl.textContent = 'Data Status: ' + (st === 'insufficient' ? 'Insufficient Data' : (st === 'stale_cached' ? 'Preserved Stale GitHub Cache' : 'Verified Profile & GitHub Data'));
    }

    var factorsList = $('#readiness-factors-list');
    if (factorsList && rs.breakdown) {
      factorsList.innerHTML = Object.keys(rs.breakdown).map(function (k) {
        var f = rs.breakdown[k];
        return '<div class="readiness-factor-card">' +
          '<div class="readiness-factor-top"><span>' + escapeHtml(f.label) + '</span><span style="color:var(--accent-text);">' + Number(f.score || 0) + ' / ' + Number(f.maxScore || 0) + ' pts</span></div>' +
          '<div class="readiness-bar-track" style="height:5px; margin-bottom:6px;"><div class="readiness-bar-fill" style="width:' + Number(f.percentage || 0) + '%;"></div></div>' +
          '<div style="font-size:11.5px; color:var(--muted); line-height:1.4;">' + escapeHtml(f.explanation || '') + '</div>' +
        '</div>';
      }).join('');
    }

    var matchedEl = $('#readiness-matched-skills');
    if (matchedEl) {
      if (Array.isArray(rs.matchedSkills) && rs.matchedSkills.length > 0) {
        matchedEl.innerHTML = rs.matchedSkills.map(function (ms) {
          return '<span class="readiness-skill-pill matched">&#10003; ' + escapeHtml(ms) + '</span>';
        }).join(' ');
      } else if (Array.isArray(rs.verifiedRepoSkills) && rs.verifiedRepoSkills.length > 0) {
        matchedEl.innerHTML = rs.verifiedRepoSkills.map(function (vs) {
          return '<span class="readiness-skill-pill matched">&#10003; ' + escapeHtml(vs) + ' (Repo)</span>';
        }).join(' ');
      } else {
        matchedEl.innerHTML = '<span style="color:var(--muted);">None matched with current repositories/issues yet</span>';
      }
    }

    var missingEl = $('#readiness-missing-skills');
    if (missingEl) {
      if (Array.isArray(rs.missingSkills) && rs.missingSkills.length > 0) {
        missingEl.innerHTML = rs.missingSkills.map(function (mis) {
          return '<span class="readiness-skill-pill missing">+ ' + escapeHtml(mis) + '</span>';
        }).join(' ');
      } else if (rs.dataAvailability && !rs.dataAvailability.hasGithubData) {
        missingEl.innerHTML = '<span style="color:var(--muted);">GitHub data unavailable to detect skill gaps</span>';
      } else {
        missingEl.innerHTML = '<span style="color:var(--success);">No missing skill gaps detected for current scope</span>';
      }
    }

    var sugEl = $('#readiness-suggestions-list');
    if (sugEl && Array.isArray(rs.suggestions)) {
      sugEl.innerHTML = rs.suggestions.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('');
    }

    var accEl = $('#readiness-accounting');
    if (accEl) {
      var src = (rs.dataAvailability && rs.dataAvailability.sourceLabel) || 'Live / Cached';
      accEl.innerHTML = '<strong>Score Accounting:</strong> ' + Number(rs.pointsAwarded != null ? rs.pointsAwarded : scoreNum) + ' pts awarded &bull; ' + Number(rs.pointsDeducted != null ? rs.pointsDeducted : (100 - scoreNum)) + ' pts deducted across 4 factors (' + escapeHtml(src) + ').';
    }

    var unvEl = $('#readiness-unverified');
    if (unvEl) {
      if (Array.isArray(rs.unverifiedData) && rs.unverifiedData.length > 0) {
        unvEl.style.display = 'block';
        unvEl.innerHTML = '<strong>Missing / Unverified Inputs:</strong> ' + escapeHtml(rs.unverifiedData.join(' '));
      } else {
        unvEl.style.display = 'none';
      }
    }

    var ctxBanner = $('#readiness-issue-context');
    var ctxTitle = $('#readiness-issue-title');
    if (ctxBanner && ctxTitle) {
      if (rs.selectedIssue && rs.selectedIssue.title) {
        ctxBanner.style.display = 'flex';
        ctxTitle.textContent = rs.selectedIssue.title;
      } else {
        ctxBanner.style.display = 'none';
        ctxTitle.textContent = '';
      }
    }
  }

  function applySyncStateToUI(data) {
    if (!data || !data.syncState) return;
    var s = data.syncState;
    var lastEl = $('#github-last-synced');
    if (lastEl && s.lastSyncedAt) {
      lastEl.innerHTML = 'Last synchronized: <strong style="color:var(--text);">' + escapeHtml(new Date(s.lastSyncedAt).toLocaleString()) + '</strong> &bull; Counting window: Last ' + Number(s.commitPeriodDays || 90) + ' days';
    }

    var metricPub = $('#metric-public-repos');
    if (metricPub) metricPub.textContent = String(s.publicRepos || 0);

    var metricPubSub = $('#metric-public-repos-sub');
    if (metricPubSub) {
      metricPubSub.textContent = Number(s.totalRepos || 0) + ' total (' + Number(s.privateRepos || 0) + ' private)';
    }

    var reposEl = $('#sync-stat-repos');
    if (reposEl) {
      reposEl.innerHTML = Number(s.totalRepos || 0) + ' <span style="font-size:12px; font-weight:500; color:var(--muted);">(' + Number(s.publicRepos || 0) + ' public, ' + Number(s.privateRepos || 0) + ' private)</span>';
    }
    var commitsEl = $('#sync-stat-commits');
    if (commitsEl) commitsEl.textContent = String(s.totalCommits || 0);

    var prsEl = $('#sync-stat-prs');
    if (prsEl) {
      prsEl.innerHTML = Number(s.prsCreated || 0) + ' <span style="font-size:12px; font-weight:500; color:var(--success);">(' + Number(s.prsMerged || 0) + ' merged)</span>';
    }

    var issuesEl = $('#sync-stat-issues');
    if (issuesEl) {
      issuesEl.innerHTML = Number(s.issuesCreated || 0) + ' <span style="font-size:12px; font-weight:500; color:var(--muted);">(' + Number(s.issuesClosed || 0) + ' closed)</span>';
    }

    var contribsEl = $('#sync-stat-contribs');
    if (contribsEl) contribsEl.textContent = String(s.contributionsCount || 0);

    renderLanguageDistribution(s.languageDistribution);
    if (Array.isArray(data.repos)) renderSyncedRepos(data.repos);
    if (Array.isArray(data.activities)) renderSyncedActivities(data.activities);

    if (data.readinessScore) {
      renderReadinessScore(data.readinessScore);
    }
  }

  function showSyncFeedback(message, tone, showAuthorizeBtn) {
    var box = $('#github-sync-feedback');
    if (!box) return;
    if (!message) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = 'flex';
    box.innerHTML = '<span>' + escapeHtml(message) + '</span>' +
      (showAuthorizeBtn ? '<a href="/auth/github" class="btn btn-sm btn-primary" style="white-space:nowrap;">Authorize Private Repos &rarr;</a>' : '');
    if (tone === 'success') {
      box.style.borderColor = 'var(--success-border)';
      box.style.background = 'var(--success-bg)';
      box.style.color = 'var(--success)';
    } else if (tone === 'warning') {
      box.style.borderColor = 'var(--warning-border)';
      box.style.background = 'var(--warning-bg)';
      box.style.color = 'var(--warning)';
    } else {
      box.style.borderColor = 'var(--danger-border)';
      box.style.background = 'var(--danger-bg)';
      box.style.color = 'var(--danger)';
    }
  }

  // Manual "Sync GitHub" button handler
  var syncBtn = $('#sync-github-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async function () {
      var label = syncBtn.querySelector('.sync-btn-label');
      syncBtn.disabled = true;
      if (label) label.textContent = 'Syncing...';
      showSyncFeedback('', 'warning');

      try {
        var res = await fetch('/dashboard/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ respectCooldown: true })
        });
        var data = await res.json();
        syncBtn.disabled = false;
        if (label) label.textContent = 'Sync GitHub';

        if (data && data.rateLimit && data.rateLimit.limit !== null && data.rateLimit.remaining !== null) {
          var quotaEl = $('#github-quota-status');
          if (quotaEl) {
            var resetText = data.rateLimit.resetAtIso
              ? ' \u2022 resets ' + new Date(data.rateLimit.resetAtIso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
              : '';
            quotaEl.innerHTML = 'GitHub Quota (' + escapeHtml(data.rateLimit.resource || 'core') + '): ' +
              '<strong style="' + (data.rateLimit.remaining === 0 ? 'color:#f85149;' : '') + '">' + Number(data.rateLimit.remaining) + '</strong> / ' +
              Number(data.rateLimit.limit) + escapeHtml(resetText);
          }
        }

        if (data && data.success) {
          applySyncStateToUI(data);
          if (window.DevNexusAnalytics && typeof window.DevNexusAnalytics.refresh === 'function') {
            window.DevNexusAnalytics.refresh();
          }
          var msg = data.message || 'GitHub activity synchronized.';
          if (data.syncState && data.syncState.privateAccessGranted === false && data.syncState.privateAccessNote) {
            showSyncFeedback(data.syncState.privateAccessNote, 'warning', true);
          } else {
            showSyncFeedback(msg, data.cooldownActive ? 'warning' : 'success', false);
          }
          showToast(msg);
        } else {
          if (data && data.syncState) applySyncStateToUI({ syncState: data.syncState });
          var tone = (res.status === 429 || (data && data.rateLimited)) ? 'warning' : 'error';
          showSyncFeedback((data && data.message) || 'GitHub sync failed. Existing synced metrics preserved.', tone);
          showToast((data && data.message) || 'GitHub sync failed.');
        }
      } catch (err) {
        syncBtn.disabled = false;
        if (label) label.textContent = 'Sync GitHub';
        showSyncFeedback('Network error during GitHub synchronization. Cached metrics preserved.', 'error');
        showToast('Network error during GitHub sync.');
      }
    });
  }

  // Activity timeline category filters
  document.addEventListener('click', async function (e) {
    var filterBtn = e.target.closest('.activity-filter-btn');
    if (!filterBtn) return;
    e.preventDefault();

    var category = filterBtn.dataset.category || 'all';
    $$('.activity-filter-btn').forEach(function (b) { b.classList.remove('active'); });
    filterBtn.classList.add('active');

    try {
      var res = await fetch('/dashboard/api/sync/status?activity=' + encodeURIComponent(category), {
        headers: { 'Accept': 'application/json' }
      });
      var data = await res.json();
      if (data && data.success) {
        renderSyncedActivities(data.activities || []);
      }
    } catch (err) {
      showToast('Unable to filter activity timeline.');
    }
  });

  // Issue-specific readiness inspection (recalculates 4-factor breakdown for selected GitHub issue)
  document.addEventListener('click', async function (e) {
    var inspectBtn = e.target.closest('.inspect-issue-readiness-btn');
    var resetBtn = e.target.closest('#reset-issue-readiness-btn');
    if (!inspectBtn && !resetBtn) return;
    e.preventDefault();

    var params = new URLSearchParams();
    if (inspectBtn) {
      if (inspectBtn.dataset.username) params.set('username', inspectBtn.dataset.username);
      if (inspectBtn.dataset.label) params.set('label', inspectBtn.dataset.label);
      if (inspectBtn.dataset.language) params.set('language', inspectBtn.dataset.language);
      if (inspectBtn.dataset.query) params.set('q', inspectBtn.dataset.query);
      if (inspectBtn.dataset.issueUrl) params.set('issueUrl', inspectBtn.dataset.issueUrl);
    } else {
      var searchForm = $('#issue-search-form');
      if (searchForm) {
        var uInput = searchForm.querySelector('input[name="username"]');
        var lInput = searchForm.querySelector('input[name="label"]');
        var qInput = searchForm.querySelector('input[name="q"]');
        var langSel = searchForm.querySelector('select[name="language"]');
        if (uInput && uInput.value) params.set('username', uInput.value);
        if (lInput && lInput.value) params.set('label', lInput.value);
        if (qInput && qInput.value) params.set('q', qInput.value);
        if (langSel && langSel.value) params.set('language', langSel.value);
      }
    }

    try {
      var res = await fetch('/dashboard/api/readiness?' + params.toString(), {
        headers: { 'Accept': 'application/json' }
      });
      var data = await res.json();
      if (data && data.success && data.readiness) {
        renderReadinessScore(data.readiness);
        var card = $('#contribution-readiness-card');
        if (card && inspectBtn) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (err) {
      showToast('Unable to evaluate selected issue readiness right now.');
    }
  });

})();
