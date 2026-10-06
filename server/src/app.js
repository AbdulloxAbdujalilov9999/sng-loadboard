import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { registerAuth } from './auth.js';
import { EventHub } from './events.js';
import { TtlCache } from './lib/ttl.js';
import { HttpError } from './lib/errors.js';
import { describeIssue } from './lib/validation.js';
import { buildCityIndex } from './lib/ai/cities.js';
import publicRoutes from './routes/public.js';
import meRoutes from './routes/me.js';
import adminRoutes from './routes/admin.js';
import cityRoutes from './routes/cities.js';
import loadRoutes from './routes/loads.js';
import truckRoutes from './routes/trucks.js';
import directoryRoutes from './routes/directory.js';
import eventRoutes from './routes/events.js';
import statsRoutes from './routes/stats.js';
import aiRoutes from './routes/ai.js';

// Sign-in uses Firebase Auth (Google popup), so these Google/Firebase origins must be reachable.
function cspDirectives(config) {
  const fb = `https://${config.firebaseProjectId}.firebaseapp.com`;
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://www.gstatic.com', 'https://apis.google.com'],
    scriptSrcAttr: ["'unsafe-inline'"], // the UI uses inline onclick handlers
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
    connectSrc: ["'self'", 'https://*.googleapis.com', 'https://www.googleapis.com', 'https://securetoken.googleapis.com', 'https://identitytoolkit.googleapis.com'],
    frameSrc: [fb, 'https://accounts.google.com', 'https://*.firebaseapp.com'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],
  };
}

const BUSY = { status: 503, code: 'busy', message: 'The service is very busy right now. Please try again in a few seconds.' };

function pgErrorToHttp(err) {
  // Pool exhausted / database restarting / too many connections: say "busy, retry" instead of a bare 500.
  if (err.message === 'timeout exceeded when trying to connect' || err.code === '53300' || err.code === '57P01' || err.code === 'ECONNREFUSED') return BUSY;
  // SQLSTATE class 22 = bad input value (e.g. a tampered cursor); 23xxx = constraint violations.
  if (/^22/.test(err.code)) return { status: 400, code: 'bad_request', message: 'Invalid parameter value' };
  if (err.code === '23505') return { status: 409, code: 'conflict', message: 'Already exists' };
  if (err.code === '23514' || err.code === '23503' || err.code === '23502') return { status: 400, code: 'constraint_violation', message: 'Value violates a data rule' };
  if (err.code === '57014') return { status: 503, code: 'timeout', message: 'The request took too long; narrow your search' };
  return null;
}

export async function buildApp({ config, pool, verifyToken, hub: providedHub, logger, ai = null }) {
  const app = Fastify({
    logger: logger ?? { level: config.logLevel, redact: ['req.headers.authorization'] },
    bodyLimit: 64 * 1024,
    trustProxy: config.trustProxy,
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, reportOnly: !config.cspEnforce, directives: cspDirectives(config) },
    // Firebase's Google sign-in popup needs window.opener; the default COOP would break it.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd ? undefined : false,
  });
  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  await app.register(rateLimit, { max: config.rateLimitPerMin, timeWindow: '1 minute', allowList: (req) => req.url === '/healthz' });

  const hub = providedHub ?? new EventHub({ config, log: app.log });
  app.decorate('hub', hub);
  // Result totals are informational, so a few seconds of staleness is fine and keeps counting off the hot path.
  app.decorate('countCache', new TtlCache({ ttlMs: config.countCacheMs, max: 2000 }));
  // Whole result pages, shared by everyone who asks for the same query within a moment (single-flight).
  // Rows are identical for every approved member; only the per-user `mine` flag is added afterwards.
  app.decorate('searchCache', new TtlCache({ ttlMs: config.searchCacheMs, max: 1000 }));
  // The 160 cities never change at runtime: one query, then pure memory. (Saves a DB round trip per search.)
  let cityState = null; let cityStateAt = 0;
  const loadCities = async () => {
    if (!cityState || Date.now() - cityStateAt > 600_000) {
      const { rows } = await pool.query('SELECT id, label, name, name_ru, country, lat, lng FROM cities ORDER BY id');
      cityState = { list: rows, byId: new Map(rows.map((r) => [r.id, r])), index: buildCityIndex(rows) };
      cityStateAt = Date.now();
    }
    return cityState;
  };
  app.decorate('cityById', async (id) => (await loadCities()).byId.get(id));
  app.decorate('cityIndex', async () => (await loadCities()).index);
  // Load shedding: when this instance already has a long line of requests waiting for a database connection,
  // new API calls fail FAST with 503 + Retry-After rather than joining a queue that would only time out
  // (which would make every user's experience worse, not just the overflow's).
  app.addHook('onRequest', async (req, reply) => {
    if (pool.waitingCount > config.dbMaxQueue && req.url.startsWith('/api/') && !req.url.startsWith('/api/events')) {
      reply.header('Retry-After', '3');
      return reply.code(503).send({ error: { code: 'busy', message: BUSY.message } });
    }
    return undefined;
  });

  registerAuth(app, { config, pool, verifyToken, hub });

  // Any write (on any instance - events arrive via NOTIFY) drops cached result pages, so people see new posts
  // at once. Throttled: the first change after a quiet moment clears immediately; a burst clears at most
  // every 500 ms, so heavy posting can never switch the cache off entirely.
  let lastClear = 0; let clearTimer = null;
  const dropSearchCache = () => { lastClear = Date.now(); app.searchCache.clear(); }; // totals (countCache) may lag a few seconds on purpose
  hub.observe((evt) => {
    if (evt.entity !== 'loads' && evt.entity !== 'trucks' && evt.entity !== 'resync') return;
    const wait = lastClear + 500 - Date.now();
    if (wait <= 0) dropSearchCache();
    else if (!clearTimer) { clearTimer = setTimeout(() => { clearTimer = null; dropSearchCache(); }, wait); clearTimer.unref(); }
  });
  app.addHook('onReady', async () => { if (!providedHub) await hub.start(); });
  app.addHook('onClose', async () => { if (!providedHub) await hub.close(); });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'validation_error', message: 'Please check the highlighted fields',
        details: err.issues.map(describeIssue) } });
    }
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    const mapped = pgErrorToHttp(err);
    if (mapped) {
      req.log.warn({ pg: err.code, constraint: err.constraint }, 'database rejected request');
      if (mapped.status === 503) reply.header('Retry-After', '3');
      return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong on our side' } });
    }
    return reply.code(status).send({ error: { code: err.code ?? `http_${status}`, message: err.message } });
  });

  const opts = { pool, config, hub, ai };
  await app.register(publicRoutes, opts);
  await app.register(meRoutes, opts);
  await app.register(adminRoutes, opts);
  await app.register(cityRoutes, opts);
  await app.register(loadRoutes, opts);
  await app.register(truckRoutes, opts);
  await app.register(directoryRoutes, opts);
  await app.register(eventRoutes, opts);
  await app.register(statsRoutes, opts);
  await app.register(aiRoutes, opts);

  // Serve the built web app (same origin as the API => no CORS needed in the default deployment).
  const webRoot = path.resolve(config.webRoot);
  const hasWeb = fs.existsSync(path.join(webRoot, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webRoot,
      // HTML must always revalidate; assets are cache-busted by the ?v=<hash> the build puts in index.html.
      // (@fastify/static hands this callback a Fastify reply, but accept a raw ServerResponse too.)
      setHeaders(res, filePath) {
        const value = filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=86400';
        if (typeof res.header === 'function') res.header('Cache-Control', value); else res.setHeader('Cache-Control', value);
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}
