/**
 * Rate Limiter Middleware
 * Simple rate limiting for socket connections
 */

const logger = require('../utils/logger');
const config = require('../config');

class RateLimiter {
  constructor() {
    this.requests = new Map(); // socketId -> { count, resetTime }  (connection-level)
    this.actions = new Map(); // socketId -> { count, resetTime }   (per-event flood guard)
    this.windowMs = config.security.rateLimit.windowMs;
    this.maxRequests = config.security.rateLimit.maxRequests;
    // Per-socket action flood guard. The connection middleware only runs once at
    // handshake, so without this a connected client could spam game actions
    // (draw/meld/discard/state) unbounded. The cap is far above human play
    // speed (a turn is a handful of actions/sec) so it only trips on a flood,
    // and callers emit an error rather than disconnecting.
    this.actionWindowMs = 1000;
    this.maxActionsPerWindow = 40;
    // Periodic sweep of expired buckets. Tracked so graceful shutdown can clear
    // it (P1-12) and `.unref()`'d so it never keeps the process alive on its own.
    this.cleanupTimer = null;
  }

  /**
   * Start the periodic cleanup sweep. Idempotent.
   */
  startCleanup(intervalMs = 60000) {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
    this.cleanupTimer.unref?.();
  }

  /**
   * Stop the cleanup sweep and drop tracked buckets. Called from graceful
   * shutdown so the interval does not escape process teardown (P1-12).
   */
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.requests.clear();
    this.actions.clear();
  }

  /**
   * Per-socket sliding-window check for individual events (flood protection),
   * independent of the connection-level checkLimit bucket.
   * @param {string} socketId
   * @returns {boolean} true if allowed, false if the socket is flooding
   */
  checkActionLimit(socketId) {
    const now = Date.now();
    const record = this.actions.get(socketId);

    if (!record || now > record.resetTime) {
      this.actions.set(socketId, { count: 1, resetTime: now + this.actionWindowMs });
      return true;
    }

    if (record.count >= this.maxActionsPerWindow) {
      logger.warn(`Action rate limit exceeded for socket ${socketId}`);
      return false;
    }

    record.count++;
    return true;
  }

  /**
   * Check if request should be allowed
   * @param {string} socketId
   * @returns {boolean}
   */
  checkLimit(socketId) {
    const now = Date.now();
    const record = this.requests.get(socketId);

    if (!record || now > record.resetTime) {
      // New window
      this.requests.set(socketId, {
        count: 1,
        resetTime: now + this.windowMs,
      });
      return true;
    }

    if (record.count >= this.maxRequests) {
      logger.warn(`Rate limit exceeded for socket ${socketId}`);
      return false;
    }

    record.count++;
    return true;
  }

  /**
   * Reset rate limit for a socket
   * @param {string} socketId
   */
  reset(socketId) {
    this.requests.delete(socketId);
    this.actions.delete(socketId);
  }

  /**
   * Cleanup old entries
   */
  cleanup() {
    const now = Date.now();
    for (const [socketId, record] of this.requests.entries()) {
      if (now > record.resetTime) {
        this.requests.delete(socketId);
      }
    }
    for (const [socketId, record] of this.actions.entries()) {
      if (now > record.resetTime) {
        this.actions.delete(socketId);
      }
    }
  }

  /**
   * Create middleware function
   * @returns {Function}
   */
  middleware() {
    return (socket, next) => {
      if (this.checkLimit(socket.id)) {
        next();
      } else {
        next(new Error('Rate limit exceeded'));
      }
    };
  }
}

// Start cleanup timer (unref'd; cleared by rateLimiter.shutdown()).
const rateLimiter = new RateLimiter();
rateLimiter.startCleanup();

module.exports = rateLimiter;
