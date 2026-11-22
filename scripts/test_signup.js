'use strict';

/**
 * Comprehensive Sign Up, Session, Onboarding, Protected Routes & DB Failure Test Suite
 */

const assert = require('assert');
const http = require('http');
const querystring = require('querystring');
const app = require('../app');
const { db, findUserByUsername, verifyPassword } = require('../db/database');

function request(server, method, path, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqHeaders = { ...headers };
    let payload = null;

    if (data !== null) {
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
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          cookie: setCookies && setCookies[0] ? setCookies[0].split(';')[0] : null,
          body
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));

  const suffix = Date.now().toString().slice(-7);
  const testUsername = `signup_qa_${suffix}`;
  const testEmail = `signup_qa_${suffix}@example.com`;
  const testPassword = 'StrongPassword123!';
  const createdUsernames = [testUsername];

  try {
    console.log('======================================================');
    console.log('DevNexus Comprehensive Sign Up & Registration Tests');
    console.log('======================================================');

    // 1. Protected routes reject unauthenticated access
    const protectedRedirects = ['/dashboard', '/onboarding', '/portfolio', '/skill-tree', '/streak', '/badges'];
    for (const p of protectedRedirects) {
      const r = await request(server, 'GET', p);
      assert.strictEqual(r.status, 302, `${p} must redirect when unauthenticated`);
      assert.ok(r.headers.location && r.headers.location.startsWith('/login'), `${p} must redirect to /login`);
    }
    const apiUnauth = await request(server, 'GET', '/dashboard/api/readiness', null, { Accept: 'application/json' });
    assert.strictEqual(apiUnauth.status, 401);
    console.log('✓ [1/10] Protected routes and API endpoints block unauthenticated access.');

    // 2. Empty fields validation (JSON & Form)
    const emptyJson = await request(server, 'POST', '/auth/signup', {
      username: '',
      email: '',
      password: '',
      confirmPassword: ''
    }, { 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(emptyJson.status, 400);
    const emptyParsed = JSON.parse(emptyJson.body);
    assert.strictEqual(emptyParsed.success, false);
    assert.ok(emptyParsed.fieldErrors.username && emptyParsed.fieldErrors.email && emptyParsed.fieldErrors.password && emptyParsed.fieldErrors.confirmPassword);

    const missingEmailForm = await request(server, 'POST', '/auth/signup', {
      username: 'validuser123',
      email: '',
      password: testPassword,
      confirmPassword: testPassword
    });
    assert.strictEqual(missingEmailForm.status, 302);
    assert.ok(missingEmailForm.headers.location.includes('/signup?error='));
    console.log('✓ [2/10] Empty and missing required fields rejected.');

    // 3. Invalid username & email formats
    const badUsername = await request(server, 'POST', '/auth/signup', {
      username: 'bad user!',
      email: 'valid@example.com',
      password: testPassword,
      confirmPassword: testPassword
    }, { 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(badUsername.status, 400);
    assert.ok(JSON.parse(badUsername.body).fieldErrors.username);

    const badEmail = await request(server, 'POST', '/auth/signup', {
      username: 'valid_user_99',
      email: 'not-an-email',
      password: testPassword,
      confirmPassword: testPassword
    }, { 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(badEmail.status, 400);
    assert.ok(JSON.parse(badEmail.body).fieldErrors.email);
    console.log('✓ [3/10] Username and email format validation verified.');

    // 4. Weak password enforcement
    const weakPasswords = ['short1!', 'alllowercase1!', 'ALLUPPERCASE1!', 'NoNumbersHere!', 'NoSpecial123'];
    for (const wp of weakPasswords) {
      const r = await request(server, 'POST', '/auth/signup', {
        username: 'valid_user_99',
        email: 'valid@example.com',
        password: wp,
        confirmPassword: wp
      }, { 'Content-Type': 'application/json', Accept: 'application/json' });
      assert.strictEqual(r.status, 400, `Weak password "${wp}" must be rejected`);
      assert.ok(JSON.parse(r.body).fieldErrors.password);
    }
    console.log('✓ [4/10] Password strength requirements enforced.');

    // 5. Password mismatch
    const mismatchRes = await request(server, 'POST', '/auth/signup', {
      username: 'valid_user_99',
      email: 'valid@example.com',
      password: testPassword,
      confirmPassword: 'DifferentPassword123!'
    }, { 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(mismatchRes.status, 400);
    const mismatchBody = JSON.parse(mismatchRes.body);
    assert.strictEqual(mismatchBody.error, 'PASSWORD_MISMATCH');
    assert.ok(mismatchBody.fieldErrors.confirmPassword);
    console.log('✓ [5/10] Password mismatch rejected.');

    // 6. Successful registration via JSON API + bcrypt hashing + session cookie
    const signupRes = await request(server, 'POST', '/auth/signup', {
      username: testUsername,
      email: testEmail,
      password: testPassword,
      confirmPassword: testPassword
    }, { 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(signupRes.status, 201, `Expected 201, got ${signupRes.status}: ${signupRes.body}`);
    const signupJson = JSON.parse(signupRes.body);
    assert.strictEqual(signupJson.success, true);
    assert.strictEqual(signupJson.redirectUrl, '/onboarding');
    assert.strictEqual(signupJson.user.username, testUsername);
    assert.strictEqual(signupJson.user.is_onboarded, false);
    assert.ok(signupRes.cookie, 'Registration must issue session cookie');
    const sessionCookie = signupRes.cookie;

    const dbUser = findUserByUsername(testUsername);
    assert.ok(dbUser, 'User must be persisted in SQLite');
    assert.strictEqual(dbUser.email, testEmail.toLowerCase());
    assert.strictEqual(dbUser.role, 'contributor');
    assert.strictEqual(dbUser.status, 'active');
    assert.strictEqual(dbUser.is_onboarded, 0);
    assert.strictEqual(dbUser.password_salt, 'bcrypt');
    assert.ok(dbUser.password_hash.startsWith('$2'), 'Password must be bcrypt-hashed');
    assert.notStrictEqual(dbUser.password_hash, testPassword);
    assert.strictEqual(verifyPassword(testPassword, dbUser.password_hash, dbUser.password_salt), true);
    console.log('✓ [6/10] Valid registration created user with bcrypt hash & session.');

    // 7. Duplicate username & duplicate email rejection (case-insensitive)
    const dupUserRes = await request(server, 'POST', '/auth/signup', {
      username: testUsername.toUpperCase(),
      email: `other_${suffix}@example.com`,
      password: testPassword,
      confirmPassword: testPassword
    }, { 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(dupUserRes.status, 409);
    assert.strictEqual(JSON.parse(dupUserRes.body).error, 'USERNAME_TAKEN');

    const dupEmailRes = await request(server, 'POST', '/auth/signup', {
      username: `other_${suffix}`,
      email: testEmail.toUpperCase(),
      password: testPassword,
      confirmPassword: testPassword
    }, { 'Content-Type': 'application/json', Accept: 'application/json' });
    assert.strictEqual(dupEmailRes.status, 409);
    assert.strictEqual(JSON.parse(dupEmailRes.body).error, 'EMAIL_EXISTS');
    console.log('✓ [7/10] Duplicate username and duplicate email rejected with HTTP 409.');

    // 8. Post-registration onboarding & dashboard access
    const onboardGet = await request(server, 'GET', '/onboarding', null, { Cookie: sessionCookie });
    assert.strictEqual(onboardGet.status, 200);
    assert.ok(onboardGet.body.includes(testUsername), 'Onboarding page must show registered username');

    const onboardPost = await request(server, 'POST', '/onboarding', {
      name: 'QA Test Developer',
      bio: 'Full stack open source contributor',
      experience_level: 'Intermediate',
      skills: ['JavaScript', 'Node.js']
    }, { Cookie: sessionCookie });
    assert.strictEqual(onboardPost.status, 302);
    assert.strictEqual(onboardPost.headers.location, '/dashboard');

    const dashRes = await request(server, 'GET', '/dashboard', null, { Cookie: sessionCookie });
    assert.strictEqual(dashRes.status, 200);
    assert.ok(dashRes.body.includes('QA Test Developer'));
    console.log('✓ [8/10] Onboarding completed and dashboard accessible with user info.');

    // 9. Logout invalidates session, re-login works with username and email
    const logoutRes = await request(server, 'GET', '/auth/logout', null, { Cookie: sessionCookie });
    assert.strictEqual(logoutRes.status, 302);
    const afterLogoutDash = await request(server, 'GET', '/dashboard', null, { Cookie: sessionCookie });
    assert.strictEqual(afterLogoutDash.status, 302);
    assert.strictEqual(afterLogoutDash.headers.location, '/login');

    const loginByUsername = await request(server, 'POST', '/auth/login', {
      username: testUsername,
      password: testPassword
    });
    assert.strictEqual(loginByUsername.status, 302);
    assert.strictEqual(loginByUsername.headers.location, '/dashboard');
    assert.ok(loginByUsername.cookie);

    const loginByEmail = await request(server, 'POST', '/auth/login', {
      username: testEmail,
      password: testPassword
    });
    assert.strictEqual(loginByEmail.status, 302);
    assert.strictEqual(loginByEmail.headers.location, '/dashboard');
    assert.ok(loginByEmail.cookie);
    console.log('✓ [9/10] Logout invalidates session; re-login with username & email succeeds.');

    // 10. Database failure handling (simulate SQLite failure gracefully)
    const origPrepare = db.prepare.bind(db);
    const origExec = db.exec.bind(db);
    try {
      db.prepare = () => { throw new Error('SQLITE_BUSY: database is locked'); };
      db.exec = () => { throw new Error('SQLITE_BUSY: database is locked'); };

      const dbFailGet = await request(server, 'GET', '/signup');
      assert.strictEqual(dbFailGet.status, 200, 'Signup page should still render cleanly even if session store fails');

      const dbFailJson = await request(server, 'POST', '/auth/signup', {
        username: `dbfail_${suffix}`,
        email: `dbfail_${suffix}@example.com`,
        password: testPassword,
        confirmPassword: testPassword
      }, { 'Content-Type': 'application/json', Accept: 'application/json' });
      assert.strictEqual(dbFailJson.status, 503);
      const dbFailBody = JSON.parse(dbFailJson.body);
      assert.strictEqual(dbFailBody.success, false);
      assert.strictEqual(dbFailBody.error, 'DATABASE_ERROR');
      assert.ok(!dbFailBody.message.includes('SQLITE_BUSY'), 'Must not leak raw SQLite errors to client');

      const dbFailHtml = await request(server, 'POST', '/auth/signup', {
        username: `dbfail_${suffix}`,
        email: `dbfail_${suffix}@example.com`,
        password: testPassword,
        confirmPassword: testPassword
      });
      assert.strictEqual(dbFailHtml.status, 503);
      assert.ok(dbFailHtml.body.includes('database error'));
    } finally {
      db.prepare = origPrepare;
      db.exec = origExec;
    }
    console.log('✓ [10/10] Database connection/query failures handled safely with HTTP 503.');

    console.log('\n======================================================');
    console.log('ALL 10 COMPREHENSIVE SIGNUP CHECKS PASSED (100%)');
    console.log('======================================================\n');
  } finally {
    try {
      for (const u of createdUsernames) {
        const row = findUserByUsername(u);
        if (row) {
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
          db.prepare('DELETE FROM activity_logs WHERE user_id = ? OR target = ?').run(row.id, u);
          db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
        }
      }
    } catch (e) {}
    server.close();
  }
}

run().catch(err => {
  console.error('Signup test suite failed:', err);
  process.exit(1);
});
