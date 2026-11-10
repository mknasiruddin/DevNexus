/**
 * DevNexus MongoDB User Schema
 * Stores authenticated GitHub developer profiles, roles, skills, and onboarding status.
 * Designed for MongoDB / Mongoose with graceful fallback to the SQLite ACID engine.
 */

try {
  require('dotenv').config();
} catch (e) {
  // Ignore if dotenv is not present
}

let mongoose = null;
try {
  mongoose = require('mongoose');
} catch (e) {
  // Mongoose not installed; SQLite provides primary persistence
}

let UserModel = null;

if (mongoose) {
  const UserSchema = new mongoose.Schema({
    githubId: { type: String, unique: true, sparse: true, index: true },
    username: { type: String, required: true, unique: true, lowercase: true, index: true },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    bio: { type: String, default: '' },
    profileUrl: { type: String, default: '' },
    role: { type: String, enum: ['contributor', 'admin', 'maintainer'], default: 'contributor' },
    skills: { type: Array, default: [] },
    experienceLevel: { type: String, default: 'Intermediate' },
    isOnboarded: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });

  UserModel = mongoose.models.User || mongoose.model('User', UserSchema);

  // Connect to MongoDB cluster if MONGODB_URI is provided
  if (process.env.MONGODB_URI && mongoose.connection.readyState === 0) {
    mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    }).then(() => {
      console.log('[DevNexus] Connected to MongoDB cluster for User persistence.');
    }).catch(err => {
      console.warn('[DevNexus] MongoDB connection skipped; SQLite engine active:', err.message);
    });
  }
}

/**
 * Creates or updates user in MongoDB without creating duplicate accounts
 */
async function upsertMongoUser(profile, localUser = null) {
  if (!mongoose || mongoose.connection.readyState !== 1 || !UserModel) {
    return null;
  }

  try {
    const updateData = {
      githubId: String(profile.id || profile.github_id || ''),
      username: (profile.login || profile.username || '').toLowerCase(),
      name: profile.name || profile.login || profile.username || '',
      email: profile.email || '',
      avatarUrl: profile.avatar_url || '',
      bio: profile.bio || '',
      profileUrl: profile.html_url || `https://github.com/${profile.login || profile.username}`,
      isOnboarded: Boolean(localUser ? localUser.is_onboarded : profile.is_onboarded),
      updatedAt: new Date()
    };

    if (localUser && localUser.role) {
      updateData.role = localUser.role;
    }
    if (localUser && localUser.skills) {
      updateData.skills = typeof localUser.skills === 'string' ? JSON.parse(localUser.skills || '[]') : localUser.skills;
    }

    const doc = await UserModel.findOneAndUpdate(
      { $or: [{ githubId: updateData.githubId }, { username: updateData.username }] },
      { $set: updateData, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, new: true }
    );

    return doc;
  } catch (err) {
    console.warn('[DevNexus] Notice: MongoDB user sync skipped:', err.message);
    return null;
  }
}

module.exports = {
  UserModel,
  upsertMongoUser,
  isMongoActive: () => Boolean(mongoose && mongoose.connection.readyState === 1)
};
