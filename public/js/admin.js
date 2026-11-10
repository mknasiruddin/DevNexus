/**
 * DevNexus Admin Dashboard Client-side Controller
 * Integrates real SQLite database updates for user role modification and account suspension.
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

  // Filter users table
  var userSearchInput = $('#admin-user-search');
  var userRows = $$('.user-table-row');
  if (userSearchInput) {
    userSearchInput.addEventListener('input', function (e) {
      var query = e.target.value.toLowerCase().trim();
      userRows.forEach(function (row) {
        var text = row.textContent.toLowerCase();
        row.style.display = (!query || text.indexOf(query) !== -1) ? '' : 'none';
      });
    });
  }

  // Real Database Role Update
  document.addEventListener('change', async function (e) {
    var select = e.target.closest('.user-role-select');
    if (!select) return;

    var userId = select.dataset.userId;
    var newRole = select.value;

    try {
      select.disabled = true;
      var res = await fetch('/admin/users/' + userId + '/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ role: newRole })
      });
      var data = await res.json();
      select.disabled = false;

      if (data.success) {
        showToast('Role updated to ' + newRole + ' in SQLite database.');
      } else {
        showToast(data.error || 'Failed to update role.');
      }
    } catch (err) {
      select.disabled = false;
      showToast('Network error while updating user role.');
    }
  });

  // Real Database Status Toggle (Active / Suspended)
  document.addEventListener('click', async function (e) {
    var btn = e.target.closest('.user-toggle-btn');
    if (!btn) return;
    e.preventDefault();

    var userId = btn.dataset.userId;
    var row = btn.closest('tr');
    var badge = row.querySelector('.user-status-badge');

    try {
      btn.disabled = true;
      var res = await fetch('/admin/users/' + userId + '/toggle-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      });
      var data = await res.json();
      btn.disabled = false;

      if (data.success) {
        if (data.status === 'active') {
          badge.className = 'status-badge user-status-badge active';
          badge.innerHTML = '&bull; active';
          btn.textContent = 'Suspend';
          showToast('User account activated in SQLite database.');
        } else {
          badge.className = 'status-badge user-status-badge pending';
          badge.innerHTML = '&bull; suspended';
          btn.textContent = 'Activate';
          showToast('User account suspended in SQLite database.');
        }
      } else {
        showToast(data.error || 'Failed to toggle status.');
      }
    } catch (err) {
      btn.disabled = false;
      showToast('Network error while updating status.');
    }
  });

})();
