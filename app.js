const path = require("path");
const fs = require("fs");

// Ensure dotenv is loaded immediately before any other module or environment variable access
const envPath = path.join(__dirname, ".env");
try {
  require("dotenv").config({ path: envPath });
} catch (e) {
  // dotenv will fallback to manual parser below if not present
}

// Fallback manual parser to ensure .env is parsed if dotenv was skipped
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  envContent.split("\n").forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...val] = trimmed.split("=");
      if (key && !process.env[key.trim()]) {
        process.env[key.trim()] = val.join("=").trim();
      }
    }
  });
}

const express = require("express");

// Initialize SQLite Database Layer (ACID Persistent Storage)
const { findUserById: findLandingUserById } = require("./db/database");

const { sessionMiddleware, securityHeadersMiddleware, loginRateLimiter, requireAuth } = require("./services/authService");

const app = express();

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");
app.use(securityHeadersMiddleware);

// View engine & static asset serving
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Database-backed Session Middleware
app.use(sessionMiddleware);

const { getUserDashboardSyncData: getLandingSyncData } = require("./services/githubSyncService");
const { getUserRepositoryStats: getLandingRepoStats } = require("./services/repoStatsService");
const { computeUserReadinessSnapshot } = require("./services/readinessHelper");

function formatStarCompact(stars) {
  const count = Number(stars) || 0;
  if (count >= 1000) {
    return (count >= 10000 ? Math.round(count / 1000) : (count / 1000).toFixed(1).replace(/\.0$/, "")) + "k";
  }
  return String(count);
}

async function loadLandingHeroContext(sessionUser) {
  if (!sessionUser || !sessionUser.id) {
    return {
      heroRepo: null,
      heroPr: null,
      heroCommit: null,
      heroReadiness: null,
      heroRoadmapCompleted: 0,
      heroSyncedRepoCount: 0
    };
  }
  try {
    const snapshot = await computeUserReadinessSnapshot(sessionUser, {
      isSelf: true,
      cacheOnly: true
    });
    const dbUser = snapshot.user;
    const roadmapCompleted = snapshot.roadmapProgress ? snapshot.roadmapProgress.completedCount : 0;
    const readiness = snapshot.readiness;

    let heroRepo = null;
    let heroPr = null;
    let heroCommit = null;
    let heroSyncedRepoCount = 0;

    if (dbUser && dbUser.github_id) {
      const syncedData = getLandingSyncData(dbUser.id, dbUser.github_id, {
        isSelf: false,
        repoLimit: 6,
        activityLimit: 15
      });
      const repos = syncedData && Array.isArray(syncedData.repos) ? syncedData.repos : [];
      const activities = syncedData && Array.isArray(syncedData.activities) ? syncedData.activities : [];
      heroSyncedRepoCount = getLandingRepoStats(dbUser.id, { isSelf: true }).total;

      if (repos.length > 0) {
        const topRepo = repos[0];
        heroRepo = {
          fullName: topRepo.fullName,
          name: topRepo.name,
          starsLabel: formatStarCompact(topRepo.stars),
          healthScore: topRepo.health && typeof topRepo.health.score === "number" ? topRepo.health.score : null,
          language: topRepo.language || null
        };
      }

      heroPr = activities.find(a => a && a.category === "pr") || null;
      heroCommit = activities.find(a => a && a.category === "commit") || null;
    }

    return {
      heroRepo,
      heroPr,
      heroCommit,
      heroReadiness: readiness && readiness.isSufficientData && typeof readiness.score === "number" ? readiness.score : null,
      heroReadinessLevel: readiness ? readiness.readinessLevel : null,
      heroRoadmapCompleted: roadmapCompleted,
      heroSyncedRepoCount
    };
  } catch (err) {
    console.warn("[DevNexus] Landing hero data fallback:", err.message);
    return {
      heroRepo: null,
      heroPr: null,
      heroCommit: null,
      heroReadiness: null,
      heroRoadmapCompleted: 0,
      heroSyncedRepoCount: 0
    };
  }
}

