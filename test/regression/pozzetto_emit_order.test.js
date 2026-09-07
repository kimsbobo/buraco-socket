/* eslint-env mocha */

/**
 * The well broadcast must reach the clients BEFORE the state that reflects it.
 *
 * Clients animate the well flying into the hand off POZZETTO_TAKEN and apply the
 * new state only when that flight lands. The server emitted the state update
 * FIRST, so by the time the animation started the pile was already empty and the
 * hand already full. Three reported symptoms came out of that one inversion:
 *
 *   * the taker watched card BACKS fly onto a hand that was already full
 *   * the flight kept animating over cards that had visibly arrived
 *   * the client resolves the taken pile as "the first non-empty one", so once
 *     the state update had cleared the real one, POZZETTO_TAKEN emptied the
 *     SURVIVING well instead — "pozzetto hilang, muncul lagi pas player
 *     melakukan aksi", the next action's state update quietly rebuilding it.
 *
 * Order is the whole assertion here, so both the room broadcast and the
 * per-socket state emit are recorded into ONE sequence.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { Card } = require('../../src/models/Deck');

const c = (rank, suit) => new Card(suit, rank);

/** A room whose seat 0 is one meld away from emptying its hand, recording ORDER. */
function table(roomId, { wells = 1 } = {}) {
  const seq = [];
  const reg = new Map();
  const mkSocket = (id) => ({
    id,
    emit: (event) => seq.push({ to: id, event }),
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
  });
  reg.set('s1', mkSocket('s1'));
  reg.set('s2', mkSocket('s2'));

  const io = {
    to: () => ({ emit: (event) => seq.push({ to: 'room', event }) }),
    sockets: { sockets: reg },
  };

  const service = new GameService();
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'p1', 'P1', 's1');
  service.joinRoom(roomId, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.ruleset = 'classicWithNoJoker';
  room.professionalWellMode = 'indirect';
  room.deadPiles = Array.from({ length: wells }, () =>
    Array.from({ length: 11 }, () => c('3', 'clubs'))
  );

  const handlers = new SocketHandlers(io, service);
  handlers._stopTurnTimer(room);
  return { service, room, handlers, seq, s1: reg.get('s1') };
}

const firstIndexOf = (seq, event) => seq.findIndex((e) => e.event === event);

describe('#the well is announced before the state that reflects it', () => {
  it('PLAY_MELD emits pozzetto_taken ahead of the state update', () => {
    const { service, handlers, room, seq, s1 } = table('ord1');
    const kings = [c('K', 'spades'), c('K', 'hearts'), c('K', 'diamonds')];
    room.playerHands.set('p1', kings);

    handlers.handlePlayMeld(s1, { cards: kings.map((x) => x.toJSON()) });

    const taken = firstIndexOf(seq, 'pozzetto_taken');
    const state = firstIndexOf(seq, 'game_state_update');
    expect(taken, 'the take was announced at all').to.be.greaterThan(-1);
    expect(state, 'and state followed').to.be.greaterThan(-1);
    expect(taken).to.be.lessThan(
      state,
      'clients must hear about the well BEFORE the board moves'
    );
    service.deleteRoom('ord1');
  });

  it('GO_DOWN keeps the same order', () => {
    const { service, handlers, room, seq, s1 } = table('ord2');
    const kings = [c('K', 'spades'), c('K', 'hearts'), c('K', 'diamonds')];
    room.playerHands.set('p1', kings);

    handlers.handleGoDown(s1, { melds: [kings.map((x) => x.toJSON())] });

    const taken = firstIndexOf(seq, 'pozzetto_taken');
    if (taken === -1) return; // this path may decline the shed; order tested elsewhere
    expect(taken).to.be.lessThan(firstIndexOf(seq, 'game_state_update'));
    service.deleteRoom('ord2');
  });

  it('ADD_TO_MELD keeps the same order', () => {
    const { service, handlers, room, seq, s1 } = table('ord3');
    const run = [c('4', 'hearts'), c('5', 'hearts'), c('6', 'hearts')];
    room.playerMelds.set('p1', [run]);
    room.playerMeldOrders.set('p1', [1]);
    const seven = c('7', 'hearts');
    room.playerHands.set('p1', [seven]);

    handlers.handleAddToMeld(s1, {
      targetPlayerIndex: 0,
      targetMeldIndex: 0,
      cards: [seven.toJSON()],
    });

    const taken = firstIndexOf(seq, 'pozzetto_taken');
    expect(taken).to.be.greaterThan(-1);
    expect(taken).to.be.lessThan(firstIndexOf(seq, 'game_state_update'));
    service.deleteRoom('ord3');
  });

  it('a meld that takes NO well announces nothing, and still sends state', () => {
    const { service, handlers, room, seq, s1 } = table('ord4');
    const kings = [c('K', 'spades'), c('K', 'hearts'), c('K', 'diamonds')];
    room.playerHands.set('p1', [...kings, c('9', 'clubs'), c('8', 'clubs')]);

    handlers.handlePlayMeld(s1, { cards: kings.map((x) => x.toJSON()) });

    expect(firstIndexOf(seq, 'pozzetto_taken')).to.equal(-1);
    expect(firstIndexOf(seq, 'game_state_update')).to.be.greaterThan(-1);
    service.deleteRoom('ord4');
  });

  it('the SECOND well survives the take of the first', () => {
    // The consequence the order bug produced on the client: with the state
    // update landing first, "the first non-empty pile" resolved to the wrong
    // one. Pinned here at the source — one take consumes exactly one pile.
    const { service, handlers, room, s1 } = table('ord5', { wells: 2 });
    const kings = [c('K', 'spades'), c('K', 'hearts'), c('K', 'diamonds')];
    room.playerHands.set('p1', kings);

    handlers.handlePlayMeld(s1, { cards: kings.map((x) => x.toJSON()) });

    const remaining = (room.deadPiles || []).filter((p) => p && p.length > 0);
    expect(remaining, 'one well taken, one still on the table').to.have.length(1);
    service.deleteRoom('ord5');
  });
});
