/**
 * DevNexus Assigned Modules Service (Saanvi)
 *
 * Implements:
 * 1. Contribution Readiness Score (transparent rule-based evaluation)
 * 2. Repository Health Score (transparent rule-based evaluation with verified vs. estimated distinction)
 * 3. First Contribution Roadmap (14-stage interactive workflow with SQLite progress tracking)
 *
 * Strictly uses deterministic rule-based calculations and official GitHub REST API metadata.
 * Zero AI or random score generation.
 */

const {
  getUserRoadmapProgress
} = require('../db/database');

// Canonical ecosystem & language skill keywords used to detect required skills in repositories and issues
const KNOWN_TECH_SKILLS = [
  'javascript', 'typescript', 'python', 'java', 'go', 'golang', 'rust',
  'c++', 'c#', 'c', 'ruby', 'php', 'swift', 'kotlin', 'dart',
  'html', 'css', 'react', 'vue', 'angular', 'svelte', 'next.js', 'node.js', 'express',
  'django', 'flask', 'fastapi', 'spring', 'docker', 'kubernetes', 'sql', 'sqlite',
  'postgresql', 'mongodb', 'graphql', 'rest', 'git', 'linux', 'bash', 'shell',
  'markdown', 'documentation', 'docs', 'testing', 'jest', 'pytest'
];

const SKILL_DISPLAY_NAMES = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  golang: 'Go',
  rust: 'Rust',
  'c++': 'C++',
  'c#': 'C#',
  c: 'C',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
  dart: 'Dart',
  html: 'HTML',
  css: 'CSS',
  react: 'React',
  vue: 'Vue',
  angular: 'Angular',
  svelte: 'Svelte',
  'next.js': 'Next.js',
  'node.js': 'Node.js',
  express: 'Express',
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  spring: 'Spring',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  sql: 'SQL',
  sqlite: 'SQLite',
  postgresql: 'PostgreSQL',
  mongodb: 'MongoDB',
  graphql: 'GraphQL',
  rest: 'REST API',
  git: 'Git',
  linux: 'Linux',
  bash: 'Bash',
  shell: 'Shell',
  markdown: 'Markdown',
  documentation: 'Documentation',
  docs: 'Documentation',
  testing: 'Testing',
  jest: 'Jest',
  pytest: 'Pytest'
};

function formatSkillName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const clean = raw.trim();
  const lower = clean.toLowerCase();
  return SKILL_DISPLAY_NAMES[lower] || (clean.charAt(0).toUpperCase() + clean.slice(1));
}

function normalizeSkillList(rawSkills) {
  if (!rawSkills) return [];
  let arr = rawSkills;
  if (typeof rawSkills === 'string') {
    try {
      const parsed = JSON.parse(rawSkills);
      arr = Array.isArray(parsed) ? parsed : rawSkills.split(',');
    } catch (e) {
      arr = rawSkills.split(',');
    }
  }
  if (!Array.isArray(arr)) return [];

  const seen = new Set();
  const normalized = [];
  for (const item of arr) {
    const rawName = typeof item === 'string' ? item : (item && item.name ? item.name : '');
    const trimmed = String(rawName || '').trim().toLowerCase();
    if (!trimmed) continue;
    const canonical = trimmed === 'golang' ? 'go' : trimmed === 'docs' ? 'documentation' : trimmed;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      normalized.push(canonical);
    }
  }
  return normalized;
}

function extractRequiredSkillsFromContext(issues = [], targetContext = null) {
  const detected = new Set();

  const scanTextForSkills = (text) => {
    if (!text || typeof text !== 'string') return;
    const lower = text.toLowerCase();
    for (const skill of KNOWN_TECH_SKILLS) {
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
      if (regex.test(lower)) {
        const canonical = skill === 'golang' ? 'go' : skill === 'docs' ? 'documentation' : skill;
        detected.add(canonical);
      }
    }
  };

  if (targetContext && typeof targetContext === 'object') {
    if (Array.isArray(targetContext.requiredSkills)) {
      for (const s of targetContext.requiredSkills) {
        const norm = String(s || '').trim().toLowerCase();
        if (norm) detected.add(norm === 'golang' ? 'go' : norm === 'docs' ? 'documentation' : norm);
      }
    }
    if (targetContext.language && targetContext.language !== 'all' && targetContext.language !== 'Other') {
      detected.add(String(targetContext.language).trim().toLowerCase());
    }
    if (targetContext.repoLanguage && targetContext.repoLanguage !== 'all' && targetContext.repoLanguage !== 'Other') {
      detected.add(String(targetContext.repoLanguage).trim().toLowerCase());
    }
    scanTextForSkills(targetContext.title);
    scanTextForSkills(targetContext.description || targetContext.body);
    if (Array.isArray(targetContext.labels)) {
      for (const lbl of targetContext.labels) {
        scanTextForSkills(typeof lbl === 'string' ? lbl : lbl?.name);
      }
    }
  }

  const safeIssues = Array.isArray(issues) ? issues : [];
  for (const iss of safeIssues.slice(0, 12)) {
    if (!iss || typeof iss !== 'object') continue;
    if (iss.language && iss.language !== 'Unknown' && iss.language !== 'Other') {
      detected.add(String(iss.language).trim().toLowerCase());
    }
    scanTextForSkills(iss.repoName);
    scanTextForSkills(iss.title);
    scanTextForSkills(iss.body || iss.description);
    if (Array.isArray(iss.labels)) {
      for (const lbl of iss.labels) {
        scanTextForSkills(typeof lbl === 'string' ? lbl : lbl?.name);
      }
    }
  }

  return Array.from(detected);
}

// ---------------------------------------------------------------------------
// MODULE 1: CONTRIBUTION READINESS SCORE
// ---------------------------------------------------------------------------

/**
 * Evaluates a developer's readiness to make an open-source contribution.
 *
 * Scoring Rubric (100 Points Total):
 * 1. Skill Alignment with Repository & Issue Requirements (0 - 35 points)
 *    - Compares developer's declared skills against repository languages, issue labels, and issue descriptions.
 * 2. Developer Profile & Experience Foundation (0 - 25 points)
 *    - Evaluates declared programming skills breadth, experience level ('Beginner', 'Intermediate', 'Advanced'),
 *      and onboarding/profile completeness.
 * 3. Issue Difficulty & Requirement Clarity (0 - 25 points)
 *    - Evaluates issue difficulty vs. developer experience level, presence of clear descriptions/requirements,
 *      and manageable discussion activity.
 * 4. Beginner-Friendly Issue Availability & Workflow Readiness (0 - 15 points)
 *    - Evaluates availability of 'good first issue' / 'help wanted' tasks and First Contribution Roadmap progress.
 */
