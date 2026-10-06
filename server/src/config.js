import os from 'node:os';
import { fileURLToPath } from 'node:url';

const truthy = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const cfg = {
    env: env.NODE_ENV || 'development',
    isProd,
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 8080),
    logLevel: env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    databaseUrl: env.DATABASE_URL,
    databaseSsl: truthy(env.DATABASE_SSL, false),
    dbPoolMax: Number(env.DB_POOL_MAX || 20),
    dbMaxQueue: Number(env.DB_MAX_QUEUE || Number(env.DB_POOL_MAX || 20) * 10),
    statementTimeoutMs: Number(env.DB_STATEMENT_TIMEOUT_MS || 8000),
    autoMigrate: truthy(env.AUTO_MIGRATE, true),
    firebaseProjectId: env.FIREBASE_PROJECT_ID || 'sng-pro',
    ownerEmails: list(env.OWNER_EMAILS).map((e) => e.toLowerCase()),
    corsOrigins: list(env.CORS_ORIGINS),
    trustProxy: truthy(env.TRUST_PROXY, false),
    rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN || 600),
    writeRateLimitPerMin: Number(env.WRITE_RATE_LIMIT_PER_MIN || 40),
    maxActiveLoadsPerMember: Number(env.MAX_ACTIVE_LOADS_PER_MEMBER || 500),
    maxActiveTrucksPerMember: Number(env.MAX_ACTIVE_TRUCKS_PER_MEMBER || 200),
    maxPostsPerHour: Number(env.MAX_POSTS_PER_HOUR || 200),
    roadFactor: Number(env.ROAD_FACTOR || 1.2),
    countCacheMs: Number(env.COUNT_CACHE_MS ?? 5000),
    searchCacheMs: Number(env.SEARCH_CACHE_MS ?? 1500),
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.8-flash', // comma-separated fallback order
    aiFallback: truthy(env.AI_FALLBACK, true), // without a Gemini key, offer the basic rule-based reader instead of nothing
    aiRatePerHour: Number(env.AI_RATE_PER_HOUR || 40),
    aiMaxParallel: Number(env.AI_MAX_PARALLEL || 8),
    eventBatchMs: Number(env.EVENT_BATCH_MS ?? 1000),
    memberCacheMs: Number(env.MEMBER_CACHE_MS ?? 10000),
    workers: env.WEB_CONCURRENCY === 'auto' ? os.availableParallelism() : Number(env.WEB_CONCURRENCY || 1),
    devAuth: truthy(env.DEV_FAKE_AUTH, false),
    cspEnforce: truthy(env.CSP_ENFORCE, false),
    // Default is resolved from this file, not the process cwd, so the server works from any launch directory.
    webRoot: env.WEB_ROOT || fileURLToPath(new URL('../../web/dist', import.meta.url)),
  };
  const problems = [];
  if (!cfg.databaseUrl) problems.push('DATABASE_URL is required');
  if (isProd && cfg.ownerEmails.length === 0) problems.push('OWNER_EMAILS is required in production (comma-separated owner Google emails)');
  if (cfg.devAuth && isProd) problems.push('DEV_FAKE_AUTH must never be enabled in production');
  if (!(cfg.workers >= 1 && cfg.workers <= 64)) problems.push('WEB_CONCURRENCY must be 1-64 or "auto"');
  if (!(cfg.roadFactor >= 1 && cfg.roadFactor <= 2)) problems.push('ROAD_FACTOR must be between 1 and 2');
  if (problems.length) throw new Error('Invalid configuration:\n - ' + problems.join('\n - '));
  return cfg;
}
