/* eslint-env mocha */

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const FailureManager = require('../../src/managers/FailureManager');
const RoomOwnerLease = require('../../src/managers/RoomOwnerLease');
const InMemoryRedis = require('../../src/utils/InMemoryRedis');
const { SocketEvents } = require('../../src/constants');

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function createIo(nodeId) {
  const listeners = new Map();
  const io = {
    nodeId,
    peers: [],
    roomEmits: [],
    sockets: { sockets: new Map() },
    on(event, handler) {
      listeners.set(event, handler);
    },
    to(roomId) {
      const target = {
        emit: (event, payload) => io.roomEmits.push({ roomId, event, payload }),
        except: () => target,
      };
      return target;
    },
    async serverSideEmitWithAck(event, payload) {
      return Promise.all(
        io.peers.map(
          (peer) =>
            new Promise((resolve) => {
              const handler = peer._listeners.get(event);
              if (!handler) {
                resolve({ success: false, ignored: true });
                return;
              }
              handler(payload, resolve);
            })
        )
      );
    },
    _listeners: listeners,
  };
  return io;
}

function createSocket(id) {
  const emitted = [];
  return {
    id,
    handshake: { headers: {} },
    data: {},
    emit: (event, payload) => emitted.push({ event, payload }),
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
    emitted,
  };
}

function createNode(nodeId, redis, ttlMs = 200, renewMs = 50) {
  const io = createIo(nodeId);
  const service = new GameService();
  const failureManager = new FailureManager(io, redis, service, noopLogger);
  const lease = new RoomOwnerLease(redis, nodeId, { ttlMs, logger: noopLogger });
  const handlers = new SocketHandlers(io, service, null, failureManager, null, {
    roomOwnerLease: lease,
    nodeId,
    renewMs,
  });
  return { io, service, failureManager, handlers, lease };
}

function seedPlayableRoom(service, roomId = 'owned-room') {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'p1', 'P1', 's1');
  service.joinRoom(roomId, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.playerHands.set('p1', [
    { suit: 'hearts', rank: '5', cardId: 'h5' },
    { suit: 'clubs', rank: '8', cardId: 'c8' },
  ]);
  return room;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('room-owner runtime guard', () => {
  it('forwards retried mutating actions to the single owner without duplicate turn advance', async () => {
    const redis = new InMemoryRedis();
    const nodeA = createNode('node-A', redis);
    const nodeB = createNode('node-B', redis);
    nodeA.io.peers = [nodeB.io];
    nodeB.io.peers = [nodeA.io];

    const ownerRoom = seedPlayableRoom(nodeA.service, 'forward-room');
    const nonOwnerRoom = seedPlayableRoom(nodeB.service, 'forward-room');
    const socket = createSocket('s1');

    try {
      await nodeA.handlers._ensureRoomOwner(ownerRoom.roomId);

      await Promise.all([
        nodeB.handlers._runOwnedSocketMutation(socket, {
          card: { suit: 'hearts', rank: '5', cardId: 'h5' },
        }, 'handleDiscardCard'),
        nodeB.handlers._runOwnedSocketMutation(socket, {
          card: { suit: 'hearts', rank: '5', cardId: 'h5' },
        }, 'handleDiscardCard'),
      ]);

      expect(ownerRoom.currentTurn).to.equal(1);
      expect(nonOwnerRoom.currentTurn).to.equal(0);
      const turnEvents = nodeA.io.roomEmits.filter(
        (event) => event.roomId === 'forward-room' && event.event === SocketEvents.TURN_COMPLETED
      );
      expect(turnEvents).to.have.length(1);
    } finally {
      await nodeA.handlers._releaseOwnedRooms();
      await nodeB.handlers._releaseOwnedRooms();
      nodeA.service.shutdown();
      nodeB.service.shutdown();
      await redis.quit();
    }
  });

  it('rehydrates a room and resumes the turn timer after owner lease expiry', async () => {
    const redis = new InMemoryRedis();
    const nodeA = createNode('node-A', redis, 80, 25);
    const nodeB = createNode('node-B', redis, 80, 25);

    const ownerRoom = seedPlayableRoom(nodeA.service, 'handoff-room');
    ownerRoom.awaitingDealAnimation = false;

    try {
      await nodeA.handlers._ensureRoomOwner(ownerRoom.roomId);
      await nodeA.failureManager.persistGameState(ownerRoom);

      nodeA.handlers._stopOwningRoom(ownerRoom.roomId, 'simulated_owner_death');
      nodeA.service.deleteRoom(ownerRoom.roomId);
      await wait(120);

      const ownership = await nodeB.handlers._ensureRoomOwner(ownerRoom.roomId);
      const recovered = nodeB.service.getRoom(ownerRoom.roomId);

      expect(ownership.owned).to.equal(true);
      expect(recovered).to.not.equal(undefined);
      expect(recovered.currentTurn).to.equal(0);
      expect(recovered.turnTimerTickHandle).to.not.equal(null);
    } finally {
      await nodeA.handlers._releaseOwnedRooms();
      await nodeB.handlers._releaseOwnedRooms();
      nodeA.service.shutdown();
      nodeB.service.shutdown();
      await redis.quit();
    }
  });
});
