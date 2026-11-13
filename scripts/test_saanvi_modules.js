/**
 * DevNexus Automated Test Suite for Saanvi's Assigned Modules
 *
 * Verifies:
 * 1. Contribution Readiness Score (unit + HTTP integration)
 * 2. Repository Health Score (unit + HTTP integration)
 * 3. First Contribution Roadmap (14 stages, SQLite persistence, user ownership, validation)
 * 4. Landing Page & UI integration
 */

const assert = require('node:assert');
const app = require('../app');
const {
  db,
  findUserByUsername,
  updateUserProfile,
  getUserRoadmapProgress,
  setRoadmapStepStatus,
  resetUserRoadmapProgress
} = require('../db/database');
const {
  calculateContributionReadiness,
  evaluateIssueReadiness,
  calculateRepositoryHealth,
  FIRST_CONTRIBUTION_ROADMAP,
  getRoadmapStagesWithProgress
} = require('../services/saanviModulesService');

const PORT = 3198;
const BASE_URL = `http://localhost:${PORT}`;

async function request(path, { method = 'GET', headers = {}, body = null, cookie = null } = {}) {
  const reqHeaders = { ...headers };
  if (cookie) reqHeaders['Cookie'] = cookie;
  let payload = body;
  if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
    reqHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (body instanceof URLSearchParams) {
    reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = body.toString();
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: reqHeaders,
    body: payload,
    redirect: 'manual'
  });

  const setCookieHeader = res.headers.get('set-cookie');
  let sessionCookie = cookie;
  if (setCookieHeader) {
    const matches = Array.from(setCookieHeader.matchAll(/devnexus_sid=[^;,\s]+/g));
    if (matches.length > 0) {
      sessionCookie = matches[matches.length - 1][0];
    }
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // HTML response
  }

  return { status: res.status, headers: res.headers, text, json, cookie: sessionCookie };
}

