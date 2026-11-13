/* DevNexus — Skill Tree Client-Side JS */

'use strict';

let currentNodeId = null;

/**
 * Opens the node inspector side panel for the clicked skill node.
 * @param {HTMLElement} el - The .skill-node element that was clicked.
 */
function openNodeInspector(el) {
  currentNodeId = el.dataset.nodeId;

  document.getElementById('inspectorTitle').textContent = el.dataset.nodeTitle;
  document.getElementById('inspectorIcon').textContent = el.querySelector('.node-icon').textContent;
  document.getElementById('inspectorTrack').textContent = el.dataset.nodeTrack;
  document.getElementById('inspectorTier').textContent = 'Tier ' + el.dataset.nodeTier;
  document.getElementById('inspectorDesc').textContent = el.dataset.nodeDesc || 'No description available.';
  document.getElementById('inspectorXP').textContent = el.dataset.nodeXp + ' XP';

  const status = el.dataset.nodeStatus;
  const statusEl = document.getElementById('inspectorStatus');
  statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  statusEl.className = 'inspector-status status-' + status;

  const unlockBtn = document.getElementById('unlockBtn');
  unlockBtn.style.display = status === 'available' ? 'block' : 'none';
  unlockBtn.disabled = false;
  unlockBtn.textContent = '🔓 Unlock Skill';

  const msgEl = document.getElementById('unlockMsg');
  msgEl.style.display = 'none';
  msgEl.textContent = '';
  msgEl.className = 'unlock-msg';

  const inspector = document.getElementById('nodeInspector');
  const backdrop = document.getElementById('inspectorBackdrop');
  inspector.style.display = 'flex';
  backdrop.style.display = 'block';

  // Trap focus into inspector
  inspector.focus();
}

/**
 * Closes the node inspector side panel.
 */
function closeInspector() {
  document.getElementById('nodeInspector').style.display = 'none';
  document.getElementById('inspectorBackdrop').style.display = 'none';
  currentNodeId = null;
}

/**
 * Sends an unlock request for the currently inspected node.
 */
async function unlockNode() {
  if (!currentNodeId) return;

  const btn = document.getElementById('unlockBtn');
  btn.disabled = true;
  btn.textContent = 'Unlocking…';

  try {
    const res = await fetch('/api/skill-tree/unlock/' + encodeURIComponent(currentNodeId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    let json;
    try {
      json = await res.json();
    } catch (_) {
      json = { success: false, error: 'Invalid server response.' };
    }

    const msgEl = document.getElementById('unlockMsg');
    msgEl.style.display = 'block';

    if (json.success) {
      msgEl.textContent = '🎉 Skill unlocked! +' + (json.xpEarned || 0) + ' XP';
      msgEl.className = 'unlock-msg unlock-success';
      btn.style.display = 'none';

      // Optimistically update the node card in the grid
      const nodeEl = document.querySelector('[data-node-id="' + currentNodeId + '"]');
      if (nodeEl) {
        nodeEl.classList.remove('node-available');
        nodeEl.classList.add('node-unlocked');
        nodeEl.dataset.nodeStatus = 'unlocked';

        // Remove the pulse ring if present
        const ring = nodeEl.querySelector('.node-pulse-ring');
        if (ring) ring.remove();

        // Add the check badge if not already there
        if (!nodeEl.querySelector('.node-badge-check')) {
          const check = document.createElement('div');
          check.className = 'node-badge-check';
          check.setAttribute('aria-label', 'Unlocked');
          check.textContent = '✓';
          nodeEl.appendChild(check);
        }

        // Update connector above this node if it exists
        _updateConnectorBefore(nodeEl);
      }

      // Reload after a short delay so XP counters refresh
      setTimeout(function() { location.reload(); }, 1500);

    } else {
      msgEl.textContent = '❌ ' + (json.error || 'Could not unlock this skill.');
      msgEl.className = 'unlock-msg unlock-error';
      btn.disabled = false;
      btn.textContent = '🔓 Unlock Skill';
    }

  } catch (err) {
    const msgEl = document.getElementById('unlockMsg');
    msgEl.textContent = '❌ Network error. Please try again.';
    msgEl.style.display = 'block';
    msgEl.className = 'unlock-msg unlock-error';
    btn.disabled = false;
    btn.textContent = '🔓 Unlock Skill';
  }
}

/**
 * Finds and updates the connector element directly preceding a node element
 * to show it as 'unlocked' (solid line) rather than available/locked.
 * @param {HTMLElement} nodeEl
 */
function _updateConnectorBefore(nodeEl) {
  const prev = nodeEl.previousElementSibling;
  if (prev && prev.classList.contains('node-connector')) {
    prev.classList.remove('connector-available', 'connector-locked');
    prev.classList.add('connector-unlocked');
  }
}

// Close inspector on Escape key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const inspector = document.getElementById('nodeInspector');
    if (inspector && inspector.style.display !== 'none') {
      closeInspector();
    }
  }
});

// Allow Enter/Space on keyboard-focused nodes
document.addEventListener('keydown', function(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('skill-node')) {
    e.preventDefault();
    openNodeInspector(e.target);
  }
});
