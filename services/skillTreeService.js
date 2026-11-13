/**
 * DevNexus Skill Tree Service
 *
 * Implements:
 * 1. SKILL_TREE_GRAPH — static definition of all 16 skill nodes across 4 tracks.
 * 2. evaluateUserSkillTree — calculates XP, determines node status, returns full tree state.
 * 3. claimSkillNode — claims an 'available' node as 'unlocked' for a user.
 */

'use strict';

const {
  getSkillTreeProgress,
  getUserXP,
  upsertUserXP,
  upsertSkillNode,
  getUserRecentActivity,
  getUserRoadmapProgress
} = require('../db/database');

// ---------------------------------------------------------------------------
// SKILL_TREE_GRAPH — static definition
// ---------------------------------------------------------------------------

const SKILL_TREE_GRAPH = [
  // ── Track 1: Frontend Engineering ────────────────────────────────────────
  {
    id: 'fe-1',
    title: 'HTML & CSS Basics',
    track: 'frontend',
    tier: 1,
    xpRequired: 50,
    prerequisites: [],
    criteriaDescription: 'Build web pages with semantic HTML and styled with CSS fundamentals.',
    icon: '🎨'
  },
  {
    id: 'fe-2',
    title: 'Modern JavaScript',
    track: 'frontend',
    tier: 2,
    xpRequired: 150,
    prerequisites: ['fe-1'],
    criteriaDescription: 'Write ES6+ JavaScript with async/await, modules, and DOM manipulation.',
    icon: '🎨'
  },
  {
    id: 'fe-3',
    title: 'UI Frameworks',
    track: 'frontend',
    tier: 3,
    xpRequired: 300,
    prerequisites: ['fe-2'],
    criteriaDescription: 'Build component-based UIs using React, Vue, or a modern frontend framework.',
    icon: '🎨'
  },
  {
    id: 'fe-4',
    title: 'Full-Stack Integration',
    track: 'frontend',
    tier: 4,
    xpRequired: 500,
    prerequisites: ['fe-3', 'be-2'],
    criteriaDescription: 'Integrate frontend with backend APIs — authentication, state management, and data fetching.',
    icon: '🎨'
  },

  // ── Track 2: Backend & APIs ───────────────────────────────────────────────
  {
    id: 'be-1',
    title: 'Server Routing',
    track: 'backend',
    tier: 1,
    xpRequired: 50,
    prerequisites: [],
    criteriaDescription: 'Set up an HTTP server with routing, middleware, and request handling.',
    icon: '⚙️'
  },
  {
    id: 'be-2',
    title: 'RESTful APIs',
    track: 'backend',
    tier: 2,
    xpRequired: 150,
    prerequisites: ['be-1'],
    criteriaDescription: 'Design and implement CRUD REST APIs with proper status codes and validation.',
    icon: '⚙️'
  },
  {
    id: 'be-3',
    title: 'Auth & Security',
    track: 'backend',
    tier: 3,
    xpRequired: 300,
    prerequisites: ['be-2'],
    criteriaDescription: 'Implement JWT/session authentication, OAuth flows, and input sanitisation.',
    icon: '⚙️'
  },
  {
    id: 'be-4',
    title: 'Scalable Architecture',
    track: 'backend',
    tier: 4,
    xpRequired: 500,
    prerequisites: ['be-3'],
    criteriaDescription: 'Build services that handle concurrency, caching, and horizontal scaling.',
    icon: '⚙️'
  },

  // ── Track 3: Database & DevOps ────────────────────────────────────────────
  {
    id: 'db-1',
    title: 'Schema Design',
    track: 'devops',
    tier: 1,
    xpRequired: 50,
    prerequisites: [],
    criteriaDescription: 'Design normalized relational schemas with proper constraints and indices.',
    icon: '🗄️'
  },
  {
    id: 'db-2',
    title: 'Query Optimization',
    track: 'devops',
    tier: 2,
    xpRequired: 150,
    prerequisites: ['db-1'],
    criteriaDescription: 'Write efficient queries using EXPLAIN, indices, and query planning.',
    icon: '🗄️'
  },
  {
    id: 'db-3',
    title: 'Git Workflows',
    track: 'devops',
    tier: 3,
    xpRequired: 300,
    prerequisites: ['db-2'],
    criteriaDescription: 'Use branching strategies, PRs, rebasing, and conflict resolution.',
    icon: '🗄️'
  },
  {
    id: 'db-4',
    title: 'CI/CD & Deployment',
    track: 'devops',
    tier: 4,
    xpRequired: 500,
    prerequisites: ['db-3'],
    criteriaDescription: 'Configure automated pipelines, containerise apps, and deploy to cloud platforms.',
    icon: '🗄️'
  },

  // ── Track 4: Open Source Mastery ─────────────────────────────────────────
  {
    id: 'os-1',
    title: 'First Repo Upload',
    track: 'opensource',
    tier: 1,
    xpRequired: 50,
    prerequisites: [],
    criteriaDescription: 'Publish a public repository with a README and proper licensing.',
    icon: '🌐'
  },
  {
    id: 'os-2',
    title: 'First Pull Request',
    track: 'opensource',
    tier: 2,
    xpRequired: 150,
    prerequisites: ['os-1'],
    criteriaDescription: 'Submit a pull request to an open-source project and get it merged.',
    icon: '🌐'
  },
  {
    id: 'os-3',
    title: 'Code Reviewer',
    track: 'opensource',
    tier: 3,
    xpRequired: 300,
    prerequisites: ['os-2'],
    criteriaDescription: 'Provide constructive code review on at least 5 pull requests.',
    icon: '🌐'
  },
  {
    id: 'os-4',
    title: 'Maintainer',
    track: 'opensource',
    tier: 4,
    xpRequired: 500,
    prerequisites: ['os-3'],
    criteriaDescription: 'Maintain an active open-source project: triage issues, review PRs, publish releases.',
    icon: '🌐'
  }
];

