/* DevNexus – Portfolio Page Client-Side JS */

/**
 * Copy the current portfolio URL to the clipboard and show a toast.
 */
function copyPortfolioLink() {
  const url = window.location.href;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => showToast('Portfolio link copied! 🔗', 'success'))
      .catch(() => _fallbackCopy(url));
  } else {
    _fallbackCopy(url);
  }
}

function _fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Portfolio link copied! 🔗', 'success');
  } catch (err) {
    showToast('Could not copy link.', 'error');
  }
  document.body.removeChild(ta);
}

/**
 * Show the #toast element with a message for 3 seconds.
 * @param {string} message
 * @param {'success'|'error'} type
 */
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  // Reset classes
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.display = 'flex';

  // Add type class
  if (type === 'success') toast.classList.add('success');
  else if (type === 'error') toast.classList.add('error');

  // Trigger transition
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });

  // Auto-hide after 3s
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, 3000);
}

/**
 * Open the portfolio edit modal.
 */
function openEditModal() {
  const modal = document.getElementById('editModal');
  if (!modal) return;
  modal.style.display = 'flex';
  // Focus first input for accessibility
  const firstInput = modal.querySelector('input');
  if (firstInput) setTimeout(() => firstInput.focus(), 50);
}

/**
 * Close the portfolio edit modal.
 */
function closeEditModal() {
  const modal = document.getElementById('editModal');
  if (!modal) return;
  modal.style.display = 'none';
}

/**
 * Sync portfolio data fresh from GitHub.
 */
async function syncWithGitHub() {
  showToast('Syncing with GitHub…');
  try {
    const res = await fetch('/portfolio/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const json = await res.json();
    if (json.success) {
      showToast('Synced with GitHub! ✅', 'success');
      setTimeout(() => location.reload(), 1000);
    } else {
      showToast(json.message || 'Sync failed.', 'error');
    }
  } catch (err) {
    showToast('Sync failed. Check your connection.', 'error');
  }
}

/* ======================= DOMContentLoaded ======================= */
document.addEventListener('DOMContentLoaded', () => {

  /* -- Edit Portfolio Form submit -- */
  const form = document.getElementById('editPortfolioForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
      }

      try {
        const data = Object.fromEntries(new FormData(form));
        const res = await fetch('/portfolio/api/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const json = await res.json();
        if (json.success) {
          closeEditModal();
          showToast('Portfolio updated! ✅', 'success');
          setTimeout(() => location.reload(), 1000);
        } else {
          showToast(json.message || 'Failed to save changes.', 'error');
        }
      } catch (err) {
        showToast('Network error. Please try again.', 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Save Changes';
        }
      }
    });
  }

  /* -- Close modal when clicking the backdrop -- */
  const modal = document.getElementById('editModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeEditModal();
    });
  }

  /* -- Close modal on Escape key -- */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditModal();
  });

});
