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
  'c++', 'c#', 'c', 'ruby', 'php', 'swift', 'kotlin', 'dart', 'scala', 'elixir', 'haskell', 'lua',
  'html', 'css', 'react', 'vue', 'angular', 'svelte', 'next.js', 'nuxt.js', 'tailwind css',
  'node.js', 'express', 'nestjs', 'django', 'flask', 'fastapi', 'spring boot', 'spring',
  'ruby on rails', 'laravel', 'asp.net core', 'react native', 'flutter', 'expo',
  'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'github actions',
  'aws', 'google cloud (gcp)', 'microsoft azure', 'nginx', 'prometheus', 'grafana',
  'sql', 'sqlite', 'postgresql', 'mysql', 'mongodb', 'redis', 'supabase', 'prisma', 'elasticsearch',
  'tensorflow', 'pytorch', 'scikit-learn', 'keras', 'hugging face', 'langchain', 'pandas', 'numpy', 'opencv',
  'figma', 'storybook', 'graphql', 'rest', 'grpc', 'git', 'linux', 'bash', 'shell',
  'markdown', 'documentation', 'docs', 'testing', 'jest', 'pytest', 'playwright', 'cypress', 'selenium', 'vitest',
  'owasp', 'oauth / jwt', 'websockets', 'unity', 'godot'
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
  scala: 'Scala',
  elixir: 'Elixir',
  haskell: 'Haskell',
  lua: 'Lua',
  html: 'HTML',
  html5: 'HTML5',
  css: 'CSS',
  css3: 'CSS3',
  react: 'React',
  vue: 'Vue.js',
  'vue.js': 'Vue.js',
  angular: 'Angular',
  svelte: 'Svelte',
  'next.js': 'Next.js',
  'nuxt.js': 'Nuxt.js',
  'tailwind css': 'Tailwind CSS',
  'node.js': 'Node.js',
  express: 'Express.js',
  'express.js': 'Express.js',
  expressjs: 'Express.js',
  nestjs: 'NestJS',
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  spring: 'Spring',
  'spring boot': 'Spring Boot',
  'ruby on rails': 'Ruby on Rails',
  laravel: 'Laravel',
  'asp.net core': 'ASP.NET Core',
  'react native': 'React Native',
  flutter: 'Flutter',
  expo: 'Expo',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  terraform: 'Terraform',
  ansible: 'Ansible',
  jenkins: 'Jenkins',
  'github actions': 'GitHub Actions',
  aws: 'AWS',
  'google cloud (gcp)': 'Google Cloud (GCP)',
  'microsoft azure': 'Microsoft Azure',
  nginx: 'Nginx',
  prometheus: 'Prometheus',
  grafana: 'Grafana',
  sql: 'SQL',
  sqlite: 'SQLite',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  redis: 'Redis',
  supabase: 'Supabase',
  prisma: 'Prisma',
  elasticsearch: 'Elasticsearch',
  tensorflow: 'TensorFlow',
  pytorch: 'PyTorch',
  'scikit-learn': 'Scikit-learn',
  keras: 'Keras',
  'hugging face': 'Hugging Face',
  langchain: 'LangChain',
  pandas: 'Pandas',
  numpy: 'NumPy',
  opencv: 'OpenCV',
  figma: 'Figma',
  storybook: 'Storybook',
  graphql: 'GraphQL',
  rest: 'REST APIs',
  'rest api': 'REST APIs',
  'rest apis': 'REST APIs',
  restful: 'REST APIs',
  grpc: 'gRPC',
  git: 'Git',
  linux: 'Linux',
  bash: 'Bash',
  shell: 'Shell',
  markdown: 'Markdown',
  documentation: 'Documentation',
  docs: 'Documentation',
  testing: 'Testing',
  jest: 'Jest',
  pytest: 'Pytest',
  playwright: 'Playwright',
  cypress: 'Cypress',
  selenium: 'Selenium',
  vitest: 'Vitest',
  owasp: 'OWASP',
  'oauth / jwt': 'OAuth / JWT',
  websockets: 'WebSockets',
  unity: 'Unity',
  godot: 'Godot'
};

function formatSkillName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const clean = raw.trim();
  const lower = clean.toLowerCase();
  return SKILL_DISPLAY_NAMES[lower] || (clean.charAt(0).toUpperCase() + clean.slice(1));
}

const CANONICAL_SKILL_ALIASES = {
  golang: 'go',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  node: 'node.js',
  nodejs: 'node.js',
  'react.js': 'react',
  reactjs: 'react',
  cpp: 'c++',
  csharp: 'c#',
  docs: 'documentation',
  html5: 'html',
  css3: 'css',
  'vue.js': 'vue',
  express: 'express.js',
  expressjs: 'express.js',
  'express.js': 'express.js',
  rest: 'rest apis',
  'rest api': 'rest apis',
  restful: 'rest apis',
  'rest apis': 'rest apis',
  'shell / bash': 'bash'
};

function toCanonicalSkill(raw) {
  const trimmed = String(raw || '').trim().toLowerCase();
  if (!trimmed) return '';
  return CANONICAL_SKILL_ALIASES[trimmed] || trimmed;
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
    const canonical = toCanonicalSkill(rawName);
    if (!canonical) continue;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      normalized.push(canonical);
    }
  }
  return normalized;
}

const STRICT_PROSE_TOKENS = new Set(['c', 'go', 'bash', 'shell', 'rest', 'express', 'spring']);