function calculateContributionReadiness(userProfile = null, issues = [], targetContext = null) {
  const safeUser = userProfile && typeof userProfile === 'object' ? userProfile : {};
  const safeIssues = Array.isArray(issues) ? issues.filter(Boolean) : [];
  const safeContext = targetContext && typeof targetContext === 'object' ? targetContext : {};

  const declaredSkills = normalizeSkillList(safeUser.skills || safeContext.userSkills);
  const rawExp = String(safeUser.experience_level || safeContext.experienceLevel || 'Beginner').trim();
  const experienceLevel = ['Beginner', 'Intermediate', 'Advanced'].includes(rawExp) ? rawExp : 'Beginner';

  const requiredSkills = extractRequiredSkillsFromContext(safeIssues, safeContext);

  const matchedSkillsCanonical = [];
  const missingSkillsCanonical = [];

  for (const reqSkill of requiredSkills) {
    if (declaredSkills.includes(reqSkill)) {
      matchedSkillsCanonical.push(reqSkill);
    } else {
      missingSkillsCanonical.push(reqSkill);
    }
  }

  // Also check if any declared skills match even if requiredSkills was empty
  const matchedSkills = matchedSkillsCanonical.map(formatSkillName);
  const missingSkills = missingSkillsCanonical.slice(0, 6).map(formatSkillName);

  // --- Factor 1: Skill Alignment (Max 35 pts) ---
  let skillAlignmentPoints = 0;
  let skillAlignmentReason = '';
  if (declaredSkills.length === 0) {
    skillAlignmentPoints = 5;
    skillAlignmentReason = 'No programming skills declared yet. Add your languages in Profile/Onboarding to unlock accurate matching.';
  } else if (requiredSkills.length === 0) {
    skillAlignmentPoints = Math.min(28, 16 + (declaredSkills.length * 3));
    skillAlignmentReason = `${declaredSkills.length} declared skill(s) ready (${declaredSkills.slice(0, 4).map(formatSkillName).join(', ')}); no restrictive repository language requirement detected.`;
  } else {
    const ratio = matchedSkillsCanonical.length / requiredSkills.length;
    const baseMatchPts = Math.round(ratio * 27);
    const bonusPts = matchedSkillsCanonical.length >= 2 ? 8 : (matchedSkillsCanonical.length === 1 ? 5 : 0);
    skillAlignmentPoints = Math.min(35, Math.max(6, baseMatchPts + bonusPts));
    skillAlignmentReason = `Matched ${matchedSkillsCanonical.length} of ${requiredSkills.length} detected repository/issue skill requirement(s).`;
  }

  // --- Factor 2: Developer Profile & Experience Foundation (Max 25 pts) ---
  let profileFoundationPoints = 0;
  // Skills count contribution (up to 10 pts)
  if (declaredSkills.length >= 4) profileFoundationPoints += 10;
  else if (declaredSkills.length === 3) profileFoundationPoints += 8;
  else if (declaredSkills.length === 2) profileFoundationPoints += 6;
  else if (declaredSkills.length === 1) profileFoundationPoints += 4;

  // Experience level baseline (up to 10 pts)
  if (experienceLevel === 'Advanced') profileFoundationPoints += 10;
  else if (experienceLevel === 'Intermediate') profileFoundationPoints += 8;
  else profileFoundationPoints += 6; // Beginner

  // Profile completeness (up to 5 pts)
  const hasName = Boolean(safeUser.name && String(safeUser.name).trim().length > 0);
  const hasBio = Boolean(safeUser.bio && String(safeUser.bio).trim().length > 5);
  const isOnboarded = Boolean(safeUser.is_onboarded);
  if (hasName) profileFoundationPoints += 2;
  if (hasBio) profileFoundationPoints += 1;
  if (isOnboarded || declaredSkills.length > 0) profileFoundationPoints += 2;
  profileFoundationPoints = Math.min(25, profileFoundationPoints);

  const profileFoundationReason = `${experienceLevel} experience level with ${declaredSkills.length} declared skill(s)${isOnboarded ? ' and completed onboarding profile' : ''}.`;

  // --- Factor 3: Issue Difficulty & Requirement Clarity (Max 25 pts) ---
  let issueClarityPoints = 0;
  let issueClarityReason = '';

  const singleIssue = safeContext.issue || (safeIssues.length === 1 ? safeIssues[0] : null);
  if (singleIssue) {
    const labels = Array.isArray(singleIssue.labels) ? singleIssue.labels : [];
    const labelNames = labels.map(l => (typeof l === 'string' ? l : (l?.name || '')).toLowerCase());
    const isGfi = labelNames.some(n => n.includes('good first issue') || n.includes('beginner') || n.includes('starter') || n.includes('easy'));
    const isHw = labelNames.some(n => n.includes('help wanted') || n.includes('contributions welcome'));
    const isComplex = labelNames.some(n => n.includes('breaking') || n.includes('complex') || n.includes('expert') || n.includes('security'));
    const issueDifficulty = singleIssue.difficulty || (isGfi ? 'Beginner' : isHw ? 'Intermediate' : isComplex ? 'Advanced' : 'Intermediate');

    // Difficulty vs developer experience alignment (up to 15 pts)
    if (experienceLevel === 'Beginner') {
      if (issueDifficulty === 'Beginner' || isGfi) issueClarityPoints += 15;
      else if (issueDifficulty === 'Intermediate' || isHw) issueClarityPoints += 10;
      else issueClarityPoints += 5;
    } else if (experienceLevel === 'Intermediate') {
      if (issueDifficulty === 'Beginner' || issueDifficulty === 'Intermediate') issueClarityPoints += 14;
      else issueClarityPoints += 10;
    } else {
      issueClarityPoints += 15;
    }

    // Issue description / title clarity & comment load (up to 10 pts)
    const descText = String(singleIssue.body || singleIssue.description || singleIssue.title || '').trim();
    if (descText.length >= 80) issueClarityPoints += 6;
    else if (descText.length >= 25) issueClarityPoints += 4;
    else if (descText.length > 0) issueClarityPoints += 2;

    const comments = Number(singleIssue.commentsCount ?? singleIssue.comments ?? 0);
    if (comments <= 6) issueClarityPoints += 4;
    else if (comments <= 12) issueClarityPoints += 2;

    issueClarityPoints = Math.min(25, issueClarityPoints);
    issueClarityReason = `Target issue is rated ${issueDifficulty} difficulty (${comments} comment${comments === 1 ? '' : 's'}) vs. your ${experienceLevel} level.`;
  } else if (safeIssues.length > 0) {
    const compatibleByDiff = safeIssues.filter(iss => {
      const diff = iss.difficulty || 'Intermediate';
      if (experienceLevel === 'Beginner') return diff === 'Beginner';
      if (experienceLevel === 'Intermediate') return diff === 'Beginner' || diff === 'Intermediate';
      return true;
    });
    const diffRatio = compatibleByDiff.length / safeIssues.length;
    const wellDescribed = safeIssues.filter(iss => String(iss.title || '').trim().length >= 20).length / safeIssues.length;
    issueClarityPoints = Math.min(25, Math.max(8, Math.round((diffRatio * 17) + (wellDescribed * 8))));
    issueClarityReason = `${compatibleByDiff.length} of ${safeIssues.length} discovered issue(s) match your ${experienceLevel} difficulty tier with clear requirements.`;
  } else {
    issueClarityPoints = 12;
    issueClarityReason = 'No active issue list provided; baseline difficulty alignment applied for your experience tier.';
  }

  // --- Factor 4: Availability of Beginner-Friendly Issues & Workflow Readiness (Max 15 pts) ---
  let availabilityPoints = 0;
  let availabilityReason = '';

  const gfiCount = safeIssues.filter(iss => {
    if (iss.category === 'good-first-issue' || iss.difficulty === 'Beginner') return true;
    const lbls = Array.isArray(iss.labels) ? iss.labels : [];
    return lbls.some(l => {
      const n = (typeof l === 'string' ? l : (l?.name || '')).toLowerCase();
      return n.includes('good first issue') || n.includes('beginner');
    });
  }).length;

  const hwCount = safeIssues.filter(iss => {
    if (iss.category === 'help-wanted') return true;
    const lbls = Array.isArray(iss.labels) ? iss.labels : [];
    return lbls.some(l => (typeof l === 'string' ? l : (l?.name || '')).toLowerCase().includes('help wanted'));
  }).length;

  const beginnerFriendlyTotal = gfiCount + hwCount;

  if (beginnerFriendlyTotal >= 4) availabilityPoints += 10;
  else if (beginnerFriendlyTotal >= 2) availabilityPoints += 8;
  else if (beginnerFriendlyTotal === 1) availabilityPoints += 6;
  else if (safeIssues.length > 0) availabilityPoints += 3;
  else availabilityPoints += 5;

  let roadmapCompletedCount = Number(safeContext.roadmapCompletedCount || 0);
  if (!roadmapCompletedCount && safeUser.id) {
    try {
      roadmapCompletedCount = getUserRoadmapProgress(safeUser.id).length;
    } catch (e) {
      roadmapCompletedCount = 0;
    }
  }
  const roadmapBonus = Math.min(5, Math.round((roadmapCompletedCount / 14) * 5));
  availabilityPoints = Math.min(15, availabilityPoints + roadmapBonus);
  availabilityReason = `${gfiCount} Good First Issue(s) and ${hwCount} Help Wanted issue(s) available; ${roadmapCompletedCount}/14 roadmap stages completed.`;

  // Total Score Calculation
  const totalScore = Math.max(0, Math.min(100,
    skillAlignmentPoints + profileFoundationPoints + issueClarityPoints + availabilityPoints
  ));

  let readinessLevel = 'Getting Started';
  let badgeClass = 'low';
  if (totalScore >= 80) {
    readinessLevel = 'High Readiness';
    badgeClass = 'high';
  } else if (totalScore >= 60) {
    readinessLevel = 'Moderate Readiness';
    badgeClass = 'medium';
  } else if (totalScore >= 40) {
    readinessLevel = 'Developing Readiness';
    badgeClass = 'developing';
  }

  // Actionable Suggestions based on rule-based gaps
  const suggestions = [];
  if (declaredSkills.length === 0) {
    suggestions.push('Declare your programming languages and tools in Profile Settings (/onboarding?edit=1) to enable skill-to-issue matching.');
  } else if (declaredSkills.length < 3) {
    suggestions.push('Add at least 3 technical skills (e.g., Git, Markdown/Documentation, or a secondary language) to broaden compatible repositories.');
  }

  if (missingSkills.length > 0) {
    suggestions.push(`Target repositories/issues reference skills not in your profile (${missingSkills.slice(0, 3).join(', ')}). Filter by your declared languages or add them if you have learned them.`);
  }

  if (experienceLevel === 'Beginner' && gfiCount === 0 && safeIssues.length > 0) {
    suggestions.push('Switch the issue filter to "Good First Issues" so tasks are scoped specifically for first-time contributors.');
  }

  if (roadmapCompletedCount < 14) {
    suggestions.push(`Complete the 14-stage First Contribution Roadmap (${roadmapCompletedCount}/14 done) at /roadmap to verify your Git fork, branch, and Pull Request workflow.`);
  }

  if (suggestions.length === 0) {
    suggestions.push('Your skill profile and workflow readiness are strong. Pick a Good First Issue below, review its CONTRIBUTING.md, and open a Pull Request!');
  }

  return {
    score: totalScore,
    readinessLevel,
    badgeClass,
    experienceLevel,
    declaredSkills: declaredSkills.map(formatSkillName),
    requiredSkills: requiredSkills.map(formatSkillName),
    matchedSkills,
    missingSkills,
    beginnerFriendlyIssuesCount: beginnerFriendlyTotal,
    goodFirstIssuesCount: gfiCount,
    helpWantedIssuesCount: hwCount,
    roadmapCompletedCount,
    breakdown: {
      skillAlignment: {
        score: skillAlignmentPoints,
        maxScore: 35,
        percentage: Math.round((skillAlignmentPoints / 35) * 100),
        label: 'Skill & Repository Alignment',
        explanation: skillAlignmentReason
      },
      profileFoundation: {
        score: profileFoundationPoints,
        maxScore: 25,
        percentage: Math.round((profileFoundationPoints / 25) * 100),
        label: 'Developer Profile & Experience',
        explanation: profileFoundationReason
      },
      issueClarity: {
        score: issueClarityPoints,
        maxScore: 25,
        percentage: Math.round((issueClarityPoints / 25) * 100),
        label: 'Issue Difficulty & Requirement Fit',
        explanation: issueClarityReason
      },
      beginnerAvailability: {
        score: availabilityPoints,
        maxScore: 15,
        percentage: Math.round((availabilityPoints / 15) * 100),
        label: 'Beginner Issue Availability & Roadmap',
        explanation: availabilityReason
      }
    },
    suggestions,
    formulaExplanation: 'Rule-Based Formula (100 pts): Skill Alignment (35 pts) + Profile & Experience Tier (25 pts) + Issue Difficulty & Requirement Clarity (25 pts) + Beginner Issue Availability & Roadmap Progress (15 pts).',
    assessmentDisclaimer: 'Estimated readiness assessment based on rule-based profile and issue metadata — not a guarantee of contribution acceptance.'
  };
}

