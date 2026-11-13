/**
 * DevNexus Complete Application Audit & Verification Runner
 * Executes all 6 existing test scripts plus the comprehensive security, profile, bookmark, and error-handling audit suite.
 */

const { execFileSync } = require('child_process');
const assert = require('assert');
const http = require('http');
const path = require('path');
const querystring = require('querystring');

const SUITES = [
  'test_navigation.js',
  'test_auth.js',
  'test_github_oauth.js',
  'test_projects.js',
  'test_leaderboard.js',
  'test_admin_security.js',
  'test_saanvi_modules.js',
  'test_member3_streaks.js',
  'test_member3_badges.js'
];

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

async function runAuditAssertions() {
  console.log('\n======================================================');
  console.log('Running Extended Security, Profile, & Persistence Audit');
  console.log('======================================================');

  const app = require('../app');
  const { db, findUserByUsername, getUserBookmarks } = require('../db/database');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));

  const tempUsername = 'qa_audit_' + Date.now().toString().slice(-6);

  try {
    // 1. Security Headers Verification
    const homeRes = await httpRequest(server, 'GET', '/');
    assert.strictEqual(homeRes.status, 200);
    assert.strictEqual(homeRes.headers['x-content-type-options'], 'nosniff', 'Must set X-Content-Type-Options: nosniff');
    assert.strictEqual(homeRes.headers['x-frame-options'], 'SAMEORIGIN', 'Must set X-Frame-Options: SAMEORIGIN');
    assert.strictEqual(homeRes.headers['referrer-policy'], 'strict-origin-when-cross-origin', 'Must set Referrer-Policy');
    assert.strictEqual(homeRes.headers['x-powered-by'], undefined, 'x-powered-by must be disabled');
    console.log('✓ [Audit 1/8] HTTP Security headers verified.');

    // 2. Demo Login Impersonation Prevention
    const demoAdminAttempt = await httpRequest(server, 'POST', '/auth/demo-login', { username: 'admin' });
    assert.strictEqual(demoAdminAttempt.status, 302);
    assert.ok(
      demoAdminAttempt.headers.location && demoAdminAttempt.headers.location.includes('/login?error='),
      'Demo login with "admin" must be rejected and redirect to /login?error=...'
    );
    const verifyUnauthedDash = await httpRequest(server, 'GET', '/dashboard', null, demoAdminAttempt.cookie ? { Cookie: demoAdminAttempt.cookie } : {});
    assert.strictEqual(verifyUnauthedDash.status, 302, 'Rejected demo login must not grant access to /dashboard');
    const verifyUnauthedAdmin = await httpRequest(server, 'GET', '/admin', null, demoAdminAttempt.cookie ? { Cookie: demoAdminAttempt.cookie } : {});
    assert.strictEqual(verifyUnauthedAdmin.status, 403, 'Rejected demo login must not grant access to /admin');
    console.log('✓ [Audit 2/8] Demo-login admin/account impersonation blocked.');

    // 3. Registration Input Validation (Invalid email & short username)
    const badEmailRes = await httpRequest(server, 'POST', '/auth/signup', {
      username: tempUsername,
      email: 'not-an-email',
      password: 'ValidPassword123!',
      confirmPassword: 'ValidPassword123!'
    });
    assert.strictEqual(badEmailRes.status, 302);
    assert.ok(badEmailRes.headers.location.includes('/signup?error='), 'Invalid email format must be rejected');

    const shortUserRes = await httpRequest(server, 'POST', '/auth/signup', {
      username: 'ab',
      email: 'ab@example.com',
      password: 'ValidPassword123!',
      confirmPassword: 'ValidPassword123!'
    });
    assert.strictEqual(shortUserRes.status, 302);
    assert.ok(shortUserRes.headers.location.includes('/signup?error='), 'Username < 3 chars must be rejected');
    console.log('✓ [Audit 3/8] Backend registration validation (email format & username length) verified.');

    // 4. User Registration + Prevent Demo Impersonation of Registered User
    const regRes = await httpRequest(server, 'POST', '/auth/signup', {
      username: tempUsername,
      email: `${tempUsername}@example.com`,
      password: 'ValidPassword123!',
      confirmPassword: 'ValidPassword123!'
    });
    assert.strictEqual(regRes.status, 302);
    assert.strictEqual(regRes.headers.location, '/onboarding');
    assert.ok(regRes.cookie, 'Valid registration must establish session cookie');
    const userCookie = regRes.cookie;

    const demoRegisteredAttempt = await httpRequest(server, 'POST', '/auth/demo-login', { username: tempUsername });
    assert.strictEqual(demoRegisteredAttempt.status, 302);
    assert.ok(demoRegisteredAttempt.headers.location.includes('/login?error='), 'Demo login must reject registered password-protected user');
    console.log('✓ [Audit 4/8] Registered user creation & demo-login protection verified.');

    // 5. Profile Onboarding & Profile Editing Persistence
    const onboardRes = await httpRequest(server, 'POST', '/onboarding', {
      name: 'QA Audit Developer',
      bio: 'Testing full-stack persistence',
      experience_level: 'Advanced',
      skills: ['Rust', 'Go', 'TypeScript']
    }, { Cookie: userCookie });
    assert.strictEqual(onboardRes.status, 302);
    assert.strictEqual(onboardRes.headers.location, '/dashboard');

    let dbUser = findUserByUsername(tempUsername);
    assert.strictEqual(dbUser.name, 'QA Audit Developer');
    assert.strictEqual(dbUser.experience_level, 'Advanced');
    assert.deepStrictEqual(
      JSON.parse(dbUser.skills).map(s => (typeof s === 'string' ? s : s.name)),
      ['Rust', 'Go', 'TypeScript']
    );

    const profileEditRes = await httpRequest(server, 'POST', '/profile', {
      name: 'Updated QA Developer',
      bio: 'Updated bio in SQLite',
      experience_level: 'Intermediate',
      skills: ['Python', 'JavaScript']
    }, { Cookie: userCookie, 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(profileEditRes.status, 200);
    const profileJson = JSON.parse(profileEditRes.body);
    assert.strictEqual(profileJson.success, true);
    assert.strictEqual(profileJson.user.name, 'Updated QA Developer');
    assert.strictEqual(profileJson.user.experience_level, 'Intermediate');
    console.log('✓ [Audit 5/8] Developer onboarding & profile editing persistence verified.');

    // 6. Bookmark Creation & Removal in SQLite
    const testIssueUrl = `https://github.com/facebook/react/issues/999999`;
    const addBmRes = await httpRequest(server, 'POST', '/dashboard/api/bookmarks', {
      issue_id: '999999',
      issue_number: 999999,
      repo_name: 'facebook/react',
      title: 'Test Audit Issue',
      html_url: testIssueUrl,
      difficulty: 'Beginner',
      comments_count: 2
    }, { Cookie: userCookie, 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(addBmRes.status, 200);
    const addBmJson = JSON.parse(addBmRes.body);
    assert.strictEqual(addBmJson.success, true);
    assert.strictEqual(addBmJson.count, 1);
    assert.strictEqual(getUserBookmarks(dbUser.id).length, 1);

    const delBmRes = await httpRequest(server, 'DELETE', '/dashboard/api/bookmarks', {
      html_url: testIssueUrl
    }, { Cookie: userCookie, 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(delBmRes.status, 200);
    const delBmJson = JSON.parse(delBmRes.body);
    assert.strictEqual(delBmJson.success, true);
    assert.strictEqual(delBmJson.count, 0);
    assert.strictEqual(getUserBookmarks(dbUser.id).length, 0);
    console.log('✓ [Audit 6/8] Persistent SQLite bookmark creation and deletion verified.');

    // 7. Password Assistance Logging (No false email claim)
    const forgotRes = await httpRequest(server, 'POST', '/forgot-password', {
      identifier: tempUsername
    });
    assert.strictEqual(forgotRes.status, 302);
    assert.ok(forgotRes.headers.location.includes('/login?success='), 'Forgot password must redirect with transparent message');
    assert.ok(decodeURIComponent(forgotRes.headers.location).includes('Automated email password reset is disabled'), 'Must clearly state email reset is disabled');
    console.log('✓ [Audit 7/8] Transparent password assistance handling verified.');

    // 8. 404 Not Found Handler (HTML & JSON)
    const notFoundHtml = await httpRequest(server, 'GET', '/non-existent-route-xyz');
    assert.strictEqual(notFoundHtml.status, 404);
    assert.ok(notFoundHtml.body.includes('Page Not Found'), '404 HTML page must render Page Not Found');

    const notFoundJson = await httpRequest(server, 'GET', '/non-existent-route-xyz', null, { Accept: 'application/json' });
    assert.strictEqual(notFoundJson.status, 404);
    const nfParsed = JSON.parse(notFoundJson.body);
    assert.strictEqual(nfParsed.success, false);
    console.log('✓ [Audit 8/8] 404 Not Found HTML & JSON handlers verified.');

  } finally {
    try {
      db.prepare('DELETE FROM users WHERE username = ?').run(tempUsername);
      db.prepare("DELETE FROM activity_logs WHERE target LIKE ?").run(`%${tempUsername}%`);
    } catch (e) {}
    server.close();
  }
}

async function main() {
  console.log('======================================================');
  console.log('DevNexus Complete Verification Suite');
  console.log('======================================================');

  for (const script of SUITES) {
    const scriptPath = path.join(__dirname, script);
    console.log(`\n>>> Running ${script}...`);
    execFileSync(process.execPath, [scriptPath], { stdio: 'inherit' });
  }

  await runAuditAssertions();

  // Final cleanup of any leftover test users from test scripts (preserving real accounts)
  const { db } = require('../db/database');
  db.prepare(`
    DELETE FROM users
    WHERE (username LIKE 'user_%' AND email LIKE '%@test.local')
       OR username LIKE 'test_dev_%'
       OR username IN ('test-navigator', 'test_oauth_developer', 'test_regular_contributor', 'mismatch_user')
  `).run();
  db.prepare("DELETE FROM contributor_activities WHERE contributor_id IN (SELECT id FROM contributors WHERE username = 'test_dev_leaderboard')").run();
  db.prepare("DELETE FROM contributors WHERE username = 'test_dev_leaderboard'").run();

  console.log('\n======================================================');
  console.log('ALL DEVNEXUS TEST SUITES & QA CHECKS PASSED (100%)');
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\nTest runner failed:', err);
  process.exit(1);
});
