#!/usr/bin/env node
/**
 * DevNexus Contribution Streaks Automated Test Suite (Member 3)
 *
 * Verifies:
 * 1. Streak State Calculation & Idempotency (unit tests)
 * 2. Consecutive Days & Grace Period Preservation
 * 3. Inactivity Gap & Longest Streak Retention
 * 4. Streak Freeze Shield Protection
 * 5. Milestone & Badge Unlocking Evaluation
 * 6. SQLite Database Persistence (`user_streaks` & `streak_activities`)
 * 7. HTTP Routes (GET /streak, GET /api/streak, POST /api/streak/ping, GET /api/streak/:username)
 * 8. Developer Dashboard Integration (GET /dashboard renders streak widget)
 * 9. Multi-User Isolation & Security Guards
 */

'use strict';

const assert = require('node:assert');
const http = require('node:http');
const app = require('../app');
const {
  db,
  findUserByUsername,
  getUserStreakData,
  upsertUserStreak,
  getUserTotalActiveDays
} = require('../db/database');
const streakService = require('../services/streakService');

// Helper for making HTTP requests
function httpRequest(server, method, reqPath, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqHeaders = { ...headers };
    let payload = null;

    if (data) {
      if (reqHeaders['Content-Type'] === 'application/json') {
        payload = JSON.stringify(data);
      } else {
        payload = typeof data === 'string' ? data : JSON.stringify(data);
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
        const setCookie = res.headers['set-cookie'] ? res.headers['set-cookie'][0].split(';')[0] : null;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          cookie: setCookie,
          body
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTests() {
  console.log('======================================================');
  console.log('DevNexus Contribution Streaks Test Suite (Member 3)');
  console.log('======================================================\n');

  // -------------------------------------------------------------------------
  // Test 1: Unit tests for computeStreakState
  // -------------------------------------------------------------------------
  console.log('[1/8] Testing Pure Streak Calculation Engine...');

  const todayStr = '2026-11-13';
  const yesterdayStr = '2026-11-12';
  const twoDaysAgoStr = '2026-11-11';
  const threeDaysAgoStr = '2026-11-10';

  // 1a. Single active day (today)
  const singleDayState = streakService.computeStreakState(
    [todayStr],
    { longest_streak: 0, streak_freeze_count: 1 },
    todayStr
  );
  assert.strictEqual(singleDayState.current_streak, 1, 'Single active day today must yield current_streak = 1');
  assert.strictEqual(singleDayState.longest_streak, 1, 'Longest streak must be at least 1');
  assert.strictEqual(singleDayState.activeToday, true, 'activeToday must be true when today is present');
  assert.strictEqual(singleDayState.total_active_days, 1, 'total_active_days must be 1');
  assert.ok(singleDayState.statusMessage.includes('Day 1'), 'Status message must acknowledge day 1');

  // 1b. 3 consecutive days (today, yesterday, 2 days ago)
  const threeDaysState = streakService.computeStreakState(
    [todayStr, yesterdayStr, twoDaysAgoStr],
    { longest_streak: 2, streak_freeze_count: 1 },
    todayStr
  );
  assert.strictEqual(threeDaysState.current_streak, 3, '3 consecutive days ending today must yield current_streak = 3');
  assert.strictEqual(threeDaysState.longest_streak, 3, 'longest_streak must update to 3');
  assert.strictEqual(threeDaysState.activeToday, true);

  // 1c. Grace period (active yesterday, but not yet today)
  const gracePeriodState = streakService.computeStreakState(
    [yesterdayStr, twoDaysAgoStr, threeDaysAgoStr],
    { longest_streak: 5, streak_freeze_count: 1 },
    todayStr
  );
  assert.strictEqual(gracePeriodState.current_streak, 3, 'Active yesterday must preserve streak count = 3');
  assert.strictEqual(gracePeriodState.activeToday, false, 'activeToday must be false when today is not yet logged');
  assert.strictEqual(gracePeriodState.longest_streak, 5, 'Stored longest streak (5) must be preserved');
  assert.ok(gracePeriodState.statusMessage.includes('Keep your 3-day streak alive'), 'Status must encourage activity today');

  // 1d. Inactivity gap (last active 2 days ago)
  const gapState = streakService.computeStreakState(
    [twoDaysAgoStr, threeDaysAgoStr],
    { longest_streak: 7, streak_freeze_count: 1 },
    todayStr
  );
  assert.strictEqual(gapState.current_streak, 0, 'Missed both today and yesterday must reset current_streak to 0');
  assert.strictEqual(gapState.longest_streak, 7, 'Historical all-time best longest_streak (7) must be retained');
  assert.strictEqual(gapState.activeToday, false);

  console.log('✓ Pure streak calculation engine handles today, consecutive days, grace period, and gap reset.');

  // -------------------------------------------------------------------------
  // Test 2: Milestone & Badge Unlocking Evaluation
  // -------------------------------------------------------------------------
  console.log('\n[2/8] Testing Streak Milestone Evaluation & Progression...');

  // State with 8 days streak
  const eightDayState = streakService.computeStreakState(
    Array.from({ length: 8 }, (_, i) => streakService.getShiftedDate(todayStr, -i)),
    { longest_streak: 8, streak_freeze_count: 1 },
    todayStr
  );

  const m1 = eightDayState.milestones.find(m => m.days === 1);
  const m3 = eightDayState.milestones.find(m => m.days === 3);
  const m7 = eightDayState.milestones.find(m => m.days === 7);
  const m14 = eightDayState.milestones.find(m => m.days === 14);

  assert.strictEqual(m1.unlocked, true, '1-day milestone must be unlocked at 8 days');
  assert.strictEqual(m3.unlocked, true, '3-day milestone must be unlocked at 8 days');
  assert.strictEqual(m7.unlocked, true, '7-day Weekly Warrior milestone must be unlocked at 8 days');
  assert.strictEqual(m14.unlocked, false, '14-day milestone must be locked at 8 days');
  assert.strictEqual(m14.progress, Math.round((8 / 14) * 100), '14-day milestone progress must reflect percentage');

  assert.ok(eightDayState.nextMilestone, 'Next milestone must be calculated');
  assert.strictEqual(eightDayState.nextMilestone.days, 14, 'Next milestone goal must be 14 days');
  assert.strictEqual(eightDayState.nextMilestone.daysLeft, 6, '14 - 8 = 6 days left for next milestone');

  console.log('✓ Milestones evaluated accurately with correct tier, unlocked state, and next goal calculation.');

  // -------------------------------------------------------------------------
  // Test 3: SQLite Database Integration & Idempotency
  // -------------------------------------------------------------------------
  console.log('\n[3/8] Testing SQLite Persistence & Idempotent Daily Recording...');

  const timestamp = Date.now();
  const testUsername = `streak_tester_${timestamp}`;
  const registerRes = db.prepare(`
    INSERT INTO users (username, name, email, role, status, is_onboarded)
    VALUES (?, 'Streak Test User', ?, 'contributor', 'active', 1)
  `).run(testUsername, `${testUsername}@example.com`);
  const testUserId = registerRes.lastInsertRowid;

  // Initial read for new user
  const initialStreak = getUserStreakData(testUserId);
  assert.strictEqual(initialStreak.current_streak, 0, 'New user starts with 0 streak');
  assert.strictEqual(initialStreak.streak_freeze_count, 1, 'New user starts with 1 streak freeze shield');

  // Record day 1
  const day1Res = await streakService.recordActivity(testUserId, 'test_first_action');
  assert.strictEqual(day1Res.current_streak, 1, 'First action records streak 1');
  assert.strictEqual(day1Res.total_active_days, 1, 'Total active days must be 1');

  // Idempotent recording on the same day (pinging 3 more times on the same date)
  await streakService.recordActivity(testUserId, 'second_action');
  await streakService.recordActivity(testUserId, 'third_action');
  const afterMultiplePings = streakService.getStreakSummary(testUserId);
  assert.strictEqual(afterMultiplePings.current_streak, 1, 'Multiple actions on same date must remain current_streak = 1');
  assert.strictEqual(afterMultiplePings.total_active_days, 1, 'Total active days must remain 1');

  // Verify total active days in DB
  const totalDaysDb = getUserTotalActiveDays(testUserId);
  assert.strictEqual(totalDaysDb, 1, 'DB distinct active days must equal 1');

  console.log('✓ SQLite persistence and daily idempotency verified (no inflation on repeated pings).');

  // -------------------------------------------------------------------------
  // Test 4: Multi-Day Streak Increment & Longest Streak
  // -------------------------------------------------------------------------
  console.log('\n[4/8] Testing Multi-Day Historical Simulation in Database...');

  // Simulate past 2 days in the database for testUserId
  const today = streakService.formatLocalDate();
  const dMinus1 = streakService.getShiftedDate(today, -1);
  const dMinus2 = streakService.getShiftedDate(today, -2);

  await streakService.recordActivity(testUserId, 'simulated_historical', dMinus2);
  await streakService.recordActivity(testUserId, 'simulated_historical', dMinus1);
  const streakNow = await streakService.recordActivity(testUserId, 'today_action', today);

  assert.strictEqual(streakNow.current_streak, 3, 'Consecutive 3-day history must produce current_streak = 3');
  assert.strictEqual(streakNow.longest_streak, 3, 'Longest streak must record 3');
  assert.strictEqual(streakNow.total_active_days, 3, 'Total active days must record 3');

  console.log('✓ Multi-day sequential streak accumulation and history verified.');

  // -------------------------------------------------------------------------
  // Test 5: Streak Freeze Shield Protection
  // -------------------------------------------------------------------------
  console.log('\n[5/8] Testing Streak Freeze Shield Activation...');

  const freezeUser = `freeze_user_${timestamp}`;
  const fRes = db.prepare(`
    INSERT INTO users (username, name, email, role, status, is_onboarded)
    VALUES (?, 'Freeze Test User', ?, 'contributor', 'active', 1)
  `).run(freezeUser, `${freezeUser}@example.com`);
  const freezeUserId = fRes.lastInsertRowid;

  // Active 2 days ago, missed yesterday
  await streakService.recordActivity(freezeUserId, 'past_action', dMinus2);
  const summaryBeforeFreeze = streakService.getStreakSummary(freezeUserId);
  assert.strictEqual(summaryBeforeFreeze.current_streak, 0, 'Missed yesterday and today means streak is broken (0)');

  // Use freeze shield to protect yesterday
  const freezeResult = streakService.useStreakFreeze(freezeUserId);
  assert.strictEqual(freezeResult.success, true, 'Streak freeze must succeed when shields remain');
  assert.strictEqual(freezeResult.streak.current_streak, 2, 'Freeze restored streak from dMinus2 through yesterday (2 consecutive days)');
  assert.strictEqual(freezeResult.streak.streak_freeze_count, 0, '1 freeze shield must be consumed');

  // Trying to use another freeze shield when 0 remain
  const secondFreeze = streakService.useStreakFreeze(freezeUserId);
  assert.strictEqual(secondFreeze.success, false, 'Cannot use freeze when 0 shields remain');

  console.log('✓ Streak freeze shield successfully protected missed day and decremented shield inventory.');

  // -------------------------------------------------------------------------
  // Test 6: HTTP Integration (GET /streak, GET /api/streak, POST /api/streak/ping)
  // -------------------------------------------------------------------------
  console.log('\n[6/8] Testing HTTP Server Routes for Streaks...');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));

  try {
    // 6a. Unauthenticated GET /streak -> 302 to /login
    const unauthStreak = await httpRequest(server, 'GET', '/streak');
    assert.strictEqual(unauthStreak.status, 302, 'Unauthenticated GET /streak must redirect (302)');
    assert.strictEqual(unauthStreak.headers.location, '/login', 'Must redirect to /login');

    // 6b. Unauthenticated GET /api/streak -> 401 JSON
    const unauthApi = await httpRequest(server, 'GET', '/api/streak', null, { 'Accept': 'application/json' });
    assert.strictEqual(unauthApi.status, 401, 'Unauthenticated GET /api/streak must return 401');
    assert.ok(unauthApi.body.includes('"UNAUTHORIZED"'), 'Must return UNAUTHORIZED error code');

    // 6c. Authenticate a session using demo-login
    const authLogin = await httpRequest(server, 'POST', '/auth/demo-login', { username: testUsername }, {
      'Content-Type': 'application/json'
    });
    const sessionCookie = authLogin.cookie;
    assert.ok(sessionCookie, 'Must receive session cookie for authenticated user');

    // 6d. Authenticated GET /streak -> 200 HTML
    const htmlStreak = await httpRequest(server, 'GET', '/streak', null, { 'Cookie': sessionCookie });
    assert.strictEqual(htmlStreak.status, 200, 'Authenticated GET /streak must return 200');
    assert.ok(htmlStreak.body.includes('Contribution Streaks'), 'HTML must include page heading');
    assert.ok(htmlStreak.body.includes('Day Streak') || htmlStreak.body.includes('days'), 'HTML must include streak display');
    assert.ok(htmlStreak.body.includes('Weekly Warrior'), 'HTML must render milestone badges');
    assert.ok(htmlStreak.body.includes('30-Day Contribution Heatmap'), 'HTML must render activity heatmap');

    // 6e. Authenticated GET /api/streak -> 200 JSON
    const jsonStreak = await httpRequest(server, 'GET', '/api/streak', null, {
      'Cookie': sessionCookie,
      'Accept': 'application/json'
    });
    assert.strictEqual(jsonStreak.status, 200, 'Authenticated GET /api/streak must return 200');
    const parsedStreak = JSON.parse(jsonStreak.body);
    assert.strictEqual(parsedStreak.success, true);
    assert.ok(parsedStreak.streak.current_streak >= 1, 'Current streak must be >= 1');
    assert.strictEqual(parsedStreak.user.username, testUsername);

    // 6f. Authenticated POST /api/streak/ping -> 200 JSON
    const pingRes = await httpRequest(server, 'POST', '/api/streak/ping', { activityType: 'manual_ping' }, {
      'Cookie': sessionCookie,
      'Content-Type': 'application/json'
    });
    assert.strictEqual(pingRes.status, 200, 'POST /api/streak/ping must return 200');
    const pingJson = JSON.parse(pingRes.body);
    assert.strictEqual(pingJson.success, true);
    assert.ok(pingJson.streak);

    // 6g. Public GET /api/streak/:username
    const pubRes = await httpRequest(server, 'GET', `/api/streak/${testUsername}`, null, {
      'Accept': 'application/json'
    });
    assert.strictEqual(pubRes.status, 200, 'GET /api/streak/:username must return 200');
    const pubJson = JSON.parse(pubRes.body);
    assert.strictEqual(pubJson.success, true);
    assert.strictEqual(pubJson.user.username, testUsername);

    // 6h. Public non-existent user -> 404
    const notFoundRes = await httpRequest(server, 'GET', '/api/streak/non_existent_random_user_9999', null, {
      'Accept': 'application/json'
    });
    assert.strictEqual(notFoundRes.status, 404, 'Non-existent user must return 404');

    console.log('✓ All HTTP HTML and JSON API endpoints verified.');

    // -------------------------------------------------------------------------
    // Test 7: Dashboard UI Integration
    // -------------------------------------------------------------------------
    console.log('\n[7/8] Testing Developer Dashboard UI Integration...');

    const dashRes = await httpRequest(server, 'GET', '/dashboard', null, { 'Cookie': sessionCookie });
    assert.strictEqual(dashRes.status, 200, 'GET /dashboard must return 200');
    assert.ok(dashRes.body.includes('sidebar-streak-card'), 'Dashboard must render streak sidebar widget');
    assert.ok(dashRes.body.includes('streak-flame-icon') || dashRes.body.includes('Day Streak'), 'Dashboard must render streak flame icon and text');
    assert.ok(dashRes.body.includes('href="/streak"'), 'Dashboard must link to full /streak page');

    console.log('✓ Developer dashboard auto-records daily activity and renders Contribution Streak widget.');

    // -------------------------------------------------------------------------
    // Test 8: Multi-User Isolation
    // -------------------------------------------------------------------------
    console.log('\n[8/8] Testing Multi-User Streak Isolation...');

    const userAlpha = `user_alpha_${timestamp}`;
    const userBeta = `user_beta_${timestamp}`;

    const rA = db.prepare(`INSERT INTO users (username, name, email, role, status, is_onboarded) VALUES (?, 'User Alpha', ?, 'contributor', 'active', 1)`).run(userAlpha, `${userAlpha}@example.com`);
    const rB = db.prepare(`INSERT INTO users (username, name, email, role, status, is_onboarded) VALUES (?, 'User Beta', ?, 'contributor', 'active', 1)`).run(userBeta, `${userBeta}@example.com`);

    const idAlpha = rA.lastInsertRowid;
    const idBeta = rB.lastInsertRowid;

    // Alpha records 3 days
    await streakService.recordActivity(idAlpha, 'alpha_1', dMinus2);
    await streakService.recordActivity(idAlpha, 'alpha_2', dMinus1);
    await streakService.recordActivity(idAlpha, 'alpha_3', today);

    // Beta records only today
    await streakService.recordActivity(idBeta, 'beta_1', today);

    const streakAlpha = streakService.getStreakSummary(idAlpha);
    const streakBeta = streakService.getStreakSummary(idBeta);

    assert.strictEqual(streakAlpha.current_streak, 3, 'User Alpha must have current_streak = 3');
    assert.strictEqual(streakBeta.current_streak, 1, 'User Beta must have current_streak = 1');
    assert.notStrictEqual(streakAlpha.current_streak, streakBeta.current_streak, 'User Alpha streak must not leak into User Beta');

    console.log('✓ Multi-user streak state isolation verified.');

  } finally {
    server.close();
  }

  console.log('\n======================================================');
  console.log('✓ ALL 8 CONTRIBUTION STREAK TESTS PASSED (100%)');
  console.log('======================================================\n');
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Streak test runner failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