/**
 * Evaluates Contribution Readiness for a single specific issue and user profile.
 */
function evaluateIssueReadiness(userProfile, issue) {
  if (!issue || typeof issue !== 'object') {
    return calculateContributionReadiness(userProfile, [], {});
  }
  return calculateContributionReadiness(userProfile, [issue], { issue });
}

// ---------------------------------------------------------------------------
// MODULE 2: REPOSITORY HEALTH SCORE
// ---------------------------------------------------------------------------

/**
 * Evaluates an open-source repository's health using transparent rule-based criteria.
 *
 * Scoring Rubric (100 Points Total):
 * 1. Recent Activity & Maintenance Recency (0 - 35 points)
 *    - Verified from GitHub 'updated_at' / 'pushed_at' timestamps and 'archived' status.
 * 2. Documentation & Metadata Completeness (0 - 25 points)
 *    - Verified from repository description, SPDX license, curated topics, and homepage/docs link.
 * 3. Issue Activity & Triage Balance (0 - 25 points)
 *    - Evaluates open_issues_count relative to community engagement so contributors know if issues are active or overloaded.
 * 4. Community Popularity & Fork Traction (0 - 15 points)
 *    - Uses stars and forks strictly as popularity context (capped at 15 pts so high stars alone cannot mask a stale or undocumented repo).
 */
