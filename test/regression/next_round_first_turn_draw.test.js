/**
 * "kenapa winner previous round selalu yang pertama jalan di next round" —
 * reported 2026-08-26 against a 2000-point match.
 *
 * Two separate questions hide in that sentence, and only one of them was a bug.
 *
 *   1. DOES round N+1 re-run the undian?  It always did: `_dealCardsForRoom`
 *      calls `runFirstTurnDraw()` on every deal, not just the opening one, and
 *      production logs show round-2 starters that differ from the round-1 winner.
 *      Pinned here anyway — it is the invariant the report is really about, and
 *      nothing else asserted it for a re-deal.
 *
 *   2. WHAT DOES THE CLIENT SEE UNTIL THE DRAW LANDS?  This is the defect.
 *      `startGame()` resets `currentTurn` to **0** and the real starter is only
 *      picked by the draw that runs with the deal a moment later — but the
 *      GAME_STARTED that announces the re-deal went out FIRST, carrying that 0
 *      as `currentPlayerIndex`. Clients apply it, so seat 0 was marked "to move"
 *      through the whole intermission and deal of every round. At a table whose
 *      host keeps winning, "seat 0 is up again" is indistinguishable from "the
 *      winner of the previous round always starts".
 *
 *      An undealt room now announces -1 ("not decided yet"), which the client's
 *      `applyServerTurnIndex` guard drops — including on already-shipped builds.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { GameRoomStatus } = require('../../src/constants');

function fakeSocket(id, emitted) {
  return {
    id,
    join: () => {},
    leave: () => {},
    emit: (event, payload) => emitted.push({ scope: 'socket', id, event, payload }),
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'socket-to', id, roomId, event, payload }),
    }),
  };
}

function fakeIo(emitted, registry) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ scope: 'room', roomId, event, payload }),
    }),
    sockets: { sockets: registry },
  };
}

const HOST = '10';
const OPP = '20';

describe('multi-round — the first-turn draw is per ROUND, and an undealt room admits it', () => {
  const services = [];
  let emitted;
  let registry;
  let io;
  let origFetch;

  beforeEach(() => {
    origFetch = global.fetch;
    global.fetch = () => Promise.resolve({ ok: true });
    emitted = [];
    registry = new Map();
    registry.set('sHost', fakeSocket('sHost', emitted));
    registry.set('sOpp', fakeSocket('sOpp', emitted));
    io = fakeIo(emitted, registry);
  });

  afterEach(() => {
    global.fetch = origFetch;
    while (services.length > 0) services.pop().shutdown();
  });

  function newService() {
    const service = new GameService();
    services.push(service);
    return service;
  }

  /** A dealt, IN_PROGRESS 2-seat room whose opening draw has already been run. */
  function liveRoom(service, roomId) {
    const room = service.createRoom(roomId, 2);
    service.joinRoom(roomId, HOST, 'Host', 'sHost');
    service.joinRoom(roomId, OPP, 'Opp', 'sOpp');
    room.targetScore = 2000;
    room.startGame(true);
    room.dealCards();
    room.runFirstTurnDraw();
    // What _dealCardsForRoom sets around the real deal: the opening window is
    // open until a client reports its deal animation finished.
    room.awaitingDealAnimation = true;
    return room;
  }

  /** Park the room in the state the scheduler's timer fires against. */
  function intermission(room) {
    room.status = GameRoomStatus.FINISHED;
    room.gameEndedAt = new Date();
    room.awaitingNextRound = true;
    room.lastRoundEndPayload = { type: 'round_ended', matchEnded: false };
  }

  it('deals round 2 with a FRESH draw, and ships it so the client can animate it', async () => {
    const service = newService();
    const handlers = new SocketHandlers(io, service);
    const room = liveRoom(service, 'ftd1');

    // Round 1's reveal is consumed once a client reports the deal animation done.
    handlers._startFirstTurnTimerAfterDeal(room, 'test');
    expect(room.firstTurnDraw).to.equal(null);

    emitted.length = 0;
    intermission(room);
    await handlers._startScheduledNextRound('ftd1');

    // A whole new ceremony was run for the new deal...
    expect(room.cardsDealt).to.equal(true);
    expect(room.firstTurnDraw).to.not.equal(null);
    expect(room.firstTurnDraw.rounds.length).to.be.at.least(1);
    expect(room.currentTurn).to.equal(room.firstTurnDraw.winnerIndex);
    // ...the ceremony cards went back, so the round is dealt from a full deck...
    expect(room.deck.count).to.equal(63);

    // ...and every seat received it, so the reveal can play for round 2 exactly
    // like it does for round 1.
    const states = emitted.filter((e) => e.event === 'game_state_update');
    expect(states.length).to.equal(2);
    for (const s of states) {
      expect(s.payload.cardsDealt).to.equal(true);
      expect(s.payload.awaitingDealAnimation).to.equal(true);
      expect(s.payload.firstTurnDraw).to.not.equal(null);
      expect(s.payload.firstTurnDraw.winnerIndex).to.equal(room.currentTurn);
      expect(s.payload.currentPlayerIndex).to.equal(room.currentTurn);
    }
  });

  it('the round-2 GAME_STARTED does not claim seat 0 is to move', async () => {
    const service = newService();
    const handlers = new SocketHandlers(io, service);
    const room = liveRoom(service, 'ftd2');
    handlers._startFirstTurnTimerAfterDeal(room, 'test');

    emitted.length = 0;
    intermission(room);
    await handlers._startScheduledNextRound('ftd2');

    const started = emitted.filter((e) => e.event === 'game_started');
    expect(started.length).to.equal(2);
    for (const s of started) {
      // The cue the client re-arms its deal latch on...
      expect(s.payload.cardsDealt).to.equal(false);
      // ...must not come with a turn. -1 is below the client's index guard, so
      // it keeps whatever it had until the dealt state update lands.
      expect(s.payload.currentPlayerIndex).to.equal(-1);
    }
  });

  it('a DEALT room still announces its real turn (reconnect / resume)', () => {
    const service = newService();
    const handlers = new SocketHandlers(io, service);
    const room = liveRoom(service, 'ftd3');
    // Push the turn off seat 0 so a stale 0 could not pass for the right answer.
    room.currentTurn = 1;
    expect(handlers._announcedTurnIndex(room)).to.equal(1);

    room.cardsDealt = false;
    expect(handlers._announcedTurnIndex(room)).to.equal(-1);
  });

  it('the round-2 starter is not pinned to one seat', async () => {
    const seen = new Set();
    for (let i = 0; i < 40 && seen.size < 2; i++) {
      const service = newService();
      const handlers = new SocketHandlers(io, service);
      const roomId = `ftd-spread-${i}`;
      const room = liveRoom(service, roomId);
      handlers._startFirstTurnTimerAfterDeal(room, 'test');
      intermission(room);
      await handlers._startScheduledNextRound(roomId);
      seen.add(room.currentTurn);
    }
    // 40 re-deals landing on the same seat is 2^-40 if the draw is honest, and
    // certain if the starter is ever wired back to a fixed seat or to the
    // previous round's winner.
    expect(Array.from(seen).sort()).to.deep.equal([0, 1]);
  });
});
