/**
 * Multi-node Redis adapter fan-out (PTW-40, Phase 1 acceptance).
 *
 * The single load-bearing claim of multi-node Socket.IO is: a `io.to(room).emit`
 * issued on node A reaches a client connected to node B. That only works when
 * BOTH nodes share the `@socket.io/redis-adapter` against the same Redis. This
 * test stands up two independent Socket.IO servers (two ports = two "nodes"),
 * wires each to the adapter against the local Redis, and asserts cross-node
 * delivery for the exact event shapes the game uses (player_joined / game_state
 * style room broadcasts).
 *
 * Skips automatically when no Redis is reachable so CI without Redis stays green;
 * the gate run (PTW-58) provides Redis and must NOT skip.
 *
 * Run: REDIS_HOST=127.0.0.1 npx mocha test/multinode_adapter.test.js
 */

const assert = require('assert');
const http = require('http');
const { Server } = require('socket.io');
const { io: ClientIO } = require('socket.io-client');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);

function makeRedis() {
  return new Redis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 2, lazyConnect: true });
}

async function redisReachable() {
  const probe = makeRedis();
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch (_) {
    return false;
  } finally {
    try { probe.disconnect(); } catch (_) {}
  }
}

// Bring up one "node": http server + Socket.IO + Redis adapter on its own pub/sub pair.
async function startNode(port) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: '*' } });
  const pub = makeRedis();
  const sub = makeRedis();
  await pub.connect();
  await sub.connect();
  io.adapter(createAdapter(pub, sub));

  // Minimal join handler mirroring the real server: socket.join(room).
  io.on('connection', (socket) => {
    socket.on('join', (room) => {
      socket.join(room);
      socket.emit('joined', room);
    });
  });

  await new Promise((resolve) => httpServer.listen(port, resolve));
  return {
    io,
    port,
    async close() {
      await io.close();
      await new Promise((r) => httpServer.close(() => r()));
      try { pub.disconnect(); } catch (_) {}
      try { sub.disconnect(); } catch (_) {}
    },
  };
}

function connectClient(port) {
  return ClientIO(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
}

function once(emitter, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    emitter.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('Multi-node Redis adapter fan-out (PTW-40 Phase 1)', function () {
  this.timeout(15000);

  let available = false;
  let nodeA;
  let nodeB;
  const clients = [];

  before(async () => {
    available = await redisReachable();
    if (!available) return;
    nodeA = await startNode(8181);
    nodeB = await startNode(8182);
  });

  after(async () => {
    clients.forEach((c) => { try { c.close(); } catch (_) {} });
    if (nodeA) await nodeA.close();
    if (nodeB) await nodeB.close();
  });

  function track(client) {
    clients.push(client);
    return client;
  }

  it('delivers a room broadcast emitted on node A to a client on node B', async function () {
    if (!available) return this.skip();

    const room = 'room-xnode-1';
    const clientA = track(connectClient(nodeA.port));
    const clientB = track(connectClient(nodeB.port));

    await Promise.all([once(clientA, 'connect'), once(clientB, 'connect')]);
    clientA.emit('join', room);
    clientB.emit('join', room);
    await Promise.all([once(clientA, 'joined'), once(clientB, 'joined')]);

    // Emit from node A's server; clientB is connected to node B.
    const received = once(clientB, 'player_joined');
    nodeA.io.to(room).emit('player_joined', { seat: 2, name: 'Bot-B' });

    const payload = await received;
    assert.strictEqual(payload.name, 'Bot-B', 'cross-node payload should arrive intact');
  });

  it('is bidirectional: broadcast from node B reaches a client on node A', async function () {
    if (!available) return this.skip();

    const room = 'room-xnode-2';
    const clientA = track(connectClient(nodeA.port));
    const clientB = track(connectClient(nodeB.port));

    await Promise.all([once(clientA, 'connect'), once(clientB, 'connect')]);
    clientA.emit('join', room);
    clientB.emit('join', room);
    await Promise.all([once(clientA, 'joined'), once(clientB, 'joined')]);

    const received = once(clientA, 'game_state_update');
    nodeB.io.to(room).emit('game_state_update', { turn: 3 });

    const payload = await received;
    assert.strictEqual(payload.turn, 3, 'cross-node state update should arrive intact');
  });

  it('does not leak a broadcast to a client in a different room on the other node', async function () {
    if (!available) return this.skip();

    const clientA = track(connectClient(nodeA.port)); // in room-iso-A
    const clientB = track(connectClient(nodeB.port)); // in room-iso-B (different room)

    await Promise.all([once(clientA, 'connect'), once(clientB, 'connect')]);
    clientA.emit('join', 'room-iso-A');
    clientB.emit('join', 'room-iso-B');
    await Promise.all([once(clientA, 'joined'), once(clientB, 'joined')]);

    let leaked = false;
    clientB.once('should_not_arrive', () => { leaked = true; });
    nodeA.io.to('room-iso-A').emit('should_not_arrive', { x: 1 });

    // Give the adapter ample time to (incorrectly) deliver before asserting absence.
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(leaked, false, 'broadcast must stay scoped to its room across nodes');
  });
});
