import { pathToFileURL } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

import { config, isProd } from './config.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { buildApiRouter } from './routes/index.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // CLIENT_ORIGIN may hold several comma-separated origins (e.g. laptop web
  // app, phone browser, Flutter web build). Native mobile apps send no Origin
  // and are never blocked by CORS.
  const allowedOrigins = config.clientOrigin
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: allowedOrigins.length > 1 ? allowedOrigins : allowedOrigins[0],
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Lightweight request log — one line per API call, no bodies.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      // eslint-disable-next-line no-console
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, env: config.nodeEnv, time: new Date().toISOString() });
  });

  app.use('/api', buildApiRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function boot() {
  // Boot sequence: verify DB, apply migrations, ensure baseline seed data.
  await pool.query('SELECT 1');
  await migrate();
  await seed();

  const app = createApp();
  const server = app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Depot API listening on http://localhost:${config.port} (${isProd ? 'production' : 'development'})`
    );
  });

  const shutdown = async (signal) => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received — shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    // Safety net if connections keep the server alive too long.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only boot when executed directly (node src/index.js); tests import createApp.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  boot().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal boot error:', err);
    process.exit(1);
  });
}
