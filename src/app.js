'use strict';
const path = require('path');
const express = require('express');
const { createWebhookRouter } = require('./webhook');
const { createApiRouter } = require('./api');

function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');

  // GitHub signs the exact bytes it sends, so keep them for signature checking.
  const keepRawBody = (req, _res, buf) => { req.rawBody = buf; };
  app.use('/webhook/github', express.json({ limit: '10mb', verify: keepRawBody }), createWebhookRouter({ db, config }));
  app.use('/api', createApiRouter({ db, config }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error.' : err.message });
  });
  return app;
}

module.exports = { createApp };
