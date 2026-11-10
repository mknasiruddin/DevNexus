// Ensure dotenv is loaded immediately before any other module or environment variable access
try {
  require("dotenv").config();
} catch (e) {
  // dotenv will fallback to manual parser below if not present
}

const express = require("express");
const path = require("path");
const fs = require("fs");

// Fallback manual parser to ensure .env is parsed if dotenv was skipped
const envPath = path.join(__dirname, ".env");
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

// Initialize SQLite Database Layer (ACID Persistent Storage)
require("./db/database");

const { sessionMiddleware } = require("./services/authService");

const app = express();

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// View engine & static asset serving
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Database-backed Session Middleware
app.use(sessionMiddleware);

// --- Teammate's Existing Routes (Preserved) ---
app.get("/", (req, res) => {
    res.render("./landing.ejs", {
      user: req.user || null
    });
});

// --- Authentication & Account Management Routes ---
const authRoutes = require("./routes/authRoutes");
app.use("/auth", authRoutes);

// Direct Top-Level Authentication Endpoints
app.get("/login", authRoutes.handleGetLogin);
app.post("/login", authRoutes.handlePostLogin);
app.get("/signup", authRoutes.handleGetSignup);
app.post("/signup", authRoutes.handlePostSignup);
app.post("/forgot-password", authRoutes.handleForgotPassword);

app.get("/logout", (req, res) => res.redirect("/auth/logout"));
app.get("/onboarding", authRoutes.handleGetOnboarding);
app.post("/onboarding", authRoutes.handlePostOnboarding);

// --- Isolated Dashboard, Admin & Project Discovery Route Modules ---
app.use("/projects", require("./routes/projectRoutes"));
app.use("/dashboard", require("./routes/dashboardRoutes"));
app.use("/admin", require("./routes/adminRoutes"));

// --- Content, Guide & Community Routes ---
app.use("/", require("./routes/contentRoutes"));


const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`listening to port ${PORT}`);
  });
}

module.exports = app;
