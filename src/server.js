'use strict';
const { config } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');

const db = openDb(config.dbPath);
const app = createApp({ db, config });
startScheduler({ db, config });

const server = app.listen(config.port, () => {
  console.log(`Commit Doctor listening on http://localhost:${config.port}`);
  console.log(`  Webhook endpoint : POST /webhook/github`);
  console.log(`  Timezone         : ${config.timezone}`);
  console.log(`  Repository       : ${config.repo || '(any - set GITHUB_REPO to lock to one)'}`);
  if (!config.webhookSecret) {
    console.warn('  WARNING: GITHUB_WEBHOOK_SECRET is empty. All webhook deliveries will be rejected until you set it.');
  }
});

const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
