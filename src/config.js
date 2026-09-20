'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const num = (v, fallback) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 3000),
    webhookSecret: env.GITHUB_WEBHOOK_SECRET || '',
    repo: (env.GITHUB_REPO || '').trim().toLowerCase(),
    timezone: env.TIMEZONE || 'Asia/Manila',
    dbPath: env.DB_PATH
      ? path.resolve(env.DB_PATH)
      : path.join(__dirname, '..', 'data', 'commitdoctor.db'),
    adminToken: env.ADMIN_TOKEN || '',
    summary: {
      minCommits: Math.max(1, num(env.SUMMARY_MIN_COMMITS, 1)),
      comparisonDays: Math.max(1, num(env.SUMMARY_COMPARISON_DAYS, 7)),
    },
  };
}

module.exports = { loadConfig, config: loadConfig() };
