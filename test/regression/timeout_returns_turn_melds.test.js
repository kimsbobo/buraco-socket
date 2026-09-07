/**
 * "kalo tersisa 1 kartu (ga di meld walaupun bisa, dan timeout) dia malah skip
 * discard" — reported 2026-08-26.
 *
 * A player melds their hand down to a single card that cannot legally be thrown:
 * throwing it would empty the hand and close a round they are not entitled to
 * close. The auto-discard found nothing legal, so the turn was force-advanced —
 * the discard simply did not happen. An inattentive player got a free turn, and
 * kept every meld that had walked them into the dead end.
 *
 * Product rule (2026-08-26): take the melds back instead. Everything laid down
 * THIS TURN returns to the hand — every meld of the turn, not just the last one,
 * because reaching one card usually took several — and a card is then thrown at
 * random. With the hand no longer one card long, the close guard that blocked
 * the discard no longer applies and the turn ends like any other.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { Card } = require('../../src/models/Deck');

function fakeSocket(id, emitted) {
  return {
    id,
    join: () => {},
    leave: () => {},
    emit: (event, payload) => emitted.push({ scope: 'socket', id, event, payload }),
    to: () => ({ emit: () => {} }),
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

const c = (rank, suit) => new Card(suit, rank);

describe('turn timeout — a hand melded into a dead end gives the melds back', () => {
  const services = [];
  let emitted;
  let registry;
  let handlers;
  let service;
  let origFetch;
  let origRandom;

  beforeEach(() => {
    origFetch = global.fetch;
    origRandom = Math.random;
    global.fetch = () => Promise.resolve({ ok: true });
    emitted = [];
    registry = new Map([
      ['sHost', fakeSocket('sHost', emitted)],
      ['sOpp', fakeSocket('sOpp', emitted)],
    ]);
    service = new GameService();
    services.push(service);
    handlers = new SocketHandlers(fakeIo(emitted, registry), service);
  });

  afterEach(() => {
    global.fetch = origFetch;
    Math.random = origRandom;
    while (services.length > 0) services.pop().shutdown();
  });

  /**
   * A room mid-round where HOST has melded down to ONE card, with no way out:
   * the meld is SIX cards (one short of a brazilia, so closing is illegal) and
   * both wells are already gone (so the last card cannot take one instead).
   * Either of those alone makes the discard legal and there is no dead end.
   */
  function deadEndRoom(roomId = 'to1') {
    const room = service.createRoom(roomId, 2);
    service.joinRoom(roomId, HOST, 'Host', 'sHost');
    service.joinRoom(roomId, OPP, 'Opp', 'sOpp');
    room.startGame(true);
    room.dealCards();
    room.currentTurn = 0;
    room.hasDrawnCard = true; // already drew this turn
    // Both wells already gone: with one available, discarding the last card is
    // LEGAL (it takes the well instead of closing), and there is no dead end to
    // reproduce. Emptied in place, which is how a taken well is represented.
    room.deadPiles = [[], []];

    const melded = [
      c('3', 'hearts'), c('4', 'hearts'), c('5', 'hearts'),
      c('6', 'hearts'), c('7', 'hearts'), c('8', 'hearts'),
    ];
    room.playerMelds.set(HOST, [melded]);
    room.playerMeldOrders.set(HOST, [0]);
    // Everything above was laid THIS turn — that is what makes it returnable.
    room.turnMeldedCards.set(HOST, melded.slice());

    const lone = c('K', 'spades');
    room.playerHands.set(HOST, [lone]);
    return { room, lone, melded };
  }

  it('BEFORE anything else: the lone card really is undiscardable', () => {
    const { room, lone } = deadEndRoom('to0');
    const GameValidator = require('../../src/validators/GameValidator');
    expect(GameValidator.validateDiscard(room, HOST, lone).isValid).to.equal(false);
  });

  it('returns every card melded this turn and throws one of them', () => {
    const { room, melded } = deadEndRoom();
    Math.random = () => 0; // pick the first legal card, deterministically

    handlers._onTurnTimerExpired(room);

    // The meld is gone from the table...
    expect(room.playerMelds.get(HOST)).to.deep.equal([]);
    // ...the turn's ledger is emptied so nothing can be handed back twice...
    expect(room.turnMeldedCards.get(HOST)).to.deep.equal([]);
    // ...a card WAS discarded (this is the whole bug: it used to be skipped)...
    expect(room.discardPile.length).to.be.greaterThan(0);
    expect(emitted.some((e) => e.event === 'card_discarded')).to.equal(true);
    // ...and the hand holds the returned cards minus the one thrown.
    const hand = room.playerHands.get(HOST);
    expect(hand.length).to.equal(melded.length + 1 - 1);
    // The turn moved on properly rather than being force-advanced.
    expect(room.currentTurn).to.equal(1);
  });

  it('tells the table how many melds the timeout took back', () => {
    const { room, melded } = deadEndRoom('to2');
    Math.random = () => 0;

    handlers._onTurnTimerExpired(room);

    const discard = emitted.find((e) => e.event === 'card_discarded');
    expect(discard, 'no card_discarded broadcast').to.not.equal(undefined);
    expect(discard.payload.meldsReturnedOnTimeout).to.equal(melded.length);
  });

  it('does not let the confiscated points satisfy the minimum-meld bar', () => {
    const { room } = deadEndRoom('to3');
    const teamKey = 'teamA';
    // Side is past 1000, so its first going-down owes 75 points; the meld above
    // is worth well over that.
    room.cumulativeTeamScores.set(teamKey, 1200);
    room.teamRequiredMeldPoints.set(teamKey, 75);
    room.teamMeldPointsThisTurn.set(teamKey, 200);
    Math.random = () => 0;

    handlers._onTurnTimerExpired(room);

    // The cards went back, so the points must not still be standing — otherwise
    // the audit reads the bar as MET and spends it for the whole round for free.
    expect(room.teamMeldPointsThisTurn.get(teamKey)).to.equal(0);
    expect(room.teamRequiredMeldPoints.get(teamKey)).to.not.equal(0);
  });

  it('an ordinary timeout is untouched — least-damage pick, melds kept', () => {
    const room = service.createRoom('to4', 2);
    service.joinRoom('to4', HOST, 'Host', 'sHost');
    service.joinRoom('to4', OPP, 'Opp', 'sOpp');
    room.startGame(true);
    room.dealCards();
    room.currentTurn = 0;
    room.hasDrawnCard = true;

    const melded = [
      c('3', 'clubs'), c('4', 'clubs'), c('5', 'clubs'),
      c('6', 'clubs'), c('7', 'clubs'), c('8', 'clubs'),
    ];
    room.playerMelds.set(HOST, [melded]);
    room.playerMeldOrders.set(HOST, [0]);
    room.turnMeldedCards.set(HOST, melded.slice());
    // A normal hand: plenty of legal discards, and a joker that must survive.
    room.playerHands.set(HOST, [c('joker', 'joker'), c('A', 'spades'), c('4', 'diamonds')]);

    handlers._onTurnTimerExpired(room);

    // The meld stays on the table — nothing was confiscated.
    expect(room.playerMelds.get(HOST)).to.deep.equal([melded]);
    const discarded = room.discardPile[room.discardPile.length - 1];
    // Lowest-value natural card, and never the wild.
    expect(discarded.rank).to.equal('4');
    const discard = emitted.find((e) => e.event === 'card_discarded');
    expect(discard.payload.meldsReturnedOnTimeout).to.equal(0);
  });

  it('a hand with nothing melded this turn still just skips (no invented cards)', () => {
    const room = service.createRoom('to5', 2);
    service.joinRoom('to5', HOST, 'Host', 'sHost');
    service.joinRoom('to5', OPP, 'Opp', 'sOpp');
    room.startGame(true);
    room.dealCards();
    room.currentTurn = 0;
    room.hasDrawnCard = true;
    room.deadPiles = [[], []];
    room.playerMelds.set(HOST, []);
    room.turnMeldedCards.set(HOST, []);
    room.playerHands.set(HOST, [c('K', 'spades')]);

    const before = room.discardPile.length;
    handlers._onTurnTimerExpired(room);

    // There is nothing to give back, so the safety net still force-advances
    // rather than forcing an illegal closing discard.
    expect(room.discardPile.length).to.equal(before);
    expect(room.currentTurn).to.equal(1);
  });

  it('undoTurnMelds is a no-op when the turn laid nothing', () => {
    const room = service.createRoom('to6', 2);
    service.joinRoom('to6', HOST, 'Host', 'sHost');
    service.joinRoom('to6', OPP, 'Opp', 'sOpp');
    room.startGame(true);
    room.turnMeldedCards.set(HOST, []);
    room.teamMeldPointsThisTurn.set('teamA', 40);

    expect(ActionHandlers.undoTurnMelds(room, HOST)).to.equal(0);
    // Nothing returned means nothing to roll back — the counter is left alone.
    expect(room.teamMeldPointsThisTurn.get('teamA')).to.equal(40);
  });
});
