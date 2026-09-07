/**
 * WHAT A RECONNECTING CLIENT MUST BE TOLD.
 *
 * A client that restarted holds nothing. Every field it cannot DERIVE has to
 * ride the state frame, and three of them did not:
 *
 *   melds            — the per-meld isBuraco/clean verdicts. The cards travel in
 *                      `playerMelds`, but the VERDICTS do not, and the PRO
 *                      sticky-dirty flag is server-only state, so a rebuilt
 *                      client re-derived them and got them wrong — most visibly
 *                      paying 200 for a buraco the server closed as dirty.
 *                      GameRoom.serializeMelds has always built this array and
 *                      was documented as "the reconnect badge fix"; nothing
 *                      emitted it. Its only reader was GameRoom.toJSON(), whose
 *                      only non-card caller is a handleReconnect static with no
 *                      call site anywhere in src/.
 *   turnTimeRemaining — the client only re-anchors its countdown on a positive
 *                      value, so a get_game_state resync left it with nothing.
 *   skins            — cosmetics a cold resync would never learn.
 *
 * The team ROUND state (well flags, meld points, the minimum bar) already rides
 * every frame via _serializeRoomGameSettings; it is asserted here too because
 * the well flags gate the client's own discard legality, so losing them makes a
 * reconnected client refuse a legal closing discard.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { Card } = require('../../src/models/Deck');

function fakeSocket(id, emitted) {
  return {
    id,
    join: () => {},
    leave: () => {},
    emit: (event, payload) => emitted.push({ to: id, event, payload }),
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
  };
}

const c = (suit, rank) => new Card(suit, rank);

function table() {
  const emitted = [];
  const registry = new Map();
  const service = new GameService();
  const io = {
    to: (roomId) => ({ emit: (event, payload) => emitted.push({ roomId, event, payload }) }),
    sockets: { sockets: registry },
  };
  const handlers = new SocketHandlers(io, service);

  const room = service.createRoom('fields', 2);
  service.joinRoom('fields', 'p1', 'P1', 's1');
  service.joinRoom('fields', 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  handlers._stopTurnTimer(room);
  registry.set('s1', fakeSocket('s1', emitted));
  registry.set('s2', fakeSocket('s2', emitted));

  // A closed, DIRTY buraco: seven cards with a wild 2 standing in for the 10.
  // "Dirty" is the verdict the client cannot re-derive on its own.
  room.playerMelds.set('p1', [
    [
      c('hearts', '4'),
      c('hearts', '5'),
      c('hearts', '6'),
      c('hearts', '7'),
      c('hearts', '8'),
      c('hearts', '9'),
      c('spades', '2'),
    ],
  ]);
  room.meldDirtyFlags.set('p1', new Set([0]));
  room.skins = { table: 'brazilia' };
  handlers._startTurnTimer(room);

  return { service, room, handlers, emitted, registry };
}

/** Every field a resyncing client cannot derive for itself. */
function assertReconnectFields(payload) {
  expect(payload.turnTimeRemaining, 'turnTimeRemaining').to.be.a('number');
  expect(payload.skins, 'skins').to.be.an('object');
  expect(payload.melds, 'melds').to.be.an('array');

  const seat0 = payload.melds.find((m) => m.playerIndex === 0);
  expect(seat0, 'seat 0 is in the melds array').to.exist;
  expect(seat0.teamId).to.equal('teamA');
  expect(seat0.melds).to.have.length(1);
  expect(seat0.melds[0].isBuraco, 'seven cards is a buraco').to.equal(true);
  expect(seat0.melds[0].clean, 'and the wild 2 makes it DIRTY').to.equal(false);
  expect(seat0.melds[0].cards).to.have.length(7);

  // Already carried, and load-bearing for the client's own discard legality.
  expect(payload).to.have.property('teamHasPickedDeadPile');
  expect(payload).to.have.property('teamDeadPileCount');
  expect(payload).to.have.property('teamRequiredMeldPoints');
  expect(payload).to.have.property('discardLock');
}

describe('#state frames carry everything a reconnect cannot derive', () => {
  const services = [];

  afterEach(() => {
    while (services.length > 0) services.pop().shutdown();
  });

  it('_sendInitialGameState — the frame a rejoin receives', () => {
    const ctx = table();
    services.push(ctx.service);
    ctx.emitted.length = 0;

    ctx.handlers._sendInitialGameState(ctx.room);

    const frame = ctx.emitted.find((e) => e.to === 's1' && e.event === 'game_state_update');
    expect(frame, 'p1 got a state frame').to.exist;
    assertReconnectFields(frame.payload);
  });

  it('handleGetGameState — the frame a resync receives', () => {
    const ctx = table();
    services.push(ctx.service);
    ctx.emitted.length = 0;

    ctx.handlers.handleGetGameState(ctx.registry.get('s1'), {
      gameId: 'fields',
      playerId: 'p1',
    });

    const frame = ctx.emitted.find((e) => e.to === 's1' && e.event === 'game_state_update');
    expect(frame, 'the resync answered with a state frame').to.exist;
    assertReconnectFields(frame.payload);
  });

  it('_sendStateToSpectator — a watcher with no history at all', () => {
    const ctx = table();
    services.push(ctx.service);
    const watcher = fakeSocket('s-watch', ctx.emitted);
    ctx.registry.set('s-watch', watcher);
    ctx.emitted.length = 0;

    ctx.handlers._sendStateToSpectator(watcher, ctx.room, 'spec1', 'Watcher', {});

    const frame = ctx.emitted.find((e) => e.to === 's-watch' && e.event === 'game_state_update');
    expect(frame, 'the spectator got a state frame').to.exist;
    expect(frame.payload.yourPlayerIndex).to.equal(-1);
    const seat0 = frame.payload.melds.find((m) => m.playerIndex === 0);
    expect(seat0.melds[0].isBuraco).to.equal(true);
    expect(seat0.melds[0].clean).to.equal(false);
  });

  it('the badge flags are computed ONCE per fan-out, not once per seat', () => {
    const ctx = table();
    services.push(ctx.service);
    let calls = 0;
    const real = ctx.room.serializeMelds.bind(ctx.room);
    ctx.room.serializeMelds = () => {
      calls += 1;
      return real();
    };

    ctx.handlers._sendInitialGameState(ctx.room);

    // serializeMelds re-serializes every card and runs meldClean per meld; two
    // human seats must not pay for the whole table twice.
    expect(calls).to.equal(1);
  });
});
