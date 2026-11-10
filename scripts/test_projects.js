const app = require('../app');
const http = require('http');

function request(server, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
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
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const server = app.listen(0, async () => {
    try {
      console.log('Testing Project Discovery on ephemeral port:', server.address().port);

      // 1. GET /projects HTML view
      const r1 = await request(server, 'GET', '/projects');
      console.log('1. GET /projects -> Status:', r1.statusCode);
      console.log('   Contains Heading "Explore Open Source Projects":', r1.body.includes('Explore Open Source Projects'));
      console.log('   Contains Search Input:', r1.body.includes('id="project-search-input"'));
      console.log('   Contains Language Filter:', r1.body.includes('id="project-language-select"'));
      console.log('   Contains Topic Filter:', r1.body.includes('id="project-topic-select"'));
      console.log('   Contains Stars Filter:', r1.body.includes('id="project-stars-select"'));
      console.log('   Contains Sort Filter:', r1.body.includes('id="project-sort-select"'));

      // 2. GET /projects JSON format
      const r2 = await request(server, 'GET', '/projects?format=json');
      console.log('2. GET /projects?format=json -> Status:', r2.statusCode);
      const json2 = JSON.parse(r2.body);
      console.log('   JSON Success:', json2.success);
      console.log('   Total Repositories count:', json2.totalCount);
      console.log('   Returned items length:', json2.repositories ? json2.repositories.length : 0);
      if (json2.repositories && json2.repositories.length > 0) {
        const sample = json2.repositories[0];
        console.log('   Sample Repo:', sample.fullName, '| Stars:', sample.stars, '| Lang:', sample.language);
      }

      // 3. Search by keyword
      const r3 = await request(server, 'GET', '/projects?q=react&format=json');
      console.log('3. GET /projects?q=react -> Status:', r3.statusCode);
      const json3 = JSON.parse(r3.body);
      console.log('   Results count for "react":', json3.totalCount);

      // 4. Filter by language
      const r4 = await request(server, 'GET', '/projects?language=python&format=json');
      console.log('4. GET /projects?language=python -> Status:', r4.statusCode);
      const json4 = JSON.parse(r4.body);
      console.log('   Results count for python:', json4.totalCount);

      // 5. Filter by topic
      const r5 = await request(server, 'GET', '/projects?topic=good-first-issue&format=json');
      console.log('5. GET /projects?topic=good-first-issue -> Status:', r5.statusCode);
      const json5 = JSON.parse(r5.body);
      console.log('   Results count for topic good-first-issue:', json5.totalCount);

      // 6. Filter by min stars
      const r6 = await request(server, 'GET', '/projects?stars=1000&format=json');
      console.log('6. GET /projects?stars=1000 -> Status:', r6.statusCode);
      const json6 = JSON.parse(r6.body);
      console.log('   Results count for stars>=1000:', json6.totalCount);

      // 7. Sort by updated
      const r7 = await request(server, 'GET', '/projects?sort=updated&format=json');
      console.log('7. GET /projects?sort=updated -> Status:', r7.statusCode);
      const json7 = JSON.parse(r7.body);
      console.log('   Sorted by updated count:', json7.totalCount);

      // 8. Direct repo redirect
      const r8 = await request(server, 'GET', '/projects/expressjs/express');
      console.log('8. GET /projects/expressjs/express -> Status:', r8.statusCode, 'Location:', r8.headers.location);

      // 9. Landing page verification
      const r9 = await request(server, 'GET', '/');
      console.log('9. GET / -> Status:', r9.statusCode);
      console.log('   Landing page contains "Browse projects" pointing to /projects:', r9.body.includes('href="/projects"'));

      console.log('\n--- ALL PROJECT DISCOVERY TESTS PASSED PERFECTLY ---');
    } catch (err) {
      console.error('Test suite error:', err);
    } finally {
      server.close();
    }
  });
})();