function calculateRepositoryHealth(repo) {
  if (!repo || typeof repo !== 'object' || Object.keys(repo).length === 0) {
    return {
      score: 0,
      statusLabel: 'Insufficient Data',
      badgeClass: 'unknown',
      isDataComplete: false,
      factors: {
        maintenanceRecency: { score: 0, maxScore: 35, label: 'Maintenance & Recency', detail: 'Repository metadata unavailable.' },
        documentationQuality: { score: 0, maxScore: 25, label: 'Documentation & Metadata', detail: 'Description and license unavailable.' },
        issueBalance: { score: 0, maxScore: 25, label: 'Issue Activity & Triage', detail: 'Open issue metrics unavailable.' },
        popularityContext: { score: 0, maxScore: 15, label: 'Popularity Context (Stars/Forks)', detail: 'Star/fork counts unavailable.' }
      },
      risks: ['Repository information is missing or could not be retrieved from the GitHub API.'],
      verifiedMetrics: [],
      estimatedMetrics: ['All health indicators unavailable due to missing repository payload.']
    };
  }

  const verifiedMetrics = [];
  const estimatedMetrics = [];
  const risks = [];

  const isArchived = Boolean(repo.archived);
  const hasIssuesEnabled = repo.has_issues !== undefined ? Boolean(repo.has_issues) : true;

  // 1. Maintenance & Recency (Max 35 pts)
  const rawDate = repo.pushed_at || repo.updated_at || repo.updatedAtExact || null;
  let maintenancePoints = 0;
  let maintenanceDetail = '';
  let daysSinceUpdate = null;

  if (rawDate) {
    const parsedTime = new Date(rawDate).getTime();
    if (!Number.isNaN(parsedTime)) {
      daysSinceUpdate = Math.max(0, Math.floor((Date.now() - parsedTime) / (1000 * 60 * 60 * 24)));
      verifiedMetrics.push(`Last repository update verified (${daysSinceUpdate} day${daysSinceUpdate === 1 ? '' : 's'} ago)`);

      if (isArchived) {
        maintenancePoints = 4;
        maintenanceDetail = `Repository is archived (last updated ${daysSinceUpdate}d ago).`;
        risks.push('Repository is archived and read-only; new Pull Requests are likely not accepted.');
      } else if (daysSinceUpdate <= 7) {
        maintenancePoints = 35;
        maintenanceDetail = `Actively maintained (updated ${daysSinceUpdate}d ago).`;
      } else if (daysSinceUpdate <= 30) {
        maintenancePoints = 30;
        maintenanceDetail = `Recent activity (updated ${daysSinceUpdate}d ago).`;
      } else if (daysSinceUpdate <= 90) {
        maintenancePoints = 22;
        maintenanceDetail = `Moderately recent activity (updated ${daysSinceUpdate}d ago).`;
      } else if (daysSinceUpdate <= 180) {
        maintenancePoints = 14;
        maintenanceDetail = `Slowing update cadence (updated ${daysSinceUpdate}d ago).`;
        risks.push(`No updates recorded in the last ${daysSinceUpdate} days — maintainer review may be slow.`);
      } else {
        maintenancePoints = 5;
        maintenanceDetail = `Stale / inactive repository (last updated ${daysSinceUpdate}d ago).`;
        risks.push(`Repository has been inactive for ${daysSinceUpdate} days (>6 months). Verify maintainer responsiveness before starting work.`);
      }
    }
  }

  if (daysSinceUpdate === null) {
    maintenancePoints = 10;
    maintenanceDetail = 'Update timestamp missing from payload (estimated baseline applied).';
    estimatedMetrics.push('Update recency estimated because exact ISO timestamp was not provided.');
    risks.push('Exact last-updated timestamp is unavailable.');
  }

  // 2. Documentation & Metadata Completeness (Max 25 pts)
  let docPoints = 0;
  const docParts = [];

  const rawDesc = String(repo.description || '').trim();
  const hasRealDescription = rawDesc.length > 0 && rawDesc !== 'No description provided.';
  if (hasRealDescription) {
    if (rawDesc.length >= 40) {
      docPoints += 10;
      docParts.push('detailed description');
    } else {
      docPoints += 6;
      docParts.push('brief description');
    }
    verifiedMetrics.push('Repository description verified from GitHub metadata');
  } else {
    risks.push('Missing repository description — project scope and setup instructions may be unclear.');
  }

  const rawLicense = repo.license
    ? (typeof repo.license === 'string' ? repo.license : (repo.license.spdx_id || repo.license.name))
    : null;
  if (rawLicense && rawLicense !== 'NOASSERTION') {
    docPoints += 8;
    docParts.push(`license (${rawLicense})`);
    verifiedMetrics.push(`Open-source license verified (${rawLicense})`);
  } else {
    risks.push('No explicit open-source license detected in repository metadata.');
  }

  const topics = Array.isArray(repo.topics) ? repo.topics : [];
  if (topics.length >= 3) {
    docPoints += 4;
    docParts.push(`${topics.length} topics`);
    verifiedMetrics.push(`Repository topics verified (${topics.length} tags)`);
  } else if (topics.length >= 1) {
    docPoints += 2;
    docParts.push(`${topics.length} topic`);
    verifiedMetrics.push(`Repository topics verified (${topics.length} tag)`);
  }

  const hasHomepage = Boolean(repo.homepage && String(repo.homepage).trim().length > 0);
  const hasOnboardingTopic = topics.some(t => {
    const low = String(t).toLowerCase();
    return low.includes('good-first-issue') || low.includes('beginner') || low.includes('hacktoberfest') || low.includes('documentation');
  });

  if (hasHomepage) {
    docPoints += 3;
    docParts.push('external docs URL');
    verifiedMetrics.push('Documentation/homepage URL verified');
  } else if (hasOnboardingTopic) {
    docPoints += 3;
    docParts.push('onboarding topic tags');
    estimatedMetrics.push('Contributor guideline friendliness estimated from onboarding topics (full tree scan not required).');
  } else {
    estimatedMetrics.push('CONTRIBUTING.md presence is estimated from repository metadata unless inspected on GitHub.');
  }

  docPoints = Math.min(25, docPoints);
  const docDetail = docParts.length > 0
    ? `Includes ${docParts.join(', ')}.`
    : 'Minimal metadata (missing description, license, and topics).';

  // 3. Issue Activity & Triage Balance (Max 25 pts)
  let issuePoints = 0;
  let issueDetail = '';
  const rawOpenIssues = repo.open_issues_count !== undefined ? repo.open_issues_count : repo.openIssues;
  const openIssues = (rawOpenIssues !== undefined && rawOpenIssues !== null && !Number.isNaN(Number(rawOpenIssues)))
    ? Math.max(0, Number(rawOpenIssues))
    : null;

  const rawStars = repo.stargazers_count !== undefined ? repo.stargazers_count : repo.stars;
  const stars = (rawStars !== undefined && rawStars !== null && !Number.isNaN(Number(rawStars)))
    ? Math.max(0, Number(rawStars))
    : 0;

  const rawForks = repo.forks_count !== undefined ? repo.forks_count : repo.forks;
  const forks = (rawForks !== undefined && rawForks !== null && !Number.isNaN(Number(rawForks)))
    ? Math.max(0, Number(rawForks))
    : 0;

  if (!hasIssuesEnabled) {
    issuePoints = 4;
    issueDetail = 'Issue tracker is disabled on this repository.';
    risks.push('GitHub Issues are disabled for this repository.');
  } else if (openIssues === null) {
    issuePoints = 10;
    issueDetail = 'Open issue count missing from payload (estimated baseline).';
    estimatedMetrics.push('Open issue activity estimated due to missing open_issues_count field.');
  } else {
    verifiedMetrics.push(`Open issues count verified (${openIssues} open)`);
    // Evaluate issue backlog relative to community size
    const issueToStarRatio = stars > 0 ? (openIssues / stars) : (openIssues > 50 ? 1 : 0.1);

    if (openIssues === 0) {
      issuePoints = 12;
      issueDetail = '0 open issues — repository may have no available tasks for new contributors.';
      risks.push('Repository currently has 0 open issues; there may be no actionable tasks to claim.');
    } else if (openIssues >= 1 && openIssues <= 150 && issueToStarRatio <= 0.5) {
      issuePoints = 25;
      issueDetail = `Healthy active queue (${openIssues} open issues, well-proportioned to community size).`;
    } else if (openIssues <= 400 && issueToStarRatio <= 0.8) {
      issuePoints = 20;
      issueDetail = `Active issue backlog (${openIssues} open issues available for triage).`;
    } else if (openIssues > 1000 || issueToStarRatio > 1.0) {
      issuePoints = 11;
      issueDetail = `High open issue backlog (${openIssues.toLocaleString()} open issues).`;
      risks.push(`Large backlog of ${openIssues.toLocaleString()} open issues — maintainers may have limited triage bandwidth.`);
    } else {
      issuePoints = 17;
      issueDetail = `Moderate issue queue (${openIssues.toLocaleString()} open issues).`;
    }
  }

  // 4. Popularity & Community Adoption Context (Max 15 pts — NOT a standalone health indicator)
  let popularityPoints = 0;
  let popularityDetail = '';
  if (rawStars !== undefined || rawForks !== undefined) {
    verifiedMetrics.push(`Popularity context verified (${stars.toLocaleString()} stars, ${forks.toLocaleString()} forks)`);
    let starPts = 0;
    if (stars >= 1000) starPts = 9;
    else if (stars >= 200) starPts = 7;
    else if (stars >= 50) starPts = 5;
    else if (stars >= 10) starPts = 3;
    else if (stars >= 1) starPts = 2;

    let forkPts = 0;
    if (forks >= 200) forkPts = 6;
    else if (forks >= 50) forkPts = 5;
    else if (forks >= 10) forkPts = 4;
    else if (forks >= 2) forkPts = 2;
    else if (forks === 1) forkPts = 1;

    popularityPoints = Math.min(15, starPts + forkPts);
    popularityDetail = `${stars.toLocaleString()} stars & ${forks.toLocaleString()} forks (weighted at max 15% as popularity context, not standalone health).`;
  } else {
    popularityPoints = 5;
    popularityDetail = 'Star/fork counts unavailable.';
    estimatedMetrics.push('Community traction estimated due to missing star/fork counters.');
  }

  const totalScore = Math.max(0, Math.min(100,
    maintenancePoints + docPoints + issuePoints + popularityPoints
  ));

  let statusLabel = 'Needs Attention';
  let badgeClass = 'warning';
  if (isArchived) {
    statusLabel = 'Archived / Read-Only';
    badgeClass = 'danger';
  } else if (totalScore >= 80) {
    statusLabel = 'Healthy & Active';
    badgeClass = 'healthy';
  } else if (totalScore >= 60) {
    statusLabel = 'Moderately Maintained';
    badgeClass = 'moderate';
  } else if (totalScore < 45) {
    statusLabel = 'High Risk / Inactive';
    badgeClass = 'danger';
  }

  return {
    score: totalScore,
    statusLabel,
    badgeClass,
    isDataComplete: daysSinceUpdate !== null && openIssues !== null,
    daysSinceUpdate,
    factors: {
      maintenanceRecency: {
        score: maintenancePoints,
        maxScore: 35,
        percentage: Math.round((maintenancePoints / 35) * 100),
        label: 'Maintenance & Activity Recency',
        detail: maintenanceDetail,
        dataSource: daysSinceUpdate !== null ? 'Verified (GitHub API)' : 'Estimated'
      },
      documentationQuality: {
        score: docPoints,
        maxScore: 25,
        percentage: Math.round((docPoints / 25) * 100),
        label: 'Documentation & Metadata',
        detail: docDetail,
        dataSource: hasRealDescription || rawLicense ? 'Verified + Inferred' : 'Estimated'
      },
      issueBalance: {
        score: issuePoints,
        maxScore: 25,
        percentage: Math.round((issuePoints / 25) * 100),
        label: 'Issue Activity & Triage Balance',
        detail: issueDetail,
        dataSource: openIssues !== null ? 'Verified (GitHub API)' : 'Estimated'
      },
      popularityContext: {
        score: popularityPoints,
        maxScore: 15,
        percentage: Math.round((popularityPoints / 15) * 100),
        label: 'Popularity Context (Capped 15%)',
        detail: popularityDetail,
        dataSource: (rawStars !== undefined || rawForks !== undefined) ? 'Verified (GitHub API)' : 'Estimated'
      }
    },
    risks,
    verifiedMetrics,
    estimatedMetrics,
    formulaNote: 'Stars and forks are capped at 15% weight as popularity context. Maintenance recency (35%), documentation/license completeness (25%), and issue triage balance (25%) drive 85% of the health score.'
  };
}

