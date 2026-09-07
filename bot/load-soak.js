const { setTimeout: sleep } = require('timers/promises');

require('dotenv').config({ path: __dirname + '/.env' });
const BotPlayer = require('./BotPlayer');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const value = argv[i + 1];

    if (!value || value.startsWith('--')) {
      out[key] = true;
      continue;
    }

    out[key] = value;
    i += 1;
  }
  return out;
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function newRoomId(prefix) {
  const rnd = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

// Percentile over an array of numbers (linear interpolation, p in [0,100]).
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return Math.round(sorted[low] * (1 - weight) + sorted[high] * weight);
}

async function requestJson(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, { method, headers, body });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function callWebhook(socketUrl, endpoint, body, secret = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-webhook-secret'] = secret;

  const { response, payload } = await requestJson(
    `${socketUrl.replace(/\/+$/, '')}${endpoint}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }
  );

  return { ok: response.ok, status: response.status, payload };
}

async function waitUntil(predicate, timeoutMs, pollMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(pollMs);
  }
  return false;
}

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 10000) / 100;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(`Usage: npm run bot:load-soak -- \\
  --socket-url http://127.0.0.1:8080 \\
  --socket-urls http://127.0.0.1:8080,http://127.0.0.1:8081 \\  # multi-node (PTW-40): rooms round-robin across nodes \\
  --rooms 6 \\
  --players-per-room 2 \\
  --runtime-seconds 120 \\
  --chaos-interval-ms 5000 \\
  --room-prefix ptw78-load \\
  --auto-deal false \\
  --slo-connect-success 99 \\
  --slo-join-success 99 \\
  --slo-join-p95-ms 2000 \\
  --slo-reconnect-success 95 \\
  --reconnect-grace-ms 30000`);
    return;
  }

  // Single-node: --socket-url. Multi-node (PTW-40): --socket-urls a,b,c spreads
  // rooms round-robin across cluster nodes so the soak exercises a real
  // multi-instance deployment (each room — and all its players/webhooks — pins
  // to one node, mirroring sticky-session LB routing). All nodes must share one
  // Redis adapter + owner-lease registry for cross-node correctness.
  const socketUrl = args['socket-url'] || process.env.BOT_SERVER_URL || 'http://127.0.0.1:8080';
  const socketUrls = (args['socket-urls'] || process.env.BOT_SERVER_URLS || socketUrl)
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const nodeUrlForRoom = (roomIndex) => socketUrls[roomIndex % socketUrls.length];
  const roomsToCreate = toNumber(args.rooms, 6);
  const playersPerRoom = toNumber(args['players-per-room'], 2);
  const joinTimeoutMs = toNumber(args['join-timeout-ms'], 12000);
  const startTimeoutMs = toNumber(args['start-timeout-ms'], 12000);
  const runtimeMs = Math.max(1000, toNumber(args['runtime-seconds'], 120) * 1000);
  const chaosIntervalMs = toNumber(args['chaos-interval-ms'], 7000);
  const roomPrefix = args['room-prefix'] || 'ptw78-load';
  const autoDeal = toBoolean(args['auto-deal'], false);
  const autoStart = toBoolean(args['auto-start'], false);
  const webhookSecret = process.env.WEBHOOK_SECRET || '';

  // Phase 0 SLO thresholds (overridable via CLI). Defaults mirror PTW-58 scope.
  const sloConnectSuccess = toNumber(args['slo-connect-success'], 99); // %
  const sloJoinSuccess = toNumber(args['slo-join-success'], 99); // %
  const sloJoinP95Ms = toNumber(args['slo-join-p95-ms'], 2000); // ms
  const sloReconnectSuccess = toNumber(args['slo-reconnect-success'], 95); // %
  const reconnectGraceMs = toNumber(args['reconnect-grace-ms'], 30000); // ms

  const rooms = [];
  const failures = [];
  let roomNotReadyErrors = 0;
  let chaosDisconnects = 0;
  let chaosReconnects = 0;

  // SLO accumulators.
  const connectLatencies = [];
  const joinLatencies = [];
  const reconnectLatencies = [];
  let connectAttempts = 0;
  let connectSuccess = 0;
  let joinAttempts = 0;
  let joinSuccess = 0;
  let reconnectAttempts = 0;
  let reconnectSuccess = 0;
  let socketErrors = 0;

  console.log('\n[LOAD] Starting load+soak run');
  console.log(
    `[LOAD] ${roomsToCreate} rooms x ${playersPerRoom} players, runtime=${runtimeMs}ms, chaosEvery=${chaosIntervalMs}ms`
  );
  console.log(
    `[LOAD] cluster: ${socketUrls.length} node(s) -> ${socketUrls.join(', ')}` +
      (socketUrls.length > 1 ? ' (multi-node: rooms round-robin, sticky per room)' : ' (single-node)')
  );
  console.log(
    `[LOAD] SLOs: connect>=${sloConnectSuccess}% join>=${sloJoinSuccess}% join_p95<=${sloJoinP95Ms}ms reconnect>=${sloReconnectSuccess}% (grace ${reconnectGraceMs}ms)`
  );

  try {
    for (let roomIndex = 0; roomIndex < roomsToCreate; roomIndex += 1) {
      const roomId = newRoomId(`${roomPrefix}-${roomIndex}`);
      const nodeUrl = nodeUrlForRoom(roomIndex);
      const synced = await callWebhook(
        nodeUrl,
        '/webhooks/sync-room',
        {
          roomId,
          maxPlayers: playersPerRoom,
          status: 'waiting',
          game_type: 'Classic',
          bots: [],
        },
        webhookSecret
      );

      if (!synced.ok) {
        throw new Error(`sync-room failed: ${roomId} ${synced.status} ${JSON.stringify(synced.payload)}`);
      }

      const room = {
        roomId,
        nodeUrl,
        bots: [],
        joinedCount: 0,
        startEvents: 0,
        lastSnapshot: null,
      };

      const bots = Array.from({ length: playersPerRoom }, (_, seat) => {
        const bot = new BotPlayer({
          serverUrl: nodeUrl,
          roomId,
          playerName: `Load-${roomIndex}-${seat + 1}`,
          playerId: `load-${roomIndex}-p${seat + 1}`,
          autoStart,
          autoDeal,
          turnDelayMs: 300,
          actionDelayMs: 300,
        });

        // Per-bot SLO state.
        bot._sloConnectStart = null; // ts when (re)connect attempt started
        bot._sloJoinStart = null; // ts when initial join attempt started
        bot._sloJoined = false; // initial join already measured
        bot._sloDroppedAt = null; // ts of a chaos-induced drop, awaiting reconnect

        bot.on('connected', () => {
          const now = Date.now();
          // Attempts are counted where _sloConnectStart is armed; here we only score success.
          if (bot._sloConnectStart != null) {
            connectSuccess += 1;
            connectLatencies.push(now - bot._sloConnectStart);
            bot._sloConnectStart = null;
          }
          // Chaos reconnect measurement.
          if (bot._sloDroppedAt != null) {
            const latency = now - bot._sloDroppedAt;
            reconnectLatencies.push(latency);
            if (latency <= reconnectGraceMs) reconnectSuccess += 1;
            bot._sloDroppedAt = null;
          }
        });

        bot.on('self_joined', () => {
          room.joinedCount += 1;
          if (!bot._sloJoined && bot._sloJoinStart != null) {
            bot._sloJoined = true;
            joinSuccess += 1;
            joinLatencies.push(Date.now() - bot._sloJoinStart);
          }
        });
        bot.on('game_started', () => {
          room.startEvents += 1;
        });
        bot.on('player_disconnected', () => {
          chaosDisconnects += 1;
        });
        bot.on('player_reconnected', () => {
          chaosReconnects += 1;
        });
        bot.on('error', (payload) => {
          socketErrors += 1;
          const message = String(payload?.error || payload?.message || '');
          if (message.toLowerCase().includes('room is not ready on realtime server')) {
            roomNotReadyErrors += 1;
          }
        });

        return bot;
      });

      room.bots = bots;
      rooms.push(room);

      // Stamp connect/join start just before dialing so latency reflects real handshake.
      bots.forEach((bot) => {
        bot._sloConnectStart = Date.now();
        bot._sloJoinStart = Date.now();
        connectAttempts += 1; // initial connect attempt (scored in 'connected' handler)
        joinAttempts += 1;
      });

      await Promise.all(bots.map((bot) => bot.start()));

      const joined = await waitUntil(() => room.joinedCount === playersPerRoom, joinTimeoutMs);
      if (!joined) {
        failures.push(`join timeout room ${roomId}: ${room.joinedCount}/${playersPerRoom}`);
        continue;
      }

      const started = await callWebhook(
        nodeUrl,
        '/webhooks/start-game',
        { roomId, source: 'phase6-load-soak' },
        webhookSecret
      );

      if (!started.ok) {
        failures.push(`start timeout room ${roomId}: ${started.status} ${JSON.stringify(started.payload)}`);
        continue;
      }

      const gameReady = await waitUntil(() => room.startEvents === playersPerRoom, startTimeoutMs);
      if (!gameReady) {
        failures.push(`game_start timeout room ${roomId}: ${room.startEvents}/${playersPerRoom}`);
      }
    }

    const startedRooms = rooms.filter((room) => room.startEvents >= 1).length;
    console.log(`[LOAD] Rooms synced+started: ${startedRooms}/${rooms.length}`);

    const endAt = Date.now() + runtimeMs;
    let chaosRound = 0;

    while (Date.now() < endAt) {
      const remaining = Math.max(0, endAt - Date.now());
      const waitMs = Math.min(chaosIntervalMs, remaining);
      await sleep(waitMs);
      if (Date.now() >= endAt) break;

      const targetRoom = rooms[Math.floor(Math.random() * rooms.length)];
      if (targetRoom?.bots.length) {
        const bot = targetRoom.bots[Math.floor(Math.random() * targetRoom.bots.length)];
        // Arm reconnect SLO measurement before forcing the drop.
        bot._sloDroppedAt = Date.now();
        bot._sloConnectStart = Date.now();
        connectAttempts += 1;
        reconnectAttempts += 1;
        bot.simulateNetworkDrop();
      }

      const snapshots = await Promise.all(
        rooms.map((room) =>
          callWebhook(
            room.nodeUrl,
            '/webhooks/room-runtime',
            { roomId: room.roomId },
            webhookSecret
          )
        )
      );
      snapshots.forEach((snapshot, index) => {
        if (snapshot.payload && snapshot.ok) {
          rooms[index].lastSnapshot = snapshot.payload;
        }
      });

      chaosRound += 1;
      const bad = snapshots.filter((snapshot) => !snapshot.ok).length;
      if (bad > 0) {
        failures.push(`runtime snapshot failures round=${chaosRound}: ${bad}/${rooms.length}`);
      }
      console.log(`[SOAK] round=${chaosRound}, runtime-snapshot failures=${bad}/${rooms.length}`);
    }

    // Give any in-flight chaos reconnects a moment to land before scoring.
    await waitUntil(() => rooms.every((room) => room.bots.every((bot) => bot._sloDroppedAt == null)), 5000);

    const unstableRooms = rooms.filter((room) => !room.lastSnapshot?.exists);
    if (unstableRooms.length > 0) {
      failures.push(`runtime snapshots missing for rooms: ${unstableRooms.map((room) => room.roomId).join(', ')}`);
    }

    // ---- SLO scoring ----
    const connectSuccessRate = pct(connectSuccess, connectAttempts);
    const joinSuccessRate = pct(joinSuccess, joinAttempts);
    const reconnectSuccessRate = pct(reconnectSuccess, reconnectAttempts);
    const joinP50 = percentile(joinLatencies, 50);
    const joinP95 = percentile(joinLatencies, 95);
    const connectP95 = percentile(connectLatencies, 95);
    const reconnectP95 = percentile(reconnectLatencies, 95);

    const sloResults = [
      {
        name: 'connect_success',
        ok: connectSuccessRate >= sloConnectSuccess,
        detail: `${connectSuccessRate}% (>=${sloConnectSuccess}%) over ${connectAttempts} attempts`,
      },
      {
        name: 'join_success',
        ok: joinSuccessRate >= sloJoinSuccess,
        detail: `${joinSuccessRate}% (>=${sloJoinSuccess}%) over ${joinAttempts} attempts`,
      },
      {
        name: 'join_p95_latency',
        ok: joinP95 == null ? false : joinP95 <= sloJoinP95Ms,
        detail: `p95=${joinP95}ms p50=${joinP50}ms (<=${sloJoinP95Ms}ms)`,
      },
      {
        name: 'reconnect_within_grace',
        // No chaos rounds => vacuously satisfied.
        ok: reconnectAttempts === 0 ? true : reconnectSuccessRate >= sloReconnectSuccess,
        detail:
          reconnectAttempts === 0
            ? 'no chaos reconnects exercised'
            : `${reconnectSuccessRate}% (>=${sloReconnectSuccess}%) over ${reconnectAttempts} drops, p95=${reconnectP95}ms`,
      },
    ];

    console.log('\n[LOAD] Summary');
    console.log(`rooms=${rooms.length}`);
    console.log(`room_not_ready_errors=${roomNotReadyErrors}`);
    console.log(`socket_errors=${socketErrors}`);
    console.log(`chaos_disconnects=${chaosDisconnects}`);
    console.log(`chaos_reconnects=${chaosReconnects}`);
    console.log(`runtime_rounds=${chaosRound}`);

    console.log('\n[SLO] Phase 0 acceptance');
    sloResults.forEach((r) => {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`);
    });
    console.log(`  mem_rss_mb=${Math.round(process.memoryUsage().rss / 1048576)} (runner-side, informational)`);

    const failedSlos = sloResults.filter((r) => !r.ok);
    failedSlos.forEach((r) => failures.push(`SLO breach ${r.name}: ${r.detail}`));

    if (failures.length > 0) {
      console.log('\n[LOAD] Failures observed');
      failures.forEach((item) => console.log(`- ${item}`));
      process.exitCode = 1;
      return;
    }

    console.log('\n[LOAD] Completed successfully. All Phase 0 SLOs met.');
    process.exitCode = 0;
  } finally {
    for (const room of rooms) {
      room.bots.forEach((bot) => {
        try {
          bot.stop();
        } catch (_) {}
      });
    }
  }
}

main().catch((error) => {
  console.error(`[LOAD] fatal: ${error.message}`);
  process.exit(1);
});
