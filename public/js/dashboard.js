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

})();