function extractRequiredSkillsFromContext(issues = [], targetContext = null) {
  const detected = new Set();

  const addExplicit = (val) => {
    if (!val || typeof val !== 'string') return;
    const clean = val.trim();
    if (!clean || /^(all|unknown|other|none|markdown)$/i.test(clean)) return;
    const canonical = toCanonicalSkill(clean);
    if (canonical) detected.add(canonical);
  };

  const scanTextForSkills = (text, { strict = true } = {}) => {
    if (!text || typeof text !== 'string') return;
    const raw = text.trim();
    if (!raw) return;
    const lower = raw.toLowerCase();

    for (const skill of KNOWN_TECH_SKILLS) {
      if (strict && STRICT_PROSE_TOKENS.has(skill)) {
        if (skill === 'go') {
          if (/(^|[^a-zA-Z0-9])Go([^a-zA-Z0-9]|$)/.test(raw) || /\bgolang\b/i.test(raw)) {
            detected.add('go');
          }
        } else if (skill === 'c') {
          if (/(^|[^a-zA-Z0-9+])(ANSI\s+C|C\s+language|C\/C\+\+)([^a-zA-Z0-9+]|$)/i.test(raw)) {
            detected.add('c');
          }
        } else if (skill === 'rest') {
          if (/(^|[^a-zA-Z0-9])(REST|REST\s+API|RESTful)([^a-zA-Z0-9]|$)/.test(raw)) {
            detected.add('rest apis');
          }
        } else if (skill === 'express') {
          if (/\bExpress\.js\b/i.test(raw) || /\bexpressjs\b/i.test(raw)) {
            detected.add('express.js');
          }
        } else if (skill === 'spring') {
          if (/\bSpring\s+Boot\b/i.test(raw) || /\bSpring\s+Framework\b/i.test(raw)) {
            detected.add('spring boot');
          }
        } else if (skill === 'bash' || skill === 'shell') {
          if (/\b(bash|shell\s+script|zsh)\b/i.test(raw)) {
            detected.add('bash');
          }
        }
        continue;
      }

      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, 'i');
      if (regex.test(lower)) {
        const canonical = toCanonicalSkill(skill);
        if (canonical) detected.add(canonical);
      }
    }
  };

  if (targetContext && typeof targetContext === 'object') {
    if (Array.isArray(targetContext.requiredSkills)) {
      for (const s of targetContext.requiredSkills) addExplicit(typeof s === 'string' ? s : s?.name);
    }
    addExplicit(targetContext.language);
    addExplicit(targetContext.repoLanguage);
    if (Array.isArray(targetContext.repoTopics)) {
      for (const topic of targetContext.repoTopics) {
        const tc = toCanonicalSkill(String(topic || ''));
        if (tc && KNOWN_TECH_SKILLS.includes(String(topic || '').toLowerCase())) detected.add(tc);
        else scanTextForSkills(String(topic || ''), { strict: false });
      }
    }
    scanTextForSkills(targetContext.title, { strict: true });
    scanTextForSkills(targetContext.description || targetContext.body, { strict: true });
    if (Array.isArray(targetContext.labels)) {
      for (const lbl of targetContext.labels) {
        scanTextForSkills(typeof lbl === 'string' ? lbl : lbl?.name, { strict: false });
      }
    }
  }

  const safeIssues = Array.isArray(issues) ? issues : [];
  for (const iss of safeIssues.slice(0, 12)) {
    if (!iss || typeof iss !== 'object') continue;
    if (Array.isArray(iss.requiredSkills)) {
      for (const s of iss.requiredSkills) addExplicit(typeof s === 'string' ? s : s?.name);
    }
    addExplicit(iss.language);
    addExplicit(iss.repoLanguage);

    const topics = Array.isArray(iss.repoTopics) ? iss.repoTopics : (Array.isArray(iss.topics) ? iss.topics : []);
    for (const topic of topics) {
      const tLower = String(topic || '').trim().toLowerCase();
      if (!tLower) continue;
      if (KNOWN_TECH_SKILLS.includes(tLower) || CANONICAL_SKILL_ALIASES[tLower]) {
        const tc = toCanonicalSkill(tLower);
        if (tc) detected.add(tc);
      }
    }

    scanTextForSkills(iss.repoName, { strict: true });
    scanTextForSkills(iss.title, { strict: true });
    scanTextForSkills(iss.body || iss.description, { strict: true });
    if (Array.isArray(iss.labels)) {
      for (const lbl of iss.labels) {
        const lname = String(typeof lbl === 'string' ? lbl : (lbl?.name || '')).trim().toLowerCase();
        if (KNOWN_TECH_SKILLS.includes(lname) || CANONICAL_SKILL_ALIASES[lname]) {
          const lc = toCanonicalSkill(lname);
          if (lc) detected.add(lc);
        } else {
          scanTextForSkills(lname, { strict: true });
        }
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
function extractRepositorySkillsFromContext(targetContext = null) {
  const repoSkills = new Set();
  if (!targetContext || typeof targetContext !== 'object') return [];

  const repos = Array.isArray(targetContext.repositories)
    ? targetContext.repositories
    : (Array.isArray(targetContext.repos) ? targetContext.repos : []);

  for (const repo of repos) {
    if (!repo || typeof repo !== 'object') continue;
    if (repo.language && repo.language !== 'Unknown' && repo.language !== 'Other') {
      const canonical = toCanonicalSkill(repo.language);
      if (canonical) repoSkills.add(canonical);
    }
    if (Array.isArray(repo.topics)) {
      for (const topic of repo.topics) {
        const canonical = toCanonicalSkill(topic);
        if (canonical && KNOWN_TECH_SKILLS.includes(canonical)) {
          repoSkills.add(canonical);
        }
      }
    }
  }

  if (Array.isArray(targetContext.languageDistribution)) {
    for (const item of targetContext.languageDistribution) {
      if (item && item.language && item.language !== 'Unknown' && item.language !== 'Other') {
        const canonical = toCanonicalSkill(item.language);
        if (canonical) repoSkills.add(canonical);
      }
    }
  }

  return Array.from(repoSkills);
}

function classifyIssueEvidence(issue) {
  if (!issue || typeof issue !== 'object') {
    return { isGfi: false, isHw: false, isComplex: false, evidenceDifficulty: 'Unclassified' };
  }
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const labelNames = labels.map(l => (typeof l === 'string' ? l : (l?.name || '')).toLowerCase());
  const titleLower = String(issue.title || '').toLowerCase();

  const isGfi = Boolean(
    issue.category === 'good-first-issue' ||
    labelNames.some(n =>
      n.includes('good first issue') ||
      n.includes('good-first-issue') ||
      n.includes('beginner') ||
      n.includes('starter') ||
      n.includes('first-timers-only') ||
      n.includes('up-for-grabs') ||
      n === 'easy'
    )
  );

  const isHw = Boolean(
    issue.category === 'help-wanted' ||
    labelNames.some(n => n.includes('help wanted') || n.includes('contributions welcome'))
  );

  const isComplex = Boolean(
    labelNames.some(n =>
      n.includes('breaking') ||
      n.includes('complex') ||
      n.includes('expert') ||
      n.includes('security') ||
      n.includes('architecture')
    ) ||
    (/\b(breaking|kernel|consensus|distributed lock)\b/.test(titleLower) && !isGfi)
  );

  let evidenceDifficulty = 'Unclassified';
  if (isComplex) {
    evidenceDifficulty = 'Advanced';
  } else if (isGfi) {
    evidenceDifficulty = 'Beginner';
  } else if (isHw) {
    evidenceDifficulty = 'Intermediate';
  } else if (issue.difficulty === 'Advanced' || issue.difficulty === 'Intermediate') {
    evidenceDifficulty = issue.difficulty;
  }

  return { isGfi, isHw, isComplex, evidenceDifficulty };
}

function calculateContributionReadiness(userProfile = null, issues = [], targetContext = null) {
  const safeUser = userProfile && typeof userProfile === 'object' ? userProfile : {};
  const safeIssues = Array.isArray(issues) ? issues.filter(Boolean) : [];
  const safeContext = targetContext && typeof targetContext === 'object' ? targetContext : {};

  const declaredSkills = normalizeSkillList(safeUser.skills || safeContext.userSkills);
  const validLevels = ['Beginner', 'Intermediate', 'Advanced'];
  const rawExp = String(safeUser.experience_level || safeContext.experienceLevel || '').trim();
  const isUnonboardedEmptyUser = Boolean(safeUser.id && !safeUser.is_onboarded && declaredSkills.length === 0 && !safeContext.experienceLevel);
  const hasConfiguredExperience = validLevels.includes(rawExp) && !isUnonboardedEmptyUser;
  const experienceLevel = hasConfiguredExperience ? rawExp : 'Unconfigured';

  const issueRequiredSkills = extractRequiredSkillsFromContext(safeIssues, safeContext);
  const repoSkills = extractRepositorySkillsFromContext(safeContext);
  const effectiveRequiredSkills = issueRequiredSkills.length > 0 ? issueRequiredSkills : repoSkills;

  const matchedIssueCanonical = issueRequiredSkills.filter(reqSkill => declaredSkills.includes(reqSkill));
  const matchedRepoCanonical = repoSkills.filter(rs => declaredSkills.includes(rs));
  const matchedCanonical = effectiveRequiredSkills.filter(reqSkill => declaredSkills.includes(reqSkill));
  const missingCanonical = effectiveRequiredSkills.filter(reqSkill => !declaredSkills.includes(reqSkill));

  const matchedSkills = matchedCanonical.map(formatSkillName);
  const missingSkills = missingCanonical.slice(0, 6).map(formatSkillName);
  const verifiedRepoSkills = matchedRepoCanonical.map(formatSkillName);

  const syncState = safeContext.syncState && typeof safeContext.syncState === 'object' ? safeContext.syncState : null;
  const githubConnected = Boolean(safeUser.github_id || safeContext.githubConnected || syncState);
  const verifiedReposCount = Array.isArray(safeContext.repositories)
    ? safeContext.repositories.length
    : (syncState ? Math.max(0, Number(syncState.totalRepos) || 0) : 0);
  const verifiedCommits = syncState ? Math.max(0, Number(syncState.totalCommits) || 0) : 0;
  const verifiedPrsCreated = syncState ? Math.max(0, Number(syncState.prsCreated) || 0) : 0;
  const verifiedPrsMerged = syncState ? Math.max(0, Number(syncState.prsMerged) || 0) : 0;
  const verifiedIssuesCreated = syncState ? Math.max(0, Number(syncState.issuesCreated) || 0) : 0;
  const verifiedContributions = syncState
    ? Math.max(0, Number(syncState.contributionsCount) || (verifiedCommits + verifiedPrsCreated + verifiedIssuesCreated))
    : 0;

  let contribProofBonus = 0;
  if (githubConnected && verifiedContributions > 0) {
    if (verifiedPrsMerged > 0 || verifiedContributions >= 10) contribProofBonus = 3;
    else if (verifiedPrsCreated > 0 || verifiedCommits >= 5 || verifiedContributions >= 3) contribProofBonus = 2;
    else contribProofBonus = 1;
  }

  // --- Factor 1: Skill, Repository & Contribution Alignment (Max 35 pts, 0 baseline when missing/unmatched) ---
  let skillAlignmentPoints = 0;
  let skillAlignmentReason = '';
  if (declaredSkills.length === 0) {
    skillAlignmentPoints = 0;
    skillAlignmentReason = 'No programming skills declared yet. Add your skills in Profile/Onboarding to compute skill alignment.';
  } else if (issueRequiredSkills.length === 0 && repoSkills.length === 0) {
    skillAlignmentPoints = 0;
    skillAlignmentReason = 'No GitHub repository languages or issue requirements available to verify skill alignment.';
  } else if (issueRequiredSkills.length === 0 && repoSkills.length > 0) {
    const repoRatio = matchedRepoCanonical.length / repoSkills.length;
    if (matchedRepoCanonical.length === 0) {
      skillAlignmentPoints = 0;
      skillAlignmentReason = `0 of ${repoSkills.length} detected GitHub repository language(s) match your declared skills.`;
    } else {
      const repoBonus = matchedRepoCanonical.length >= 2 ? 6 : 4;
      skillAlignmentPoints = Math.min(35, Math.round(repoRatio * 26) + repoBonus + contribProofBonus);
      skillAlignmentReason = `Matched ${matchedRepoCanonical.length} of ${repoSkills.length} GitHub repository language(s) (${verifiedRepoSkills.slice(0, 4).join(', ')})${contribProofBonus > 0 ? ` with ${verifiedContributions} verified contribution(s)` : ''}.`;
    }
  } else if (matchedIssueCanonical.length === 0) {
    if (matchedRepoCanonical.length > 0) {
      skillAlignmentPoints = Math.min(8, matchedRepoCanonical.length * 2 + (contribProofBonus > 0 ? 1 : 0));
      skillAlignmentReason = `0 issue skills matched (${issueRequiredSkills.length} required), with ${matchedRepoCanonical.length} transferable GitHub repository language(s).`;
    } else {
      skillAlignmentPoints = 0;
      skillAlignmentReason = `0 of ${issueRequiredSkills.length} required repository/issue skill(s) match your declared profile.`;
    }
  } else {
    const ratio = matchedIssueCanonical.length / issueRequiredSkills.length;
    const baseMatchPts = Math.round(ratio * 25);
    const breadthBonus = matchedIssueCanonical.length >= 2 ? 5 : 3;
    const repoOverlapCount = matchedIssueCanonical.filter(s => matchedRepoCanonical.includes(s)).length;
    const repoProofBonus = repoOverlapCount > 0 ? 2 : 0;
    skillAlignmentPoints = Math.min(35, baseMatchPts + breadthBonus + repoProofBonus + contribProofBonus);
    skillAlignmentReason = repoOverlapCount > 0
      ? `Matched ${matchedIssueCanonical.length} of ${issueRequiredSkills.length} issue requirement(s) with ${repoOverlapCount} proven in your GitHub repositories${contribProofBonus > 0 ? ` and ${verifiedContributions} verified contribution(s)` : ''}.`
      : `Matched ${matchedIssueCanonical.length} of ${issueRequiredSkills.length} detected repository/issue skill requirement(s)${contribProofBonus > 0 ? ` with ${verifiedContributions} verified contribution(s)` : ''}.`;
  }

  // --- Factor 2: Developer Profile & Experience (Max 25 pts) ---
  let profileFoundationPoints = 0;
  if (declaredSkills.length >= 4) profileFoundationPoints += 10;
  else if (declaredSkills.length === 3) profileFoundationPoints += 8;
  else if (declaredSkills.length === 2) profileFoundationPoints += 6;
  else if (declaredSkills.length === 1) profileFoundationPoints += 4;

  if (experienceLevel === 'Advanced') profileFoundationPoints += 10;
  else if (experienceLevel === 'Intermediate') profileFoundationPoints += 8;
  else if (experienceLevel === 'Beginner') profileFoundationPoints += 6;

  const trimmedName = safeUser.name ? String(safeUser.name).trim() : '';
  const hasName = trimmedName.length > 0;
  const trimmedBio = safeUser.bio ? String(safeUser.bio).trim() : '';
  const isDefaultSignupBio = trimmedBio === 'Open source developer exploring community projects.';
  const hasBio = Boolean(trimmedBio.length > 5 && (!isDefaultSignupBio || safeUser.is_onboarded));
  const isOnboarded = Boolean(safeUser.is_onboarded);
  if (hasName && (isOnboarded || declaredSkills.length > 0 || safeUser.experience_level)) profileFoundationPoints += 2;
  if (hasBio) profileFoundationPoints += 1;
  if (isOnboarded) profileFoundationPoints += 2;
  profileFoundationPoints = Math.min(25, profileFoundationPoints);

  const profileFoundationReason = experienceLevel === 'Unconfigured'
    ? `Experience level is unconfigured with ${declaredSkills.length} declared skill(s); complete onboarding/profile setup.`
    : `${experienceLevel} experience level with ${declaredSkills.length} declared skill(s)${isOnboarded ? ' and completed onboarding profile' : ''}.`;

  // --- Factor 3: Issue Difficulty & Requirement Fit (Max 25 pts) ---
  let issueClarityPoints = 0;
  let issueClarityReason = '';

  const singleIssue = safeContext.issue || (safeIssues.length === 1 ? safeIssues[0] : null);
  if (singleIssue) {
    const evidence = classifyIssueEvidence(singleIssue);
    const issueDifficulty = evidence.evidenceDifficulty;

    if (experienceLevel === 'Unconfigured') {
      issueClarityPoints += 0;
    } else if (experienceLevel === 'Beginner') {
      if (issueDifficulty === 'Beginner') issueClarityPoints += 15;
      else if (issueDifficulty === 'Intermediate') issueClarityPoints += 9;
      else if (issueDifficulty === 'Unclassified') issueClarityPoints += 7;
      else issueClarityPoints += 4;
    } else if (experienceLevel === 'Intermediate') {
      if (issueDifficulty === 'Beginner' || issueDifficulty === 'Intermediate') issueClarityPoints += 14;
      else if (issueDifficulty === 'Unclassified') issueClarityPoints += 11;
      else issueClarityPoints += 9;
    } else {
      if (issueDifficulty === 'Advanced' || issueDifficulty === 'Intermediate') issueClarityPoints += 15;
      else issueClarityPoints += 13;
    }

    const descText = String(singleIssue.body || singleIssue.description || singleIssue.title || '').trim();
    if (descText.length >= 80) issueClarityPoints += 6;
    else if (descText.length >= 25) issueClarityPoints += 4;
    else if (descText.length > 0) issueClarityPoints += 2;

    const rawComments = Number(singleIssue.commentsCount ?? singleIssue.comments ?? 0);
    const comments = Number.isFinite(rawComments) ? Math.max(0, Math.round(rawComments)) : 0;
    if (descText.length > 0) {
      if (comments <= 6) issueClarityPoints += 4;
      else if (comments <= 12) issueClarityPoints += 2;
    }

    issueClarityPoints = Math.min(25, Math.max(0, Math.round(issueClarityPoints)));
    issueClarityReason = experienceLevel === 'Unconfigured'
      ? `Target issue difficulty is ${issueDifficulty} (${comments} comments); configure your experience level to score difficulty fit.`
      : `Selected issue is rated ${issueDifficulty} (${comments} comment${comments === 1 ? '' : 's'}) vs. your ${experienceLevel} level.`;
  } else if (safeIssues.length > 0) {
    const compatibleByDiff = experienceLevel === 'Unconfigured'
      ? []
      : safeIssues.filter(iss => {
          const diff = classifyIssueEvidence(iss).evidenceDifficulty;
          if (experienceLevel === 'Beginner') return diff === 'Beginner';
          if (experienceLevel === 'Intermediate') return diff === 'Beginner' || diff === 'Intermediate';
          return diff !== 'Unclassified';
        });
    const diffRatio = compatibleByDiff.length / safeIssues.length;
    const wellDescribed = safeIssues.filter(iss => {
      const txt = String(iss.body || iss.description || iss.title || '').trim();
      return txt.length >= 20;
    }).length / safeIssues.length;

    if (experienceLevel === 'Unconfigured') {
      issueClarityPoints = Math.min(8, Math.max(0, Math.round(wellDescribed * 8)));
      issueClarityReason = `Difficulty fit could not be scored because your experience level is unconfigured (${safeIssues.length} issue(s) inspected for clarity).`;
    } else {
      issueClarityPoints = Math.min(25, Math.max(0, Math.round((diffRatio * 17) + (wellDescribed * 8))));
      issueClarityReason = `${compatibleByDiff.length} of ${safeIssues.length} active issue(s) match your ${experienceLevel} difficulty tier with clear requirements.`;
    }
  } else {
    issueClarityPoints = 0;
    issueClarityReason = 'No GitHub issues available to evaluate issue difficulty and requirement clarity.';
  }

  // --- Factor 4: Beginner-Friendly Issue Availability, Roadmap & Contribution Activity (Max 15 pts) ---
  let availabilityPoints = 0;
  let availabilityReason = '';

  let gfiCount = 0;
  let hwCount = 0;
  for (const iss of safeIssues) {
    const ev = classifyIssueEvidence(iss);
    if (ev.isGfi) gfiCount++;
    else if (ev.isHw) hwCount++;
  }
  const beginnerFriendlyTotal = gfiCount + hwCount;

  if (safeIssues.length > 0 && beginnerFriendlyTotal > 0) {
    if (beginnerFriendlyTotal >= 4) availabilityPoints += (gfiCount > 0 ? 8 : 6);
    else if (beginnerFriendlyTotal >= 2) availabilityPoints += (gfiCount > 0 ? 7 : 5);
    else if (beginnerFriendlyTotal === 1) availabilityPoints += (gfiCount > 0 ? 5 : 3);
  }

  const hasExplicitRoadmapCount = safeContext.roadmapCompletedCount !== undefined && safeContext.roadmapCompletedCount !== null;
  let roadmapCompletedCount = 0;
  let roadmapVerified = false;
  if (hasExplicitRoadmapCount) {
    const parsedRoadmap = Number(safeContext.roadmapCompletedCount);
    roadmapCompletedCount = Number.isFinite(parsedRoadmap) ? Math.min(14, Math.max(0, Math.round(parsedRoadmap))) : 0;
    roadmapVerified = Boolean(safeUser.id || safeContext.roadmapVerified);
  } else if (safeUser.id) {
    try {
      roadmapCompletedCount = Math.min(14, Math.max(0, getUserRoadmapProgress(safeUser.id).length));
      roadmapVerified = true;
    } catch (e) {
      roadmapCompletedCount = 0;
      roadmapVerified = false;
    }
  }
  const roadmapBonus = Math.min(5, Math.max(0, Math.round((roadmapCompletedCount / 14) * 5)));
  const contribActivityBonus = githubConnected
    ? (verifiedPrsMerged > 0 || verifiedContributions >= 5 ? 2 : (verifiedContributions > 0 ? 1 : 0))
    : 0;
  availabilityPoints = Math.min(15, Math.max(0, Math.round(availabilityPoints + roadmapBonus + contribActivityBonus)));
  availabilityReason = safeIssues.length === 0
    ? `No GitHub issue results available to count beginner-friendly tasks; ${roadmapCompletedCount}/14 roadmap stages completed; ${verifiedContributions} verified GitHub contribution(s).`
    : (beginnerFriendlyTotal === 0
        ? `No eligible Good First Issue or Help Wanted issues found among ${safeIssues.length} result(s); ${roadmapCompletedCount}/14 roadmap stages completed; ${verifiedContributions} verified contribution(s).`
        : `${gfiCount} Good First Issue(s) and ${hwCount} Help Wanted issue(s) verified; ${roadmapCompletedCount}/14 roadmap stages completed; ${verifiedContributions} verified contribution(s).`);

  skillAlignmentPoints = Math.min(35, Math.max(0, Math.round(skillAlignmentPoints)));
  profileFoundationPoints = Math.min(25, Math.max(0, Math.round(profileFoundationPoints)));
  issueClarityPoints = Math.min(25, Math.max(0, Math.round(issueClarityPoints)));
  availabilityPoints = Math.min(15, Math.max(0, Math.round(availabilityPoints)));

  const totalScore = Math.max(0, Math.min(100,
    skillAlignmentPoints + profileFoundationPoints + issueClarityPoints + availabilityPoints
  ));

  const pointsAwarded = totalScore;
  const pointsDeducted = Math.max(0, 100 - totalScore);
  const deductionReasons = [];
  if (skillAlignmentPoints < 35) deductionReasons.push(`-${35 - skillAlignmentPoints} pts in Skill Alignment (${skillAlignmentReason})`);
  if (profileFoundationPoints < 25) deductionReasons.push(`-${25 - profileFoundationPoints} pts in Developer Profile (${profileFoundationReason})`);
  if (issueClarityPoints < 25) deductionReasons.push(`-${25 - issueClarityPoints} pts in Issue Difficulty Fit (${issueClarityReason})`);
  if (availabilityPoints < 15) deductionReasons.push(`-${15 - availabilityPoints} pts in Issue Availability & Roadmap (${availabilityReason})`);

  const verifiedData = [];
  const unverifiedData = [];
  if (declaredSkills.length > 0) {
    verifiedData.push(`Declared skills verified (${declaredSkills.length} technical skill${declaredSkills.length === 1 ? '' : 's'}).`);
  } else {
    unverifiedData.push('Developer skills are not declared yet.');
  }
  if (experienceLevel !== 'Unconfigured') {
    verifiedData.push(`Experience tier verified (${experienceLevel}).`);
  } else {
    unverifiedData.push('Experience level is unconfigured.');
  }
  if (githubConnected) {
    verifiedData.push(`GitHub account connected (${verifiedReposCount} repository/repositories, ${verifiedContributions} verified contribution(s)).`);
    if (verifiedContributions === 0) {
      unverifiedData.push('Connected GitHub account has 0 verified recent contributions (commits, PRs, or issues).');
    }
  } else {
    unverifiedData.push('No GitHub account connected via OAuth (0 synced repositories and 0 verified contributions).');
  }
  if (repoSkills.length > 0) {
    verifiedData.push(`GitHub repository languages analyzed (${repoSkills.length} language${repoSkills.length === 1 ? '' : 's'}).`);
  } else {
    unverifiedData.push('No synced or fetched GitHub repository languages available.');
  }
  if (safeIssues.length > 0) {
    verifiedData.push(`${safeIssues.length} active issue(s) analyzed for difficulty and skill requirements.`);
    if (beginnerFriendlyTotal === 0) {
      unverifiedData.push('No eligible Good First Issue or Help Wanted tasks found in current issue results.');
    }
  } else {
    unverifiedData.push('No live or cached GitHub issues available for issue-level scoring.');
  }
  if (roadmapVerified) {
    verifiedData.push(`Roadmap completion verified (${roadmapCompletedCount}/14 stages).`);
  } else {
    unverifiedData.push('First Contribution Roadmap progress not linked to a verified DevNexus account (0/14).');
  }

  const hasSkills = declaredSkills.length > 0;
  const hasExperience = experienceLevel !== 'Unconfigured';
  const hasIssues = safeIssues.length > 0;
  const hasRepos = repoSkills.length > 0 || verifiedReposCount > 0;
  const hasGithubData = hasIssues || hasRepos;
  const isStale = Boolean(safeContext.isStale);
  const githubError = safeContext.githubError || null;
  const isSufficientData = Boolean(hasSkills && hasExperience && hasGithubData);
  const dataStatus = !isSufficientData ? 'insufficient' : (isStale || githubError ? 'stale_cached' : 'verified');

  let readinessLevel = 'Insufficient Data';
  let badgeClass = 'insufficient';
  if (isSufficientData) {
    if (totalScore >= 80) {
      readinessLevel = 'High Readiness';
      badgeClass = 'high';
    } else if (totalScore >= 60) {
      readinessLevel = 'Moderate Readiness';
      badgeClass = 'medium';
    } else if (totalScore >= 40) {
      readinessLevel = 'Developing Readiness';
      badgeClass = 'developing';
    } else {
      readinessLevel = 'Getting Started';
      badgeClass = 'low';
    }
  }

  const suggestions = [];
  if (!hasSkills || !hasExperience) {
    suggestions.push('Complete your developer profile (/onboarding?edit=1) with your technical skills and experience tier to unlock a verified readiness score.');
  } else if (declaredSkills.length < 3) {
    suggestions.push('Add at least 3 technical skills (e.g., Git, Documentation, or your primary stack) to broaden compatible repositories.');
  }

  if (!githubConnected) {
    suggestions.push('Connect your GitHub account via OAuth (/auth/github) to verify your repositories and contribution history.');
  } else if (!hasGithubData) {
    suggestions.push('GitHub issue or repository data is currently unavailable. Sync your GitHub account or wait for GitHub API recovery.');
  } else if (verifiedContributions === 0) {
    suggestions.push('Sync or push commits and Pull Requests on GitHub to verify active contribution history.');
  }

  if (missingSkills.length > 0) {
    suggestions.push(`Target repositories/issues reference skills not in your profile (${missingSkills.slice(0, 3).join(', ')}). Filter by your declared languages or add them once learned.`);
  }

  if (hasIssues && beginnerFriendlyTotal === 0) {
    suggestions.push('No eligible beginner-friendly ("good first issue" or "help wanted") issues were found in this result set. Switch tabs or broaden filters.');
  }

  if (roadmapCompletedCount < 14) {
    suggestions.push(`Complete the 14-stage First Contribution Roadmap (${roadmapCompletedCount}/14 done) at /roadmap to verify your Git fork, branch, and Pull Request workflow.`);
  }

  if (suggestions.length === 0) {
    suggestions.push('Your skill profile, repository alignment, and workflow readiness are strong. Pick a verified issue below and open your Pull Request!');
  }

  const sourceLabel = !hasGithubData
    ? 'GitHub data unavailable'
    : (isStale ? 'Preserved stale GitHub cache' : (safeContext.githubSource === 'synced' ? 'Synced GitHub SQLite & API' : 'Live / Cached GitHub API'));

  return {
    score: totalScore,
    isSufficientData,
    dataStatus,
    dataAvailability: {
      hasSkills,
      hasExperience,
      hasIssues,
      hasRepos,
      hasGithubData,
      githubConnected,
      verifiedReposCount,
      verifiedContributionsCount: verifiedContributions,
      verifiedCommits90d: verifiedCommits,
      verifiedPrsMerged,
      isStale,
      githubError,
      sourceLabel,
      noBeginnerIssuesFound: Boolean(hasIssues && beginnerFriendlyTotal === 0)
    },
    pointsAwarded,
    pointsDeducted,
    deductionReasons,
    verifiedData,
    unverifiedData,
    readinessLevel,
    badgeClass,
    experienceLevel,
    declaredSkills: declaredSkills.map(formatSkillName),
    repoLanguages: repoSkills.map(formatSkillName),
    verifiedRepoSkills,
    requiredSkills: effectiveRequiredSkills.map(formatSkillName),
    matchedSkills,
    missingSkills,
    beginnerFriendlyIssuesCount: beginnerFriendlyTotal,
    goodFirstIssuesCount: gfiCount,
    helpWantedIssuesCount: hwCount,
    roadmapCompletedCount,
    selectedIssue: singleIssue ? {
      title: singleIssue.title || '',
      repoName: singleIssue.repoName || '',
      number: singleIssue.number || null,
      htmlUrl: singleIssue.htmlUrl || null
    } : null,
    breakdown: {
      skillAlignment: {
        score: skillAlignmentPoints,
        maxScore: 35,
        deducted: 35 - skillAlignmentPoints,
        percentage: Math.round((skillAlignmentPoints / 35) * 100),
        label: 'Skill & Repository Alignment',
        explanation: skillAlignmentReason
      },
      profileFoundation: {
        score: profileFoundationPoints,
        maxScore: 25,
        deducted: 25 - profileFoundationPoints,
        percentage: Math.round((profileFoundationPoints / 25) * 100),
        label: 'Developer Profile & Experience',
        explanation: profileFoundationReason
      },
      issueClarity: {
        score: issueClarityPoints,
        maxScore: 25,
        deducted: 25 - issueClarityPoints,
        percentage: Math.round((issueClarityPoints / 25) * 100),
        label: 'Issue Difficulty & Requirement Fit',
        explanation: issueClarityReason
      },
      beginnerAvailability: {
        score: availabilityPoints,
        maxScore: 15,
        deducted: 15 - availabilityPoints,
        percentage: Math.round((availabilityPoints / 15) * 100),
        label: 'Beginner Issue Availability & Roadmap',
        explanation: availabilityReason
      }
    },
    suggestions,
    formulaExplanation: 'Rule-Based Formula (100 pts): Skill & Repository Alignment (35 pts) + Developer Profile & Experience (25 pts) + Issue Difficulty & Requirement Fit (25 pts) + Beginner Issue Availability & Roadmap Progress (15 pts).',
    assessmentDisclaimer: 'Estimated readiness assessment calculated deterministically from your saved profile, SQLite roadmap progress, GitHub repository languages, and real issue metadata — not a guarantee of contribution acceptance.'
  };
}

/**
 * Evaluates Contribution Readiness for a single specific issue and user profile.
 */
function evaluateIssueReadiness(userProfile, issue, targetContext = null) {
  const baseCtx = targetContext && typeof targetContext === 'object' ? targetContext : {};
  if (!issue || typeof issue !== 'object') {
    return calculateContributionReadiness(userProfile, [], baseCtx);
  }
  return calculateContributionReadiness(userProfile, [issue], { ...baseCtx, issue });
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
  const timestampCandidates = [repo.pushed_at, repo.updated_at, repo.updatedAtExact];
  let maintenancePoints = 0;
  let maintenanceDetail = '';
  let daysSinceUpdate = null;

  for (const candidate of timestampCandidates) {
    if (!candidate) continue;
    const parsedTime = new Date(candidate).getTime();
    if (!Number.isNaN(parsedTime) && Number.isFinite(parsedTime)) {
      daysSinceUpdate = Math.max(0, Math.floor((Date.now() - parsedTime) / (1000 * 60 * 60 * 24)));
      break;
    }
  }

  if (isArchived) {
    maintenancePoints = 4;
    maintenanceDetail = daysSinceUpdate !== null
      ? `Repository is archived (last updated ${daysSinceUpdate}d ago).`
      : 'Repository is archived and read-only.';
    if (daysSinceUpdate !== null) {
      verifiedMetrics.push(`Last repository update verified (${daysSinceUpdate} day${daysSinceUpdate === 1 ? '' : 's'} ago)`);
    }
    verifiedMetrics.push('Archive status verified (read-only)');
    risks.push('Repository is archived and read-only; new Pull Requests are likely not accepted.');
  } else if (daysSinceUpdate !== null) {
    verifiedMetrics.push(`Last repository update verified (${daysSinceUpdate} day${daysSinceUpdate === 1 ? '' : 's'} ago)`);
    if (daysSinceUpdate <= 7) {
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
      risks.push(`Repository has been inactive for ${daysSinceUpdate} days (>6 months). High star count does not override maintenance inactivity.`);
    }
  } else {
    maintenancePoints = 0;
    maintenanceDetail = 'Update timestamp missing from repository payload (unverified).';
    estimatedMetrics.push('Exact last-updated timestamp (pushed_at/updated_at) is unavailable; 0 maintenance points awarded.');
    risks.push('Exact last-updated timestamp is unavailable — maintenance recency could not be verified.');
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
  const parsedStars = (rawStars !== undefined && rawStars !== null && rawStars !== '' && Number.isFinite(Number(rawStars)))
    ? Math.max(0, Number(rawStars))
    : null;
  const stars = parsedStars ?? 0;

  const rawForks = repo.forks_count !== undefined ? repo.forks_count : repo.forks;
  const parsedForks = (rawForks !== undefined && rawForks !== null && rawForks !== '' && Number.isFinite(Number(rawForks)))
    ? Math.max(0, Number(rawForks))
    : null;
  const forks = parsedForks ?? 0;

  if (!hasIssuesEnabled) {
    issuePoints = 4;
    issueDetail = 'Issue tracker is disabled on this repository.';
    risks.push('GitHub Issues are disabled for this repository.');
  } else if (openIssues === null) {
    issuePoints = 0;
    issueDetail = 'Open issue count missing from repository payload (unverified).';
    estimatedMetrics.push('Open issue activity unavailable because open_issues_count field is missing; 0 points awarded.');
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
  if (parsedStars !== null || parsedForks !== null) {
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
    popularityPoints = 0;
    popularityDetail = 'Star/fork counts unavailable (unverified).';
    estimatedMetrics.push('Community traction unavailable due to missing star/fork counters; 0 popularity points awarded.');
  }

  const totalScore = Math.max(0, Math.min(100,
    maintenancePoints + docPoints + issuePoints + popularityPoints
  ));

  const isDataComplete = daysSinceUpdate !== null && openIssues !== null;
  let statusLabel = 'Needs Attention';
  let badgeClass = 'warning';
  if (isArchived) {
    statusLabel = 'Archived / Read-Only';
    badgeClass = 'danger';
  } else if (daysSinceUpdate !== null && daysSinceUpdate > 180) {
    statusLabel = 'Stale / Inactive';
    badgeClass = daysSinceUpdate > 365 ? 'danger' : 'warning';
  } else if (!isDataComplete) {
    statusLabel = (daysSinceUpdate === null && openIssues === null && !hasRealDescription && !rawLicense && parsedStars === null && parsedForks === null)
      ? 'Insufficient Data'
      : 'Incomplete Data';
    badgeClass = 'unknown';
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
    isDataComplete,
    daysSinceUpdate,
    factors: {
      maintenanceRecency: {
        score: maintenancePoints,
        maxScore: 35,
        percentage: Math.round((maintenancePoints / 35) * 100),
        label: 'Maintenance & Activity Recency',
        detail: maintenanceDetail,
        dataSource: daysSinceUpdate !== null ? 'Verified (GitHub API)' : 'Unavailable'
      },
      documentationQuality: {
        score: docPoints,
        maxScore: 25,
        percentage: Math.round((docPoints / 25) * 100),
        label: 'Documentation & Metadata',
        detail: docDetail,
        dataSource: hasRealDescription || rawLicense ? 'Verified + Inferred' : 'Unavailable'
      },
      issueBalance: {
        score: issuePoints,
        maxScore: 25,
        percentage: Math.round((issuePoints / 25) * 100),
        label: 'Issue Activity & Triage Balance',
        detail: issueDetail,
        dataSource: openIssues !== null ? 'Verified (GitHub API)' : 'Unavailable'
      },
      popularityContext: {
        score: popularityPoints,
        maxScore: 15,
        percentage: Math.round((popularityPoints / 15) * 100),
        label: 'Popularity Context (Capped 15%)',
        detail: popularityDetail,
        dataSource: (parsedStars !== null || parsedForks !== null) ? 'Verified (GitHub API)' : 'Unavailable'
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
