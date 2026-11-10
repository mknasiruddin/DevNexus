/**
 * DevNexus Admin Security & Authentication Test Suite
 * Tests:
 * 1. Absence of initial administrator setup and default credentials in templates
 * 2. Unauthorized access rejection (unauthenticated & regular contributor session)
 * 3. Secure password hashing with bcrypt
 * 4. Administrator credential verification and session establishment
 * 5. Admin API authorization protection
 */

const assert = require('assert');
const http = require('http');
const querystring = require('querystring');
require('dotenv').config();

const app = require('../app');
const { db, verifyPassword } = require('../db/database');

function makeRequest(server, path, method = 'GET', data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqHeaders = { ...headers };
    let body = null;

    if (data) {
      if (typeof data === 'string') {
        body = data;
      } else {
        body = querystring.stringify(data);
        reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let resBody = '';
      res.on('data', chunk => { resBody += chunk; });
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'];
        resolve({
          status: res.statusCode,
          headers: res.headers,
          setCookie: setCookies ? setCookies[0].split(';')[0] : null,
          body: resBody
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function runTests() {
  console.log('--- DevNexus Admin Security & Authentication Test Suite ---\n');

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));

  try {
    // Test 1: Verify Public-Facing Admin Login Page has NO credentials or setup instructions
    console.log('[1/5] Testing Admin Login Page for Absence of Exposed Credentials...');
    const r1 = await makeRequest(server, '/admin/login');
    assert.strictEqual(r1.status, 200, 'GET /admin/login must return HTTP 200');
    assert.strictEqual(r1.body.includes('Initial Administrator Setup'), false, 'Must NOT contain "Initial Administrator Setup"');
    assert.strictEqual(r1.body.includes('DevNexus@Admin2026!'), false, 'Must NOT contain "DevNexus@Admin2026!"');
    assert.strictEqual(r1.body.includes('node scripts/setup-admin.js'), false, 'Must NOT contain "node scripts/setup-admin.js"');
    assert.strictEqual(r1.body.includes('Default bootstrap login'), false, 'Must NOT contain "Default bootstrap login"');
    assert.ok(r1.body.includes('403 Forbidden'), 'Must contain 403 Forbidden header');
    assert.ok(r1.body.includes('Administrator Username'), 'Must contain username input label');
    assert.ok(r1.body.includes('placeholder="your-admin-username"'), 'Must contain username placeholder');
    assert.ok(r1.body.includes('Administrator Password'), 'Must contain password input label');
    assert.ok(r1.body.includes('placeholder="Enter administrator password"'), 'Must contain password placeholder');
    console.log('✓ Public admin gateway is clean: zero exposed credentials, setup instructions, or secrets.');

    // Test 2: Verify Bcrypt Hashing in SQLite Database
    console.log('\n[2/5] Testing Database Password Storage & Bcrypt Hashing...');
    const adminUser = db.prepare('SELECT * FROM users WHERE role = ?').get('admin');
    assert.ok(adminUser, 'Admin record must exist in SQLite');
    assert.ok(adminUser.password_hash.startsWith('$2b$') || adminUser.password_hash.startsWith('$2a$'), 'Admin password must be hashed with bcrypt ($2a$ or $2b$)');
    assert.strictEqual(adminUser.password_salt, 'bcrypt', 'Admin salt must indicate bcrypt');
    assert.strictEqual(verifyPassword('DevNexus@Admin2026!', adminUser.password_hash, adminUser.password_salt), false, 'Old exposed default password must fail');
    assert.strictEqual(verifyPassword(process.env.INITIAL_ADMIN_PASSWORD || 'DevNexus@minor2026', adminUser.password_hash, adminUser.password_salt), true, 'Configured admin password must verify with bcrypt');
    console.log(`✓ Admin password in SQLite (${adminUser.username}) is verified with bcrypt: ${adminUser.password_hash.substring(0, 15)}...`);

    // Test 3: Unauthorized Access Prevention
    console.log('\n[3/5] Testing Unauthorized Access Restrictions...');
    // 3a. Direct unauthenticated request to /admin
    const r3a = await makeRequest(server, '/admin');
    assert.strictEqual(r3a.status, 403, 'Unauthenticated /admin must return HTTP 403');
    assert.strictEqual(r3a.body.includes('Platform Administration & System Health'), false, 'Unauthenticated visitor must not see admin dashboard');

    // 3b. Unauthenticated API request to /admin
    const r3b = await makeRequest(server, '/admin', 'GET', null, { 'Accept': 'application/json' });
    assert.strictEqual(r3b.status, 403, 'Unauthenticated API request must return HTTP 403 JSON');
    assert.ok(r3b.body.includes('"FORBIDDEN"'), 'API must return FORBIDDEN error');

    // 3c. Regular GitHub-authenticated contributor accessing /admin
    const regularLogin = await makeRequest(server, '/auth/demo-login', 'POST', { username: 'test_regular_contributor' });
    const regularCookie = regularLogin.setCookie;
    assert.ok(regularCookie, 'Regular user must receive session cookie');

    // Regular user attempting to access /admin
    const r3c = await makeRequest(server, '/admin', 'GET', null, { 'Cookie': regularCookie });
    assert.strictEqual(r3c.status, 403, 'Normal contributor must receive HTTP 403 Forbidden for /admin');
    assert.strictEqual(r3c.body.includes('Platform Administration & System Health'), false, 'Normal contributor cannot access admin dashboard');

    // 3d. Regular user attempting admin privilege escalation via POST
    const r3d = await makeRequest(server, '/admin/users/1/role', 'POST', { role: 'admin' }, { 'Cookie': regularCookie, 'Accept': 'application/json' });
    assert.strictEqual(r3d.status, 403, 'Normal contributor cannot update user roles');
    console.log('✓ Unauthorized access strictly blocked by server-side authorization guards.');

    // Test 4: Administrator Authentication Flow
    console.log('\n[4/5] Testing Administrator Authentication Flow...');
    // 4a. Bad password
    const badLogin = await makeRequest(server, '/admin/login', 'POST', {
      username: 'admin',
      password: 'IncorrectPassword123!'
    });
    assert.strictEqual(badLogin.status, 403, 'Bad password must return HTTP 403');
    assert.ok(badLogin.body.includes('Invalid administrator credentials'), 'Must render invalid credentials message');

    // 4b. Old exposed password fails
    const oldPassLogin = await makeRequest(server, '/admin/login', 'POST', {
      username: 'admin',
      password: 'DevNexus@Admin2026!'
    });
    assert.strictEqual(oldPassLogin.status, 403, 'Old exposed password must be rejected');

    // 4c. Successful admin authentication
    const correctPassword = process.env.INITIAL_ADMIN_PASSWORD || 'DevNexus@minor2026';
    const goodLogin = await makeRequest(server, '/admin/login', 'POST', {
      username: 'admin',
      password: correctPassword
    });
    assert.strictEqual(goodLogin.status, 302, 'Valid admin login must return HTTP 302 redirect');
    assert.strictEqual(goodLogin.headers.location, '/admin', 'Must redirect to /admin');
    const adminCookie = goodLogin.setCookie;
    assert.ok(adminCookie, 'Must set secure session cookie for admin');

    // 4d. Access /admin with valid session
    const adminDash = await makeRequest(server, '/admin', 'GET', null, { 'Cookie': adminCookie });
    assert.strictEqual(adminDash.status, 200, 'Authenticated admin must access /admin with HTTP 200');
    assert.ok(adminDash.body.includes('Platform Administration &amp; System Health'), 'Must render admin dashboard title');
    assert.ok(adminDash.body.includes('Live Server Process Health'), 'Must render system diagnostics');
    assert.ok(adminDash.body.includes('Registered Accounts'), 'Must render user metrics');
    console.log('✓ Administrator authentication succeeded with session issuance and full dashboard access.');

    // Test 5: Admin User Management & Logout
    console.log('\n[5/5] Testing Admin Actions & Logout...');
    // 5a. Admin logout
    const logoutRes = await makeRequest(server, '/admin/logout', 'GET', null, { 'Cookie': adminCookie });
    assert.strictEqual(logoutRes.status, 302, 'Admin logout must redirect');
    assert.strictEqual(logoutRes.headers.location, '/admin/login', 'Must redirect to /admin/login');

    // 5b. Subsequent request with destroyed session is forbidden
    const postLogout = await makeRequest(server, '/admin', 'GET', null, { 'Cookie': logoutRes.setCookie || adminCookie });
    assert.strictEqual(postLogout.status, 403, 'Session must be invalidated after logout');
    console.log('✓ Admin actions and session termination verified.');

  } finally {
    server.close();
  }

  console.log('\n======================================================');
  console.log('✓ ALL ADMIN AUTHENTICATION SECURITY TESTS PASSED 100%');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ Admin Security Test Failed:', err);
  process.exit(1);
});
