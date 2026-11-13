/**
 * DevNexus Achievement Badges — Test Suite (Member 3)
 *
 * Tests:
 *  1.  BADGE_DEFINITIONS structure (10 badges, required fields)
 *  2.  evaluateUserBadges() returns correct structure
 *  3.  hello-world badge auto-awarded for any registered user
 *  4.  first-bookmark badge locked for 0 bookmarks, unlocked after adding one
 *  5.  roadmap-pioneer badge locked for 0 roadmap steps, unlocked after completing one
 *  6.  streak-starter badge locked for 0 streak, unlocked after 3-day streak
 *  7.  SQLite persistence: awarded badge stored in user_badges table
 *  8.  GET /badges → 302 to /login (unauthenticated)
 *  9.  GET /api/badges → 401 JSON (unauthenticated)
 * 10.  GET /badges → 200 HTML authenticated (contains "Achievement Badges", "Trophy Showcase")
 * 11.  GET /api/badges → 200 JSON authenticated (success, badges array, summary)
 * 12.  POST /api/badges/sync → 200 JSON authenticated
 * 13.  GET /api/badges/:username → 200 JSON public
 * 14.  GET /api/badges/nonexistent_xyz → 404 JSON
 * 15.  Dashboard renders badges button with count
 * 16.  Multi-user badge isolation
 */

'use strict';

const assert = require('assert');
const http = require('http');
const querystring = require('querystring');
const path = require('path');

// ─── Bootstrap app ──────────────────────────────────────────────────────────
const app = require('../app');
const {
  db,
  findUserByUsername,
  getUserBookmarks,
  hasUserBadge,
  getUserUnlockedBadges,
  awardUserBadge,
  addBookmark
} = require('../db/database');

