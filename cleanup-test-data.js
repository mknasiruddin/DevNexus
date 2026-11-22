const { db } = require('./db/database');

const cleanup = db.transaction(() => {
    const contributor = db.prepare(`
        SELECT id
        FROM contributors
        WHERE username = ? AND github_id = ?
    `).get('test_dev_leaderboard', '9999901');

    if (!contributor) {
        throw new Error('Test contributor not found. Nothing deleted.');
    }

    const activities = db.prepare(`
        DELETE FROM contributor_activities
        WHERE contributor_id = ?
    `).run(contributor.id);

    db.prepare(`
        DELETE FROM contributors
        WHERE id = ?
    `).run(contributor.id);

    return activities.changes;
});

const deletedActivities = cleanup();

console.log('Deleted test activities:', deletedActivities);
console.log('Remaining contributors:');

console.table(
    db.prepare(`
        SELECT id, username, github_id
        FROM contributors
    `).all()
);

db.close();