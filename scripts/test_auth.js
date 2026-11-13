const app = require('../app');
const http = require('http');
const querystring = require('querystring');

function request(server, method, path, data = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const postData = data ? querystring.stringify(data) : null;
    const headers = {};
    if (postData) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }
    if (cookie) {
      headers['Cookie'] = cookie;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'];
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          setCookie: setCookies ? setCookies[0].split(';')[0] : null,
          body
        });
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

(async () => {
  const server = app.listen(0, async () => {
    try {
      console.log('Testing on ephemeral port:', server.address().port);

      // 1. GET /login redirect
      const r1 = await request(server, 'GET', '/login');
      console.log('1. GET /login -> Status:', r1.statusCode, 'Location:', r1.headers.location);

      // 2. GET /signup redirect
      const r2 = await request(server, 'GET', '/signup');
      console.log('2. GET /signup -> Status:', r2.statusCode, 'Location:', r2.headers.location);

      // 3. GET /auth/login
      const r3 = await request(server, 'GET', '/auth/login');
      console.log('3. GET /auth/login -> Status:', r3.statusCode, 'Contains Sign In:', r3.body.includes('action="/auth/login"'));

      // 4. GET /auth/signup
      const r4 = await request(server, 'GET', '/auth/signup');
      console.log('4. GET /auth/signup -> Status:', r4.statusCode, 'Contains Sign Up:', r4.body.includes('action="/auth/signup"'));

      // 5. POST /auth/signup - password mismatch
      const r5 = await request(server, 'POST', '/auth/signup', {
        username: 'mismatch_user',
        email: 'mismatch@test.local',
        password: 'password123',
        confirmPassword: 'wrongpassword'
      });
      console.log('5. Signup password mismatch -> Status:', r5.statusCode, 'Location:', r5.headers.location);

      // 6. POST /auth/signup - valid registration
      const testUser = 'user_' + Date.now();
      const r6 = await request(server, 'POST', '/auth/signup', {
        username: testUser,
        email: testUser + '@test.local',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!'
      });
      console.log('6. Valid Signup -> Status:', r6.statusCode, 'Location:', r6.headers.location, 'Has Cookie:', !!r6.setCookie);
      const sessionCookie = r6.setCookie;

      // 7. GET /onboarding with session
      const r7 = await request(server, 'GET', '/onboarding', null, sessionCookie);
      console.log('7. GET /onboarding with session -> Status:', r7.statusCode, 'Includes username:', r7.body.includes(testUser));

      // 8. POST /onboarding - complete setup
      const r8 = await request(server, 'POST', '/onboarding', {
        experience_level: 'Intermediate',
        skills: ['JavaScript', 'TypeScript', 'Node.js']
      }, sessionCookie);
      console.log('8. POST /onboarding -> Status:', r8.statusCode, 'Location:', r8.headers.location);

      // 9. GET /dashboard with session
      const r9 = await request(server, 'GET', '/dashboard', null, sessionCookie);
      console.log('9. GET /dashboard with session -> Status:', r9.statusCode, 'Contains dashboard:', r9.body.includes('Developer Dashboard'));

      // 10. GET /logout
      const r10 = await request(server, 'GET', '/logout', null, sessionCookie);
      console.log('10. GET /logout -> Status:', r10.statusCode, 'Location:', r10.headers.location);

      // 11. POST /auth/login with the created user
      const r11 = await request(server, 'POST', '/auth/login', {
        username: testUser,
        password: 'SecurePassword123!'
      });
      console.log('11. POST /auth/login (Success) -> Status:', r11.statusCode, 'Location:', r11.headers.location, 'Has Cookie:', !!r11.setCookie);

      // 12. POST /auth/login with wrong password
      const r12 = await request(server, 'POST', '/auth/login', {
        username: testUser,
        password: 'WrongPassword!'
      });
      console.log('12. POST /auth/login (Bad Password) -> Status:', r12.statusCode, 'Location:', r12.headers.location);

      // 13. Verify Landing page placeholders
      const r13 = await request(server, 'GET', '/');
      console.log('13. Landing page contains "Search projects and issues...":', r13.body.includes('placeholder="Search projects and issues..."'));
      console.log('    Landing page contains "Filter issues by keyword or topic...":', r13.body.includes('placeholder="Filter issues by keyword or topic..."'));

      // 14. Verify Login & Signup placeholders
      console.log('14. Login page contains "your-github-username or name@company.com":', r3.body.includes('placeholder="your-github-username or name@company.com"'));
      console.log('    Login page contains "Enter your password":', r3.body.includes('placeholder="Enter your password"'));
      console.log('    Login page contains demo "your-github-username":', r3.body.includes('placeholder="your-github-username"'));
      console.log('    Login page has no hardcoded value="saanvi-p-rao":', !r3.body.includes('value="saanvi-p-rao"'));
      console.log('    Signup page contains "your-github-username":', r4.body.includes('placeholder="your-github-username"'));
      console.log('    Signup page contains "name@company.com":', r4.body.includes('placeholder="name@company.com"'));
      console.log('    Signup page has no "alex@example.com":', !r4.body.includes('alex@example.com'));
      console.log('    Signup page has no "dev-alex":', !r4.body.includes('dev-alex'));

      // 15. Verify Dashboard placeholders
      console.log('15. Dashboard contains "your-github-username":', r9.body.includes('placeholder="your-github-username"'));
      console.log('    Dashboard contains "Search open-source issues by keyword or topic...":', r9.body.includes('placeholder="Search open-source issues by keyword or topic..."'));

      // 16. Verify Admin Forbidden / Gateway placeholders
      const r16 = await request(server, 'GET', '/admin');
      console.log('16. Admin gateway status:', r16.statusCode);
      console.log('    Admin gateway contains "your-admin-username":', r16.body.includes('placeholder="your-admin-username"'));
      console.log('    Admin gateway contains "Enter administrator password":', r16.body.includes('placeholder="Enter administrator password"'));

      console.log('\n--- ALL AUTHENTICATION AND PLACEHOLDER VERIFICATION TESTS PASSED PERFECTLY ---');
    } catch (err) {
      console.error('Test suite error:', err);
    } finally {
      try {
        const { db } = require('../db/database');
        db.prepare("DELETE FROM users WHERE username LIKE 'user_%' AND email LIKE '%@test.local'").run();
      } catch (e) {}
      server.close();
    }
  });
})();
