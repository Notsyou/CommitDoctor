'use strict';
const { config } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');
const { startPoller } = require('./poller');
const { createMailer } = require('./mailer');

const db = openDb(config.dbPath);
const mailer = createMailer(config);
const app = createApp({ db, config, mailer });
startScheduler({ db, config, mailer });
startPoller({ db, config, intervalMs: config.pollIntervalMs });

const server = app.listen(config.port, () => {
  console.log(`Commit Doctor listening on http://localhost:${config.port}`);
  console.log(`  Webhook endpoint : POST /webhook/github`);
  console.log(`  Timezone         : ${config.timezone}`);
  console.log(`  Repository       : ${config.repo || '(any - set GITHUB_REPO to lock to one)'}`);
  console.log(`  Email            : ${mailer ? `on (${config.smtp.host})` : 'off (set SMTP_HOST to enable)'}`);
  if (!config.webhookSecret) {
    console.warn('  WARNING: GITHUB_WEBHOOK_SECRET is empty. All webhook deliveries will be rejected until you set it.');
  }
});

const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
