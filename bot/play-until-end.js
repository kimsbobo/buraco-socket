require('dotenv').config({ path: __dirname + '/.env' });

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

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function ensureApiBase(url) {
  const base = String(url || '').replace(/\/+$/, '');
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

async function provisionAndLoginBotAccount({ backendUrl, matchId, role, password }) {
  const normalizedRole = String(role).toLowerCase();
  const email = `bot.${normalizedRole}.${matchId}@brazilia.local`;
  const name = `Match ${role}`;

  try {
    await registerBackendAccount({
      backendUrl,
      name,
      email,
      password,
    });
  } catch (error) {
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

async function createBackendRoom({ backendUrl, backendToken, gameType, maxPlayers, roomName }) {
  const apiBase = ensureApiBase(backendUrl);

  const response = await fetch(`${apiBase}/rooms`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${backendToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      name: roomName,
      game_type: gameType,
      max_players: maxPlayers,
      is_private: false,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Create room failed (${response.status}): ${payload.message || payload.error || 'unknown error'}`);
  }

  if (!payload?.id) {
    throw new Error('Create room response missing id');
  }

  return payload;
}

async function joinBackendRoom({ backendUrl, backendToken, roomId }) {
  const apiBase = ensureApiBase(backendUrl);

  const response = await fetch(`${apiBase}/rooms/${roomId}/join`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${backendToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({}),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Join room failed (${response.status}): ${payload.message || payload.error || 'unknown error'}`);
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

async function waitUntil(predicate, timeoutMs, pollMs = 200) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(`Usage: npm run bot:play -- \\
  [--socket-url https://ws-buraco.wblue.id] \\
  [--backend-url https://api-buraco.wblue.id] \\
  [--bot-password botpass123] \\
  [--game-type Classic] \\
  [--max-players 4] \\
  [--turn-delay 3000] \\
  [--action-delay 3000] \\
  [--wait-timeout 1800000]`);
    return;
  }

  const socketUrl = args['socket-url'] || process.env.BOT_SERVER_URL || 'https://ws-buraco.wblue.id';
  const backendUrl = args['backend-url'] || process.env.BOT_BACKEND_URL;
  const botPassword = args['bot-password'] || process.env.BOT_SIM_BOT_PASSWORD || 'botpass123';
  const gameType = args['game-type'] || process.env.BOT_BACKEND_GAME_TYPE || 'Classic';
  const maxPlayers = args['max-players'] !== undefined
    ? toNumber(args['max-players'], 4)
    : 4;
  const waitTimeoutMs = toNumber(args['wait-timeout'], 30 * 60 * 1000);
  const turnDelayMs = toNumber(args['turn-delay'], 3000);
  const actionDelayMs = toNumber(args['action-delay'], 3000);

  if (!backendUrl) {
    throw new Error('backend-url is required');
  }

  const matchId = `live-${Date.now()}`;
  const roomName = args['room-name'] || `Live Bot Match ${matchId}`;

  console.log(`\n[MATCH] Starting bot match ${matchId}`);

  const bots = [];
  let hostBot = null;
  let guestBot = null;

  try {
    const hostIdentity = await provisionAndLoginBotAccount({
      backendUrl,
      matchId,
      role: 'Host',
      password: botPassword,
    });

    const guestIdentity = await provisionAndLoginBotAccount({
      backendUrl,
      matchId,
      role: 'Guest',
      password: botPassword,
    });

    console.log(`[MATCH] Accounts ready: ${hostIdentity.email}, ${guestIdentity.email}`);

    const room = await createBackendRoom({
      backendUrl,
      backendToken: hostIdentity.token,
      gameType,
      maxPlayers,
      roomName,
    });

    const roomId = String(room.id);

    await joinBackendRoom({
      backendUrl,
      backendToken: guestIdentity.token,
      roomId,
    });

    console.log(`[MATCH] Room created: ${roomName}`);
    console.log(`[MATCH] Room ID: ${roomId}`);
    console.log(`[MATCH] Room slots: 2/${maxPlayers} occupied by bots`);
    console.log(`[MATCH] Spectator hint: open mobile app and spectate room ${roomId}`);

    hostBot = new BotPlayer({
      serverUrl: socketUrl,
      roomId,
      playerName: hostIdentity.name,
      playerId: hostIdentity.userId,
      autoStart: false,
      autoDeal: true,
      turnDelayMs,
      actionDelayMs,
    });

    guestBot = new BotPlayer({
      serverUrl: socketUrl,
      roomId,
      playerName: guestIdentity.name,
      playerId: guestIdentity.userId,
      autoStart: false,
      autoDeal: true,
      turnDelayMs,
      actionDelayMs,
    });

    bots.push(hostBot, guestBot);

    let hostJoined = false;
    let guestJoined = false;
    let hostStarted = false;
    let guestStarted = false;

    let lastProgressLogAt = 0;
    const progressLogger = (state) => {
      const now = Date.now();
      if (now - lastProgressLogAt < 1500) return;
      lastProgressLogAt = now;

      const currentTurn = state?.currentPlayerIndex;
      const deck = state?.deckCount;
      const discard = Array.isArray(state?.discardPile) ? state.discardPile.length : 0;
      const round = state?.roundNumber;
      const cardsDealt = Boolean(state?.cardsDealt);
      const pozzettoPiles = Array.isArray(state?.deadPileCounts)
        ? state.deadPileCounts.filter((count) => Number(count) > 0).length
        : (Number(state?.pozzettosCardCount || 0) >= 22
            ? 2
            : (Number(state?.pozzettosCardCount || 0) >= 11 ? 1 : 0));

      console.log(`[MATCH] Progress | room=${roomId} round=${round ?? 'n/a'} cardsDealt=${cardsDealt} turn=${currentTurn ?? 'n/a'} deck=${deck ?? 'n/a'} discard=${discard} pozzetto=${pozzettoPiles}`);
    };

    hostBot.on('self_joined', () => {
      hostJoined = true;
    });
    guestBot.on('self_joined', () => {
      guestJoined = true;
    });
    hostBot.on('game_started', () => {
      hostStarted = true;
    });
    guestBot.on('game_started', () => {
      guestStarted = true;
    });

    hostBot.on('game_state_update', progressLogger);
    guestBot.on('game_state_update', progressLogger);

    await hostBot.start();
    await guestBot.start();

    const joinedOk = await waitUntil(() => hostJoined && guestJoined, 15000);
    if (!joinedOk) {
      throw new Error('Bots failed to join room on socket in time');
    }

    const startPayload = await startBackendRoom({
      backendUrl,
      backendToken: hostIdentity.token,
      roomId,
    });
    console.log(`[MATCH] Backend start triggered: ${startPayload?.room?.status || 'unknown'}`);

    const startedOk = await waitUntil(() => hostStarted && guestStarted, 15000);
    if (!startedOk) {
      throw new Error('Bots did not receive game_started in time');
    }

    console.log('[MATCH] Game started. Bots will play until game end...');

    const gameEnded = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ ok: false, reason: `Timeout waiting for game end (${waitTimeoutMs}ms)` });
      }, waitTimeoutMs);

      const done = (payload, source) => {
        clearTimeout(timeout);
        resolve({ ok: true, payload, source });
      };

      hostBot.on('game_ended', (payload) => done(payload, 'host'));
      guestBot.on('game_ended', (payload) => done(payload, 'guest'));
    });

    if (!gameEnded.ok) {
      throw new Error(gameEnded.reason);
    }

    console.log(`[MATCH] Game ended (${gameEnded.source} event). Room ${roomId}`);
    process.exitCode = 0;
  } catch (error) {
    console.error(`[MATCH] failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    for (const bot of bots) {
      try {
        bot.stop();
      } catch (_) {}
    }
  }
}

main().catch((error) => {
  console.error(`[MATCH] fatal: ${error.message}`);
  process.exit(1);
});