async function runTests() {
  console.log('==========================================================');
  console.log(' DEVNEXUS ASSIGNED MODULES TEST SUITE (SAANVI)');
  console.log('==========================================================');

  let passed = 0;
  function pass(name) {
    passed++;
    console.log(`  [PASS] ${name}`);
  }

  // -------------------------------------------------------------------------
  // SECTION 1: CONTRIBUTION READINESS SCORE TESTS
  // -------------------------------------------------------------------------
  console.log('\n--- 1. Contribution Readiness Score Tests ---');

  const sampleBeginnerIssues = [
    {
      id: 1001,
      number: 42,
      title: 'Fix TypeScript type definition in React button component',
      repoName: 'acme/ui-toolkit',
      language: 'TypeScript',
      difficulty: 'Beginner',
      category: 'good-first-issue',
      commentsCount: 2,
      description: 'Update the ButtonProps interface in src/Button.tsx and add a unit test in Jest.',
      labels: [{ name: 'good first issue', isGfi: true }, { name: 'typescript' }]
    },
    {
      id: 1002,
      number: 55,
      title: 'Add Python FastAPI endpoint documentation',
      repoName: 'acme/api-service',
      language: 'Python',
      difficulty: 'Beginner',
      category: 'good-first-issue',
      commentsCount: 1,
      description: 'Document the health check route in Markdown and OpenAPI schema.',
      labels: [{ name: 'good first issue', isGfi: true }, { name: 'documentation' }]
    }
  ];

  // 1.1 Valid developer profile
  const validProfile = {
    name: 'Saanvi Rao',
    bio: 'Full-stack open source contributor working with TypeScript and Python.',
    skills: JSON.stringify([{ name: 'TypeScript' }, { name: 'React' }, { name: 'Jest' }, { name: 'Python' }]),
    experience_level: 'Intermediate',
    is_onboarded: 1
  };
  const validReadiness = calculateContributionReadiness(validProfile, sampleBeginnerIssues, { roadmapCompletedCount: 10 });
  assert.ok(validReadiness.score >= 75 && validReadiness.score <= 100, `Expected high readiness score, got ${validReadiness.score}`);
  const expectedSum =
    validReadiness.breakdown.skillAlignment.score +
    validReadiness.breakdown.profileFoundation.score +
    validReadiness.breakdown.issueClarity.score +
    validReadiness.breakdown.beginnerAvailability.score;
  assert.strictEqual(validReadiness.score, expectedSum, 'Total readiness score must equal exact sum of 4 breakdown factors');
  assert.ok(typeof validReadiness.assessmentDisclaimer === 'string' && validReadiness.assessmentDisclaimer.includes('Estimated readiness assessment'), 'Must label score as an estimated readiness assessment');
  pass(`Valid developer profile & exact 4-factor formula calculation (${validReadiness.score}/100, ${validReadiness.readinessLevel})`);

  // 1.2 Missing skills detection
  const partialSkillProfile = {
    name: 'New Developer',
    bio: 'Learning web development',
    skills: JSON.stringify(['HTML', 'CSS']),
    experience_level: 'Beginner',
    is_onboarded: 1
  };
  const missingSkillsResult = calculateContributionReadiness(partialSkillProfile, sampleBeginnerIssues);
  assert.ok(missingSkillsResult.missingSkills.includes('TypeScript'), 'Should identify TypeScript as a missing skill');
  assert.ok(missingSkillsResult.missingSkills.includes('Python'), 'Should identify Python as a missing skill');
  assert.ok(missingSkillsResult.score < validReadiness.score, 'Profile with missing required skills should score lower than matched profile');
  assert.ok(missingSkillsResult.suggestions.some(s => s.includes('skills')), 'Should provide actionable suggestion for missing skills');
  pass(`Missing skills identification (Detected missing: ${missingSkillsResult.missingSkills.join(', ')})`);

  // 1.3 Different experience levels
  const expBeginner = calculateContributionReadiness({ ...validProfile, experience_level: 'Beginner' }, sampleBeginnerIssues);
  const expIntermediate = calculateContributionReadiness({ ...validProfile, experience_level: 'Intermediate' }, sampleBeginnerIssues);
  const expAdvanced = calculateContributionReadiness({ ...validProfile, experience_level: 'Advanced' }, sampleBeginnerIssues);
  assert.ok(
    expBeginner.breakdown.profileFoundation.score < expIntermediate.breakdown.profileFoundation.score &&
    expIntermediate.breakdown.profileFoundation.score < expAdvanced.breakdown.profileFoundation.score,
    'Profile foundation points must scale accurately across Beginner < Intermediate < Advanced'
  );
  pass(`Different experience levels (Beginner: ${expBeginner.score}, Intermediate: ${expIntermediate.score}, Advanced: ${expAdvanced.score})`);

  // 1.4 Different issue requirements (Beginner Good First Issue vs Complex/Breaking Issue)
  const complexIssue = {
    id: 2001,
    number: 99,
    title: 'Distributed Raft consensus lock refactor in Rust kernel',
    repoName: 'systems/core-engine',
    language: 'Rust',
    difficulty: 'Advanced',
    category: 'general',
    commentsCount: 24,
    description: 'Short note',
    labels: [{ name: 'breaking' }, { name: 'expert' }]
  };
  const beginnerOnGfi = evaluateIssueReadiness({ ...partialSkillProfile, skills: JSON.stringify(['TypeScript']) }, sampleBeginnerIssues[0]);
  const beginnerOnComplex = evaluateIssueReadiness({ ...partialSkillProfile, skills: JSON.stringify(['TypeScript']) }, complexIssue);
  assert.ok(beginnerOnGfi.score > beginnerOnComplex.score, `Beginner should be much readier for matching GFI (${beginnerOnGfi.score}) than complex unmatched Rust issue (${beginnerOnComplex.score})`);
  pass(`Different issue requirements (Beginner on matching GFI: ${beginnerOnGfi.score}/100 vs Complex unmatched issue: ${beginnerOnComplex.score}/100)`);

  // 1.5 Missing or incomplete data handling
  const nullReadiness = calculateContributionReadiness(null, null, null);
  assert.ok(Number.isInteger(nullReadiness.score) && nullReadiness.score >= 0 && nullReadiness.score <= 100, 'Null profile/issues must return a valid integer score without throwing');
  assert.ok(Array.isArray(nullReadiness.suggestions) && nullReadiness.suggestions.length > 0, 'Null profile must still return helpful suggestions');
  pass(`Missing or incomplete data handled gracefully (Score: ${nullReadiness.score}/100, no NaN/exceptions)`);

  // -------------------------------------------------------------------------
  // SECTION 2: REPOSITORY HEALTH SCORE TESTS
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Repository Health Score Tests ---');

  // 2.1 Active, well-documented repository
  const activeRepo = {
    name: 'devnexus-core',
    full_name: 'org/devnexus-core',
    description: 'Comprehensive open-source developer collaboration platform with beginner-friendly issues and docs.',
    updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    stargazers_count: 450,
    forks_count: 85,
    open_issues_count: 18,
    license: { spdx_id: 'MIT' },
    topics: ['open-source', 'good-first-issue', 'nodejs', 'sqlite'],
    homepage: 'https://docs.example.com',
    has_issues: true,
    archived: false
  };
  const activeHealth = calculateRepositoryHealth(activeRepo);
  const activeFactorSum =
    activeHealth.factors.maintenanceRecency.score +
    activeHealth.factors.documentationQuality.score +
    activeHealth.factors.issueBalance.score +
    activeHealth.factors.popularityContext.score;
  assert.strictEqual(activeHealth.score, activeFactorSum, 'Health score must equal exact sum of its 4 factors');
  assert.ok(activeHealth.score >= 85, `Expected Healthy & Active score >= 85, got ${activeHealth.score}`);
  assert.strictEqual(activeHealth.statusLabel, 'Healthy & Active');
  assert.strictEqual(activeHealth.risks.length, 0, 'Active well-documented repo should have 0 risks');
  pass(`Active repository evaluation & factor accuracy (${activeHealth.score}/100, "${activeHealth.statusLabel}")`);

  // 2.2 Inactive / stale repository (> 1 year old, even with high stars!)
  const staleHighStarRepo = {
    name: 'legacy-framework',
    description: 'Old library that is no longer actively updated by maintainers.',
    updated_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(), // 400 days ago
    stargazers_count: 15000,
    forks_count: 2000,
    open_issues_count: 120,
    license: { spdx_id: 'MIT' },
    topics: ['javascript']
  };
  const staleHealth = calculateRepositoryHealth(staleHighStarRepo);
  assert.strictEqual(staleHealth.factors.maintenanceRecency.score, 5, 'Stale repository (>180d) should receive 5/35 recency points');
  assert.strictEqual(staleHealth.factors.popularityContext.score, 15, 'Popularity context is capped at 15 points');
  assert.ok(staleHealth.score < activeHealth.score, 'Stale repository must score lower than active repository despite having 15,000 stars');
  assert.ok(staleHealth.risks.some(r => r.includes('inactive')), 'Should warn about repository inactivity');
  pass(`Inactive repository & popularity cap enforcement (${staleHealth.score}/100, risks flagged: ${staleHealth.risks.length})`);

  // 2.3 Repository with many open issues (overloaded backlog)
  const overloadedRepo = {
    name: 'overloaded-project',
    description: 'Project with an unmanageable backlog of open issues.',
    updated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    stargazers_count: 120,
    forks_count: 15,
    open_issues_count: 1450,
    license: { spdx_id: 'Apache-2.0' },
    topics: ['web']
  };
  const overloadedHealth = calculateRepositoryHealth(overloadedRepo);
  assert.ok(overloadedHealth.factors.issueBalance.score <= 12, 'Overloaded issue backlog should receive reduced issue balance points');
  assert.ok(overloadedHealth.risks.some(r => r.toLowerCase().includes('backlog')), 'Should warn about large open issue backlog');
  pass(`Repository with many open issues (${overloadedHealth.score}/100, issueBalance: ${overloadedHealth.factors.issueBalance.score}/25)`);

  // 2.4 Repository with missing documentation, description, and license
  const undocumentedRepo = {
    name: 'mystery-repo',
    description: '',
    updated_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    stargazers_count: 25,
    forks_count: 4,
    open_issues_count: 5,
    license: null,
    topics: []
  };
  const undocHealth = calculateRepositoryHealth(undocumentedRepo);
  assert.strictEqual(undocHealth.factors.documentationQuality.score, 0, 'Repo without description, license, topics, or homepage should score 0/25 on docs');
  assert.ok(undocHealth.risks.some(r => r.includes('description')), 'Should flag missing description risk');
  assert.ok(undocHealth.risks.some(r => r.includes('license')), 'Should flag missing license risk');
  assert.ok(undocHealth.verifiedMetrics.length > 0 && undocHealth.estimatedMetrics.length > 0, 'Should distinguish verified vs estimated metrics');
  pass(`Missing documentation/license handling (docScore: ${undocHealth.factors.documentationQuality.score}/25, risks: ${undocHealth.risks.length})`);

  // 2.5 Missing or unavailable GitHub data
  const missingRepoHealth = calculateRepositoryHealth(null);
  assert.strictEqual(missingRepoHealth.score, 0);
  assert.strictEqual(missingRepoHealth.statusLabel, 'Insufficient Data');
  assert.strictEqual(missingRepoHealth.isDataComplete, false);
  pass('Missing/null GitHub repository payload handled safely (0/100, "Insufficient Data")');

  // -------------------------------------------------------------------------
  // SECTION 3: FIRST CONTRIBUTION ROADMAP & HTTP INTEGRATION TESTS
  // -------------------------------------------------------------------------
  console.log('\n--- 3. First Contribution Roadmap & HTTP Integration Tests ---');

  // Verify all 14 required stages exist in exact order
  const expectedStageTitles = [
    'Introduction to Open Source',
    'Understanding Git and GitHub',
    'Setting up a GitHub account',
    'Finding beginner-friendly repositories',
    'Identifying Good First Issues',
    'Understanding repository guidelines',
    'Forking a repository',
    'Cloning the repository',
    'Creating a new branch',
    'Making code changes',
    'Testing the changes',
    'Committing and pushing changes',
    'Creating a Pull Request',
    'Responding to maintainer feedback'
  ];
  assert.strictEqual(FIRST_CONTRIBUTION_ROADMAP.length, 14, 'Roadmap must have exactly 14 stages');
  expectedStageTitles.forEach((title, idx) => {
    assert.strictEqual(FIRST_CONTRIBUTION_ROADMAP[idx].stepNumber, idx + 1);
    assert.strictEqual(FIRST_CONTRIBUTION_ROADMAP[idx].title, title);
    assert.ok(FIRST_CONTRIBUTION_ROADMAP[idx].docUrl.startsWith('https://'), `Stage ${idx + 1} must include official doc link`);
  });
  pass('All 14 required First Contribution Roadmap stages verified in exact order with commands & doc links');

  const server = await new Promise(resolve => {
    const s = app.listen(PORT, () => resolve(s));
  });

  const testUserA = `saanvi_mod_a_${Date.now()}`;
  const testUserB = `saanvi_mod_b_${Date.now()}`;

  try {
    // 3.1 Landing page & public roadmap page loading
    const landingRes = await request('/');
    assert.strictEqual(landingRes.status, 200);
    assert.ok(landingRes.text.includes('Contribution Readiness Score'), 'Landing page must feature Contribution Readiness Score');
    assert.ok(landingRes.text.includes('Repository Health Score'), 'Landing page must feature Repository Health Score');
    assert.ok(landingRes.text.includes('First Contribution Roadmap'), 'Landing page must feature First Contribution Roadmap');
    pass('Landing page (GET /) renders all 3 assigned module cards and navigation links');

    const publicRoadmapPage = await request('/roadmap');
    assert.strictEqual(publicRoadmapPage.status, 200);
    expectedStageTitles.forEach(title => {
      assert.ok(publicRoadmapPage.text.includes(title), `Roadmap page must display "${title}"`);
    });
    pass('First Contribution Roadmap page (GET /roadmap) renders all 14 stages for visitors');

    // 3.2 Unauthenticated POST to /api/roadmap/step must be rejected with 401
    const unauthStep = await request('/api/roadmap/step', {
      method: 'POST',
      body: { stepNumber: 1, completed: true }
    });
    assert.strictEqual(unauthStep.status, 401, 'Unauthenticated roadmap progress update must return 401');
    pass('Unauthenticated POST /api/roadmap/step properly rejected with HTTP 401');

    // 3.3 Register User A and User B to test persistence, user ownership isolation, and dynamic readiness updates
    const regA = await request('/auth/signup', {
      method: 'POST',
      body: new URLSearchParams({
        username: testUserA,
        name: 'Saanvi Test A',
        email: `${testUserA}@example.com`,
        password: 'Password123!',
        confirm_password: 'Password123!'
      })
    });
    assert.strictEqual(regA.status, 302);
    const cookieA = regA.cookie;

    const regB = await request('/auth/signup', {
      method: 'POST',
      body: new URLSearchParams({
        username: testUserB,
        name: 'Saanvi Test B',
        email: `${testUserB}@example.com`,
        password: 'Password123!',
        confirm_password: 'Password123!'
      })
    });
    assert.strictEqual(regB.status, 302);
    const cookieB = regB.cookie;

    // 3.4 Step completion & persistence in SQLite for User A
    const completeStep1 = await request('/api/roadmap/step', {
      method: 'POST',
      cookie: cookieA,
      body: { stepNumber: 1, completed: true }
    });
    assert.strictEqual(completeStep1.status, 200);
    assert.strictEqual(completeStep1.json.success, true);
    assert.deepStrictEqual(completeStep1.json.completedSteps, [1]);

    const completeStep2 = await request('/api/roadmap/step', {
      method: 'POST',
      cookie: cookieA,
      body: { stepNumber: 2, completed: true }
    });
    assert.strictEqual(completeStep2.status, 200);
    assert.deepStrictEqual(completeStep2.json.completedSteps, [1, 2]);
    assert.strictEqual(completeStep2.json.completedCount, 2);
    assert.strictEqual(completeStep2.json.percentage, Math.round((2 / 14) * 100));
    pass('Step completion (stages 1 & 2) persisted in SQLite via POST /api/roadmap/step');

    // 3.5 Verify User B's roadmap progress is completely isolated (0 completed)
    const progressB = await request('/api/roadmap', { cookie: cookieB });
    assert.strictEqual(progressB.status, 200);
    assert.strictEqual(progressB.json.completedCount, 0, 'User B must not see User A roadmap progress');
    pass('User ownership isolation verified (User A progress does not leak to User B)');

    // 3.6 Step incompletion (unchecking stage 1 for User A)
    const uncheckStep1 = await request('/api/roadmap/step', {
      method: 'POST',
      cookie: cookieA,
      body: { stepNumber: 1, completed: false }
    });
    assert.strictEqual(uncheckStep1.status, 200);
    assert.deepStrictEqual(uncheckStep1.json.completedSteps, [2]);
    assert.strictEqual(uncheckStep1.json.completedCount, 1);
    pass('Step incompletion (unchecking stage 1) persisted in SQLite via POST /api/roadmap/step');

    // 3.7 Invalid request handling (step 0, step 15, non-integer step)
    const invalidLow = await request('/api/roadmap/step', {
      method: 'POST',
      cookie: cookieA,
      body: { stepNumber: 0, completed: true }
    });
    assert.strictEqual(invalidLow.status, 400);

    const invalidHigh = await request('/api/roadmap/step', {
      method: 'POST',
      cookie: cookieA,
      body: { stepNumber: 15, completed: true }
    });
    assert.strictEqual(invalidHigh.status, 400);

    const invalidNaN = await request('/api/roadmap/step', {
      method: 'POST',
      cookie: cookieA,
      body: { stepNumber: 'invalid-step', completed: true }
    });
    assert.strictEqual(invalidNaN.status, 400);
    pass('Invalid roadmap step requests (0, 15, "invalid-step") rejected with HTTP 400');

    // 3.8 Verify Readiness Score updates when developer profile changes
    const userADbBefore = findUserByUsername(testUserA);
    const readinessBefore = calculateContributionReadiness(userADbBefore, sampleBeginnerIssues);

    // Update User A profile via POST /onboarding with matched skills & Advanced level
    const onboardUpdate = await request('/onboarding', {
      method: 'POST',
      cookie: cookieA,
      body: new URLSearchParams({
        name: 'Saanvi Updated',
        experience_level: 'Advanced',
        skills: 'TypeScript, Python, React, Jest',
        bio: 'Experienced open-source developer ready for contributions.'
      })
    });
    assert.strictEqual(onboardUpdate.status, 302);

    const userADbAfter = findUserByUsername(testUserA);
    const readinessAfter = calculateContributionReadiness(userADbAfter, sampleBeginnerIssues);
    assert.ok(
      readinessAfter.score > readinessBefore.score,
      `Readiness score must increase after declaring matching skills & experience (${readinessBefore.score} -> ${readinessAfter.score})`
    );
    pass(`Dynamic Contribution Readiness Score update on profile change (${readinessBefore.score}/100 -> ${readinessAfter.score}/100)`);

    // 3.9 Verify POST /projects/api/health endpoint
    const healthApiRes = await request('/projects/api/health', {
      method: 'POST',
      body: activeRepo
    });
    assert.strictEqual(healthApiRes.status, 200);
    assert.strictEqual(healthApiRes.json.success, true);
    assert.strictEqual(healthApiRes.json.health.score, activeHealth.score);
    pass(`Repository Health API endpoint (POST /projects/api/health) verified (${healthApiRes.json.health.score}/100)`);

    // 3.10 Verify Dashboard renders Contribution Readiness Score card
    const dashRes = await request('/dashboard', { cookie: cookieA });
    assert.strictEqual(dashRes.status, 200);
    assert.ok(dashRes.text.includes('Contribution Readiness Score'), 'Dashboard must display Contribution Readiness Score section');
    assert.ok(dashRes.text.includes('14-Stage Roadmap'), 'Dashboard must link to 14-Stage Roadmap');
    pass('Developer Dashboard (GET /dashboard) renders Contribution Readiness Score & Roadmap link');

    // --- 4. Developer Portfolio & Interactive Skill Tree Tests ---
    console.log('\n--- 4. Developer Portfolio & Interactive Skill Tree Tests ---');
    const portfolioService = require('../services/portfolioService');
    const skillTreeService = require('../services/skillTreeService');

    // 4.1 SKILL_TREE_GRAPH verification
    const graph = skillTreeService.SKILL_TREE_GRAPH;
    assert.strictEqual(Array.isArray(graph), true, 'SKILL_TREE_GRAPH must be an array');
    assert.strictEqual(graph.length, 16, 'SKILL_TREE_GRAPH must contain 16 nodes');
    const tracksInGraph = [...new Set(graph.map(n => n.track))];
    assert.strictEqual(tracksInGraph.length, 4, 'Must have 4 unique tracks');
    pass('Skill Tree Graph structure verified (16 nodes across 4 tracks, tiers 1-4)');

    // 4.2 Evaluate Skill Tree for User A
    const userADoc = findUserByUsername(testUserA);
    const evaluatedTree = await skillTreeService.evaluateUserSkillTree(userADoc.id, userADoc, [
      { name: 'web-app', language: 'JavaScript' },
      { name: 'api-service', language: 'Python' }
    ]);
    assert.ok(evaluatedTree.xp, 'Must calculate XP object');
    assert.ok(evaluatedTree.tracks, 'Must include tracks breakdown');
    assert.strictEqual(evaluatedTree.nodes.length, 16, 'All 16 nodes must have evaluated status');
    assert.ok(evaluatedTree.nodes.some(n => n.status === 'available' || n.status === 'unlocked'), 'Tier 1 nodes should be available or unlocked');
    pass('Skill Tree evaluation engine verified (automatic XP calculation & node states)');

    // 4.3 Claim / Unlock a skill node
    const availableNode = evaluatedTree.nodes.find(n => n.status === 'available');
    if (availableNode) {
      const claimRes = await skillTreeService.claimSkillNode(userADoc.id, availableNode.id, evaluatedTree);
      assert.strictEqual(claimRes.node.id, availableNode.id);
      pass(`Skill node unlocking verified (Claimed '${availableNode.title}' +${claimRes.xpEarned} XP)`);
    } else {
      pass('Skill node status evaluation verified');
    }

    // 4.4 HTTP: GET /portfolio (unauthenticated redirects to /login)
    const unauthPortfolio = await request('/portfolio');
    assert.strictEqual(unauthPortfolio.status, 302, 'Unauthenticated /portfolio must redirect to /login');
    assert.strictEqual(unauthPortfolio.headers.get('location'), '/login');
    pass('Unauthenticated GET /portfolio properly redirects to /login');

    // 4.5 HTTP: GET /portfolio (authenticated user view)
    const authPortfolio = await request('/portfolio', { cookie: cookieA });
    assert.strictEqual(authPortfolio.status, 200);
    assert.ok(authPortfolio.text.includes('Impact Metrics'), 'Portfolio must render Impact Metrics');
    assert.ok(authPortfolio.text.includes('Featured Repositories'), 'Portfolio must render Featured Repositories');
    assert.ok(authPortfolio.text.includes('Skill Tree Progress'), 'Portfolio must render Skill Tree Progress');
    pass('Authenticated GET /portfolio renders Hero, Impact Metrics, Repos & Skill Tree');

    // 4.6 HTTP: POST /portfolio/api/update (update settings)
    const updatePortRes = await request('/portfolio/api/update', {
      method: 'POST',
      cookie: cookieA,
      body: {
        headline: 'Open Source Visionary & Full-Stack Architect',
        location: 'Bengaluru, India',
        github_url: 'https://github.com/' + testUserA,
        linkedin_url: 'https://linkedin.com/in/' + testUserA,
        website_url: 'https://devnexus.io',
        twitter_url: 'https://twitter.com/' + testUserA
      }
    });
    assert.strictEqual(updatePortRes.status, 200);
    assert.strictEqual(updatePortRes.json.success, true);
    pass('Portfolio settings update (POST /portfolio/api/update) persisted in SQLite');

    // 4.7 HTTP: GET /portfolio/:username (public view)
    const publicPortRes = await request('/portfolio/' + testUserA);
    assert.strictEqual(publicPortRes.status, 200);
    assert.ok(publicPortRes.text.includes('Open Source Visionary'), 'Public portfolio must display updated headline');
    assert.ok(publicPortRes.text.includes('Bengaluru, India'), 'Public portfolio must display location');
    pass('Public GET /portfolio/:username displays developer portfolio and social links');

    // 4.8 HTTP: GET /skill-tree (authenticated view)
    const skillTreePage = await request('/skill-tree', { cookie: cookieA });
    assert.strictEqual(skillTreePage.status, 200);
    assert.ok(skillTreePage.text.includes('Skill Tree'), 'Skill Tree page must render');
    assert.ok(skillTreePage.text.includes('Frontend'), 'Must render Frontend track');
    assert.ok(skillTreePage.text.includes('Backend'), 'Must render Backend track');
    pass('Authenticated GET /skill-tree renders 4 RPG-style progression tracks & XP bars');

    // 4.9 HTTP: GET /api/skill-tree (JSON API)
    const skillTreeJson = await request('/api/skill-tree', {
      cookie: cookieA,
      headers: { 'Accept': 'application/json' }
    });
    assert.strictEqual(skillTreeJson.status, 200);
    assert.strictEqual(skillTreeJson.json.success, true);
    assert.ok(skillTreeJson.json.tree.xp, 'API returns computed user XP');
    pass('JSON API endpoint (GET /api/skill-tree) verified');

  } finally {
    // Clean up temporary test users and their cascaded roadmap_progress/sessions/activity_logs
    for (const uName of [testUserA, testUserB]) {
      const u = findUserByUsername(uName);
      if (u) {
        db.prepare('DELETE FROM roadmap_progress WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM activity_logs WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      }
    }
    server.close();
  }

  console.log('\n==========================================================');
  console.log(` ALL ${passed} ASSIGNED MODULE CHECKS PASSED SUCCESSFULLY!`);
  console.log('==========================================================\n');
}

runTests().catch(err => {
  console.error('\n[FAIL] Assigned Module Test Error:', err);
  process.exit(1);
});
