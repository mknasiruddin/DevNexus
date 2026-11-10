/**
 * DevNexus MongoDB Contributor Schema
 * Stores GitHub contributor profiles, timestamped verified activities, and synchronization metadata.
 * Designed for MongoDB / Mongoose with graceful fallback to SQLite engine.
 */

let mongoose = null;
try {
  mongoose = require('mongoose');
} catch (e) {
  // Mongoose not installed in current environment; SQLite provides primary persistence
}

let ContributorModel = null;

if (mongoose) {
  const ContributorActivitySchema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true },
    repoName: { type: String, default: '' },
    actionSummary: { type: String, default: '' },
    points: { type: Number, required: true, default: 0 },
    source: { type: String, enum: ['github', 'devnexus'], default: 'github' },
    eventTimestamp: { type: Date, required: true, index: true },
    createdAt: { type: Date, default: Date.now }
  });

  const ContributorSchema = new mongoose.Schema({
    githubId: { type: String, unique: true, sparse: true },
    username: { type: String, required: true, unique: true, lowercase: true, index: true },
    name: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    bio: { type: String, default: '' },
    htmlUrl: { type: String, default: '' },
    publicRepos: { type: Number, default: 0 },
    followers: { type: Number, default: 0 },
    lastSyncedAt: { type: Date, default: Date.now },
    activities: [ContributorActivitySchema],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });

  // Indices for performant leaderboard ranking queries
  ContributorSchema.index({ username: 1 });
  ContributorSchema.index({ 'activities.eventTimestamp': 1 });

  ContributorModel = mongoose.models.Contributor || mongoose.model('Contributor', ContributorSchema);

  // Connect to MongoDB if MONGODB_URI is provided
  if (process.env.MONGODB_URI && mongoose.connection.readyState === 0) {
    mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }).then(() => {
      console.log('[DevNexus] Connected to MongoDB cluster for Leaderboard data.');
    }).catch(err => {
      console.warn('[DevNexus] MongoDB connection skipped; SQLite engine active:', err.message);
    });
  }
}

module.exports = {
  ContributorModel,
  isMongoActive: () => Boolean(mongoose && mongoose.connection.readyState === 1)
};