// ---------------------------------------------------------------------------
// MODULE 3: FIRST CONTRIBUTION ROADMAP (14 STAGES)
// ---------------------------------------------------------------------------

const FIRST_CONTRIBUTION_ROADMAP = [
  {
    stepNumber: 1,
    phase: 'Phase 1: Foundations',
    title: 'Introduction to Open Source',
    summary: 'Learn how collaborative open-source software works, why maintainers welcome contributors, and how licenses & governance protect the community.',
    instructions: [
      'Understand what open-source software (OSS) means: source code that anyone can inspect, modify, and enhance under an open license (such as MIT, Apache-2.0, or GPL).',
      'Recognize the roles in an OSS project: Authors/Owners, Maintainers, Reviewers, and Contributors (code, documentation, triage, and testing).',
      'Review how issues, pull requests, and code reviews form the core collaboration loop.'
    ],
    commands: [
      '# No local terminal command needed for Stage 1 — explore open repositories on DevNexus:',
      '# Visit /projects to see real open-source licenses (MIT, Apache-2.0, BSD) and health metrics.'
    ],
    example: 'A documentation fix, bug reproduction report, or test case is just as valuable as a new feature for your first contribution.',
    docTitle: 'Open Source Guides: How to Contribute to Open Source',
    docUrl: 'https://opensource.guide/how-to-contribute/'
  },
  {
    stepNumber: 2,
    phase: 'Phase 1: Foundations',
    title: 'Understanding Git and GitHub',
    summary: 'Master the difference between Git (local distributed version control) and GitHub (remote collaboration & Pull Request hosting).',
    instructions: [
      'Install Git on your machine and configure your global author name and email address.',
      'Understand the core Git states: Working Directory -> Staging Area (git add) -> Local Repository (git commit) -> Remote Repository (git push).',
      'Understand how remotes work: "origin" points to your fork on GitHub, while "upstream" points to the original maintainer repository.'
    ],
    commands: [
      'git --version',
      'git config --global user.name "Your Full Name"',
      'git config --global user.email "your-verified-email@example.com"',
      'git config --global init.defaultBranch main'
    ],
    example: 'Run `git config --list` to confirm your author identity before creating commits.',
    docTitle: 'GitHub Docs: About Git and GitHub',
    docUrl: 'https://docs.github.com/en/get-started/using-git/about-git'
  },
  {
    stepNumber: 3,
    phase: 'Phase 1: Foundations',
    title: 'Setting up a GitHub account',
    summary: 'Set up your GitHub developer profile, verify your primary email address, and configure SSH or Personal Access Token authentication.',
    instructions: [
      'Create a free GitHub account (or sign in to your existing account) and verify your email address so your commits link to your profile.',
      'Add a clear display name, bio, and profile picture, and enable Two-Factor Authentication (2FA) for account security.',
      'Complete your DevNexus Onboarding profile (/onboarding?edit=1) with your programming languages and experience level.'
    ],
    commands: [
      '# Verify SSH connectivity to GitHub (optional but recommended):',
      'ssh -T git@github.com',
      '# Or authenticate using the official GitHub CLI:',
      'gh auth login'
    ],
    example: 'When your email in git config matches your verified GitHub email, every merged commit is credited to your GitHub profile.',
    docTitle: 'GitHub Docs: Getting started with your GitHub account',
    docUrl: 'https://docs.github.com/en/get-started/onboarding/getting-started-with-your-github-account'
  },
  {
    stepNumber: 4,
    phase: 'Phase 2: Discovery & Preparation',
    title: 'Finding beginner-friendly repositories',
    summary: 'Use DevNexus Project Discovery and the Repository Health Score to select an active, well-documented repository in a language you know.',
    instructions: [
      'Open the DevNexus Explore Projects page (/projects) and filter by your strongest programming language and topic (e.g., good-first-issue, beginner-friendly).',
      'Check the Repository Health Score badge on each card: prioritize "Healthy & Active" repositories updated within the last 30 days.',
      'Verify that the project has an open-source license, a clear description, and an active issue tracker.'
    ],
    commands: [
      '# Search beginner-friendly repositories via GitHub CLI or DevNexus /projects:',
      'gh search repos --topic=good-first-issue --language=javascript --sort=updated'
    ],
    example: 'A repository with 300 stars updated 2 days ago is much better for a first contribution than a 20,000-star repo with no commits in 9 months.',
    docTitle: 'GitHub Docs: Finding ways to contribute to open source on GitHub',
    docUrl: 'https://docs.github.com/en/get-started/exploring-projects-on-github/finding-ways-to-contribute-to-open-source-on-github'
  },
  {
    stepNumber: 5,
    phase: 'Phase 2: Discovery & Preparation',
    title: 'Identifying Good First Issues',
    summary: 'Select a well-scoped issue labeled "good first issue" or "help wanted" and check your DevNexus Contribution Readiness Score.',
    instructions: [
      'Navigate to your Developer Dashboard (/dashboard) and select the "Good First Issues" tab.',
      'Inspect the Contribution Readiness Score and Compatibility badge on candidate issues to verify skill overlap.',
      'Read the existing comments on the GitHub issue to make sure no one else has already submitted an open Pull Request for it, then politely comment that you would like to work on it.'
    ],
    commands: [
      '# List open "good first issue" tasks in a target repository:',
      'gh issue list --repo owner/repository --label "good first issue" --state open'
    ],
    example: 'Comment on the issue: "Hi! I would like to work on this issue. I have reproduced the problem locally and plan to submit a PR shortly."',
    docTitle: 'GitHub Docs: Searching issues and pull requests',
    docUrl: 'https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests'
  },
  {
    stepNumber: 6,
    phase: 'Phase 2: Discovery & Preparation',
    title: 'Understanding repository guidelines',
    summary: 'Read README.md, CONTRIBUTING.md, and CODE_OF_CONDUCT.md carefully so your setup, coding style, and PR format follow project rules.',
    instructions: [
      'Read README.md to understand the project architecture and local installation requirements.',
      'Read CONTRIBUTING.md to check branch naming rules, commit message conventions (e.g., Conventional Commits), and test commands.',
      'Check if the project requires signing a Contributor License Agreement (CLA) or Developer Certificate of Origin (DCO sign-off).'
    ],
    commands: [
      '# Inspect documentation files after cloning or on GitHub:',
      'ls -la README* CONTRIBUTING* CODE_OF_CONDUCT* LICENSE*'
    ],
    example: 'Many maintainers automatically close PRs that target the wrong base branch or skip the PR template checklist.',
    docTitle: 'GitHub Docs: Setting guidelines for repository contributors',
    docUrl: 'https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors'
  },
  {
    stepNumber: 7,
    phase: 'Phase 3: Local Git Workflow',
    title: 'Forking a repository',
    summary: 'Create your own personal copy (fork) of the upstream repository under your GitHub account so you can push branches safely.',
    instructions: [
      'Open the target repository on GitHub and click the "Fork" button in the top-right corner.',
      'Keep the default repository name under your personal GitHub account and click "Create fork".',
      'Your fork URL will be https://github.com/<your-username>/<repo-name>.'
    ],
    commands: [
      '# Fork a repository from the terminal using GitHub CLI:',
      'gh repo fork owner/repository --clone=false'
    ],
    example: 'Forking lets you experiment and push commits freely without needing write permissions on the original maintainer repository.',
    docTitle: 'GitHub Docs: Fork a repository',
    docUrl: 'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/fork-a-repo'
  },
  {
    stepNumber: 8,
    phase: 'Phase 3: Local Git Workflow',
    title: 'Cloning the repository',
    summary: 'Download your forked repository to your computer and configure the "upstream" remote to stay synchronized with the original project.',
    instructions: [
      'Copy the HTTPS or SSH URL of your GitHub fork and run `git clone` in your terminal.',
      'Change into the project directory (`cd <repo-name>`) and add the original repository as the `upstream` remote.',
      'Run `git remote -v` to verify that `origin` points to your fork and `upstream` points to the original repository.'
    ],
    commands: [
      'git clone https://github.com/your-username/repository-name.git',
      'cd repository-name',
      'git remote add upstream https://github.com/original-owner/repository-name.git',
      'git remote -v'
    ],
    example: '`origin` is where you push your work; `upstream` is where you pull the latest maintainer updates from.',
    docTitle: 'GitHub Docs: Cloning a repository and configuring remotes',
    docUrl: 'https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository'
  },
  {
    stepNumber: 9,
    phase: 'Phase 3: Local Git Workflow',
    title: 'Creating a new branch',
    summary: 'Create a dedicated, descriptively named feature or bugfix branch off the latest default branch — never commit directly to main.',
    instructions: [
      'Sync your local default branch (`main` or `master`) with `upstream` before branching.',
      'Create and switch to a new branch named after the issue or change (e.g., `fix/issue-42-navbar-link` or `docs/update-install-guide`).',
      'Verify your active branch using `git branch` or `git status`.'
    ],
    commands: [
      'git fetch upstream',
      'git checkout main',
      'git merge upstream/main',
      'git checkout -b fix/issue-104-broken-link'
    ],
    example: 'Using one focused branch per issue allows you to work on multiple contributions independently without mixing commits.',
    docTitle: 'GitHub Docs: About branches',
    docUrl: 'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-branches'
  },
  {
    stepNumber: 10,
    phase: 'Phase 4: Implementation & Verification',
    title: 'Making code changes',
    summary: 'Write clean, minimal, well-commented code or documentation changes that directly solve the issue without unrelated formatting edits.',
    instructions: [
      'Install the project dependencies as documented in README.md or CONTRIBUTING.md (e.g., `npm install` or `pip install -r requirements.txt`).',
      'Implement the fix or enhancement requested in the issue, matching the existing indentation, naming conventions, and architecture.',
      'Run `git diff` to review every line you modified and ensure no debug logs, `.env` secrets, or unrelated files were touched.'
    ],
    commands: [
      'git status',
      'git diff'
    ],
    example: 'Keep your diff focused strictly on the issue requirements — maintainers review small, surgical Pull Requests much faster.',
    docTitle: 'GitHub Docs: Tracking changes in a repository',
    docUrl: 'https://docs.github.com/en/get-started/using-git/about-git#basic-git-commands'
  },
  {
    stepNumber: 11,
    phase: 'Phase 4: Implementation & Verification',
    title: 'Testing the changes',
    summary: 'Run the repository test suite, linter, and build scripts locally to verify your changes work and cause zero regressions.',
    instructions: [
      'Run the project automated test suite (e.g., `npm test`, `pytest`, `cargo test`, or `go test ./...`).',
      'If you fixed a bug or added a function, add or update a unit test covering the behavior.',
      'Run the project linter/formatter if configured (e.g., `npm run lint`) so Continuous Integration (CI) checks pass on the first run.'
    ],
    commands: [
      'npm test',
      'npm run lint'
    ],
    example: 'Mentioning in your Pull Request description that all local tests pass gives maintainers immediate confidence in your work.',
    docTitle: 'GitHub Docs: About status checks and CI',
    docUrl: 'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks'
  },
  {
    stepNumber: 12,
    phase: 'Phase 5: Submission & Collaboration',
    title: 'Committing and pushing changes',
    summary: 'Stage your intended files, write a clear commit message explaining what changed and why, and push your branch to your GitHub fork.',
    instructions: [
      'Stage only the relevant modified files using `git add <file>` (avoid `git add .` if you have untracked temporary files).',
      'Create a concise, meaningful commit message (e.g., `fix(docs): correct broken setup link in README (#104)`).',
      'Push your branch to your `origin` fork on GitHub using `git push -u origin <branch-name>`.'
    ],
    commands: [
      'git add path/to/modified-file.js',
      'git commit -m "fix: resolve null check in issue filter (#104)"',
      'git push -u origin fix/issue-104-broken-link'
    ],
    example: 'Use imperative mood in commit subjects ("fix: handle empty array" rather than "fixed empty array").',
    docTitle: 'GitHub Docs: Pushing commits to a remote repository',
    docUrl: 'https://docs.github.com/en/get-started/using-git/pushing-commits-to-a-remote-repository'
  },
  {
    stepNumber: 13,
    phase: 'Phase 5: Submission & Collaboration',
    title: 'Creating a Pull Request',
    summary: 'Open a Pull Request from your fork branch to the upstream repository, fill out the PR template, and link the issue number.',
    instructions: [
      'Visit the upstream repository on GitHub and click the "Compare & pull request" banner that appears after your push.',
      'Write a clear PR title and complete the Pull Request template: summarize the problem, explain your solution, and list how you tested it.',
      'Include a linking keyword such as `Fixes #104` or `Closes #104` in the PR description so GitHub links the issue automatically.'
    ],
    commands: [
      '# Or open the Pull Request directly from the terminal with GitHub CLI:',
      'gh pr create --title "fix: resolve null check in issue filter" --body "Fixes #104. Added guard clause and unit test."'
    ],
    example: 'Include screenshots if your Pull Request modifies any user interface or styling.',
    docTitle: 'GitHub Docs: Creating a pull request from a fork',
    docUrl: 'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request-from-a-fork'
  },
  {
    stepNumber: 14,
    phase: 'Phase 5: Submission & Collaboration',
    title: 'Responding to maintainer feedback',
    summary: 'Collaborate constructively during code review, push requested follow-up commits to the same branch, and celebrate your merged PR!',
    instructions: [
      'Monitor your Pull Request notifications for automated CI check results and maintainer review comments.',
      'If a reviewer requests changes, make the edits locally on the same branch, commit them, and run `git push` — the Pull Request updates automatically.',
      'Reply politely to review comments explaining what you updated, and thank the maintainers once your Pull Request is approved and merged!'
    ],
    commands: [
      '# To update your open Pull Request after review feedback, commit and push on the same branch:',
      'git add .',
      'git commit -m "refactor: apply reviewer feedback on error message"',
      'git push origin fix/issue-104-broken-link'
    ],
    example: 'Code review is a collaborative learning process — every review comment helps you grow as an engineer.',
    docTitle: 'GitHub Docs: Incorporating feedback in your pull request',
    docUrl: 'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request'
  }
];

