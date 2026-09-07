/**
 * Cross-node owner-kill failover + room rehydration (PTW-90, Phase 3).
 *
 * This is the deterministic proof for the "owner-node kill mid-turn" chaos
 * scenario that the network soak (`bot/load-soak.js`) cannot exercise without
 * real multi-node orchestration (killing a node process). Two SocketHandlers
 * instances ("node A" / "node B") share ONE InMemoryRedis — the same pattern as
 * room_owner_lease.test.js — so the lease registry and persisted game state are
 * visible across both nodes, exactly as a real shared Redis would make them.
 *
 * Scenario:
 *   1. Node A owns an in-progress room (dealt cards) and persists its state.
 *   2. Node A "crashes": it stops renewing and its lease expires (Redis del).
 *   3. A player lands on node B. Node B has NO copy of the room in memory.
 *   4. Node B rehydrates the room from Redis, wins the freed lease (controlled
 *      owner re-election), and restarts the room runtime — instead of the old
 *      `join_rejected_room_not_synced` freeze.
 *
 * Also asserts the split-brain guard: while node A is ALIVE and still holds the
 * lease, node B rehydrating keeps a passive read-copy and must NOT take the
 * lease or start a turn timer.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const InMemoryRedis = require('../src/utils/InMemoryRedis');
const RoomOwnerLease = require('../src/managers/RoomOwnerLease');
const FailureManager = require('../src/managers/FailureManager');
const GameService = require('../src/services/GameService');
const SocketHandlers = require('../src/handlers/SocketHandlers');
const { SocketEvents } = require('../src/constants');

const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {},
};

function makeIoMock() {
  return {
    roomEmits: [],
    sockets: { sockets: new Map() },
    on() {},
    to() {
      return {
        emit() {},
        except() {
          return { emit() {} };
        },
      };
    },
  };
}

function makeSocketMock(id) {
  const emitted = [];
  const joinedRooms = [];
  return {
    id,
    handshake: { headers: {} },
    join: (roomId) => joinedRooms.push(roomId),
    to: () => ({ emit() {} }),
    emit: (event, payload) => emitted.push({ event, payload }),
    get emitted() {
      return emitted;
    },
    get joinedRooms() {
      return joinedRooms;
    },
  };
}

// Stand up one "node": GameService + FailureManager + lease-backed SocketHandlers
// all sharing the injected Redis.
function makeNode(redis, nodeId) {
  const io = makeIoMock();
  const gameService = new GameService();
  const failureManager = new FailureManager(io, redis, gameService, silentLogger);
  const lease = new RoomOwnerLease(redis, nodeId, { ttlMs: 15000, logger: silentLogger });
  const handler = new SocketHandlers(io, gameService, null, failureManager, null, {
    roomOwnerLease: lease,
    nodeId,
    renewMs: 5000,
  });
  return { io, gameService, failureManager, lease, handler, nodeId };
}

describe('Owner-kill failover + cross-node rehydration (PTW-90 Phase 3)', function () {
  this.timeout(5000);

  let redis;
  let nodeA;
  let nodeB;
  const roomId = 'ptw90-room-1';

  beforeEach(async () => {
    redis = new InMemoryRedis();
    nodeA = makeNode(redis, 'node-A');
    nodeB = makeNode(redis, 'node-B');

    // Node A builds and owns an in-progress, dealt room.
    const room = nodeA.gameService.createRoom(roomId, 2);
    nodeA.gameService.joinRoom(roomId, 'p1', 'P1', 's1');
    nodeA.gameService.joinRoom(roomId, 'p2', 'P2', 's2');
    room.startGame(true);
    room.dealCards();

    const ownership = await nodeA.handler._ensureRoomOwner(roomId, { acquire: true });
    expect(ownership.owned).to.equal(true);
    expect(await nodeA.lease.isOwner(roomId)).to.equal(true);

    // Persist the runtime to the shared Redis (what every game action does).
    await nodeA.failureManager.persistGameState(room);
  });

  afterEach(async () => {
    [nodeA, nodeB].forEach((node) => {
      try {
        node.handler._releaseOwnedRooms();
      } catch (_) {}
      const room = node.gameService.getRoom(roomId);
      if (room) node.handler._stopTurnTimer(room);
      node.failureManager.dispose();
      node.gameService.shutdown();
    });
    await redis.quit();
  });

  it('node B serves a room it never synced after the owner node is killed (rehydrate + re-elect)', async () => {
    // Sanity: node B has no local copy before failover.
    expect(nodeB.gameService.getRoom(roomId)).to.equal(undefined);

    // Node A "crashes": it stops renewing and the lease expires. We delete the
    // owner key to deterministically represent TTL expiry of a dead owner.
    nodeA.handler._stopOwningRoom(roomId, 'simulated_crash');
    await redis.del(nodeA.lease.key(roomId));
    expect(await nodeB.lease.getOwner(roomId)).to.equal(null);

    // Node B rehydrates for an incoming join.
    const room = await nodeB.handler._rehydrateRoomForJoin(roomId);

    expect(room, 'room rehydrated from persisted state').to.not.equal(null);
    expect(nodeB.gameService.getRoom(roomId), 'room now lives in node B memory').to.equal(room);
    expect(room.isInProgress()).to.equal(true);
    expect(room.cardsDealt).to.equal(true);
    expect(room.getPlayers().map((p) => p.playerId).sort()).to.deep.equal(['p1', 'p2']);

    // Controlled owner re-election: node B won the freed lease and restarted runtime.
    expect(await nodeB.lease.isOwner(roomId)).to.equal(true);
    expect(nodeB.handler.ownedRoomIds.has(roomId)).to.equal(true);
    expect(room.turnTimerTickHandle, 'turn timer restarted on new owner').to.not.equal(
      null
    );
    expect(room.turnTimerTickHandle).to.not.equal(undefined);
  });

  it('handleJoinRoom rehydrates instead of rejecting after owner death', async () => {
    nodeA.handler._stopOwningRoom(roomId, 'simulated_crash');
    await redis.del(nodeA.lease.key(roomId));

    const socket = makeSocketMock('s1-reconnect');
    await nodeB.handler.handleJoinRoom(socket, {
      playerId: 'p1',
      playerName: 'P1',
      roomId,
    });

    const rejected = socket.emitted.find(
      (e) =>
        e.event === SocketEvents.ERROR &&
        String(e.payload?.error || '').includes('Room is not ready on realtime server')
    );
    expect(rejected, 'join must not be rejected as not-synced').to.equal(undefined);
    expect(nodeB.gameService.getRoom(roomId), 'node B served the room').to.not.equal(undefined);
    expect(await nodeB.lease.isOwner(roomId)).to.equal(true);
  });

  it('split-brain guard: node B does NOT steal a live owner\'s lease on rehydrate', async () => {
    // Node A is still ALIVE and owns the lease (no crash, no del).
    expect(await nodeA.lease.isOwner(roomId)).to.equal(true);

    const room = await nodeB.handler._rehydrateRoomForJoin(roomId);

    // Node B keeps a passive read-copy: it serves the join, but ownership and
    // the authoritative turn timer stay with the live owner (node A).
    expect(room, 'read-copy rehydrated').to.not.equal(null);
    expect(await nodeA.lease.isOwner(roomId)).to.equal(true);
    expect(await nodeB.lease.isOwner(roomId)).to.equal(false);
    expect(nodeB.handler.ownedRoomIds.has(roomId)).to.equal(false);
    const bRoom = nodeB.gameService.getRoom(roomId);
    expect(bRoom?.turnTimerTickHandle == null, 'no timer on non-owner read-copy').to.equal(true);
  });
});
