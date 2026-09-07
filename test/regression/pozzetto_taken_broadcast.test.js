/* eslint-env mocha */

/**
 * POZZETTO_TAKEN is what the clients ANIMATE off. They fly the well into the
 * hand and play a sound from it, and they flip their local team well flags from
 * it too.
 *
 * It was emitted on only two of the five paths a pot can be taken. The three
 * that stayed silent — PLAY_MELD, GO_DOWN and ADD_TO_MELD — are every take that
 * happens because a MELD emptied the hand, which is the ordinary way a well is
 * collected (and the ONLY way in direct mode). Those branches just re-armed the
 * turn timer, so the taker's eleven new cards appeared out of nowhere on the
 * next state update, with no motion and no sound.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { Card } = require('../../src/models/Deck');

const c = (rank, suit) => new Card(suit, rank);

/** io double that RECORDS room broadcasts instead of dropping them. */
function recordingIo(reg, broadcasts) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => broadcasts.push({ roomId, event, payload }),
    }),
    sockets: { sockets: reg },
  };
}
function fakeSocket(id) {
  return {
    id,
    emit: () => {},
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
  };
}

/** A dealt room whose seat 0 is one meld away from emptying its hand. */
function room1() {
  const service = new GameService();
  const room = service.createRoom('pot', 2);
  service.joinRoom('pot', 'p1', 'P1', 's1');
  service.joinRoom('pot', 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.ruleset = 'classicWithNoJoker';
  room.professionalWellMode = 'indirect';
  // One well on the table, untaken.
  room.deadPiles = [Array.from({ length: 11 }, () => c('3', 'clubs'))];

  const reg = new Map();
  reg.set('s1', fakeSocket('s1'));
  reg.set('s2', fakeSocket('s2'));
  const broadcasts = [];
  const handlers = new SocketHandlers(recordingIo(reg, broadcasts), service);
  handlers._stopTurnTimer(room);
  return { service, room, handlers, broadcasts, s1: reg.get('s1') };
}

describe('#pozzetto_taken is broadcast on every path that takes a well', () => {
  it('PLAY_MELD that empties the hand announces the take', () => {
    const { service, room, handlers, broadcasts, s1 } = room1();
    const kings = [c('K', 'spades'), c('K', 'hearts'), c('K', 'diamonds')];
    room.playerHands.set('p1', kings);

    handlers.handlePlayMeld(s1, { cards: kings.map((x) => x.toJSON()) });

    const taken = broadcasts.filter((b) => b.event === 'pozzetto_taken');
    expect(taken, 'the clients were told, so they can animate it').to.have.length(1);
    expect(taken[0].payload.playerIndex).to.equal(0);
    expect(taken[0].payload.cardCount).to.equal(11);
    expect(
      room.playerHands.get('p1'),
      'and the hand really did refill from the well'
    ).to.have.length(11);
    service.deleteRoom('pot');
  });

  it('ADD_TO_MELD that empties the hand announces the take', () => {
    const { service, room, handlers, broadcasts, s1 } = room1();
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

    const taken = broadcasts.filter((b) => b.event === 'pozzetto_taken');
    expect(taken).to.have.length(1);
    expect(taken[0].payload.cardCount).to.equal(11);
    service.deleteRoom('pot');
  });

  it('a meld that does NOT empty the hand announces nothing', () => {
    // The guard must stay quiet on the ordinary case, or every meld would fire
    // a well animation.
    const { service, room, handlers, broadcasts, s1 } = room1();
    const kings = [c('K', 'spades'), c('K', 'hearts'), c('K', 'diamonds')];
    room.playerHands.set('p1', [...kings, c('9', 'clubs'), c('8', 'clubs')]);

    handlers.handlePlayMeld(s1, { cards: kings.map((x) => x.toJSON()) });

    expect(broadcasts.filter((b) => b.event === 'pozzetto_taken')).to.have.length(0);
    service.deleteRoom('pot');
  });
});
