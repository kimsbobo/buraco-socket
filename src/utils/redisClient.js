const InMemoryRedis = require('./InMemoryRedis');
const config = require('../config');
const logger = require('./logger');

/**
 * Create a Redis-compatible client.
 *
 * When a real Redis is configured (REDIS_URL or REDIS_HOST) this returns an
 * ioredis client so persistence/reconnection survive restarts and scale-out
 * (S-C10). Otherwise it falls back to the in-process InMemoryRedis — convenient
 * for local dev/tests but NOT durable: reconnection-by-previous-socket will not
 * survive a restart, so a warning is logged.
 *
 * The ioredis client exposes the same async methods the codebase uses
 * (setex/get/del/exists/keys/quit). The synchronous `getSync` only exists on the
 * in-memory store; callers must use the async `get` so both backends work.
 */
function createRedisClient() {
  const { url, host, port, password } = config.redis || {};

  if (!url && !host) {
    logger.warn(
      '[redis] No REDIS_URL/REDIS_HOST configured — using in-memory store. ' +
      'Reconnection/persistence will NOT survive restarts or scale across instances.'
    );
    return new InMemoryRedis();
  }

  // Lazy-require so a deployment without ioredis installed can still boot on the
  // in-memory fallback above.
  // eslint-disable-next-line global-require
  const Redis = require('ioredis');
  const client = url
    ? new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })
    : new Redis({ host, port, password: password || undefined, maxRetriesPerRequest: 3 });

  client.on('error', (err) => logger.error(`[redis] client error: ${err.message}`));
  client.on('connect', () => logger.info('[redis] Connected to Redis'));

  return client;
}

/**
 * Wait for an ioredis client to reach the `ready` state, or reject on timeout /
 * fatal error. Used to make adapter bootstrap fail-fast (PTW-43, Phase 1).
 */
function waitForReady(client, timeoutMs, label) {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`[redis] ${label} not ready within ${timeoutMs}ms`));
    }, timeoutMs);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      // ioredis retries transient errors; only treat as fatal once the timeout
      // fires. But surface the message for diagnostics.
      logger.warn(`[redis] ${label} connecting error: ${err.message}`);
    };
    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener('ready', onReady);
      client.removeListener('error', onError);
    };
    client.on('ready', onReady);
    client.on('error', onError);
  });
}

/**
 * Build the pub/sub ioredis client pair required by `@socket.io/redis-adapter`.
 * Throws if no real Redis is configured (the in-memory fallback cannot fan out
 * across nodes). Returns clients plus a `ready()` promise that resolves when
 * both are connected or rejects on timeout — callers use it for fail-fast boot.
 */
function createAdapterClients() {
  const { url, host, port, password, adapterConnectTimeoutMs } = config.redis || {};

  if (!url && !host) {
    throw new Error(
      '[redis] Cannot create adapter clients without a real Redis (REDIS_URL or REDIS_HOST).'
    );
  }

  // eslint-disable-next-line global-require
  const Redis = require('ioredis');
  const make = (role) => {
    const c = url
      ? new Redis(url, { lazyConnect: false, maxRetriesPerRequest: null })
      : new Redis({ host, port, password: password || undefined, maxRetriesPerRequest: null });
    c.on('error', (err) => logger.error(`[redis] adapter ${role} error: ${err.message}`));
    return c;
  };

  const pubClient = make('pub');
  // The adapter subscribes on the sub client; ioredis recommends a duplicate.
  const subClient = pubClient.duplicate();
  subClient.on('error', (err) => logger.error(`[redis] adapter sub error: ${err.message}`));

  const timeout = adapterConnectTimeoutMs || 10000;
  const ready = () =>
    Promise.all([
      waitForReady(pubClient, timeout, 'adapter pub'),
      waitForReady(subClient, timeout, 'adapter sub'),
    ]);

  return { pubClient, subClient, ready };
}

module.exports = { createRedisClient, createAdapterClients, waitForReady };
