/**
 * Lightweight in-process metrics registry (PTW-81).
 *
 * The socket service has no metrics dependency (no prom-client/statsd), and the
 * deploy target's monitoring stack is not fixed. This registry keeps a tiny
 * dependency-free counter/gauge store and renders it in the Prometheus text
 * exposition format — the de-facto scrape format understood by Prometheus,
 * Grafana Agent, the Datadog/CloudWatch agents, etc. It is exposed over HTTP at
 * `GET /metrics` (and embedded in `GET /health`).
 *
 * Every alert-worthy signal ALSO emits a one-line structured `[ALERT]` log via
 * `alert()` so that deployments which only ship logs (CloudWatch Logs, Loki,
 * ELK) can build log-based alerts without a scraper. Belt and suspenders: the
 * four PTW-81 signals surface both as a scrapeable metric and as a greppable log
 * line.
 *
 * Labels are encoded into the series key as a sorted `name{a="x",b="y"}` string
 * so the same (name, labels) pair maps to one series. Keep label cardinality
 * low (small fixed allowlists only) — never label by roomId/userId/matchId.
 */

const logger = require('../utils/logger');

const HELP = {
  buraco_stuck_anim_watchdog_total:
    'Count of client stuck-UI animation-flag watchdog firings reported by mobile.',
  buraco_ghost_occupancy_drift_rooms:
    'Active rooms whose seated-human count diverges from live socket occupancy beyond the reconnect grace window (room-listing desync class).',
  buraco_ghost_occupancy_drift_total:
    'Cumulative count of rooms that crossed into sustained ghost-occupancy drift.',
  brazilia_redis_fallback_in_prod:
    'Set to 1 if the in-memory Redis fallback is active while NODE_ENV=production (must be 0 — the boot guard should make this impossible).',
  buraco_redis_fallback_in_prod_total:
    'Cumulative observations of the in-memory Redis fallback being active in production.',
  buraco_game_result_double_fire_total:
    'Socket-side duplicate game-result webhook attempts suppressed by the per-room resultReported guard.',
  buraco_active_rooms: 'Active (non-finished, non-abandoned) game rooms.',
  buraco_live_sockets: 'Currently connected Socket.IO sockets.',
  buraco_host_heartbeat_kill_total:
    'Lobby/WAITING rooms killed because the host stopped answering the app-level heartbeat (swiped/killed app) or explicitly left.',
  buraco_next_round_scheduled_total:
    'Server-driven multi-round intermissions armed (a non-terminal round ended and the next deal was scheduled).',
  buraco_next_round_aborted_total:
    'Multi-round matches settled early because the scheduled next round could not be dealt (seat_missing / no_humans / start_failed / deal_failed / scheduler_error).',
};

const TYPE = {
  buraco_stuck_anim_watchdog_total: 'counter',
  buraco_ghost_occupancy_drift_rooms: 'gauge',
  buraco_ghost_occupancy_drift_total: 'counter',
  brazilia_redis_fallback_in_prod: 'gauge',
  buraco_redis_fallback_in_prod_total: 'counter',
  buraco_game_result_double_fire_total: 'counter',
  buraco_active_rooms: 'gauge',
  buraco_live_sockets: 'gauge',
  buraco_host_heartbeat_kill_total: 'counter',
  buraco_next_round_scheduled_total: 'counter',
  buraco_next_round_aborted_total: 'counter',
};

class MetricsRegistry {
  constructor() {
    // series-key -> { name, labels, value }
    this._series = new Map();
  }

  /**
   * Build the canonical series key `name` or `name{k="v",...}` (labels sorted so
   * key order never splits a series).
   * @private
   */
  _key(name, labels) {
    const keys = labels ? Object.keys(labels).filter((k) => labels[k] != null).sort() : [];
    if (keys.length === 0) return name;
    const inner = keys
      .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',');
    return `${name}{${inner}}`;
  }

  /**
   * Increment a counter series (default +1).
   */
  increment(name, labels = null, by = 1) {
    const key = this._key(name, labels);
    const cur = this._series.get(key);
    if (cur) {
      cur.value += by;
    } else {
      this._series.set(key, { name, labels, value: by });
    }
    return this._series.get(key).value;
  }

  /**
   * Set a gauge series to an absolute value.
   */
  setGauge(name, value, labels = null) {
    const key = this._key(name, labels);
    this._series.set(key, { name, labels, value });
    return value;
  }

  /**
   * Read a single series value (0 if unseen). Mainly for tests/health JSON.
   */
  get(name, labels = null) {
    const s = this._series.get(this._key(name, labels));
    return s ? s.value : 0;
  }

  /**
   * Plain object snapshot of every series, for the `/health` JSON body.
   * @returns {Object<string, number>}
   */
  snapshot() {
    const out = {};
    for (const [key, s] of this._series.entries()) out[key] = s.value;
    return out;
  }

  /**
   * Render the registry in Prometheus text exposition format. Emits one HELP/TYPE
   * block per metric name, then every series for that name.
   * @returns {string}
   */
  renderProm() {
    // Group series by metric name so HELP/TYPE is emitted once per name.
    const byName = new Map();
    for (const s of this._series.values()) {
      if (!byName.has(s.name)) byName.set(s.name, []);
      byName.get(s.name).push(s);
    }
    const lines = [];
    for (const [name, seriesList] of byName.entries()) {
      if (HELP[name]) lines.push(`# HELP ${name} ${HELP[name]}`);
      if (TYPE[name]) lines.push(`# TYPE ${name} ${TYPE[name]}`);
      for (const s of seriesList) {
        lines.push(`${this._key(s.name, s.labels)} ${s.value}`);
      }
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  /**
   * Emit a one-line structured alert log AND bump its counter. Use for the
   * alert-worthy transitions so log-only deployments still get a signal.
   * @param {string} signal short stable id, e.g. 'redis_fallback_in_prod'
   * @param {Object} [context]
   */
  alert(signal, context = {}) {
    logger.error(`[ALERT] ${signal}`, { alert: signal, ...context });
  }

  /**
   * Test helper: wipe all series.
   */
  reset() {
    this._series.clear();
  }
}

// Singleton — every module increments the same registry.
module.exports = new MetricsRegistry();
