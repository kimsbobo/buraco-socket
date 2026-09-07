/**
 * Ghost-occupancy drift monitor (PTW-81).
 *
 * Surfaces the room-listing-desync class: a room the realtime server still
 * believes is occupied (it has seated human players) while NO live sockets are
 * actually connected to it. Those are the phantom "occupied" rooms that used to
 * linger in the lobby when teardown/delist webhooks were missed.
 *
 * Detection compares, per active room:
 *   seatedHumans = non-bot players still seated in the GameRoom model
 *   liveSockets  = sockets currently joined to the room's Socket.IO room
 *                  (a socket leaves its rooms the instant it disconnects)
 * A room with seatedHumans >= 1 and liveSockets == 0 is "drifting".
 *
 * Reconnect grace: a brief drift is NORMAL during a reconnect window (the seat is
 * held while the client re-establishes its socket). To avoid alerting on that
 * expected transient, a room must stay drifting for `graceMs` before it counts.
 * We track the first-seen-drifting timestamp per room across sweeps and only
 * count rooms that have been drifting longer than the grace window.
 *
 * Output each sweep:
 *   gauge   buraco_active_rooms
 *   gauge   buraco_ghost_occupancy_drift_rooms  (sustained-drift room count)
 *   counter buraco_ghost_occupancy_drift_total  (incremented once per room when
 *                                                it first crosses the threshold)
 * The first crossing also emits an `[ALERT] ghost_occupancy_drift` log.
 */

const logger = require('../utils/logger');

class OccupancyMonitor {
  /**
   * @param {Object} deps
   * @param {Object} deps.io           Socket.IO server (for adapter.rooms)
   * @param {Object} deps.gameService  GameService (getActiveRooms)
   * @param {Object} deps.metrics      metrics registry singleton
   * @param {Object} [opts]
   * @param {number} [opts.intervalMs=30000]  sweep cadence
   * @param {number} [opts.graceMs=60000]     drift must persist this long to count
   */
  constructor({ io, gameService, metrics }, opts = {}) {
    this.io = io;
    this.gameService = gameService;
    this.metrics = metrics;
    this.intervalMs = opts.intervalMs || 30000;
    this.graceMs = opts.graceMs ?? 60000;
    // roomId -> { since: epochMs, alerted: boolean }
    this._drifting = new Map();
    this._timer = null;
  }

  /**
   * Count sockets joined to a Socket.IO room (excludes already-disconnected
   * sockets, which the adapter drops immediately).
   * @private
   */
  _liveSockets(roomId) {
    const room = this.io?.sockets?.adapter?.rooms?.get(roomId);
    return room ? room.size : 0;
  }

  /**
   * Run one reconciliation pass. Returns the structured result (also pushed to
   * the metrics registry) so tests can assert without scraping.
   * @param {number} now epoch ms (injectable for deterministic tests)
   * @returns {{activeRooms:number, driftRooms:number, drifting:string[]}}
   */
  sweep(now = Date.now()) {
    const activeRooms = this.gameService.getActiveRooms();
    const seen = new Set();
    let driftRooms = 0;
    const driftingIds = [];

    for (const room of activeRooms) {
      const roomId = room.roomId;
      const seatedHumans = room.getPlayers().filter((p) => !p.isBot).length;
      const liveSockets = this._liveSockets(roomId);
      const isDrifting = seatedHumans >= 1 && liveSockets === 0;

      if (!isDrifting) {
        this._drifting.delete(roomId);
        continue;
      }

      seen.add(roomId);
      let entry = this._drifting.get(roomId);
      if (!entry) {
        entry = { since: now, alerted: false };
        this._drifting.set(roomId, entry);
      }

      // Only count/alert once the drift has outlived the reconnect grace window.
      if (now - entry.since >= this.graceMs) {
        driftRooms += 1;
        driftingIds.push(roomId);
        if (!entry.alerted) {
          entry.alerted = true;
          this.metrics.increment('buraco_ghost_occupancy_drift_total');
          this.metrics.alert('ghost_occupancy_drift', {
            roomId: String(roomId),
            seatedHumans,
            liveSockets,
            driftingForMs: now - entry.since,
          });
        }
      }
    }

    // Drop bookkeeping for rooms that are no longer active so the map can't grow
    // unbounded (a torn-down room never reappears in getActiveRooms).
    for (const roomId of this._drifting.keys()) {
      const stillActive = activeRooms.some((r) => r.roomId === roomId);
      if (!stillActive) this._drifting.delete(roomId);
    }

    this.metrics.setGauge('buraco_active_rooms', activeRooms.length);
    this.metrics.setGauge('buraco_ghost_occupancy_drift_rooms', driftRooms);
    this.metrics.setGauge('buraco_live_sockets', this.io?.sockets?.sockets?.size || 0);

    return { activeRooms: activeRooms.length, driftRooms, drifting: driftingIds };
  }

  /**
   * Begin the periodic sweep. The interval is unref'd so it never keeps the
   * process alive on its own.
   */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        logger.error(`[OccupancyMonitor] sweep failed: ${err.message}`);
      }
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    logger.info(
      `✓ Occupancy monitor started (every ${this.intervalMs}ms, grace ${this.graceMs}ms)`
    );
  }

  /**
   * Stop the periodic sweep (graceful shutdown).
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = OccupancyMonitor;
