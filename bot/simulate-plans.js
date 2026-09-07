require('dotenv').config({ path: __dirname + '/.env' });

const { spawnSync } = require('child_process');
const path = require('path');
const BotPlayer = require('./BotPlayer');

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;

  const normalized = String(value).toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;

  return fallback;
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureApiBase(url) {
  const base = url.replace(/\/+$/, '');
  if (base.endsWith('/api')) return base;
  return `${base}/api`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.message || payload?.error || JSON.stringify(payload) || 'unknown error';
    throw new Error(`${options.method || 'GET'} ${url} failed (${response.status}): ${message}`);
  }

  return payload;
}

async function registerBackendAccount({ backendUrl, name, email, password }) {
  const apiBase = ensureApiBase(backendUrl);

  return requestJson(`${apiBase}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      name,
      email,
      password,
      password_confirmation: password,
    }),
  });
}

async function loginBackendAccount({ backendUrl, email, password }) {
  const apiBase = ensureApiBase(backendUrl);

  return requestJson(`${apiBase}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
    }),
  });
}

async function provisionAndLoginBotAccount({ backendUrl, simulationId, role, password }) {
  const normalizedRole = String(role).toLowerCase();
  const email = `bot.${normalizedRole}.${simulationId}@brazilia.local`;
  const name = `Sim ${role}`;

  try {
    await registerBackendAccount({
      backendUrl,
      name,
      email,
      password,
    });
  } catch (error) {
    // If account already exists for any reason, continue with login attempt.
    if (!String(error.message).includes('422')) {
      throw error;
    }
  }

  const loginPayload = await loginBackendAccount({
    backendUrl,
    email,
    password,
  });

  const accessToken = loginPayload?.access_token;
  const userId = loginPayload?.user?.id;
  const userName = loginPayload?.user?.name || name;

  if (!accessToken || userId === undefined || userId === null) {
    throw new Error(`Provisioned account missing access token or user id for role ${role}`);
  }

  return {
    role,
    email,
    name: userName,
    userId: String(userId),
    token: accessToken,
  };
}

async function createBackendRoom({ backendUrl, backendToken, gameType, maxPlayers, roomName, isPrivate, password }) {
  const apiBase = ensureApiBase(backendUrl);
  const requestBody = {
    name: roomName,
    game_type: gameType,
    max_players: maxPlayers,
    is_private: isPrivate,
  };

  if (isPrivate && password) {
    requestBody.password = password;
  }

  const response = await fetch(`${apiBase}/rooms`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${backendToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Create room failed (${response.status}): ${payload.message || payload.error || 'unknown error'}`);
  }

  if (!payload.id) {
    throw new Error('Create room response missing id');
  }

  return payload;
}

async function startBackendRoom({ backendUrl, backendToken, roomId }) {
  const apiBase = ensureApiBase(backendUrl);

  const response = await fetch(`${apiBase}/rooms/${roomId}/start`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${backendToken}`,
      Accept: 'application/json',
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Start room failed (${response.status}): ${payload.message || payload.error || 'unknown error'}`);
  }

  return payload;
}

async function joinBackendRoom({ backendUrl, backendToken, roomId, password = '' }) {
  const apiBase = ensureApiBase(backendUrl);
  const body = password ? { password } : {};

  const response = await fetch(`${apiBase}/rooms/${roomId}/join`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${backendToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Join room failed (${response.status}): ${payload.message || payload.error || 'unknown error'}`);
  }

  return payload;
}

