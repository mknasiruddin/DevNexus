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

  // Theme switcher
  var themeToggle = $('#theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      var nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', nextTheme);
      try { localStorage.setItem('theme', nextTheme); } catch (e) {}
    });
  }

  // Mobile menu
  var burger = $('#burger');
  var mobilePanel = $('#mobile-panel');
  if (burger && mobilePanel) {
    burger.addEventListener('click', function () {
      mobilePanel.classList.toggle('open');
    });
  }

  // Keyboard shortcut '/'
  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement || {}).tagName;
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      var s = $('#nav-search') || $('input[name="q"]');
      if (s) { e.preventDefault(); s.focus(); }
    }
  });

  // Persistent Database Bookmarking
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

        // Update counts across the dashboard
        var counts = ['#sidebar-bookmark-count', '#stats-bookmark-count', '#tab-bookmark-count'];
        counts.forEach(function (sel) {
          var el = $(sel);
          if (el) el.textContent = data.count;
        });
      } else {
        showToast(data.error || 'Failed to update bookmark.');
      }
    } catch (err) {
      btn.disabled = false;
      showToast('Network error while saving bookmark.');
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
      var firstTab = $('.tab-btn');
      if (firstTab) firstTab.classList.add('active');
    });
  }

})();
