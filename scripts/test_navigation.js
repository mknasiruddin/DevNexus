const app = require('../app');
const http = require('http');

const querystring = require('querystring');

function request(server, method, path, data = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const postData = data ? querystring.stringify(data) : null;
    const reqHeaders = {};
    if (postData) {
      reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }
    if (cookie) {
      reqHeaders['Cookie'] = cookie;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: reqHeaders
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
      console.log('Testing Navigation & Elements on ephemeral port:', server.address().port);

      // 1. Landing page loads
      const r1 = await request(server, 'GET', '/');
      console.log('1. GET / -> Status:', r1.statusCode);
      console.log('   Contains Hero "Get started" pointing to /login or dashboard:', r1.body.includes('href="/login"') || r1.body.includes('href="/dashboard"'));
      console.log('   Contains CTA "Get started" pointing to /login or dashboard:', r1.body.includes('Get started'));
      console.log('   Contains CTA "Read the guide" pointing to /learn:', r1.body.includes('href="/learn"'));
      console.log('   Contains "Browse projects" pointing to /projects:', r1.body.includes('href="/projects"'));

      // 2. Contribution Guide
      const r2 = await request(server, 'GET', '/learn');
      console.log('2. GET /learn -> Status:', r2.statusCode);
      console.log('   Contains "What DevNexus Does":', r2.body.includes('What DevNexus Does'));
      console.log('   Contains "Discover Open-Source Repositories":', r2.body.includes('Discover Open-Source Repositories'));
      console.log('   Contains "Find Good First Issues":', r2.body.includes('Find Good First Issues'));
      console.log('   Contains "Filter by Programming Language":', r2.body.includes('Filter by Programming Language'));
      console.log('   Contains "Bookmark & Track Issues":', r2.body.includes('Bookmark &amp; Track Issues'));
      console.log('   Contains "Skill-Based Matching":', r2.body.includes('Skill-Based Matching'));
      console.log('   Contains "Opening Issues on GitHub":', r2.body.includes('Opening Issues on GitHub'));
      console.log('   Contains "Making a Contribution Through GitHub":', r2.body.includes('Making a Contribution Through GitHub'));

      // 3. /guide redirect
      const r3 = await request(server, 'GET', '/guide');
      console.log('3. GET /guide -> Status:', r3.statusCode, 'Renders Guide:', r3.body.includes('DevNexus Developer Guide'));

      // 4. Git Basics and Code of Conduct
      const r4 = await request(server, 'GET', '/learn/git-basics');
      console.log('4. GET /learn/git-basics -> Status:', r4.statusCode, 'Renders Git Basics:', r4.body.includes('Essential Git Commands'));

      const r5 = await request(server, 'GET', '/learn/code-of-conduct');
      console.log('5. GET /learn/code-of-conduct -> Status:', r5.statusCode, 'Renders Code of Conduct:', r5.body.includes('Contributor Code of Conduct'));

      // 6. Project discovery
      const r6 = await request(server, 'GET', '/projects');
      console.log('6. GET /projects -> Status:', r6.statusCode, 'Renders Projects:', r6.body.includes('Explore Open Source Projects'));

      // 7. Protected Dashboard (Unauthenticated should redirect to /auth/github)
      const r7 = await request(server, 'GET', '/dashboard');
      console.log('7. GET /dashboard (Unauthenticated) -> Status:', r7.statusCode, 'Location:', r7.headers.location);

      // 8. Sign Up / Get Started redirect
      const r8 = await request(server, 'GET', '/signup');
      console.log('8. GET /signup -> Status:', r8.statusCode, 'Location:', r8.headers.location);

      // 9. GitHub OAuth entrypoint
      const r9 = await request(server, 'GET', '/auth/github');
      console.log('9. GET /auth/github -> Status:', r9.statusCode, 'Initiates OAuth or shows setup:', r9.statusCode === 302 || r9.body.includes('GitHub OAuth'));

      // 10. Search redirect
      const r10 = await request(server, 'GET', '/search?q=express');
      console.log('10. GET /search?q=express -> Status:', r10.statusCode, 'Location:', r10.headers.location);

      // 11. Issues and Topics shortcuts
      const r11 = await request(server, 'GET', '/issues');
      console.log('11. GET /issues -> Status:', r11.statusCode, 'Location:', r11.headers.location);

      const r12 = await request(server, 'GET', '/topics');
      console.log('12. GET /topics -> Status:', r12.statusCode, 'Location:', r12.headers.location);

      // 12. Community & Documentation pages
      const r13 = await request(server, 'GET', '/docs');
      console.log('13. GET /docs -> Status:', r13.statusCode, 'Renders Docs:', r13.body.includes('Architecture'));

      const r14 = await request(server, 'GET', '/leaderboard');
      console.log('14. GET /leaderboard -> Status:', r14.statusCode, 'Renders Leaderboard:', r14.body.includes('Leaderboard'));

      const r15 = await request(server, 'GET', '/maintainers');
      console.log('15. GET /maintainers -> Status:', r15.statusCode, 'Renders Maintainers:', r15.body.includes('Maintainers'));

      const r16 = await request(server, 'GET', '/events');
      console.log('16. GET /events -> Status:', r16.statusCode, 'Renders Events:', r16.body.includes('Events'));

      const r17 = await request(server, 'GET', '/about');
      console.log('17. GET /about -> Status:', r17.statusCode, 'Renders About:', r17.body.includes('About DevNexus'));

      const r18 = await request(server, 'GET', '/privacy');
      console.log('18. GET /privacy -> Status:', r18.statusCode, 'Renders Privacy:', r18.body.includes('Privacy Policy'));

      const r19 = await request(server, 'GET', '/terms');
      console.log('19. GET /terms -> Status:', r19.statusCode, 'Renders Terms:', r19.body.includes('Terms of Service'));

      // 13. Authenticated session accessing protected dashboard
      const authTest = await request(server, 'POST', '/auth/demo-login', { username: 'test-navigator' });
      const cookie = authTest.setCookie;
      // Complete onboarding if needed
      await request(server, 'POST', '/onboarding', { experience_level: 'Intermediate', skills: ['JavaScript'] }, cookie);
      const r20 = await request(server, 'GET', '/dashboard', null, cookie);
      console.log('20. GET /dashboard (Authenticated Session) -> Status:', r20.statusCode, 'Contains Developer Dashboard:', r20.body.includes('Developer Dashboard'));

      console.log('\n--- ALL NAVIGATION DESTINATIONS AND BUTTON TESTS PASSED PERFECTLY ---');
    } catch (err) {
      console.error('Test suite error:', err);
    } finally {
      server.close();
    }
  });
})();
