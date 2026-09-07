/**
 * SCORING STATE HYGIENE — the state around _computeScores, not the arithmetic.
 *
 * Every case here is a way for a figure to survive something that was supposed
 * to clear it, or for a settled match to be handed a second life:
 *
 *   - the per-ROUND maps must all come back to zero at a new deal. The
 *     team-keyed teamTurnPenalty entry was the last one still guarded by has(),
 *     directly under a comment explaining why these must NOT be guarded;
 *   - room.nextTurn() does NOT clear teamMeldPointsThisTurn, so every path that
 *     advances a turn without _startTurnForPlayer hands the arriving side last
 *     turn's melded-points credit — and that counter is what the minimum-meld
 *     audit reads;
 *   - a SETTLED match must not be re-dealt: startGame() deliberately preserves
 *     the ledger and nothing clears matchResultReported, so a restart would
 *     begin past target with its settlement webhook already latched shut;
 *   - a live state frame must not carry room.lastRoundScores (the previous
 *     round's breakdown OBJECTS) in a field the client types Map<int,int>;
 *   - the timeout auto-discard must value cards by the ROOM's ruleset.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const FailureManager = require('../../src/managers/FailureManager');
const GameService = require('../../src/services/GameService');
const { Card } = require('../../src/models/Deck');

const noopLogger = { info() {}, warn() {}, debug() {}, error() {} };
const c = (suit, rank) => new Card(suit, rank);

function fakeRedis() {
  const store = new Map();
  return {
    async setex(k, _t, v) { store.set(k, v); },
    async set(k, v) { store.set(k, v); },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async del(k) { store.delete(k); },
    async exists(k) { return store.has(k) ? 1 : 0; },
    async keys() { return Array.from(store.keys()); },
  };
}

function fakeSocket(id, emitted) {
  return {
    id,
    join: () => {},
    leave: () => {},
    emit: (event, payload) => emitted.push({ to: id, event, payload }),
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
  };
}

function table(roomId = 'hyg', seats = 2) {
  const emitted = [];
  const registry = new Map();
  const service = new GameService();
  const io = {
    to: (rid) => ({ emit: (event, payload) => emitted.push({ roomId: rid, event, payload }) }),
    sockets: { sockets: registry },
  };
  const handlers = new SocketHandlers(io, service);
  const room = service.createRoom(roomId, seats);
  for (let i = 0; i < seats; i += 1) {
    service.joinRoom(roomId, `p${i + 1}`, `P${i + 1}`, `s${i + 1}`);
    registry.set(`s${i + 1}`, fakeSocket(`s${i + 1}`, emitted));
  }
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  handlers._stopTurnTimer(room);
  return { service, room, handlers, emitted, registry, io };
}

describe('#scoring state hygiene', () => {
  const services = [];

  afterEach(() => {
    while (services.length > 0) services.pop().shutdown();
  });

  it('a new deal zeroes EVERY score-adjacent per-round map', () => {
    const ctx = table('hyg-deal');
    services.push(ctx.service);
    const room = ctx.room;

    // Dirty every one of them, including the two TEAM-keyed entries.
    room.teamTurnPenalty.set('teamA', 100);
    room.teamTurnPenalty.set('p1', 100);
    room.teamMeldPointsThisTurn.set('teamA', 60);
    room.teamRequiredMeldPoints.set('teamA', 115);
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerDeadPileCount.set('p1', 2);
    room.turnMeldedCards.set('p1', [c('hearts', 'K')]);
    room.consecutiveInactiveTurns.set('p1', 3);

    room.startGame(true);

    expect(room.teamTurnPenalty.get('teamA'), 'the TEAM-keyed charge').to.equal(0);
    expect(room.teamTurnPenalty.get('p1'), 'and the seat-keyed one').to.equal(0);
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(0);
    expect(room.teamRequiredMeldPoints.get('teamA'), 'the bar comes back down').to.equal(null);
    expect(room.playerHasTakenPozzetto.get('p1')).to.equal(false);
    expect(room.playerDeadPileCount.get('p1')).to.equal(0);
    // .clear()ed outright rather than re-seeded per seat.
    expect(room.turnMeldedCards.has('p1')).to.equal(false);
    expect(room.consecutiveInactiveTurns.get('p1')).to.equal(0);
    // The LEDGER is not a per-round map and must survive.
    expect(room.cumulativeTeamScores.has('teamA')).to.equal(true);
  });

  it('a FORCED turn advance arms the arriving seat', () => {
    const ctx = table('hyg-force');
    services.push(ctx.service);
    const room = ctx.room;
    room.teamMeldPointsThisTurn.set('teamA', 50);
    room.teamMeldPointsThisTurn.set('teamB', 50);

    ctx.handlers._forceAdvanceTurn(room); // -> seat 1 (teamB)
    expect(room.teamMeldPointsThisTurn.get('teamB'), 'arriving side is armed').to.equal(0);
    ctx.handlers._forceAdvanceTurn(room); // -> seat 0 (teamA)
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(0);
    ctx.handlers._stopTurnTimer(room);
  });

  it('a SKIPPED turn arms the arriving seat too', async () => {
    const ctx = table('hyg-skip');
    services.push(ctx.service);
    const room = ctx.room;
    const manager = new FailureManager(ctx.io, fakeRedis(), ctx.service, noopLogger);
    room.teamMeldPointsThisTurn.set('teamB', 50);
    room.phase = 'meld';

    manager._skipPlayerTurn(room, room.getPlayer('p1')); // -> seat 1 (teamB)

    expect(room.teamMeldPointsThisTurn.get('teamB')).to.equal(0);
    manager.dispose();
  });

  it('a SETTLED match cannot be re-dealt, but a finished ROUND still can', () => {
    const ctx = table('hyg-settled');
    services.push(ctx.service);
    const room = ctx.room;
    room.cumulativeTeamScores = new Map([['teamA', 1200], ['teamB', 400]]);

    // A ROUND end: FINISHED on paper, but the match is alive. Still re-dealable
    // (this is how round N+1 arrives, from the scheduler or from wlive).
    room.endGame('p1');
    expect(ctx.handlers.triggerStartGame(room.roomId, {}).success).to.equal(true);
    expect(room.isInProgress()).to.equal(true);

    // Now settle the MATCH.
    room.endGame('p1');
    room.matchResultReported = true;
    ctx.emitted.length = 0;

    const res = ctx.handlers.triggerStartGame(room.roomId, {});
    expect(res.success).to.equal(false);
    expect(res.error).to.match(/finished/i);

    ctx.handlers.handleStartGame(ctx.registry.get('s1'), {
      roomId: room.roomId,
      playerId: 'p1',
    });
    expect(room.isInProgress(), 'no second life for a settled match').to.equal(false);
    expect(room.cumulativeTeamScores.get('teamA'), 'the ledger is untouched').to.equal(1200);
    expect(ctx.emitted.some((e) => e.event === 'game_started')).to.equal(false);
    ctx.handlers._stopTurnTimer(room);
  });

  it('no live state frame carries the previous round\'s playerScores', () => {
    const ctx = table('hyg-scores');
    services.push(ctx.service);
    const room = ctx.room;
    // Exactly what _finalizeWith leaves behind after round 1: BREAKDOWN OBJECTS.
    room.lastRoundScores = { 0: { playerId: 'p1', total: 345 }, 1: { playerId: 'p2', total: 120 } };
    ctx.emitted.length = 0;

    ctx.handlers._sendInitialGameState(room);
    ctx.handlers.handleGetGameState(ctx.registry.get('s1'), { gameId: room.roomId, playerId: 'p1' });
    ctx.handlers._sendStateToSpectator(
      fakeSocket('s-watch', ctx.emitted),
      room,
      'spec',
      'Watcher',
      {}
    );

    const frames = ctx.emitted.filter((e) => e.event === 'game_state_update');
    expect(frames.length, 'three builders ran').to.be.greaterThan(2);
    for (const frame of frames) {
      expect(frame.payload).to.not.have.property('playerScores');
    }
    ctx.handlers._stopTurnTimer(room);
  });

  it('the timeout auto-discard values cards by the ROOM\'s ruleset', () => {
    // The classic table pays a 2 twenty and a joker thirty; professional pays a
    // 2 ten and a joker nothing. A private copy of the classic table therefore
    // inverts the "throw the cheapest card" pick on every professional room.
    const classic = ActionHandlers._cardValue(c('hearts', '2'), 'classic');
    const pro = ActionHandlers._cardValue(c('hearts', '2'), 'professional');
    expect(classic).to.equal(20);
    expect(pro).to.equal(10);
    expect(ActionHandlers._cardValue(c('joker', 'joker'), 'professional')).to.equal(0);
    // And no fourth table exists to disagree with it.
    expect(typeof new Card('hearts', 'K').getValue).to.equal('undefined');
  });
});