// Map node id -> node definition for quick lookup
const NODE_MAP = Object.fromEntries(SKILL_TREE_GRAPH.map(n => [n.id, n]));

// Track id prefix -> column name in user_xp
const TRACK_XP_COL = {
  frontend:   'frontend_xp',
  backend:    'backend_xp',
  devops:     'devops_xp',
  opensource: 'opensource_xp'
};

// Language sets for XP classification
const FRONTEND_LANGS = new Set(['html', 'css', 'javascript', 'typescript', 'react']);
const BACKEND_LANGS  = new Set(['node', 'python', 'go', 'rust', 'java']);

// ---------------------------------------------------------------------------
// evaluateUserSkillTree
// ---------------------------------------------------------------------------

/**
 * Computes the full skill tree state for a user.
 *
 * @param {number}   userId      - SQLite user id
 * @param {object}   user        - User row from DB (must include bio field)
 * @param {Array}    githubRepos - Array of repo objects from getUserRepositories()
 * @returns {{ nodes, xp, tracks }}
 */
async function evaluateUserSkillTree(userId, user, githubRepos) {
  const repos = Array.isArray(githubRepos) ? githubRepos : [];

  // ── 1. Calculate XP per track ────────────────────────────────────────────

  // frontend_xp: repos whose primary language is in FRONTEND_LANGS × 25, cap 500
  const frontendCount = repos.filter(r => {
    const lang = String(r.language || r.Language || '').toLowerCase();
    return FRONTEND_LANGS.has(lang);
  }).length;
  const frontend_xp = Math.min(frontendCount * 25, 500);

  // backend_xp: repos whose primary language is in BACKEND_LANGS × 25, cap 500
  // "Node" may appear as "JavaScript" in GitHub — also check repo name/topics for "node"
  const backendCount = repos.filter(r => {
    const lang = String(r.language || r.Language || '').toLowerCase();
    return BACKEND_LANGS.has(lang);
  }).length;
  const backend_xp = Math.min(backendCount * 25, 500);

  // devops_xp: bio mentions docker/k8s/CI → +100; completed roadmap steps × 25, cap 500
  const bio = String(user.bio || '').toLowerCase();
  const bioBonus = /docker|kubernetes|k8s|\bci\b|ci\/cd/.test(bio) ? 100 : 0;

  let roadmapProgress = [];
  try {
    roadmapProgress = getUserRoadmapProgress(userId) || [];
  } catch (e) {
    roadmapProgress = [];
  }
  const devops_xp = Math.min(bioBonus + (roadmapProgress.length * 25), 500);

  // opensource_xp: activity_log count × 10, cap 500
  let activityCount = 0;
  try {
    const activityRows = getUserRecentActivity(userId, 1000);
    activityCount = Array.isArray(activityRows) ? activityRows.length : 0;
  } catch (e) {
    activityCount = 0;
  }
  const opensource_xp = Math.min(activityCount * 10, 500);

  const total_xp = frontend_xp + backend_xp + devops_xp + opensource_xp;
  const level = Math.floor(total_xp / 200) + 1;

  const xpData = { total_xp, frontend_xp, backend_xp, devops_xp, opensource_xp, level };

  // ── 2. Persist updated XP ────────────────────────────────────────────────
  upsertUserXP(userId, xpData);

  // ── 3. Load persisted progress ───────────────────────────────────────────
  const progressRows = getSkillTreeProgress(userId);
  const progressMap = Object.fromEntries(progressRows.map(r => [r.node_id, r]));

  // Helper: track XP by track name
  const trackXP = {
    frontend:   frontend_xp,
    backend:    backend_xp,
    devops:     devops_xp,
    opensource: opensource_xp
  };

  // ── 4. Compute status for each node ─────────────────────────────────────
  const nodes = SKILL_TREE_GRAPH.map(node => {
    const persisted = progressMap[node.id];

    // Already unlocked in DB
    if (persisted && persisted.status === 'unlocked') {
      return {
        ...node,
        status: 'unlocked',
        userProgress: persisted
      };
    }

    // Check prerequisites — all must be unlocked
    const prereqsMet = node.prerequisites.every(pid => {
      const p = progressMap[pid];
      return p && p.status === 'unlocked';
    });

    const currentXP = trackXP[node.track] || 0;
    const xpMet = currentXP >= node.xpRequired;

    const status = (prereqsMet && xpMet) ? 'available' : 'locked';

    return {
      ...node,
      status,
      userProgress: persisted || null
    };
  });

  // ── 5. Build track summaries ─────────────────────────────────────────────
  const TRACK_TOTAL = 4; // 4 nodes per track
  const tracks = {
    frontend: {
      xp: frontend_xp,
      level: Math.floor(frontend_xp / 200) + 1,
      unlockedCount: nodes.filter(n => n.track === 'frontend' && n.status === 'unlocked').length,
      totalNodes: TRACK_TOTAL
    },
    backend: {
      xp: backend_xp,
      level: Math.floor(backend_xp / 200) + 1,
      unlockedCount: nodes.filter(n => n.track === 'backend' && n.status === 'unlocked').length,
      totalNodes: TRACK_TOTAL
    },
    devops: {
      xp: devops_xp,
      level: Math.floor(devops_xp / 200) + 1,
      unlockedCount: nodes.filter(n => n.track === 'devops' && n.status === 'unlocked').length,
      totalNodes: TRACK_TOTAL
    },
    opensource: {
      xp: opensource_xp,
      level: Math.floor(opensource_xp / 200) + 1,
      unlockedCount: nodes.filter(n => n.track === 'opensource' && n.status === 'unlocked').length,
      totalNodes: TRACK_TOTAL
    }
  };

  return { nodes, xp: xpData, tracks };
}

