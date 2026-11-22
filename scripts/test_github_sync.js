/**
 * DevNexus GitHub Activity Synchronization Test Suite
 * Tests two separate GitHub accounts, OAuth token encryption & zero-leakage guarantees,
 * paginated repo/event sync, commits/PRs/issues/branches/releases timeline,
 * strict per-user private repo isolation, rate-limit resilience, and API failure recovery.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('node:crypto');

require('dotenv').config();

const app = require('../app');
const {
  db,
  upsertGithubUser,
  findUserByUsername,
  saveUserGithubToken,
  getUserGithubSyncToken,
  createSession,
  getUserGithubSyncState
} = require('../db/database');

const {
  synchronizeUserGitHubActivity,
  runScheduledGithubSyncBatch,
  getUserDashboardSyncData
} = require('../services/githubSyncService');

function makeHeaders(map = {}) {
  return {
    get(key) {
      return map[String(key).toLowerCase()] ?? null;
    }
  };
}

function createMockFetch(datasetsByToken) {
  let networkCalls = 0;
  const requestedRepoUrls = [];

  async function mockFetch(url, options = {}) {
    networkCalls++;
    const auth = (options.headers && (options.headers.Authorization || options.headers.authorization)) || '';
    const token = auth.replace(/^Bearer\s+/i, '');

    if (token === 'gho_rate_limit_token') {
      return {
        ok: false,
        status: 403,
        headers: makeHeaders({
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-used': '5000',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
          'x-ratelimit-resource': 'core'
        }),
        async json() { return { message: 'API rate limit exceeded' }; }
      };
    }

    if (token === 'gho_network_down') {
      throw new Error('ECONNREFUSED simulated GitHub outage');
    }

    const dataset = datasetsByToken[token];
    if (!dataset) {
      return {
        ok: false,
        status: 401,
        headers: makeHeaders({ 'x-ratelimit-remaining': '60', 'x-ratelimit-limit': '60' }),
        async json() { return { message: 'Bad credentials' }; }
      };
    }

    const defaultHeaders = makeHeaders({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4950',
      'x-ratelimit-used': '50',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-ratelimit-resource': 'core'
    });

    if (url.endsWith('/user')) {
      return { ok: true, status: 200, headers: defaultHeaders, async json() { return dataset.profile; } };
    }

    if (url.includes('/user/repos')) {
      requestedRepoUrls.push(url);
      const pageMatch = url.match(/[?&]page=(\d+)/);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      const rawSlice = page === 1 ? dataset.reposPage1 : (page === 2 ? (dataset.reposPage2 || []) : []);
      // Mirror GitHub ?type=owner behavior unless dataset deliberately injects edge-case non-owner rows for defensive filter testing
      const slice = (url.includes('type=owner') && !dataset.injectNonOwnerOnTypeOwner)
        ? rawSlice.filter(r => !r.owner || (String(r.owner.type || 'User').toLowerCase() === 'user' && String(r.owner.id) === String(dataset.profile.id)))
        : rawSlice;
      const hasNext = page === 1 && Array.isArray(dataset.reposPage2) && dataset.reposPage2.length > 0;
      const headers = makeHeaders({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4940',
        'x-ratelimit-used': '60',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        link: hasNext ? '<https://api.github.com/user/repos?type=owner&per_page=100&page=2>; rel="next"' : ''
      });
      return { ok: true, status: 200, headers, async json() { return slice; } };
    }

    if (url.includes('/events')) {
      const pageMatch = url.match(/[?&]page=(\d+)/);
      const page = pageMatch ? Number(pageMatch[1]) : 1;
      return {
        ok: true,
        status: 200,
        headers: defaultHeaders,
        async json() { return page === 1 ? dataset.events : []; }
      };
    }

    if (url.includes('/search/issues') && url.includes('type%3Apr%20is%3Amerged')) {
      return {
        ok: true,
        status: 200,
        headers: defaultHeaders,
        async json() { return { total_count: dataset.prsMergedTotal, items: [] }; }
      };
    }

    if (url.includes('/search/issues') && url.includes('type%3Apr')) {
      return {
        ok: true,
        status: 200,
        headers: defaultHeaders,
        async json() { return { total_count: dataset.prsCreatedTotal, items: dataset.prItems || [] }; }
      };
    }

    if (url.includes('/search/issues') && url.includes('type%3Aissue')) {
      return {
        ok: true,
        status: 200,
        headers: defaultHeaders,
        async json() { return { total_count: dataset.issuesCreatedTotal, items: dataset.issueItems || [] }; }
      };
    }

    if (url.includes('/search/commits')) {
      return {
        ok: true,
        status: 200,
        headers: defaultHeaders,
        async json() { return { total_count: dataset.commits90dTotal, items: [] }; }
      };
    }

    if (url.includes('/releases')) {
      return {
        ok: true,
        status: 200,
        headers: defaultHeaders,
        async json() { return dataset.releases || []; }
      };
    }

    return { ok: false, status: 404, headers: defaultHeaders, async json() { return {}; } };
  }

  mockFetch.getCallCount = () => networkCalls;
  mockFetch.getRequestedRepoUrls = () => requestedRepoUrls.slice();
  return mockFetch;
}

async function runTests() {
  console.log('==========================================================');
  console.log(' DEVNEXUS GITHUB ACTIVITY SYNCHRONIZATION TEST SUITE');
  console.log('==========================================================\n');

  const suffix = Date.now().toString().slice(-6);
  const usernameA = `sync_alpha_${suffix}`;
  const usernameB = `sync_beta_${suffix}`;
  const ghIdA = `9910${suffix}`;
  const ghIdB = `9920${suffix}`;
  const tokenA = 'gho_alpha_secret_token_xyz';
  const tokenB = 'gho_beta_secret_token_abc';

  const nowIso = new Date().toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString();

  const datasets = {
    [tokenA]: {
      profile: { id: Number(ghIdA), login: usernameA, public_repos: 2, owned_private_repos: 1 },
      reposPage1: [
        {
          id: 10101,
          name: 'alpha-public-api',
          full_name: `${usernameA}/alpha-public-api`,
          html_url: `https://github.com/${usernameA}/alpha-public-api`,
          description: 'Alpha public REST API written in TypeScript with Express and SQLite.',
          language: 'TypeScript',
          private: false,
          fork: false,
          stargazers_count: 140,
          forks_count: 25,
          open_issues_count: 8,
          license: { spdx_id: 'MIT' },
          topics: ['typescript', 'api', 'good-first-issue'],
          homepage: 'https://alpha.example.dev',
          has_issues: true,
          archived: false,
          pushed_at: nowIso,
          updated_at: nowIso
        },
        {
          id: 10102,
          name: 'alpha-secret-vault',
          full_name: `${usernameA}/alpha-secret-vault`,
          html_url: `https://github.com/${usernameA}/alpha-secret-vault`,
          description: 'Confidential private repository belonging strictly to Alpha.',
          language: 'Go',
          private: true,
          fork: false,
          stargazers_count: 1,
          forks_count: 0,
          open_issues_count: 2,
          license: null,
          topics: [],
          has_issues: true,
          archived: false,
          pushed_at: twoDaysAgo,
          updated_at: twoDaysAgo
        }
      ],
      reposPage2: [
        {
          id: 10103,
          name: 'alpha-docs-site',
          full_name: `${usernameA}/alpha-docs-site`,
          html_url: `https://github.com/${usernameA}/alpha-docs-site`,
          description: 'Paginated page-2 repository synced cleanly for Alpha.',
          language: 'JavaScript',
          private: false,
          fork: false,
          stargazers_count: 15,
          forks_count: 3,
          open_issues_count: 1,
          license: { spdx_id: 'Apache-2.0' },
          topics: ['docs'],
          has_issues: true,
          archived: false,
          pushed_at: twoDaysAgo,
          updated_at: twoDaysAgo
        }
      ],
      events: [
        {
          id: 'ev_a_push_1',
          type: 'PushEvent',
          public: true,
          repo: { name: `${usernameA}/alpha-public-api` },
          created_at: nowIso,
          payload: { size: 4, ref: 'refs/heads/main', head: 'abc1234' }
        },
        {
          id: 'ev_a_priv_1',
          type: 'PushEvent',
          public: false,
          repo: { name: `${usernameA}/alpha-secret-vault` },
          created_at: nowIso,
          payload: { size: 2, ref: 'refs/heads/secret-branch', head: 'def5678' }
        },
        {
          id: 'ev_a_repo_1',
          type: 'CreateEvent',
          public: true,
          repo: { name: `${usernameA}/alpha-docs-site` },
          created_at: twoDaysAgo,
          payload: { ref_type: 'repository', ref: null }
        },
        {
          id: 'ev_a_branch_1',
          type: 'CreateEvent',
          public: true,
          repo: { name: `${usernameA}/alpha-public-api` },
          created_at: twoDaysAgo,
          payload: { ref_type: 'branch', ref: 'feat/sync-worker' }
        }
      ],
      prsCreatedTotal: 5,
      prsMergedTotal: 3,
      prItems: [
        {
          id: 8001,
          number: 42,
          title: 'Add paginated GitHub sync endpoints',
          html_url: `https://github.com/${usernameA}/alpha-public-api/pull/42`,
          repository_url: `https://api.github.com/repos/${usernameA}/alpha-public-api`,
          state: 'closed',
          pull_request: { merged_at: nowIso },
          created_at: twoDaysAgo,
          updated_at: nowIso
        }
      ],
      issuesCreatedTotal: 4,
      issueItems: [
        {
          id: 9001,
          number: 19,
          title: 'Document language breakdown metrics',
          html_url: `https://github.com/${usernameA}/alpha-public-api/issues/19`,
          repository_url: `https://api.github.com/repos/${usernameA}/alpha-public-api`,
          state: 'closed',
          created_at: twoDaysAgo,
          closed_at: nowIso,
          updated_at: nowIso
        }
      ],
      commits90dTotal: 27,
      releases: [
        { id: 7001, tag_name: 'v1.2.0', html_url: `https://github.com/${usernameA}/alpha-public-api/releases/tag/v1.2.0`, published_at: nowIso }
      ]
    },
    [tokenB]: {
      profile: { id: Number(ghIdB), login: usernameB, public_repos: 1, owned_private_repos: 0 },
      reposPage1: [
        {
          id: 20201,
          name: 'beta-python-cli',
          full_name: `${usernameB}/beta-python-cli`,
          html_url: `https://github.com/${usernameB}/beta-python-cli`,
          description: 'Python CLI helper owned strictly by Beta.',
          language: 'Python',
          private: false,
          fork: false,
          stargazers_count: 65,
          forks_count: 9,
          open_issues_count: 4,
          license: { spdx_id: 'MIT' },
          topics: ['python', 'cli'],
          has_issues: true,
          archived: false,
          pushed_at: nowIso,
          updated_at: nowIso
        }
      ],
      reposPage2: [],
      events: [
        {
          id: 'ev_b_push_1',
          type: 'PushEvent',
          public: true,
          repo: { name: `${usernameB}/beta-python-cli` },
          created_at: nowIso,
          payload: { size: 3, ref: 'refs/heads/main', head: 'bbb111' }
        }
      ],
      prsCreatedTotal: 2,
      prsMergedTotal: 1,
      prItems: [],
      issuesCreatedTotal: 1,
      issueItems: [],
      commits90dTotal: 11,
      releases: []
    }
  };

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  async function request(pathUrl, { method = 'GET', cookie = null, body = null, headers = {} } = {}) {
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders.Cookie = cookie;
    let payload;
    if (body) {
      payload = JSON.stringify(body);
      reqHeaders['Content-Type'] = 'application/json';
    }
    const res = await fetch(`http://127.0.0.1:${port}${pathUrl}`, {
      method,
      headers: reqHeaders,
      body: payload,
      redirect: 'manual'
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, text, json, headers: res.headers };
  }

  let passed = 0;
  function pass(msg) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  }

  try {
    // 1. Create two distinct GitHub-authenticated DevNexus accounts & verify encrypted tokens
    const { user: userA } = upsertGithubUser({ id: ghIdA, login: usernameA, name: 'Alpha Dev', avatar_url: '', bio: 'TS developer', email: `${usernameA}@example.com` });
    const { user: userB } = upsertGithubUser({ id: ghIdB, login: usernameB, name: 'Beta Dev', avatar_url: '', bio: 'Python developer', email: `${usernameB}@example.com` });

    db.prepare('UPDATE users SET is_onboarded = 1, skills = ? WHERE id = ?')
      .run(JSON.stringify([{ name: 'TypeScript' }, { name: 'JavaScript' }]), userA.id);
    db.prepare('UPDATE users SET is_onboarded = 1, skills = ? WHERE id = ?')
      .run(JSON.stringify([{ name: 'Python' }]), userB.id);

    assert.strictEqual(saveUserGithubToken(userA.id, ghIdA, usernameA, tokenA), true);
    assert.strictEqual(saveUserGithubToken(userB.id, ghIdB, usernameB, tokenB), true);
    // Reject cross-user token ownership read
    assert.strictEqual(getUserGithubSyncToken(userA.id, ghIdB), null, 'User A must not decrypt token with User B github_id');
    assert.strictEqual(getUserGithubSyncToken(userA.id, ghIdA), tokenA, 'Encrypted token must roundtrip cleanly for owner');
    pass('Two GitHub OAuth accounts created with AES-256-GCM encrypted token ownership isolation');

    // 2. Synchronize both accounts via paginated mock GitHub API
    const mockFetch = createMockFetch(datasets);
    const syncA = await synchronizeUserGitHubActivity(userA.id, { fetchImpl: mockFetch, force: true });
    const syncB = await synchronizeUserGitHubActivity(userB.id, { fetchImpl: mockFetch, force: true });

    assert.strictEqual(syncA.ok, true);
    assert.strictEqual(syncA.syncState.totalRepos, 3, 'Alpha must aggregate paginated repos (page 1 + page 2)');
    assert.strictEqual(syncA.syncState.publicRepos, 2);
    assert.strictEqual(syncA.syncState.privateRepos, 1);
    assert.strictEqual(syncA.syncState.totalCommits, 27);
    assert.strictEqual(syncA.syncState.prsCreated, 5);
    assert.strictEqual(syncA.syncState.prsMerged, 3);
    assert.strictEqual(syncA.syncState.issuesCreated, 4);
    assert.ok(syncA.syncState.languageDistribution.some(l => l.language === 'TypeScript'));

    assert.strictEqual(syncB.ok, true);
    assert.strictEqual(syncB.syncState.totalRepos, 1);
    assert.strictEqual(syncB.syncState.totalCommits, 11);
    assert.strictEqual(syncB.syncState.prsCreated, 2);
    pass('Paginated GitHub sync verified for both accounts (repos, commits 90d, PRs, issues, languages)');

    // 3. Simulate new commits, new repo, and merged PR arriving on Alpha's GitHub
    datasets[tokenA].commits90dTotal = 34;
    datasets[tokenA].prsCreatedTotal = 6;
    datasets[tokenA].prsMergedTotal = 4;
    datasets[tokenA].reposPage1.unshift({
      id: 10199,
      name: 'alpha-new-microservice',
      full_name: `${usernameA}/alpha-new-microservice`,
      html_url: `https://github.com/${usernameA}/alpha-new-microservice`,
      description: 'Brand new microservice pushed just now.',
      language: 'TypeScript',
      private: false,
      fork: false,
      stargazers_count: 3,
      forks_count: 0,
      open_issues_count: 1,
      license: { spdx_id: 'MIT' },
      topics: ['microservice'],
      has_issues: true,
      archived: false,
      pushed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    const resyncA = await synchronizeUserGitHubActivity(userA.id, { fetchImpl: mockFetch, force: true });
    assert.strictEqual(resyncA.ok, true);
    assert.strictEqual(resyncA.syncState.totalCommits, 34);
    assert.strictEqual(resyncA.syncState.prsMerged, 4);
    assert.strictEqual(resyncA.syncState.totalRepos, 4);
    const alphaRepos = getUserDashboardSyncData(userA.id, ghIdA, { isSelf: true, repoLimit: 10 }).repos;
    assert.strictEqual(alphaRepos[0].name, 'alpha-new-microservice', 'Newest pushed repo must appear first');
    assert.ok(alphaRepos[0].health && alphaRepos[0].health.score >= 70, 'Synced repo must integrate real Repository Health Score');
    const apiRepo = alphaRepos.find(r => r.name === 'alpha-public-api');
    assert.ok(apiRepo && apiRepo.health.score >= 85 && apiRepo.health.statusLabel === 'Healthy & Active');
    pass('Incremental sync reflects new commits, PR merges, new repositories & integrated Repo Health Score');

    // 4. HTTP Personal Data Isolation, Private Repo Protection & Zero Token Leakage
    const sidA = crypto.randomUUID();
    const sidB = crypto.randomUUID();
    createSession(sidA, userA.id, { userId: userA.id });
    createSession(sidB, userB.id, { userId: userB.id });
    const cookieA = `devnexus_sid=${sidA}`;
    const cookieB = `devnexus_sid=${sidB}`;

    const dashA = await request('/dashboard', { cookie: cookieA });
    const dashB = await request('/dashboard', { cookie: cookieB });
    assert.strictEqual(dashA.status, 200);
    assert.strictEqual(dashB.status, 200);
    assert.ok(dashA.text.includes('alpha-secret-vault'), 'Alpha must see their own private repo on their dashboard');
    assert.ok(!dashA.text.includes('beta-python-cli'), 'Alpha must never see Beta repos on Alpha dashboard');
    assert.ok(dashB.text.includes('beta-python-cli'), 'Beta must see Beta repo on Beta dashboard');
    assert.ok(!dashB.text.includes('alpha-secret-vault'), 'Beta must NEVER see Alpha private repo');
    assert.ok(!dashA.text.includes(tokenA) && !dashB.text.includes(tokenB), 'Raw GitHub tokens must never appear in rendered HTML');

    // Cross-user inspection must still hide private repos and private activities
    const bInspectA = await request(`/dashboard?username=${encodeURIComponent(usernameA)}`, { cookie: cookieB });
    assert.strictEqual(bInspectA.status, 200);
    assert.ok(bInspectA.text.includes('alpha-public-api'), 'Inspecting Alpha can display Alpha public repo');
    assert.ok(!bInspectA.text.includes('alpha-secret-vault'), 'Inspecting Alpha MUST redact Alpha private repo & private events');
    assert.ok(!bInspectA.text.includes('secret-branch'), 'Inspecting Alpha MUST redact Alpha private push branch activity');

    // Cross-user API ownership guards (HTTP 403)
    const crossStatusRes = await request(`/dashboard/api/sync/status?userId=${userA.id}`, {
      cookie: cookieB,
      headers: { Accept: 'application/json' }
    });
    assert.strictEqual(crossStatusRes.status, 403);
    const crossPostRes = await request('/dashboard/api/sync', {
      method: 'POST',
      cookie: cookieB,
      body: { userId: userA.id },
      headers: { Accept: 'application/json' }
    });
    assert.strictEqual(crossPostRes.status, 403);

    const statusAJson = await request('/dashboard/api/sync/status', {
      cookie: cookieA,
      headers: { Accept: 'application/json' }
    });
    assert.strictEqual(statusAJson.status, 200);
    assert.strictEqual(statusAJson.json.syncState.totalCommits, 34);
    assert.ok(!statusAJson.text.includes(tokenA) && !statusAJson.text.includes('access_token_enc'), 'API JSON must never leak encrypted or raw tokens');
    pass('Personal data isolation, private repo/activity redaction & 403 ownership enforcement verified');

    // 5. Rate Limit, Cooldown Deduplication & Network Failure Resilience
    const rlFetch = createMockFetch({});
    const rlRes = await synchronizeUserGitHubActivity(userA.id, {
      sessionToken: 'gho_rate_limit_token',
      force: true,
      fetchImpl: rlFetch
    });
    assert.strictEqual(rlRes.ok, false);
    assert.strictEqual(rlRes.rateLimited, true);
    assert.strictEqual(rlRes.reason, 'RATE_LIMIT_EXCEEDED');

    // Preserved previous SQLite snapshot even after rate limit & outage
    const preservedState = getUserGithubSyncState(userA.id, ghIdA);
    assert.strictEqual(preservedState.totalCommits, 34, 'Existing synced counts must survive rate-limit failure');
    assert.strictEqual(preservedState.lastSyncStatus, 'rate_limited');

    // Subsequent sync while reset window is active must short-circuit with 0 external calls
    const callsBefore = rlFetch.getCallCount();
    const skippedRl = await synchronizeUserGitHubActivity(userA.id, {
      sessionToken: 'gho_rate_limit_token',
      force: true,
      fetchImpl: rlFetch
    });
    assert.strictEqual(skippedRl.rateLimited, true);
    assert.strictEqual(rlFetch.getCallCount(), callsBefore, 'Rate-limited cooldown must prevent redundant API requests');

    // Clear reset epoch & test network error resilience + dashboard render resilience
    db.prepare('UPDATE github_sync_states SET rate_limit_reset_epoch = 0, last_sync_status = ? WHERE user_id = ?')
      .run('success', userA.id);
    const downRes = await synchronizeUserGitHubActivity(userA.id, {
      sessionToken: 'gho_network_down',
      force: true,
      fetchImpl: rlFetch
    });
    assert.strictEqual(downRes.ok, false);
    assert.strictEqual(downRes.reason, 'NETWORK_ERROR');
    const dashAfterOutage = await request('/dashboard', { cookie: cookieA });
    assert.strictEqual(dashAfterOutage.status, 200, 'Dashboard must render cleanly during GitHub API outage');
    assert.ok(dashAfterOutage.text.includes('alpha-new-microservice'), 'Dashboard still shows preserved SQLite synced repos');
    pass('Rate limit backoff, redundant-call guard, API failure handling & SQLite preservation verified');

    // 6. Scheduled Sync Batch respects staleness threshold
    db.prepare('UPDATE github_sync_states SET last_synced_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 30 * 60 * 1000).toISOString(), userB.id);
    db.prepare('UPDATE github_sync_states SET last_synced_at = ? WHERE user_id = ?')
      .run(new Date().toISOString(), userA.id);
    const batchRes = await runScheduledGithubSyncBatch({
      limit: 5,
      staleMs: 15 * 60 * 1000,
      fetchImpl: mockFetch,
      userIds: [userA.id, userB.id]
    });
    assert.ok(batchRes.some(r => r.userId === userB.id && r.ok), 'Scheduled sync must refresh stale Account Beta');
    assert.ok(!batchRes.some(r => r.userId === userA.id), 'Scheduled sync must skip fresh Account Alpha');
    pass('Scheduled GitHub background sync respects staleness and skips fresh accounts');

    // 7. Strict Ownership Filtering (?type=owner), Deduplication by Repo ID, Deletion Convergence & Dashboard UI Consistency
    const repoUrlsUsed = mockFetch.getRequestedRepoUrls();
    assert.ok(repoUrlsUsed.length > 0, 'Sync must request authenticated /user/repos endpoint');
    assert.ok(repoUrlsUsed.every(u => u.includes('/user/repos?type=owner&per_page=100')), 'Authenticated sync MUST query /user/repos?type=owner&per_page=100');
    assert.ok(repoUrlsUsed.every(u => !u.includes('collaborator')), 'Must never request collaborator affiliation');

    // Simulate page duplication, collaborator repo, org repo, and stale higher ghProfile.public_repos counter
    datasets[tokenA].injectNonOwnerOnTypeOwner = true;
    datasets[tokenA].profile.public_repos = 99;
    datasets[tokenA].profile.owned_private_repos = 99;
    datasets[tokenA].reposPage2.push(
      {
        id: 10101,
        name: 'alpha-public-api',
        full_name: `${usernameA}/alpha-public-api`,
        html_url: `https://github.com/${usernameA}/alpha-public-api`,
        owner: { id: Number(ghIdA), login: usernameA, type: 'User' },
        private: false
      },
      {
        id: 777001,
        name: 'teammate-collab-repo',
        full_name: 'teammate-dev/teammate-collab-repo',
        html_url: 'https://github.com/teammate-dev/teammate-collab-repo',
        owner: { id: 777001, login: 'teammate-dev', type: 'User' },
        private: false
      },
      {
        id: 777002,
        name: 'org-member-repo',
        full_name: 'acme-org/org-member-repo',
        html_url: 'https://github.com/acme-org/org-member-repo',
        owner: { id: 777002, login: 'acme-org', type: 'Organization' },
        private: false
      }
    );

    const dedupSync = await synchronizeUserGitHubActivity(userA.id, { fetchImpl: mockFetch, force: true });
    assert.strictEqual(dedupSync.ok, true);
    assert.strictEqual(dedupSync.syncState.totalRepos, 4, 'Must count exact 4 deduplicated owned repos (ignoring collab, org, duplicate ID & stale profile)');
    assert.strictEqual(dedupSync.syncState.publicRepos, 3, 'Must count exact 3 public owned repos');
    assert.strictEqual(dedupSync.syncState.privateRepos, 1, 'Must count exact 1 private owned repo');

    // Repeated sync must not add cached + fresh counts together or double-count repos
    const repeatSync = await synchronizeUserGitHubActivity(userA.id, { fetchImpl: mockFetch, force: true });
    assert.strictEqual(repeatSync.syncState.totalRepos, 4);
    assert.strictEqual(repeatSync.syncState.publicRepos, 3);

    // Simulate repository deletion (remove alpha-docs-site from page 2)
    datasets[tokenA].reposPage2 = datasets[tokenA].reposPage2.filter(r => r.id !== 10103);
    const deleteSync = await synchronizeUserGitHubActivity(userA.id, { fetchImpl: mockFetch, force: true });
    assert.strictEqual(deleteSync.ok, true);
    assert.strictEqual(deleteSync.syncState.totalRepos, 3, 'Deleting a repo must reduce totalRepos immediately (no stale Math.max)');
    assert.strictEqual(deleteSync.syncState.publicRepos, 2, 'Deleting a public repo must reduce publicRepos immediately');
    assert.strictEqual(deleteSync.syncState.privateRepos, 1);

    // Verify rendered Dashboard statistics and repo cards match 100% and remain isolated per user
    const dashConsistent = await request('/dashboard', { cookie: cookieA });
    assert.strictEqual(dashConsistent.status, 200);
    assert.ok(dashConsistent.text.includes('id="metric-public-repos" data-dx-count="2">2</div>'), 'Top Public Repositories card must display 2');
    assert.ok(dashConsistent.text.includes('3 repositories owned'), 'Top card subtitle must display total owned count without private repo statistics');
    assert.ok(!/\d+\s+private/i.test(dashConsistent.text), 'Dashboard must never display private repository counts');
    assert.ok(dashConsistent.text.includes('id="synced-repos-count-pill"'), 'Dashboard repo listing card must include synced repo count badge');
    assert.ok(dashConsistent.text.includes('(3)'), 'Repo listing header count pill must match exact 3 repo cards');
    assert.ok(!dashConsistent.text.includes('teammate-collab-repo') && !dashConsistent.text.includes('org-member-repo'), 'Dashboard must never display collaborator or org repos');
    const cardMatches = dashConsistent.text.slice(dashConsistent.text.indexOf('id="synced-repos-body"'), dashConsistent.text.indexOf('id="github-activity-timeline-card"')).match(/class="repo-card"/g) || [];
    assert.strictEqual(cardMatches.length, 3, 'Rendered repository cards must match total owned count (3)');

    // Second GitHub user (Account B) count remains isolated at 1
    const dashBConsistent = await request('/dashboard', { cookie: cookieB });
    assert.strictEqual(dashBConsistent.status, 200);
    assert.ok(dashBConsistent.text.includes('id="metric-public-repos" data-dx-count="1">1</div>'), 'Account B count must stay isolated at 1');
    pass('?type=owner filtering, repo-ID deduplication, deletion updates, UI card consistency & user isolation verified');

  } finally {
    for (const uname of [usernameA, usernameB]) {
      const u = findUserByUsername(uname);
      if (u) {
        db.prepare('DELETE FROM github_synced_activities WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM github_synced_repos WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM github_sync_states WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM activity_logs WHERE user_id = ?').run(u.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      }
    }
    server.close();
  }

  console.log('\n==========================================================');
  console.log(` ALL ${passed} GITHUB SYNCHRONIZATION CHECKS PASSED!`);
  console.log('==========================================================\n');
}

runTests().catch(err => {
  console.error('\n[FAIL] GitHub Sync Test Error:', err);
  process.exit(1);
});
