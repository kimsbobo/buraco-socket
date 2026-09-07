/**
 * THE TURN CLOCK DIES WITH THE GAME — server half.
 *
 * REPORTED LIVE: "the timer keeps running after the game has ended / after the
 * other player leaves". The leak is in the Flutter client (its 1 Hz display
 * countdown is only cancelled when it reaches zero), but the client's fix rests
 * on a server contract that nothing pinned:
 *
 *   1. every terminal transition — a round/match end, a forfeit-by-leave —
 *      clears the armed expiry AND the deadline;
 *   2. a FINISHED room reports ZERO seconds left, so no state frame the client
 *      receives afterwards can re-anchor a phantom countdown;
 *   3. a callback that was already in flight is INERT once the room is finished.
 *
 * All three already hold. They are pinned here so a future edit to the end-of-
 * round path cannot quietly hand the client a clock it has no way to stop: the
 * server sends NO turn-timer event on a normal round end, so `game_ended` is the
 * only stop signal a client ever gets.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { GameRoomStatus } = require('../../src/constants');

function fakeIo(emitted, registry) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ roomId, event, payload }),
    }),
    sockets: { sockets: registry },
  };
}

function fakeSocket(id, emitted) {
  return {
    id,
    leave: () => {},
    join: () => {},
    emit: (event, payload) => emitted.push({ id, event, payload }),
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
  };
}

/** A dealt 2-seat room with the turn clock actually ARMED. */
function tickingRoom(service, roomId) {
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'host', 'Host', 'sHost');
  service.joinRoom(roomId, 'opp', 'Opp', 'sOpp');
  room.startGame();
  room.dealCards();
  room.turnTimeLimit = 30;

  const emitted = [];
  const registry = new Map();
  registry.set('sHost', fakeSocket('sHost', emitted));
  registry.set('sOpp', fakeSocket('sOpp', emitted));
  const handlers = new SocketHandlers(fakeIo(emitted, registry), service);

  handlers._startTurnTimer(room);
  expect(room.turnTimerTickHandle, 'the clock is armed to begin with').to.not.equal(null);
  expect(room.turnTimerDeadline, 'and anchored to a deadline').to.be.a('number');

  return { room, handlers, emitted, registry };
}

describe('#the turn clock dies with the game', () => {
  const services = [];

  afterEach(() => {
    while (services.length > 0) services.pop().shutdown();
  });

  it('a forfeit-by-leave stops the clock', () => {
    const service = new GameService();
    services.push(service);
    const { room, handlers, emitted } = tickingRoom(service, 'tt-leave');

    handlers.handleLeaveRoom(fakeSocket('sOpp', emitted));

    expect(room.status).to.equal(GameRoomStatus.FINISHED);
    expect(room.turnTimerTickHandle, 'no expiry left armed').to.equal(null);
    expect(room.turnTimerDeadline, 'and no deadline left behind').to.equal(null);
    expect(emitted.some((e) => e.event === 'game_ended'), 'the client is told').to.equal(true);
  });

  it('a round end stops the clock before GAME_ENDED goes out', () => {
    const service = new GameService();
    services.push(service);
    const { room, handlers, emitted } = tickingRoom(service, 'tt-round');
    emitted.length = 0; // drop the TURN_TIMER_STARTED the arming above emitted

    handlers._broadcastRoundEndAndCleanup(room, {
      winnerIndex: 0,
      winnerId: 'host',
      playerScores: {},
      teamScores: {},
    });

    expect(room.turnTimerTickHandle).to.equal(null);
    expect(room.turnTimerDeadline).to.equal(null);
    const ended = emitted.find((e) => e.event === 'game_ended');
    expect(ended, 'game_ended emitted').to.exist;
    // The stop is SILENT: no turn-timer event rides along, which is exactly why
    // the client must treat game_ended itself as the stop signal.
    expect(
      emitted.some((e) => String(e.event).startsWith('turn_timer')),
      'no turn-timer event accompanies a normal round end'
    ).to.equal(false);
  });

  it('a finished room reports ZERO seconds left, never a stale snapshot', () => {
    const service = new GameService();
    services.push(service);
    const { room, handlers } = tickingRoom(service, 'tt-zero');
    // A stale snapshot from the last live tick, of the kind a state frame used
    // to ship. With no deadline armed it must not be believed.
    room.turnTimeRemaining = 27;

    handlers._stopTurnTimer(room);

    expect(room.getTurnTimeRemaining(), 'nothing for a client to anchor to').to.equal(0);
  });

  it('an expiry callback that was already in flight is inert once the room is FINISHED', () => {
    const service = new GameService();
    services.push(service);
    const { room, handlers, emitted } = tickingRoom(service, 'tt-stray');
    handlers._stopTurnTimer(room);
    room.status = GameRoomStatus.FINISHED;
    emitted.length = 0;

    handlers._onTurnTimerExpired(room);

    expect(
      emitted.some((e) => e.event === 'turn_timer_expired'),
      'a stray expiry neither fires nor auto-plays a card'
    ).to.equal(false);
  });
});