// ---------------------------------------------------------------------------
// claimSkillNode
// ---------------------------------------------------------------------------

/**
 * Claims an 'available' skill node as 'unlocked' for a user.
 *
 * @param {number} userId       - SQLite user id
 * @param {string} nodeId       - Skill node id (e.g. 'fe-1')
 * @param {object} evaluatedTree - Return value of evaluateUserSkillTree()
 * @returns {{ success, node, xpEarned } | { success, error }}
 */
function claimSkillNode(userId, nodeId, evaluatedTree) {
  // Validate nodeId exists in the graph
  const nodeDef = NODE_MAP[nodeId];
  if (!nodeDef) {
    return { success: false, error: `Unknown node id: ${nodeId}` };
  }

  // Find the node in the evaluated tree
  const treeNode = (evaluatedTree.nodes || []).find(n => n.id === nodeId);
  if (!treeNode) {
    return { success: false, error: 'Node not found in evaluated tree' };
  }

  if (treeNode.status !== 'available') {
    return {
      success: false,
      error: `Node '${nodeId}' is not available (status: ${treeNode.status})`
    };
  }

  const xpEarned = nodeDef.xpRequired;
  upsertSkillNode(userId, nodeId, 'unlocked', xpEarned);

  return { success: true, node: nodeDef, xpEarned };
}

module.exports = {
  SKILL_TREE_GRAPH,
  evaluateUserSkillTree,
  claimSkillNode
};
