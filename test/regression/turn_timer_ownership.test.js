/* eslint-env mocha */
/**
 * Regression cover for the three turn-clock defects found in the pre-release audit.
 *
 *  1. A room that is freshly dealt has no owner lease yet — join_room / start_game /
 *     deal_cards are not ownership-wrapped — so _startTurnTimer used to bail out and
 *     the match ran its whole life with no clock, no expiry and no anti-freeze
 *     backstop. It must now acquire the lease and arm instead.
 *  2. handleDiscardCard stopped the turn timer BEFORE validating, and its failure
 *     branch re-armed a full fresh turn, so any seated socket could push the current
 *     player's deadline out indefinitely.
 *  3. handleDrawCard ran the deck-out terminal (which can end the round and promote
 *     an untaken pozzetto) before checking whose turn it was.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoomStatus } = require('../../src/constants');

describe('turn timer — ownership and out-of-turn hardening', () => {
  const createSocketMock = (id) => {
    const emitted = [];
    return {
      id,
      handshake: { headers: {} },
      join: () => {},
      leave: () => {},
      to: () => ({ emit: () => {} }),
      emit: (event, payload) => emitted.push({ event, payload }),
      get emitted() {
        return emitted;
      },
    };
  };

  const createIoMock = (sockets = []) => {
    const io = {
      roomEmits: [],
      sockets: { sockets: new Map(sockets.map((s) => [s.id, s])) },
      to: (roomId) => ({
        emit: (event, payload) => io.roomEmits.push({ roomId, event, payload }),
      }),
    };
    return io;
  };

  /** Minimal in-memory stand-in for RoomOwnerLease. */
  const createLeaseMock = () => {
    const owners = new Map();
    return {
      acquireCalls: 0,
      owners,
      async acquire(roomId) {
        this.acquireCalls += 1;
        if (owners.has(roomId)) return false;
        owners.set(roomId, 'node-under-test');
        return true;
      },
      async renew(roomId) {
        return owners.get(roomId) === 'node-under-test';
      },
      async getOwner(roomId) {
        return owners.get(roomId) || null;
      },
      async release(roomId) {
        owners.delete(roomId);
      },
    };
  };

  const setup = (ownership = {}) => {
    const s1 = createSocketMock('s1');
    const s2 = createSocketMock('s2');
    const io = createIoMock([s1, s2]);
    const service = new GameService();
    const handler = new SocketHandlers(io, service, null, null, null, ownership);
    const room = service.createRoom('ownership-room', 2);
    service.joinRoom('ownership-room', 'p1', 'P1', 's1');
    service.joinRoom('ownership-room', 'p2', 'P2', 's2');
    // A dealt, in-progress room with p1 on turn — the state right after the first
    // deal, which is exactly where the missing-timer defect bit.
    room.status = GameRoomStatus.IN_PROGRESS;
    room.dealCards();
    room.currentTurn = 0;
    room.hasDrawnCard = false;
    return { io, service, handler, room, s1, s2 };
  };

  const teardown = (service, handler, room) => {
    if (room) handler?._stopTurnTimer(room);
    handler?._releaseOwnedRooms?.().catch(() => {});
    service?.shutdown();
  };

  it('arms the first turn timer even though the freshly dealt room is not yet owned', async () => {
    const lease = createLeaseMock();
    const { service, handler, room } = setup({
      roomOwnerLease: lease,
      nodeId: 'node-under-test',
    });
    expect(handler._ownershipEnabled()).to.equal(true);
    expect(handler.ownedRoomIds.has(String(room.roomId))).to.equal(false);

    handler._startTurnTimer(room);
    // the acquire path is async; let the microtask queue drain
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(lease.acquireCalls, 'lease should have been acquired').to.be.greaterThan(0);
    expect(handler.ownedRoomIds.has(String(room.roomId))).to.equal(true);
    expect(room.turnTimerTickHandle, 'a timer must be armed').to.not.equal(null);
    expect(room.turnTimerDeadline).to.be.a('number');

    teardown(service, handler, room);
  });

  it('arms the first turn timer immediately on a single node (no lease)', () => {
    const { service, handler, room } = setup();
    expect(handler._ownershipEnabled()).to.equal(false);
    handler._startTurnTimer(room);

    expect(room.turnTimerTickHandle).to.not.equal(null);
    expect(room.turnTimerDeadline).to.be.a('number');

    teardown(service, handler, room);
  });

  it('does not extend the deadline when a discard is rejected', async () => {
    const { service, handler, room, s2 } = setup();
    handler._startTurnTimer(room);

    const deadlineBefore = room.turnTimerDeadline;
    const handleBefore = room.turnTimerTickHandle;
    expect(deadlineBefore).to.be.a('number');

    // p2 is NOT on turn and sends a card it does not hold.
    await handler.handleDiscardCard(s2, { card: { suit: 'hearts', rank: 'A' } });

    expect(room.turnTimerDeadline, 'deadline must not move').to.equal(deadlineBefore);
    expect(room.turnTimerTickHandle, 'the live timer must survive untouched').to.equal(
      handleBefore
    );

    teardown(service, handler, room);
  });

  it('rejects an out-of-turn draw before the deck-out terminal can run', async () => {
    const { service, handler, room, s2 } = setup();
    let deckOutCalls = 0;
    const originalDeckOut = ActionHandlers._deckOutTerminal;
    ActionHandlers._deckOutTerminal = function patched(...args) {
      deckOutCalls += 1;
      return originalDeckOut.apply(this, args);
    };

    try {
      await handler.handleDrawCard(s2, { fromDeck: true });
      expect(deckOutCalls, '_deckOutTerminal must not run for an out-of-turn draw').to.equal(0);
      const errors = s2.emitted.filter((e) => e.event === 'error');
      expect(errors.length, 'the out-of-turn draw must be rejected').to.be.greaterThan(0);
    } finally {
      ActionHandlers._deckOutTerminal = originalDeckOut;
    }

    teardown(service, handler, room);
  });
});