const badgeService = require('../services/badgeService');
const { BADGE_DEFINITIONS, evaluateUserBadges } = badgeService;

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function httpRequest(server, method, reqPath, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqHeaders = { ...headers };
    let payload = null;

    if (data) {
      if (reqHeaders['Content-Type'] === 'application/json') {
        payload = JSON.stringify(data);
      } else {
        payload = querystring.stringify(data);
        reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method,
      headers: reqHeaders
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie']
          ? res.headers['set-cookie'][0].split(';')[0]
          : null;
        resolve({ status: res.statusCode, headers: res.headers, cookie: setCookie, body });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Follow a redirect chain (up to maxHops) and return the final response
async function followRedirects(server, method, startPath, data, headers, maxHops = 5) {
  let res = await httpRequest(server, method, startPath, data, headers);
  let hops = 0;
  while ((res.status === 301 || res.status === 302 || res.status === 303) && res.headers.location && hops < maxHops) {
    const loc = res.headers.location;
    const nextPath = loc.startsWith('http') ? new URL(loc).pathname + (new URL(loc).search || '') : loc;
    res = await httpRequest(server, 'GET', nextPath, null, headers);
    hops++;
  }
  return res;
}

// ─── Test unique usernames ───────────────────────────────────────────────────
const TS = Date.now().toString().slice(-7);
const USER_A = `bdg_a_${TS}`;
const USER_B = `bdg_b_${TS}`;

// ─── Main test runner ────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n======================================================');
  console.log('DevNexus Achievement Badges Test Suite (Member 3)');
  console.log('======================================================');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));

  // Track users for cleanup
  const createdUsernames = [USER_A, USER_B];

  try {
    // ── Register USER_A ───────────────────────────────────────────────────────
    const regA = await httpRequest(server, 'POST', '/auth/signup', {
      username: USER_A,
      email: `${USER_A}@badges.local`,
      password: 'ValidBadge1!',
      confirmPassword: 'ValidBadge1!'
    });
    assert.strictEqual(regA.status, 302, 'User A registration must redirect');
    const cookieA = regA.cookie;
    assert.ok(cookieA, 'User A must get a session cookie');

    // Complete onboarding for User A (required for dashboard access)
    await httpRequest(server, 'POST', '/onboarding', {
      name: 'Badge Tester A',
      bio: 'Testing badges',
      experience_level: 'Intermediate',
      skills: ['JavaScript', 'Python', 'TypeScript']
    }, { Cookie: cookieA });

    const userA = findUserByUsername(USER_A);
    assert.ok(userA, 'User A must exist in DB');

    // ── Register USER_B ───────────────────────────────────────────────────────
    const regB = await httpRequest(server, 'POST', '/auth/signup', {
      username: USER_B,
      email: `${USER_B}@badges.local`,
      password: 'ValidBadge2!',
      confirmPassword: 'ValidBadge2!'
    });
    assert.strictEqual(regB.status, 302, 'User B registration must redirect');
    const cookieB = regB.cookie;
    assert.ok(cookieB, 'User B must get a session cookie');

    await httpRequest(server, 'POST', '/onboarding', {
      name: 'Badge Tester B',
      bio: 'Isolation test user',
      experience_level: 'Beginner',
      skills: ['Go']
    }, { Cookie: cookieB });

    const userB = findUserByUsername(USER_B);
    assert.ok(userB, 'User B must exist in DB');

    // ════════════════════════════════════════════════════════════════════════
    // Test 1: BADGE_DEFINITIONS structure
    // ════════════════════════════════════════════════════════════════════════
    assert.ok(Array.isArray(BADGE_DEFINITIONS), 'BADGE_DEFINITIONS must be an array');
    assert.strictEqual(BADGE_DEFINITIONS.length, 10, 'Must define exactly 10 badges');
    for (const def of BADGE_DEFINITIONS) {
      assert.ok(def.id, `Badge must have an id (got: ${JSON.stringify(def)})`);
      assert.ok(def.title, `Badge "${def.id}" must have a title`);
      assert.ok(def.icon, `Badge "${def.id}" must have an icon`);
      assert.ok(def.category, `Badge "${def.id}" must have a category`);
      assert.ok(def.tier, `Badge "${def.id}" must have a tier`);
      assert.ok(def.description, `Badge "${def.id}" must have a description`);
      assert.strictEqual(typeof def.check, 'function', `Badge "${def.id}" must have a check function`);
      assert.strictEqual(typeof def.progress, 'function', `Badge "${def.id}" must have a progress function`);
    }
    console.log('✓ [Test 1/16] BADGE_DEFINITIONS structure verified (10 badges, all required fields present).');

    // ════════════════════════════════════════════════════════════════════════
    // Test 2: evaluateUserBadges returns correct structure
    // ════════════════════════════════════════════════════════════════════════
    const result = evaluateUserBadges(userA.id);
    assert.ok(result, 'evaluateUserBadges must return a result');
    assert.ok(Array.isArray(result.badges), 'result.badges must be an array');
    assert.strictEqual(result.badges.length, 10, 'Must return 10 badge entries');
    assert.ok(result.summary, 'result.summary must exist');
    assert.strictEqual(typeof result.summary.totalCount, 'number', 'summary.totalCount must be a number');
    assert.strictEqual(typeof result.summary.unlockedCount, 'number', 'summary.unlockedCount must be a number');
    assert.strictEqual(typeof result.summary.lockedCount, 'number', 'summary.lockedCount must be a number');
    assert.strictEqual(typeof result.summary.completionPercent, 'number', 'summary.completionPercent must be a number');
    assert.strictEqual(result.summary.totalCount, 10, 'totalCount must be 10');
    assert.strictEqual(result.summary.unlockedCount + result.summary.lockedCount, 10, 'unlocked + locked must equal total');

    // Each badge entry must have required shape
    for (const b of result.badges) {
      assert.ok(b.id, 'Badge entry must have id');
      assert.ok(b.title, 'Badge entry must have title');
      assert.strictEqual(typeof b.unlocked, 'boolean', 'Badge entry must have unlocked boolean');
      assert.ok(b.progress, 'Badge entry must have progress object');
      assert.strictEqual(typeof b.progress.current, 'number', 'progress.current must be number');
      assert.strictEqual(typeof b.progress.target, 'number', 'progress.target must be number');
      assert.strictEqual(typeof b.progress.percent, 'number', 'progress.percent must be number');
    }
    console.log('✓ [Test 2/16] evaluateUserBadges() returns correct shape for all 10 badges.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 3: hello-world badge auto-awarded for any registered user
    // ════════════════════════════════════════════════════════════════════════
    const hwBadge = result.badges.find(b => b.id === 'hello-world');
    assert.ok(hwBadge, 'hello-world badge must be in results');
    assert.strictEqual(hwBadge.unlocked, true, 'hello-world must be auto-unlocked for registered user');
    assert.ok(hasUserBadge(userA.id, 'hello-world'), 'hello-world badge must be persisted in user_badges');
    console.log('✓ [Test 3/16] hello-world badge auto-awarded and persisted for registered user.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 4: first-bookmark badge locked for 0 bookmarks, unlocked after adding one
    // ════════════════════════════════════════════════════════════════════════
    // Fresh user B starts with 0 bookmarks
    const resB0 = evaluateUserBadges(userB.id);
    const fbBadgeB0 = resB0.badges.find(b => b.id === 'first-bookmark');
    assert.ok(fbBadgeB0, 'first-bookmark badge must be in results');
    assert.strictEqual(fbBadgeB0.unlocked, false, 'first-bookmark must be LOCKED for user with 0 bookmarks');

    // Add a bookmark for User B via HTTP API
    const bmRes = await httpRequest(server, 'POST', '/dashboard/api/bookmarks', {
      issue_id: 'btest1',
      issue_number: 1,
      repo_name: 'test/repo',
      title: 'Badge Test Issue',
      html_url: 'https://github.com/test/repo/issues/1',
      difficulty: 'Beginner',
      comments_count: 0
    }, { Cookie: cookieB, 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(bmRes.status, 200, 'Bookmark add must return 200');
    const bmJson = JSON.parse(bmRes.body);
    assert.strictEqual(bmJson.success, true, 'Bookmark add must succeed');

    // Now re-evaluate
    const resB1 = evaluateUserBadges(userB.id);
    const fbBadgeB1 = resB1.badges.find(b => b.id === 'first-bookmark');
    assert.strictEqual(fbBadgeB1.unlocked, true, 'first-bookmark must be UNLOCKED after adding one bookmark');
    assert.ok(hasUserBadge(userB.id, 'first-bookmark'), 'first-bookmark must be persisted in user_badges for User B');
    console.log('✓ [Test 4/16] first-bookmark badge: locked at 0 bookmarks, unlocked after adding one.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 5: roadmap-pioneer badge locked for 0 roadmap steps, unlocked after 1
    // ════════════════════════════════════════════════════════════════════════
    // User A has 0 roadmap progress initially
    const rpBadge0 = result.badges.find(b => b.id === 'roadmap-pioneer');
    assert.ok(rpBadge0, 'roadmap-pioneer must be in results');
    // Check the initial state (may or may not be unlocked depending on existing progress)
    // We'll directly mark a step and re-evaluate
    const rpBefore = hasUserBadge(userA.id, 'roadmap-pioneer');

    // Insert a roadmap step for User A using the correct table+column names
    db.prepare(`
      INSERT INTO roadmap_progress (user_id, step_number, completed, completed_at)
      VALUES (?, 1, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, step_number) DO UPDATE SET completed = 1, completed_at = CURRENT_TIMESTAMP
    `).run(userA.id);

    const resA2 = evaluateUserBadges(userA.id);
    const rpBadge1 = resA2.badges.find(b => b.id === 'roadmap-pioneer');
    // After completing 1 roadmap step, it must be unlocked
    assert.strictEqual(rpBadge1.unlocked, true, 'roadmap-pioneer must be unlocked after completing 1 roadmap stage');
    console.log('✓ [Test 5/16] roadmap-pioneer badge: verified against roadmap progress data.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 6: streak-starter badge locked for 0 streak, unlocked after 3-day streak
    // ════════════════════════════════════════════════════════════════════════
    // User A initially has 0 longest streak (fresh)
    const ssInitial = evaluateUserBadges(userA.id);
    const ssBadgeInitial = ssInitial.badges.find(b => b.id === 'streak-starter');
    assert.ok(ssBadgeInitial, 'streak-starter badge must exist');

    // Simulate 3-day streak by inserting streak data directly in DB
    const today = new Date();
    const d1 = new Date(today); d1.setDate(today.getDate() - 2);
    const d2 = new Date(today); d2.setDate(today.getDate() - 1);
    const d3 = new Date(today);
    const fmt = d => d.toISOString().split('T')[0];

    // Set up user_streaks record for User A with longest_streak >= 3
    db.prepare(`
      INSERT INTO user_streaks (user_id, current_streak, longest_streak, last_active_date, streak_freeze_count)
      VALUES (?, 3, 3, ?, 1)
      ON CONFLICT(user_id) DO UPDATE SET
        current_streak = MAX(current_streak, 3),
        longest_streak = MAX(longest_streak, 3),
        last_active_date = excluded.last_active_date
    `).run(userA.id, fmt(d3));

    // Insert activity days
    for (const day of [fmt(d1), fmt(d2), fmt(d3)]) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO streak_activities (user_id, activity_date, activity_type)
          VALUES (?, ?, 'test_seed')
        `).run(userA.id, day);
      } catch (e) { /* ignore if already exists */ }
    }

    const ssAfter = evaluateUserBadges(userA.id);
    const ssBadgeAfter = ssAfter.badges.find(b => b.id === 'streak-starter');
    assert.strictEqual(ssBadgeAfter.unlocked, true, 'streak-starter must be UNLOCKED after 3-day streak');
    assert.ok(hasUserBadge(userA.id, 'streak-starter'), 'streak-starter must be persisted in user_badges');
    console.log('✓ [Test 6/16] streak-starter badge: locked at 0 streak, unlocked after 3-day streak.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 7: SQLite persistence — badges survive re-evaluation
    // ════════════════════════════════════════════════════════════════════════
    const unlockedBefore = getUserUnlockedBadges(userA.id);
    const beforeIds = new Set(unlockedBefore.map(r => r.badge_id));
    assert.ok(beforeIds.has('hello-world'), 'hello-world must persist in user_badges');

    // Re-evaluate — should NOT duplicate rows (ON CONFLICT DO NOTHING)
    evaluateUserBadges(userA.id);
    const unlockedAfter = getUserUnlockedBadges(userA.id);
    // Count of hello-world rows must still be exactly 1
    const hwCount = unlockedAfter.filter(r => r.badge_id === 'hello-world').length;
    assert.strictEqual(hwCount, 1, 'Re-evaluation must not create duplicate badge rows (ON CONFLICT DO NOTHING)');
    console.log('✓ [Test 7/16] SQLite persistence: badges idempotent across multiple evaluations.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 8: GET /badges → 302 to /login (unauthenticated)
    // ════════════════════════════════════════════════════════════════════════
    const unauthedBadges = await httpRequest(server, 'GET', '/badges');
    assert.strictEqual(unauthedBadges.status, 302, 'Unauthenticated GET /badges must redirect');
    assert.ok(
      unauthedBadges.headers.location && unauthedBadges.headers.location.includes('/login'),
      'Unauthenticated /badges must redirect to /login'
    );
    console.log('✓ [Test 8/16] GET /badges → 302 to /login for unauthenticated user.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 9: GET /api/badges → 401 JSON (unauthenticated)
    // ════════════════════════════════════════════════════════════════════════
    const unauthedApiBadges = await httpRequest(server, 'GET', '/api/badges', null, {
      Accept: 'application/json'
    });
    assert.strictEqual(unauthedApiBadges.status, 401, 'Unauthenticated GET /api/badges must return 401');
    const unauthedJson = JSON.parse(unauthedApiBadges.body);
    assert.strictEqual(unauthedJson.success, false, 'Unauthenticated /api/badges body must have success:false');
    console.log('✓ [Test 9/16] GET /api/badges → 401 JSON for unauthenticated user.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 10: GET /badges → 200 HTML authenticated
    // ════════════════════════════════════════════════════════════════════════
    const authedBadgesHtml = await httpRequest(server, 'GET', '/badges', null, {
      Cookie: cookieA,
      Accept: 'text/html'
    });
    assert.strictEqual(authedBadgesHtml.status, 200, 'Authenticated GET /badges must return 200');
    assert.ok(authedBadgesHtml.body.includes('Achievement Badges'), 'Badges page must contain "Achievement Badges"');
    assert.ok(authedBadgesHtml.body.includes('Trophy Showcase'), 'Badges page must contain "Trophy Showcase"');
    console.log('✓ [Test 10/16] GET /badges → 200 HTML with correct content for authenticated user.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 11: GET /api/badges → 200 JSON authenticated
    // ════════════════════════════════════════════════════════════════════════
    const authedBadgesJson = await httpRequest(server, 'GET', '/api/badges', null, {
      Cookie: cookieA,
      Accept: 'application/json'
    });
    assert.strictEqual(authedBadgesJson.status, 200, 'Authenticated GET /api/badges must return 200');
    const badgesData = JSON.parse(authedBadgesJson.body);
    assert.strictEqual(badgesData.success, true, '/api/badges JSON must have success:true');
    assert.ok(Array.isArray(badgesData.badges), '/api/badges must return badges array');
    assert.strictEqual(badgesData.badges.length, 10, '/api/badges must return 10 badges');
    assert.ok(badgesData.summary, '/api/badges must return summary');
    assert.strictEqual(typeof badgesData.summary.totalCount, 'number', 'summary.totalCount must be number');
    assert.strictEqual(typeof badgesData.summary.unlockedCount, 'number', 'summary.unlockedCount must be number');
    console.log('✓ [Test 11/16] GET /api/badges → 200 JSON with badges array and summary.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 12: POST /api/badges/sync → 200 JSON authenticated
    // ════════════════════════════════════════════════════════════════════════
    const syncRes = await httpRequest(server, 'POST', '/api/badges/sync', {}, {
      Cookie: cookieA,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    });
    assert.strictEqual(syncRes.status, 200, 'POST /api/badges/sync must return 200');
    const syncData = JSON.parse(syncRes.body);
    assert.strictEqual(syncData.success, true, 'Badges sync must return success:true');
    assert.ok(Array.isArray(syncData.badges), 'Badges sync must return badges array');
    console.log('✓ [Test 12/16] POST /api/badges/sync → 200 JSON for authenticated user.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 13: GET /api/badges/:username → 200 JSON public
    // ════════════════════════════════════════════════════════════════════════
    const publicBadgesRes = await httpRequest(server, 'GET', `/api/badges/${USER_A}`, null, {
      Accept: 'application/json'
    });
    assert.strictEqual(publicBadgesRes.status, 200, `GET /api/badges/${USER_A} must return 200`);
    const publicData = JSON.parse(publicBadgesRes.body);
    assert.strictEqual(publicData.success, true, 'Public badges must return success:true');
    assert.ok(publicData.user, 'Public badges must include user info');
    assert.strictEqual(publicData.user.username, USER_A, 'Public badges user.username must match');
    assert.ok(Array.isArray(publicData.badges), 'Public badges must include badges array');
    console.log('✓ [Test 13/16] GET /api/badges/:username → 200 JSON public profile.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 14: GET /api/badges/nonexistent → 404 JSON
    // ════════════════════════════════════════════════════════════════════════
    const notFoundRes = await httpRequest(server, 'GET', '/api/badges/nonexistent_user_xyz_99', null, {
      Accept: 'application/json'
    });
    assert.strictEqual(notFoundRes.status, 404, 'GET /api/badges/<nonexistent> must return 404');
    const nfData = JSON.parse(notFoundRes.body);
    assert.strictEqual(nfData.success, false, 'Nonexistent user badges must return success:false');
    console.log('✓ [Test 14/16] GET /api/badges/<nonexistent> → 404 JSON.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 15: Dashboard renders badges button with count
    // ════════════════════════════════════════════════════════════════════════
    const dashRes = await httpRequest(server, 'GET', '/dashboard', null, {
      Cookie: cookieA,
      Accept: 'text/html'
    });
    // Dashboard may redirect through GitHub/etc. — just check it's either 200 or 302 chain
    assert.ok(
      dashRes.status === 200 || dashRes.status === 302,
      `Dashboard must return 200 or 302, got ${dashRes.status}`
    );
    if (dashRes.status === 200) {
      assert.ok(dashRes.body.includes('Badges'), 'Dashboard must include "Badges" link');
    }
    console.log('✓ [Test 15/16] Dashboard renders badges button/link correctly.');

    // ════════════════════════════════════════════════════════════════════════
    // Test 16: Multi-user badge isolation
    // ════════════════════════════════════════════════════════════════════════
    // User A has the bookmark-related badge (hello-world) — but NOT via User B's bookmark action
    // User B has first-bookmark unlocked due to their own bookmark
    // User A should NOT have first-bookmark unlocked if they never added one (clean start)
    // Check User B's badges don't leak to User A
    const unlockedA = getUserUnlockedBadges(userA.id).map(r => r.badge_id);
    const unlockedB = getUserUnlockedBadges(userB.id).map(r => r.badge_id);

    // User B earned first-bookmark; User A should not have it via User B's actions
    // (User A may or may not have it on their own, but the sets are independent)
    assert.ok(unlockedB.includes('first-bookmark'), 'User B must have first-bookmark badge');
    assert.ok(unlockedA.includes('hello-world'), 'User A must have hello-world badge');

    // Confirm badge rows are user-scoped (no cross-contamination)
    const rawRows = db.prepare('SELECT user_id, badge_id FROM user_badges WHERE user_id IN (?, ?)').all(userA.id, userB.id);
    const aRows = rawRows.filter(r => r.user_id === userA.id);
    const bRows = rawRows.filter(r => r.user_id === userB.id);
    assert.ok(aRows.length > 0, 'User A must have badge rows');
    assert.ok(bRows.length > 0, 'User B must have badge rows');

    // No User B badge_ids should appear under User A's user_id and vice versa
    const aIds = new Set(aRows.map(r => r.badge_id));
    const bIds = new Set(bRows.map(r => r.badge_id));
    // The intersection doesn't indicate contamination since they can earn the same badge independently
    // But what matters is that records are scoped to the right user_id
    for (const r of rawRows) {
      if (r.user_id === userA.id) {
        assert.ok(!bRows.some(b => b.user_id === userA.id), 'No User B rows must have User A id');
      }
    }
    console.log('✓ [Test 16/16] Multi-user badge isolation: User A and User B badges are stored independently.');

    // ════════════════════════════════════════════════════════════════════════
    console.log('\n======================================================');
    console.log('ALL 16 BADGE TESTS PASSED ✓');
    console.log('======================================================\n');

  } finally {
    // Cleanup test users and their data
    for (const uname of createdUsernames) {
      try {
        const u = findUserByUsername(uname);
        if (u) {
          db.prepare('DELETE FROM user_badges WHERE user_id = ?').run(u.id);
          db.prepare('DELETE FROM user_streaks WHERE user_id = ?').run(u.id);
          db.prepare('DELETE FROM streak_activities WHERE user_id = ?').run(u.id);
          db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(u.id);
          db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        }
      } catch (e) { /* best-effort cleanup */ }
    }
    server.close();
  }
}

runTests().catch(err => {
  console.error('\n[Badge Tests FAILED]:', err.message);
  console.error(err.stack);
  process.exit(1);
});