/**
 * Returns the 14-stage First Contribution Roadmap enriched with the user's persisted completion state.
 */
function getRoadmapStagesWithProgress(userId = null) {
  const completedRows = userId ? getUserRoadmapProgress(userId) : [];
  const completedMap = new Map();
  for (const row of completedRows) {
    completedMap.set(Number(row.stepNumber), row.completedAt);
  }

  const stages = FIRST_CONTRIBUTION_ROADMAP.map(stage => ({
    ...stage,
    completed: completedMap.has(stage.stepNumber),
    completedAt: completedMap.get(stage.stepNumber) || null
  }));

  const completedCount = stages.filter(s => s.completed).length;
  const totalStages = FIRST_CONTRIBUTION_ROADMAP.length;
  const percentage = Math.round((completedCount / totalStages) * 100);

  // Determine next recommended stage
  const nextStage = stages.find(s => !s.completed) || null;

  return {
    stages,
    completedSteps: stages.filter(s => s.completed).map(s => s.stepNumber),
    completedCount,
    totalStages,
    percentage,
    isAllCompleted: completedCount === totalStages,
    nextStage: nextStage ? { stepNumber: nextStage.stepNumber, title: nextStage.title, phase: nextStage.phase } : null
  };
}

module.exports = {
  calculateContributionReadiness,
  evaluateIssueReadiness,
  calculateRepositoryHealth,
  FIRST_CONTRIBUTION_ROADMAP,
  getRoadmapStagesWithProgress,
  normalizeSkillList
};
