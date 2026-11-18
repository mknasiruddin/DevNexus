/**
 * DevNexus Rate-Limit Resilience, Caching & Sync Locking Test Suite
 * Verifies:
 *   1. Repeated dashboard refreshes reuse cached responses / SQLite snapshot (0 redundant API calls)
 *   2. Simultaneous concurrent API & sync requests deduplicate to a single upstream fetch
 *   3. Manual "Sync GitHub" enforces 60s cooldown without extra Search calls
 *   4. Automatic syncIfStale skips fresh snapshots, rate-limit windows & error backoff
 *   5. Primary rate limits (X-RateLimit-Remaining: 0) preserve stale cache/metrics & surface reset time
 *   6. Secondary rate limits (429 / Retry-After) classify distinctly, block retries & preserve data
 *   7. Missing X-RateLimit headers never produce fake quota values; DevNexus cache vs GitHub quota UI distinct
 *   8. Cache expiration recovers cleanly with fresh data once healthy
 *   9. Strict multi-user isolation & zero GitHub token leakage in responses or cache keys
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
  createSession,
  getCached,
  setCache
} = require('../db/database');

const {
  parseRateLimit,
  classifyRateLimitResponse,
  getUserProfile,
  getUserRepositories,
  searchIssues,
  searchRepositories
} = require('../services/githubService');

const {
  synchronizeUserGitHubActivity,
  syncIfStale,
  getUserDashboardSyncData,
  MANUAL_SYNC_COOLDOWN_MS
} = require('../services/githubSyncService');

function makeHeaders(map = {}) {
  const lowered = {};
  for (const [k, v] of Object.entries(map)) {
    lowered[String(k).toLowerCase()] = v;
  }
  return {
    get(key) {
      const k = String(key).toLowerCase();
      return Object.prototype.hasOwnProperty.call(lowered, k) ? lowered[k] : null;
    }
  };
}

function makeHttpClient(port) {
  return async function request(path, { method = 'GET', cookie = '', body = null } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          } : {})
        }
      }, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) {}
          resolve({ status: res.statusCode, headers: res.headers, text: raw, json });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
}

async function runTests() {
  let passed = 0;
  function pass(msg) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  }

  const ts = Date.now();
  const usernameA = `rltest_alpha_${ts}`;
  const usernameB = `rltest_beta_${ts}`;
  const ghIdA = `991000${ts % 100000}`;
  const ghIdB = `992000${ts % 100000}`;
  const tokenA = `gho_rltest_alpha_secret_${ts}`;
  const tokenB = `gho_rltest_beta_secret_${ts}`;
  const testQuery = `rltestquery${ts}`;

  const createdCacheKeys = new Set();
  const tokenHashA = crypto.createHash('sha256').update(tokenA).digest('hex').slice(0, 12);
  const tokenHashB = crypto.createHash('sha256').update(tokenB).digest('hex').slice(0, 12);

  // Clean helper for rate limit blocks matching our mock tokens
  function clearTestRateLimitBlocks() {
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`rl_block:%:tok_${tokenHashA}%`);
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`rl_block:%:tok_${tokenHashB}%`);
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run('rl_block:%:public%');
  }

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const request = makeHttpClient(port);

  const originalGlobalFetch = global.fetch;

  // Controllable mock state for global.fetch
  const mockControl = {
    mode: 'normal', // 'normal' | 'primary_limit' | 'secondary_limit' | 'no_headers'
    callLog: [],
    repoVersion: 1,
    issueTitleSuffix: 'v1',
    delayMs: 0,
    resetFutureSec: 900
  };

  function getCallCount(substr = null) {
    if (!substr) return mockControl.callLog.length;
    return mockControl.callLog.filter(entry => entry.url.includes(substr)).length;
  }

  function resetCallLog() {
    mockControl.callLog.length = 0;
  }

  global.fetch = async function controllableGithubFetch(url, options = {}) {
    const urlStr = String(url);
    if (!urlStr.startsWith('https://api.github.com')) {
      return originalGlobalFetch(url, options);
    }

    const auth = (options.headers && (options.headers.Authorization || options.headers.authorization)) || '';
    mockControl.callLog.push({ url: urlStr, auth });

    if (mockControl.delayMs > 0) {
      await new Promise(r => setTimeout(r, mockControl.delayMs));
    }

    const isUserB = auth.includes(tokenB);
    const uname = isUserB ? usernameB : usernameA;
    const ghId = isUserB ? ghIdB : ghIdA;
    const nowEpoch = Math.floor(Date.now() / 1000);

    if (mockControl.mode === 'primary_limit') {
      return {
        ok: false,
        status: 403,
        headers: makeHeaders({
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(nowEpoch + mockControl.resetFutureSec),
          'x-ratelimit-resource': urlStr.includes('/search/') ? 'search' : 'core'
        }),
        json: async () => ({ message: 'API rate limit exceeded for test user.' })
      };
    }

    if (mockControl.mode === 'secondary_limit') {
      return {
        ok: false,
        status: 429,
        headers: makeHeaders({
          'retry-after': '90',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4990',
          'x-ratelimit-reset': String(nowEpoch + 3000),
          'x-ratelimit-resource': urlStr.includes('/search/') ? 'search' : 'core'
        }),
        json: async () => ({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' })
      };
    }

    const stdHeaders = mockControl.mode === 'no_headers'
      ? makeHeaders({})
      : makeHeaders({
          'x-ratelimit-limit': urlStr.includes('/search/') ? '30' : '5000',
          'x-ratelimit-remaining': urlStr.includes('/search/') ? '28' : '4982',
          'x-ratelimit-reset': String(nowEpoch + 1800),
          'x-ratelimit-resource': urlStr.includes('/search/') ? 'search' : 'core'
        });

    if (urlStr.endsWith('/user') || urlStr.includes(`/users/${usernameA}`) || urlStr.includes(`/users/${usernameB}`)) {
      return {
        ok: true,
        status: 200,
        headers: stdHeaders,
        json: async () => ({
          id: Number(ghId),
          login: uname,
          name: `Test ${uname}`,
          avatar_url: 'https://avatars.githubusercontent.com/u/9919?v=4',
          bio: isUserB ? 'Beta developer account' : 'Alpha developer account',
          public_repos: isUserB ? 1 : 2,
          followers: isUserB ? 3 : 11,
          following: 2,
          created_at: '2022-01-01T00:00:00Z'
        })
      };
    }

    if (urlStr.includes('/user/repos') || urlStr.includes('/repos?')) {
      const repos = isUserB
        ? [{
            id: 88001,
            name: 'beta-isolated-repo',
            full_name: `${usernameB}/beta-isolated-repo`,
            html_url: `https://github.com/${usernameB}/beta-isolated-repo`,
            description: 'Beta isolated private-like workspace test',
            language: 'Python',
            stargazers_count: 4,
            forks_count: 1,
            open_issues_count: 2,
            has_issues: true,
            private: true,
            archived: false,
            pushed_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }]
        : [
            {
              id: 77001,
              name: `alpha-core-v${mockControl.repoVersion}`,
              full_name: `${usernameA}/alpha-core-v${mockControl.repoVersion}`,
              html_url: `https://github.com/${usernameA}/alpha-core-v${mockControl.repoVersion}`,
              description: 'Alpha public test project',
              language: 'JavaScript',
              stargazers_count: 18,
              forks_count: 3,
              open_issues_count: 4,
              has_issues: true,
              private: false,
              archived: false,
              pushed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            },
            {
              id: 77002,
              name: 'alpha-secret-vault',
              full_name: `${usernameA}/alpha-secret-vault`,
              html_url: `https://github.com/${usernameA}/alpha-secret-vault`,
              description: 'Alpha confidential repo only visible to Alpha',
              language: 'TypeScript',
              stargazers_count: 0,
              forks_count: 0,
              open_issues_count: 1,
              has_issues: true,
              private: true,
              archived: false,
              pushed_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            }
          ];
      return { ok: true, status: 200, headers: stdHeaders, json: async () => repos };
    }

    if (urlStr.includes('/commits?')) {
      return {
        ok: true,
        status: 200,
        headers: stdHeaders,
        json: async () => [{
          sha: `abc${mockControl.repoVersion}1234`,
          html_url: `https://github.com/${uname}/repo/commit/abc`,
          commit: {
            message: `Add rate-limit hardening (${mockControl.issueTitleSuffix})`,
            author: { name: uname, date: new Date().toISOString() }
          }
        }]
      };
    }

    if (urlStr.includes('/releases?')) {
      return { ok: true, status: 200, headers: stdHeaders, json: async () => [] };
    }

    if (urlStr.includes('/events')) {
      return {
        ok: true,
        status: 200,
        headers: stdHeaders,
        json: async () => [{
          id: `evt_${uname}_1`,
          type: 'PushEvent',
          repo: { name: `${uname}/repo` },
          created_at: new Date().toISOString(),
          payload: { ref: 'refs/heads/main', size: 2, commits: [{ sha: 'deadbeef', message: 'Sync commit' }] }
        }]
      };
    }

    if (urlStr.includes('/search/repositories')) {
      return {
        ok: true,
        status: 200,
        headers: stdHeaders,
        json: async () => ({
          total_count: 1,
          items: [{
            id: 55001,
            name: 'awesome-js-starter',
            full_name: 'org/awesome-js-starter',
            html_url: 'https://github.com/org/awesome-js-starter',
            description: 'Great open-source starter repository for JavaScript contributors',
            language: 'JavaScript',
            stargazers_count: 420,
            forks_count: 64,
            open_issues_count: 12,
            has_issues: true,
            topics: ['javascript', 'nodejs'],
            license: { spdx_id: 'MIT' },
            pushed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            owner: { login: 'org', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4' }
          }]
        })
      };
    }

    if (urlStr.includes('/search/issues')) {
      // Distinguish user commit/PR/issue sync summary searches from issue discovery search
      if (urlStr.includes(`author%3A${usernameA}`) || urlStr.includes(`author%3A${usernameB}`) ||
          urlStr.includes(`author:${usernameA}`) || urlStr.includes(`author:${usernameB}`)) {
        return {
          ok: true,
          status: 200,
          headers: stdHeaders,
          json: async () => ({
            total_count: isUserB ? 1 : 4,
            items: []
          })
        };
      }

      return {
        ok: true,
        status: 200,
        headers: stdHeaders,
        json: async () => ({
          total_count: 1,
          items: [{
            id: 66001,
            number: 42,
            title: `Fix rate limit handling in DevNexus (${mockControl.issueTitleSuffix})`,
            html_url: 'https://github.com/org/awesome-js-starter/issues/42',
            repository_url: 'https://api.github.com/repos/org/awesome-js-starter',
            state: 'open',
            comments: 2,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            labels: [{ name: 'good first issue', color: '7057ff' }],
            user: { login: 'maintainer', avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' },
            body: 'Implement centralized caching and backoff.'
          }]
        })
      };
    }

    return { ok: true, status: 200, headers: stdHeaders, json: async () => ({}) };
  };

  try {
    // -------------------------------------------------------------------------
    // Setup 2 isolated OAuth users & sessions
    // -------------------------------------------------------------------------
    const { user: userA } = upsertGithubUser({
      id: ghIdA,
      login: usernameA,
      name: `Alpha ${ts}`,
      email: `${usernameA}@example.test`,
      avatar_url: 'https://avatars.githubusercontent.com/u/9919?v=4',
      bio: 'Alpha developer account'
    });
    const { user: userB } = upsertGithubUser({
      id: ghIdB,
      login: usernameB,
      name: `Beta ${ts}`,
      email: `${usernameB}@example.test`,
      avatar_url: 'https://avatars.githubusercontent.com/u/9919?v=4',
      bio: 'Beta developer account'
    });

    db.prepare('UPDATE users SET skills = ?, experience_level = ?, is_onboarded = 1 WHERE id = ?')
      .run(JSON.stringify(['JavaScript', 'Node.js']), 'Intermediate', userA.id);
    db.prepare('UPDATE users SET skills = ?, experience_level = ?, is_onboarded = 1 WHERE id = ?')
      .run(JSON.stringify(['Python']), 'Beginner', userB.id);

    saveUserGithubToken(userA.id, ghIdA, tokenA);
    saveUserGithubToken(userB.id, ghIdB, tokenB);

    const sidA = `sid_rltest_a_${ts}_${crypto.randomBytes(6).toString('hex')}`;
    const sidB = `sid_rltest_b_${ts}_${crypto.randomBytes(6).toString('hex')}`;
    createSession(sidA, userA.id, { userId: userA.id, githubToken: tokenA });
    createSession(sidB, userB.id, { userId: userB.id, githubToken: tokenB });
    const cookieA = `devnexus_sid=${sidA}`;
    const cookieB = `devnexus_sid=${sidB}`;

    // -------------------------------------------------------------------------
    // Test 1: Rate-limit header parser & secondary classification
    // -------------------------------------------------------------------------
    assert.strictEqual(parseRateLimit(null), null, 'Null headers must return null (no fake quota)');
    assert.strictEqual(parseRateLimit(makeHeaders({})), null, 'Missing X-RateLimit headers must return null');

    const realParsed = parseRateLimit(makeHeaders({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4123',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
      'x-ratelimit-resource': 'core'
    }));
    assert.strictEqual(realParsed.limit, 5000);
    assert.strictEqual(realParsed.remaining, 4123);
    assert.strictEqual(realParsed.resource, 'core');

    const secondaryCls = classifyRateLimitResponse(429, parseRateLimit(makeHeaders({
      'retry-after': '90',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4990'
    })), { message: 'You have exceeded a secondary rate limit.' });
    assert.strictEqual(secondaryCls.isRateLimited, true);
    assert.strictEqual(secondaryCls.rateLimitType, 'secondary');
    assert.ok(secondaryCls.waitSeconds >= 85 && secondaryCls.waitSeconds <= 95);
    pass('Header parsing returns real quota only & classifies primary vs secondary rate limits accurately');

    // -------------------------------------------------------------------------
    // Test 2: Simultaneous concurrent requests deduplication (in-flight lock)
    // -------------------------------------------------------------------------
    mockControl.mode = 'normal';
    mockControl.delayMs = 40;
    resetCallLog();

    const concurrentKeyProfile = usernameA;
    // Clear existing cache entry if any
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`%${usernameA}%`);
    db.prepare('DELETE FROM api_cache WHERE cache_key IN (?, ?)').run(
      'issue_search:is:issue is:open:1:8',
      'repo_search:stars:>=10:stars:desc:1:12'
    );
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`%${testQuery}%`);

    const [p1, p2, p3, p4] = await Promise.all([
      getUserProfile(concurrentKeyProfile, tokenA),
      getUserProfile(concurrentKeyProfile, tokenA),
      getUserProfile(concurrentKeyProfile, tokenA),
      getUserProfile(concurrentKeyProfile, tokenA)
    ]);
    assert.strictEqual(p1.user.login, usernameA);
    assert.strictEqual(p4.user.login, usernameA);
    assert.strictEqual(getCallCount(`/users/${usernameA}`), 1, '4 simultaneous profile calls must coalesce to 1 upstream request');

    resetCallLog();
    const [s1, s2, s3] = await Promise.all([
      synchronizeUserGitHubActivity(userA.id, { sessionToken: tokenA, force: true }),
      synchronizeUserGitHubActivity(userA.id, { sessionToken: tokenA, force: true }),
      synchronizeUserGitHubActivity(userA.id, { sessionToken: tokenA, force: true })
    ]);
    assert.strictEqual(s1.ok, true);
    assert.strictEqual(s2.ok, true);
    assert.strictEqual(s3.ok, true);
    assert.strictEqual(getCallCount('/user/repos'), 1, '3 concurrent sync calls for same user must coalesce via inFlightSyncs lock');

    mockControl.delayMs = 0;
    pass('Simultaneous concurrent API & sync requests deduplicated to 1 upstream GitHub call each');

    // -------------------------------------------------------------------------
    // Test 3: Repeated dashboard refreshes reuse cache & skip getUserEvents
    // -------------------------------------------------------------------------
    // Warm dashboard issue/repo searches once via GET /dashboard
    resetCallLog();
    const dashFirst = await request('/dashboard', { cookie: cookieA });
    assert.strictEqual(dashFirst.status, 200);
    assert.ok(dashFirst.text.includes('GitHub Quota'), 'Dashboard must show GitHub Quota label');
    assert.ok(dashFirst.text.includes('DevNexus Cache:'), 'Dashboard must show distinct DevNexus Cache indicator');

    // Now perform 3 consecutive refreshes: should consume ZERO GitHub API calls!
    resetCallLog();
    const r1 = await request('/dashboard', { cookie: cookieA });
    const r2 = await request('/dashboard', { cookie: cookieA });
    const r3 = await request('/dashboard', { cookie: cookieA });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r3.status, 200);
    assert.strictEqual(getCallCount(), 0, `Repeated dashboard refreshes must make 0 GitHub API calls (made ${getCallCount()})`);
    assert.ok(r3.text.includes('alpha-core-v1'), 'Dashboard must render synchronized repo data from SQLite');
    pass('Repeated dashboard refreshes consume 0 upstream GitHub API requests');

    // -------------------------------------------------------------------------
    // Test 4: Manual "Sync GitHub" enforces 60s cooldown & saves Search quota
    // -------------------------------------------------------------------------
    resetCallLog();
    const manualImmediate = await request('/dashboard/api/sync', {
      method: 'POST',
      cookie: cookieA,
      body: { force: true } // even if client attempts force: true, route enforces manual cooldown
    });
    assert.strictEqual(manualImmediate.status, 200);
    assert.strictEqual(manualImmediate.json.success, true);
    assert.strictEqual(manualImmediate.json.cooldownActive, true, 'Manual sync within 60s must hit cooldown');
    assert.ok(manualImmediate.json.retryAfterSeconds > 0, 'Cooldown must report remaining seconds');
    assert.strictEqual(getCallCount(), 0, 'Cooldown hit must make 0 outbound GitHub API requests');

    // Expire manual cooldown & verify fresh sync succeeds and resets cooldown window
    db.prepare('UPDATE github_sync_states SET next_allowed_sync_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 5000).toISOString(), userA.id);
    resetCallLog();
    const manualAllowed = await request('/dashboard/api/sync', {
      method: 'POST',
      cookie: cookieA,
      body: { respectCooldown: true }
    });
    assert.strictEqual(manualAllowed.status, 200);
    assert.strictEqual(manualAllowed.json.success, true);
    assert.strictEqual(manualAllowed.json.cooldownActive, false);
    assert.ok(manualAllowed.json.nextAllowedSyncAt, 'Manual sync must set nextAllowedSyncAt for 60s cooldown');
    assert.ok(new Date(manualAllowed.json.nextAllowedSyncAt).getTime() > Date.now() + 30000);
    pass('Manual "Sync GitHub" enforces 60s per-user cooldown and reuses search cache safely');

    // -------------------------------------------------------------------------
    // Test 5: Primary Rate Limit preserves stale cache & blocks premature retries
    // -------------------------------------------------------------------------
    // Warm an identifiable issue search cache, then force-expire it (stale copy stays in SQLite)
    await searchIssues({ query: testQuery, label: 'all', language: 'all', page: 1, perPage: 6 }, ['JavaScript'], tokenA);
    db.prepare('UPDATE api_cache SET expires_at = ? WHERE cache_key LIKE ?')
      .run(Date.now() - 3600000, `%${testQuery}%`);
    db.prepare('UPDATE github_sync_states SET next_allowed_sync_at = NULL, last_synced_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 3600000).toISOString(), userA.id);

    mockControl.mode = 'primary_limit';
    mockControl.resetFutureSec = 900;
    resetCallLog();

    const rlIssues = await searchIssues(
      { query: testQuery, label: 'all', language: 'all', page: 1, perPage: 6 },
      ['JavaScript'],
      tokenA
    );
    assert.strictEqual(rlIssues.error, 'RATE_LIMIT_EXCEEDED');
    assert.strictEqual(rlIssues.rateLimitType, 'primary');
    assert.strictEqual(rlIssues.stale, true, 'Must preserve stale cached issues instead of wiping to []');
    assert.strictEqual(rlIssues.issues.length, 1, 'Preserved cached issue must still be returned');
    assert.ok(rlIssues.issues[0].title.includes('(v1)'), 'Preserved issue content must match cached snapshot');
    assert.ok(rlIssues.rateLimitResetAtIso, 'Actual reset ISO timestamp must be surfaced');
    const callsDuringFirstPrimaryHit = getCallCount();
    assert.strictEqual(callsDuringFirstPrimaryHit, 1);

    // Second immediate query & manual sync BEFORE reset window must NOT hit GitHub!
    resetCallLog();
    const rlIssuesBlocked = await searchIssues(
      { query: testQuery, label: 'all', language: 'all', page: 1, perPage: 6 },
      ['JavaScript'],
      tokenA
    );
    assert.strictEqual(rlIssuesBlocked.error, 'RATE_LIMIT_EXCEEDED');
    assert.strictEqual(rlIssuesBlocked.stale, true);
    assert.strictEqual(rlIssuesBlocked.issues.length, 1);
    assert.strictEqual(getCallCount(), 0, 'Active primary rate-limit block must skip outbound retries until reset');

    // First manual sync under core rate limit detects 403 on /user (at most 1 call, aborts cascade immediately)
    resetCallLog();
    const syncLimited = await request('/dashboard/api/sync', { method: 'POST', cookie: cookieA, body: { respectCooldown: true } });
    assert.strictEqual(syncLimited.status, 429);
    assert.strictEqual(syncLimited.json.rateLimited, true);
    assert.strictEqual(syncLimited.json.syncState.totalRepos, 2, 'SQLite repo total (2) must remain preserved');
    assert.ok(syncLimited.json.resetEpoch > Math.floor(Date.now() / 1000));
    assert.strictEqual(getCallCount(), 1, 'Sync must abort immediately on first core 403 without cascading calls');

    // Subsequent manual sync AND automatic syncIfStale before reset must fire 0 GitHub calls
    resetCallLog();
    const syncLimitedAgain = await request('/dashboard/api/sync', { method: 'POST', cookie: cookieA, body: { respectCooldown: true } });
    assert.strictEqual(syncLimitedAgain.status, 429);
    const staleAutoSkipped = await syncIfStale(userA.id, { sessionToken: tokenA });
    assert.strictEqual(staleAutoSkipped.skipped, true);
    assert.strictEqual(getCallCount(), 0, 'Active rate-limit window must block both manual and automatic sync retries until reset');

    // Verify dashboard HTML shows preserved metrics + rate limit notice + real 0 quota
    const dashLimited = await request('/dashboard', { cookie: cookieA });
    assert.strictEqual(dashLimited.status, 200);
    assert.ok(dashLimited.text.includes('alpha-core-v1'), 'Dashboard must still show preserved synced repos during rate limit');
    assert.ok(!dashLimited.text.includes('60</strong> / 60'), 'Dashboard must never display fake 60/60 quota');
    pass('Primary rate limit preserves stale cache & SQLite metrics, reports actual reset time, and blocks retries');

    // -------------------------------------------------------------------------
    // Test 6: Secondary Rate Limit (429 + Retry-After) classification & preservation
    // -------------------------------------------------------------------------
    clearTestRateLimitBlocks();
    db.prepare('UPDATE github_sync_states SET last_sync_status = ?, rate_limit_reset_epoch = NULL WHERE user_id = ?')
      .run('completed', userA.id);
    db.prepare('UPDATE api_cache SET expires_at = ? WHERE cache_key LIKE ?')
      .run(Date.now() - 3600000, `%${testQuery}%`);

    mockControl.mode = 'secondary_limit';
    resetCallLog();

    const secIssues = await searchIssues(
      { query: testQuery, label: 'all', language: 'all', page: 1, perPage: 6 },
      ['JavaScript'],
      tokenA
    );
    assert.strictEqual(secIssues.error, 'RATE_LIMIT_EXCEEDED');
    assert.strictEqual(secIssues.rateLimitType, 'secondary', 'Must classify 429 Retry-After as secondary rate limit');
    assert.strictEqual(secIssues.stale, true);
    assert.strictEqual(secIssues.issues.length, 1, 'Stale cached issues must stay preserved on secondary limit');
    assert.ok(secIssues.errorMessage.toLowerCase().includes('secondary'), 'Message must indicate secondary rate limit');

    // Immediate retry must be blocked locally via Retry-After block
    resetCallLog();
    const secRetryBlocked = await searchIssues(
      { query: testQuery, label: 'all', language: 'all', page: 1, perPage: 6 },
      ['JavaScript'],
      tokenA
    );
    assert.strictEqual(secRetryBlocked.rateLimitType, 'secondary');
    assert.strictEqual(getCallCount(), 0, 'Secondary rate limit block must prevent repeated bursts');
    pass('Secondary rate limits (Retry-After / 429) classified distinctly, block bursts, and preserve cached data');

    // -------------------------------------------------------------------------
    // Test 7: Missing headers show unavailable quota (never fake 60/60) & cache expiry recovers
    // -------------------------------------------------------------------------
    clearTestRateLimitBlocks();
    mockControl.mode = 'no_headers';
    mockControl.issueTitleSuffix = 'v2-recovered';
    db.prepare('UPDATE api_cache SET expires_at = ? WHERE cache_key LIKE ?')
      .run(Date.now() - 3600000, `%${testQuery}%`);
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`%${usernameA}%`);
    db.prepare('DELETE FROM api_cache WHERE cache_key IN (?, ?)').run(
      'issue_search:is:issue is:open:1:8',
      'repo_search:stars:>=10:stars:desc:1:12'
    );
    db.prepare('UPDATE github_sync_states SET rate_limit_limit = NULL, rate_limit_remaining = NULL, rate_limit_reset_epoch = NULL, last_sync_status = ? WHERE user_id = ?')
      .run('completed', userA.id);

    const recoveredIssues = await searchIssues(
      { query: testQuery, label: 'all', language: 'all', page: 1, perPage: 6 },
      ['JavaScript'],
      tokenA
    );
    assert.ok(!recoveredIssues.error, 'Recovered issue search must have no error');
    assert.strictEqual(recoveredIssues.rateLimit, null, 'Missing X-RateLimit headers must keep rateLimit null (no fake 60)');
    assert.ok(recoveredIssues.issues[0].title.includes('v2-recovered'), 'Expired cache must refresh cleanly once healthy');

    const dashNoHeaders = await request('/dashboard', { cookie: cookieA });
    assert.strictEqual(dashNoHeaders.status, 200);
    const quotaIdx = dashNoHeaders.text.indexOf('id="github-quota-status"');
    const quotaSnippet = quotaIdx >= 0 ? dashNoHeaders.text.slice(quotaIdx, quotaIdx + 350) : 'NOT_FOUND';
    assert.ok(
      dashNoHeaders.text.includes('GitHub Quota: unavailable'),
      `Dashboard must display quota unavailable instead of fake 60/60 when headers are absent. Got: ${quotaSnippet}`
    );
    pass('Cache expiration refreshes cleanly and absent GitHub headers never fabricate fake quota');

    // -------------------------------------------------------------------------
    // Test 8: Strict two-user isolation & zero GitHub token exposure
    // -------------------------------------------------------------------------
    mockControl.mode = 'normal';
    const syncBRes = await synchronizeUserGitHubActivity(userB.id, { sessionToken: tokenB, force: true });
    assert.strictEqual(syncBRes.ok, true);

    const dashA = await request('/dashboard', { cookie: cookieA });
    const dashB = await request('/dashboard', { cookie: cookieB });
    const statusA = await request('/dashboard/api/sync/status', { cookie: cookieA });
    const crossUserForbidden = await request(`/dashboard/api/sync/status?userId=${userB.id}`, { cookie: cookieA });

    assert.strictEqual(crossUserForbidden.status, 403, 'User A must get 403 querying User B sync status');
    assert.ok(dashA.text.includes('alpha-secret-vault'), 'User A sees own private repo');
    assert.ok(!dashB.text.includes('alpha-secret-vault'), 'User B must NEVER see User A repo');
    assert.ok(dashB.text.includes('beta-isolated-repo'), 'User B sees own private repo');
    assert.ok(!dashA.text.includes('beta-isolated-repo'), 'User A must NEVER see User B repo');

    assert.ok(!dashA.text.includes(tokenA) && !dashB.text.includes(tokenB), 'GitHub tokens must NEVER leak in HTML');
    assert.ok(!JSON.stringify(statusA.json).includes(tokenA), 'GitHub token must NEVER leak in JSON API');
    assert.ok(!JSON.stringify(statusA.json).includes('access_token'), 'access_token fields must NEVER leak in JSON API');
    pass('Two-user cache/sync isolation and zero GitHub token leakage verified');

  } finally {
    global.fetch = originalGlobalFetch;
    clearTestRateLimitBlocks();
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`%${usernameA}%`);
    db.prepare('DELETE FROM api_cache WHERE cache_key IN (?, ?)').run(
      'issue_search:is:issue is:open:1:8',
      'repo_search:stars:>=10:stars:desc:1:12'
    );
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`%${usernameB}%`);
    db.prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`%${testQuery}%`);
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
  console.log(` ALL ${passed} RATE-LIMIT & CACHING VERIFICATION CHECKS PASSED!`);
  console.log('==========================================================\n');
}

runTests().catch(err => {
  console.error('\n[FAIL] Rate-Limit & Caching Test Error:', err);
  process.exit(1);
});