async function callSocketWebhook({ socketUrl, secret, endpoint, body }) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (secret) {
    headers['x-webhook-secret'] = secret;
  }

  const response = await fetch(`${socketUrl.replace(/\/+$/, '')}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    payload,
  };
}

function runReconcileCommand({ backendPath }) {
  const command = 'php';
  const args = ['artisan', 'rooms:reconcile-runtime', '--close-empty-ongoing'];

  const result = spawnSync(command, args, {
    cwd: backendPath,
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function waitUntil(predicate, timeoutMs, pollMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(pollMs);
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(`Usage: npm run bot:simulate -- \\
  --socket-url http://localhost:8080 \\
  --backend-url http://localhost:8000 \\
  [--simulate-auth true] \\
  [--bot-password botpass123] \\
  [--backend-token YOUR_HOST_BEARER_TOKEN] \\
  [--webhook-secret YOUR_WEBHOOK_SECRET] \\
  [--backend-path ../backend] \\
  [--backend-game-type Classic] \\
  [--backend-max-players 2] \\
  [--post-recovery-turns 2] \\
  [--post-recovery-timeout 30000] \\
  [--run-reconcile true] \\
  [--timeout 25000]`);
    return;
  }

  const socketUrl = args['socket-url'] || process.env.BOT_SERVER_URL || 'http://localhost:8080';
  const backendUrl = args['backend-url'] || process.env.BOT_BACKEND_URL;
  const manualBackendToken = args['backend-token'] || process.env.BOT_BACKEND_TOKEN;
  const simulateAuth = toBoolean(args['simulate-auth'] ?? process.env.BOT_SIMULATE_AUTH, true);
  const botPassword = args['bot-password'] || process.env.BOT_SIM_BOT_PASSWORD || 'botpass123';
  const webhookSecret = args['webhook-secret'] || process.env.WEBHOOK_SECRET || '';
  const backendPath = args['backend-path'] || path.resolve(__dirname, '../../backend');

  const timeoutMs = toNumber(args.timeout, 25000);
  const runReconcile = toBoolean(args['run-reconcile'], true);
  const postRecoveryTurns = toNumber(
    args['post-recovery-turns'] || process.env.BOT_SIM_POST_RECOVERY_TURNS,
    2
  );
  const postRecoveryTimeoutMs = toNumber(
    args['post-recovery-timeout'] || process.env.BOT_SIM_POST_RECOVERY_TIMEOUT,
    timeoutMs
  );

  if (!backendUrl) {
    throw new Error('backend-url is required for simulation');
  }

  if (!simulateAuth && !manualBackendToken) {
    throw new Error('backend-token is required when simulate-auth is false');
  }

  const simulationId = `sim-${Date.now()}`;
  const roomName = args['room-name'] || `Bot Plan Simulation ${simulationId}`;

  console.log(`\n[SIM] Starting simulation ${simulationId}`);

  const results = [];
  const bots = [];

  const mark = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`[SIM] ${ok ? '✓' : '✗'} ${name}${detail ? ` | ${detail}` : ''}`);
  };

  let roomId;
  let hostIdentity;
  let guestIdentity;

  try {
    // Scenario 1: Explicit unsynced room join should be rejected
    const unsyncedProbe = new BotPlayer({
      serverUrl: socketUrl,
      roomId: `unsynced-${simulationId}`,
      playerName: `Probe-${simulationId}`,
      playerId: `probe-${simulationId}`,
      autoStart: false,
      autoDeal: false,
      turnDelayMs: 200,
      actionDelayMs: 200,
    });

    bots.push(unsyncedProbe);
    await unsyncedProbe.start();

    let unsyncedRejected = false;
    unsyncedProbe.on('error', (payload) => {
      const message = payload?.error || payload?.message || '';
      if (String(message).toLowerCase().includes('room is not ready on realtime server')) {
        unsyncedRejected = true;
      }
    });

    const unsyncedOk = await waitUntil(() => unsyncedRejected, timeoutMs);
    mark('Unsynced room join rejected', unsyncedOk);
    unsyncedProbe.stop();

    // Scenario 2: Backend room creation + sync, then bots join the same room
    if (simulateAuth) {
      hostIdentity = await provisionAndLoginBotAccount({
        backendUrl,
        simulationId,
        role: 'Host',
        password: botPassword,
      });

      guestIdentity = await provisionAndLoginBotAccount({
        backendUrl,
        simulationId,
        role: 'Guest',
        password: botPassword,
      });

      mark('Bot accounts created and logged in', true, `host=${hostIdentity.email}, guest=${guestIdentity.email}`);
    } else {
      hostIdentity = {
        role: 'Host',
        userId: `host-${simulationId}`,
        name: `Host-${simulationId}`,
        token: manualBackendToken,
      };
      guestIdentity = {
        role: 'Guest',
        userId: `guest-${simulationId}`,
        name: `Guest-${simulationId}`,
        token: manualBackendToken,
      };
      mark('Using manual backend token mode', true);
    }

    const room = await createBackendRoom({
      backendUrl,
      backendToken: hostIdentity.token,
      gameType: args['backend-game-type'] || process.env.BOT_BACKEND_GAME_TYPE || 'Classic',
      maxPlayers: toNumber(args['backend-max-players'] || process.env.BOT_BACKEND_MAX_PLAYERS, 2),
      roomName,
      isPrivate: toBoolean(args['backend-is-private'] || process.env.BOT_BACKEND_IS_PRIVATE, false),
      password: args['backend-password'] || process.env.BOT_BACKEND_PASSWORD || '',
    });

    roomId = String(room.id);
    mark('Backend room created', true, `roomId=${roomId}`);

    if (simulateAuth) {
      await joinBackendRoom({
        backendUrl,
        backendToken: guestIdentity.token,
        roomId,
        password: args['backend-password'] || process.env.BOT_BACKEND_PASSWORD || '',
      });
      mark('Guest backend join completed', true);
    }

    const hostBot = new BotPlayer({
      serverUrl: socketUrl,
      roomId,
      playerName: hostIdentity.name,
      playerId: hostIdentity.userId,
      autoStart: false,
      autoDeal: true,
      turnDelayMs: 3000,
      actionDelayMs: 3000,
    });

    const guestBot = new BotPlayer({
      serverUrl: socketUrl,
      roomId,
      playerName: guestIdentity.name,
      playerId: guestIdentity.userId,
      autoStart: false,
      autoDeal: true,
      turnDelayMs: 3000,
      actionDelayMs: 3000,
    });

    bots.push(hostBot, guestBot);

    let hostJoined = false;
    let guestJoined = false;
    let trackRecoveryTurns = false;
    let recoveryTurnCompletions = 0;
    let recoveryTurnIndexChanges = 0;
    let lastObservedTurnIndex = null;
    hostBot.on('self_joined', () => { hostJoined = true; });
    guestBot.on('self_joined', () => { guestJoined = true; });
    guestBot.on('turn_completed', () => {
      if (trackRecoveryTurns) {
        recoveryTurnCompletions += 1;
      }
    });
    guestBot.on('game_state_update', (state) => {
      const currentTurnIndex = state?.currentPlayerIndex;
      if (!trackRecoveryTurns || !Number.isInteger(currentTurnIndex)) {
        if (Number.isInteger(currentTurnIndex)) {
          lastObservedTurnIndex = currentTurnIndex;
        }
        return;
      }

      if (lastObservedTurnIndex !== null && currentTurnIndex !== lastObservedTurnIndex) {
        recoveryTurnIndexChanges += 1;
      }

      lastObservedTurnIndex = currentTurnIndex;
    });

    await hostBot.start();
    await guestBot.start();

    const joinedOk = await waitUntil(() => hostJoined && guestJoined, timeoutMs);
    mark('Two bots joined synced room', joinedOk, `hostJoined=${hostJoined}, guestJoined=${guestJoined}`);

    // Scenario 3: single start pipeline via backend only
    let hostStarted = false;
    let guestStarted = false;
    hostBot.on('game_started', () => { hostStarted = true; });
    guestBot.on('game_started', () => { guestStarted = true; });

    const startPayload = await startBackendRoom({
      backendUrl,
      backendToken: hostIdentity.token,
      roomId,
    });
    mark('Backend start endpoint triggered', true, `status=${startPayload?.room?.status || 'unknown'}`);

    const startedOk = await waitUntil(() => hostStarted && guestStarted, timeoutMs);
    mark('Both bots received game_started', startedOk);

    // Scenario 4: in-progress disconnect/reconnect recovery
    let hostSawGuestDisconnect = false;
    let hostSawGuestReconnect = false;

    hostBot.on('player_disconnected', (payload) => {
      if (String(payload?.playerId || '') === guestBot.playerId) {
        hostSawGuestDisconnect = true;
      }
    });

    hostBot.on('player_reconnected', (payload) => {
      if (String(payload?.playerId || '') === guestBot.playerId) {
        hostSawGuestReconnect = true;
      }
    });

    guestBot.simulateNetworkDrop();

    const guestDcSeen = await waitUntil(() => hostSawGuestDisconnect, timeoutMs);
    const guestRcSeen = await waitUntil(() => hostSawGuestReconnect, timeoutMs);

    mark('Guest disconnect detected in-game', guestDcSeen);
    mark('Guest reconnect detected in-game', guestRcSeen);

    // Scenario 5: host migration signal when host disconnects
    let guestSawHostChanged = false;
    guestBot.on('host_changed', () => {
      guestSawHostChanged = true;
    });

    hostBot.simulateNetworkDrop();
    const hostMigrationSeen = await waitUntil(() => guestSawHostChanged, timeoutMs);
    mark('Host migration signal observed', hostMigrationSeen);

    trackRecoveryTurns = true;
    recoveryTurnCompletions = 0;
    recoveryTurnIndexChanges = 0;
    const continuedPlaying = await waitUntil(
      () => recoveryTurnCompletions >= postRecoveryTurns || recoveryTurnIndexChanges >= postRecoveryTurns,
      postRecoveryTimeoutMs
    );
    mark(
      'Bots continue playing after disruption',
      continuedPlaying,
      `turnCompletions=${recoveryTurnCompletions}/${postRecoveryTurns}, turnIndexChanges=${recoveryTurnIndexChanges}/${postRecoveryTurns}`
    );
    trackRecoveryTurns = false;

    // Scenario 6: runtime snapshot webhook
    const runtimeSnapshot = await callSocketWebhook({
      socketUrl,
      secret: webhookSecret,
      endpoint: '/webhooks/room-runtime',
      body: { roomId },
    });

    const snapshotOk =
      runtimeSnapshot.ok &&
      runtimeSnapshot.payload?.success === true &&
      String(runtimeSnapshot.payload?.roomId || '') === roomId;

    mark('Socket runtime snapshot webhook', snapshotOk, `status=${runtimeSnapshot.status}`);

    // Scenario 7: backend reconciliation command
    if (runReconcile) {
      const reconcileResult = runReconcileCommand({ backendPath });
      const reconcileOk = reconcileResult.status === 0;
      mark('Backend reconcile command', reconcileOk, `exit=${reconcileResult.status}`);

      if (!reconcileOk) {
        console.log('[SIM] Reconcile stderr:\n' + reconcileResult.stderr);
      }
    }
  } catch (error) {
    mark('Simulation runtime error', false, error.message);
  } finally {
    for (const bot of bots) {
      try {
        bot.stop();
      } catch (_) {}
    }
  }

  const failed = results.filter((entry) => !entry.ok);

  console.log('\n[SIM] Summary');
  results.forEach((entry) => {
    console.log(`  - ${entry.ok ? 'PASS' : 'FAIL'} | ${entry.name}${entry.detail ? ` | ${entry.detail}` : ''}`);
  });

  if (failed.length > 0) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

main().catch((error) => {
  console.error(`[SIM] fatal error: ${error.message}`);
  process.exit(1);
});
