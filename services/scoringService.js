'use strict';

const { getAllScoringRules, upsertScoringRule } = require('../db/database');

/**
 * Centralized Contribution Scoring Rules
 *
 * Points can be customized via environment overrides (DEVNEXUS_SCORE_<RULE_KEY>)
 * or updated dynamically via the SQLite `scoring_rules` table.
 */
const DEFAULT_SCORING_RULES = Object.freeze([
  { ruleKey: 'commit', source: 'github', label: 'Verified Git Commit', defaultPoints: 2, description: 'Awarded per unique verified commit SHA or commit unit' },
  { ruleKey: 'pr_created', source: 'github', label: 'Pull Request Created', defaultPoints: 10, description: 'Awarded per opened pull request authored by the developer' },
  { ruleKey: 'pr_merged', source: 'github', label: 'Pull Request Merged', defaultPoints: 15, description: 'Awarded when an authored pull request is merged' },
  { ruleKey: 'pr_closed', source: 'github', label: 'Pull Request Closed', defaultPoints: 4, description: 'Awarded when an authored pull request closes without merge' },
  { ruleKey: 'issue_opened', source: 'github', label: 'Issue Opened', defaultPoints: 5, description: 'Awarded per verified GitHub issue opened' },
  { ruleKey: 'issue_closed', source: 'github', label: 'Issue Resolved / Closed', defaultPoints: 8, description: 'Awarded when a tracked GitHub issue is resolved/closed' },
  { ruleKey: 'pr_review', source: 'github', label: 'Pull Request Code Review', defaultPoints: 6, description: 'Awarded per verified peer pull request review' },
  { ruleKey: 'repo_contribution', source: 'github', label: 'Repository Contribution', defaultPoints: 5, description: 'Awarded for verified repository creation or release events' },
  { ruleKey: 'roadmap_stage', source: 'devnexus', label: 'Roadmap Stage Completed', defaultPoints: 10, description: 'One-time DevNexus points for completing a roadmap stage' },
  { ruleKey: 'skill_task', source: 'devnexus', label: 'Skill Tree Task Completed', defaultPoints: 15, description: 'One-time DevNexus points for unlocking a Skill Tree node' },
  { ruleKey: 'contribution_milestone', source: 'devnexus', label: 'Contribution Milestone Earned', defaultPoints: 20, description: 'One-time DevNexus points for earning a contribution/streak milestone badge' }
]);

const DEFAULT_RULE_BY_KEY = new Map(DEFAULT_SCORING_RULES.map(r => [r.ruleKey, r]));

function resolveEnvOverride(ruleKey) {
  const envName = `DEVNEXUS_SCORE_${String(ruleKey).toUpperCase()}`;
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getScoringRules() {
  let dbRows = [];
  try {
    dbRows = getAllScoringRules();
  } catch (e) {
    dbRows = [];
  }

  const byKey = new Map();
  for (const def of DEFAULT_SCORING_RULES) {
    byKey.set(def.ruleKey, {
      ruleKey: def.ruleKey,
      source: def.source,
      label: def.label,
      points: def.defaultPoints,
      description: def.description,
      isActive: true
    });
  }

  for (const row of dbRows) {
    const base = byKey.get(row.rule_key) || {};
    byKey.set(row.rule_key, {
      ruleKey: row.rule_key,
      source: row.source || base.source || 'github',
      label: row.label || base.label || row.rule_key,
      points: Number.isFinite(Number(row.points)) ? Number(row.points) : (base.points || 0),
      description: row.description || base.description || '',
      isActive: row.is_active !== 0,
      updatedAt: row.updated_at || null
    });
  }

  for (const [ruleKey, rule] of byKey.entries()) {
    const envPts = resolveEnvOverride(ruleKey);
    if (envPts !== null) {
      rule.points = envPts;
    }
  }

  return Array.from(byKey.values());
}

function getScoringRulesMap() {
  const map = {};
  for (const rule of getScoringRules()) {
    map[rule.ruleKey] = rule.isActive ? rule.points : 0;
  }
  return map;
}

function getPointsForActivity(ruleKey, units = 1) {
  const map = getScoringRulesMap();
  const base = Number(map[ruleKey]);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const count = Math.max(1, Number(units) || 1);
  return base * count;
}

function updateScoringRule(ruleKey, { points, description, isActive = true } = {}) {
  const def = DEFAULT_RULE_BY_KEY.get(ruleKey);
  if (!def) throw new Error(`Unknown scoring rule key: ${ruleKey}`);
  const safePts = Math.max(0, Math.round(Number(points)));
  if (!Number.isFinite(safePts)) throw new Error('points must be a non-negative integer');
  return upsertScoringRule(ruleKey, {
    source: def.source,
    label: def.label,
    points: safePts,
    description: description !== undefined ? description : def.description,
    isActive
  });
}

module.exports = {
  DEFAULT_SCORING_RULES,
  getScoringRules,
  getScoringRulesMap,
  getPointsForActivity,
  updateScoringRule
};