// --- Teammate's Existing Routes (Preserved) ---
app.get("/", async (req, res) => {
    const heroContext = await loadLandingHeroContext(req.user || null);
    res.render("./landing.ejs", {
      user: req.user || null,
      ...heroContext
    });
});

// --- Authentication & Account Management Routes ---
const authRoutes = require("./routes/authRoutes");
app.use("/auth", authRoutes);

// Direct Top-Level Authentication & Profile Endpoints
app.get("/login", authRoutes.handleGetLogin);
app.post("/login", loginRateLimiter, authRoutes.handlePostLogin);
app.get("/signup", authRoutes.handleGetSignup);
app.post("/signup", authRoutes.handlePostSignup);
app.post("/forgot-password", loginRateLimiter, authRoutes.handleForgotPassword);

app.get("/logout", (req, res) => res.redirect("/auth/logout"));
app.get("/onboarding", authRoutes.handleGetOnboarding);
app.post("/onboarding", authRoutes.handlePostOnboarding);
app.get("/profile", requireAuth, (req, res) => res.redirect("/onboarding?edit=1"));
app.post("/profile", requireAuth, authRoutes.handlePostProfile);

// --- Isolated Dashboard, Admin & Project Discovery Route Modules ---
app.use("/projects", require("./routes/projectRoutes"));
app.use("/dashboard", require("./routes/dashboardRoutes"));
app.use("/admin", require("./routes/adminRoutes"));

// --- Portfolio & Skill Tree Routes ---
app.use("/portfolio", require("./routes/portfolioRoutes"));
app.use("/api/portfolio", require("./routes/portfolioRoutes"));
app.use("/skill-tree", require("./routes/skillTreeRoutes"));
app.use("/api/skill-tree", require("./routes/skillTreeRoutes"));

// --- Contribution Streak Routes (Member 3) ---
app.use("/streak", require("./routes/streakRoutes"));
app.use("/api/streak", require("./routes/streakRoutes"));

// --- Developer Productivity & Activity Analytics Routes ---
app.use("/analytics", require("./routes/analyticsRoutes"));
app.use("/api/analytics", require("./routes/analyticsRoutes"));

// --- Achievement Badges Routes (Member 3) ---
app.use("/badges", require("./routes/badgeRoutes"));
app.use("/api/badges", require("./routes/badgeRoutes"));

// --- Content, Guide & Community Routes ---
app.use("/", require("./routes/contentRoutes"));

// --- 404 Not Found Handler ---
app.use((req, res) => {
  if (req.xhr || (req.headers.accept && req.headers.accept.includes("application/json")) || req.path.startsWith("/api/") || req.path.includes("/api/")) {
    return res.status(404).json({ success: false, error: "NOT_FOUND", message: "The requested resource or endpoint does not exist." });
  }
  res.status(404).render("error", {
    siteName: "DevNexus",
    activePage: "",
    statusCode: 404,
    title: "404 — Page Not Found",
    message: "The page you are looking for does not exist or may have been moved.",
    actionUrl: "/",
    actionText: "Return to Home"
  });
});

// --- Global Error Handling Middleware (No Stack Traces Exposed) ---
app.use((err, req, res, next) => {
  console.error("[DevNexus Unhandled Error]", err.message);
  if (res.headersSent) {
    return next(err);
  }
  if (req.xhr || (req.headers.accept && req.headers.accept.includes("application/json"))) {
    return res.status(500).json({ success: false, error: "INTERNAL_SERVER_ERROR", message: "An unexpected server error occurred." });
  }
  res.status(500).render("error", {
    siteName: "DevNexus",
    activePage: "",
    statusCode: 500,
    title: "Unexpected Server Error",
    message: "Something went wrong while processing your request. Please try again.",
    actionUrl: "/",
    actionText: "Return to Home"
  });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  const { startGithubSyncScheduler } = require("./services/githubSyncService");
  app.listen(PORT, () => {
    console.log(`listening to port ${PORT}`);
    startGithubSyncScheduler();
  });
}

module.exports = app;
