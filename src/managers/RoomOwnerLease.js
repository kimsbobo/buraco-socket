/**
 * RoomOwnerLease (PTW-43, Phase 2)
 *
 * A per-room ownership lease in Redis so that, across a multi-node socket
 * cluster, exactly ONE node mutates a given room's turn/timer/bot state at a
 * time. This is the split-brain guard the multi-node deploy depends on
 * (socket_scaling_plan.md, Phase 2).
 *
 * Key: `room:{roomId}:owner = nodeId` with a TTL. The owner node renews the
 * lease well within the TTL; if the owner dies, the lease expires and another
 * node may acquire it (owner re-election, Phase 3).
 *
 * Atomicity:
 *   - acquire  -> `SET key nodeId NX PX ttl`   (atomic claim)
 *   - renew    -> Lua compare-and-pexpire       (only the owner extends)
 *   - release  -> Lua compare-and-del           (only the owner releases)
 * The Lua scripts run server-side on a real Redis so check-and-act is atomic
 * across nodes. When the injected client lacks `eval` (the in-memory dev/test
 * fallback, which is single-process anyway) we fall back to a get-then-act that
 * is safe within one process.
 *
 * This module is the lease PRIMITIVE only. Routing mutating actions to the owner
 * node (forwarding from non-owners) is wired in a follow-up issue.
 */

// KEYS[1]=lease key, ARGV[1]=nodeId, ARGV[2]=ttlMs
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

// KEYS[1]=lease key, ARGV[1]=nodeId
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

class RoomOwnerLease {
  /**
   * @param {object} redis  Redis-compatible client (ioredis or InMemoryRedis).
   * @param {string} nodeId This node's stable identity.
   * @param {object} [opts]
   * @param {number} [opts.ttlMs=15000]   Lease lifetime.
   * @param {object} [opts.logger]        Optional logger.
   */
  constructor(redis, nodeId, { ttlMs = 15000, logger } = {}) {
    if (!redis) throw new Error('RoomOwnerLease requires a redis client');
    if (!nodeId) throw new Error('RoomOwnerLease requires a nodeId');
    this.redis = redis;
    this.nodeId = nodeId;
    this.ttlMs = ttlMs;
    this.logger = logger || null;
    this._canEval = typeof redis.eval === 'function';
  }

  key(roomId) {
    return `room:${roomId}:owner`;
  }

  /**
   * Attempt to become the owner of a room. Resolves true if this node now holds
   * the lease (either freshly acquired or already owned), false otherwise.
   */
  async acquire(roomId) {
    const key = this.key(roomId);
    const res = await this.redis.set(key, this.nodeId, 'PX', this.ttlMs, 'NX');
    if (res === 'OK') return true;
    // Someone owns it — true only if it is us (idempotent re-acquire).
    const owner = await this.redis.get(key);
    return owner === this.nodeId;
  }

  /**
   * Extend the lease iff this node still owns it. Resolves true on success,
   * false if ownership was lost (caller must stop mutating the room).
   */
  async renew(roomId) {
    const key = this.key(roomId);
    if (this._canEval) {
      const res = await this.redis.eval(RENEW_SCRIPT, 1, key, this.nodeId, String(this.ttlMs));
      return res === 1 || res === '1';
    }
    const owner = await this.redis.get(key);
    if (owner !== this.nodeId) return false;
    await this.redis.pexpire(key, this.ttlMs);
    return true;
  }

  /** Resolve the current owner nodeId for a room, or null if unowned. */
  async getOwner(roomId) {
    return this.redis.get(this.key(roomId));
  }

  /** True iff this node currently owns the room. */
  async isOwner(roomId) {
    const owner = await this.getOwner(roomId);
    return owner === this.nodeId;
  }

  /**
   * Release the lease iff this node owns it (compare-and-del). Resolves true if
   * released, false if it was not ours (never steal another node's lease).
   */
  async release(roomId) {
    const key = this.key(roomId);
    if (this._canEval) {
      const res = await this.redis.eval(RELEASE_SCRIPT, 1, key, this.nodeId);
      return res === 1 || res === '1';
    }
    const owner = await this.redis.get(key);
    if (owner !== this.nodeId) return false;
    await this.redis.del(key);
    return true;
  }
}

module.exports = RoomOwnerLease;
