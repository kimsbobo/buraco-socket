/* eslint-env mocha */

/**
 * Deck-out must never leave a table stuck ("stuck game" report):
 *
 * 1. Stock dead + pile takeable, but the CURRENT player is move-locked by the
 *    single-card squeeze guard (hand=1, pile=1): draw is rejected AND the pile
 *    take is rejected → no legal move exists. The round must end no-batida
 *    right there (previously: hard deadlock, the timer skipped seats forever).
 * 2. Stock dead + the player lets the turn timer lapse without taking the
 *    pile: that is a DECLINE → the round ends no-batida (previously:
 *    _forceAdvanceTurn skipped to the next seat and the game zombied around
 *    the table indefinitely, 30s per seat — or minutes with the timer "Off"
 *    watchdog).
 * 3. Stock dead + pile takeable and NOT blocked: the round does NOT end early
 *    — the player keeps their chance to take the pile.
 *
 * Chokepoints: ActionHandlers._deckOutTerminal (draw-time),
 * SocketHandlers.endRoundOnDeckOut (timer expiry + BotCoordinator escape).
 */

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => ({ suit, rank });

function fakeIo() {
  return {
    to: () => ({ emit: () => {} }),
    sockets: { sockets: new Map() },
  };
}

// In-progress 1v1 room with a DEAD stock (deck empty, no untaken pozzetto).
function makeDeckOutRoom(service, { discardPile, hands, squeeze = false } = {}) {
  const room = service.createRoom('deckout', 2);
  service.joinRoom('deckout', 'p1', 'P1', 's1');
  service.joinRoom('deckout', 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();

  room.currentTurn = 0;
  room.hasDrawnCard = false;
  room.deck.cards = [];
  room.deadPiles = [];
  room.discardPile = discardPile;
  if (squeeze) {
    room.ruleset = 'professional';
  }
  room.playerHands.set('p1', hands.p1);
  room.playerHands.set('p2', hands.p2);
  return room;
}

describe('#deck-out never leaves the game stuck', () => {
  afterEach(function cleanup() {
    if (this.currentService) {
      this.currentService.deleteRoom('deckout');
      this.currentService = null;
    }
  });

  it('a dead stock ENDS the round, so the §3.3/§3.13 deadlock cannot arise', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeDeckOutRoom(service, {
      discardPile: [card('diamonds', '8')],
      hands: { p1: [card('hearts', '5')], p2: [card('spades', '9'), card('clubs', '4')] },
      squeeze: true,
    });

    // The single-card guard still lifts on a dead stock (its "draw instead"
    // premise is unsatisfiable), which is what used to keep the take legal…
    expect(ActionHandlers._pileTakeBlockedBySqueeze(room, 'p1')).to.equal(false);

    // …but the deadlock it was defending against is now unreachable by
    // construction: an empty stock with no pozzetto left to promote ENDS the
    // round, so nobody is ever left with a rejected draw AND a rejected take.
    const terminal = ActionHandlers._deckOutTerminal(room, 'p1');
    expect(terminal).to.not.equal(null);
    expect(terminal.roundEnded).to.not.equal(undefined);
    expect(room.status).to.equal(GameRoomStatus.FINISHED);
  });

  it('keeps the squeeze guard while a deck draw is still possible (live stock / promotable pozzetto)', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeDeckOutRoom(service, {
      discardPile: [card('diamonds', '8')],
      hands: { p1: [card('hearts', '5')], p2: [card('spades', '9'), card('clubs', '4')] },
      squeeze: true,
    });

    room.deck.cards = [card('clubs', 'K')]; // stock alive → guard holds
    expect(ActionHandlers._pileTakeBlockedBySqueeze(room, 'p1')).to.equal(true);
    expect(ActionHandlers.handlePickUpPile(room, 'p1', [card('diamonds', '8')]).success).to.equal(false);

    room.deck.cards = [];
    room.deadPiles = [[card('clubs', '2'), card('clubs', '3')]]; // promotable pozzetto → guard holds
    expect(ActionHandlers._pileTakeBlockedBySqueeze(room, 'p1')).to.equal(true);
  });

  it('the pile-take terminal check never PROMOTES an untaken pozzetto', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeDeckOutRoom(service, {
      discardPile: [card('diamonds', '8'), card('diamonds', '9')],
      hands: {
        p1: [card('hearts', '5'), card('clubs', '7')],
        p2: [card('spades', '9'), card('clubs', '4')],
      },
    });
    // Empty deck, but a well is STILL on the table and untaken.
    room.deadPiles = [Array.from({ length: 11 }, () => card('clubs', '3'))];

    // The stock is not dead — the well can still be promoted on a real DRAW — so
    // taking the pile must not end the round…
    expect(ActionHandlers._deadStockTerminal(room)).to.equal(null);
    // …and, crucially, must not consume the well as a side effect. The draw-path
    // helper (_deckOutTerminal) promotes; wiring THAT into the pile take would
    // silently move these 11 cards into the deck, where they can never be taken
    // as a morto again.
    expect(room.deadPiles[0]).to.have.length(11);
    expect(room.deck.count).to.equal(0);
  });

  it('ends the round on a dead stock even while the pile is still takeable', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeDeckOutRoom(service, {
      discardPile: [card('diamonds', '8'), card('diamonds', '9')],
      hands: {
        p1: [card('hearts', '5'), card('clubs', '7')],
        p2: [card('spades', '9'), card('clubs', '4')],
      },
      squeeze: true, // single-card guard must NOT fire here: hand=2, pile=2
    });

    // PRODUCT RULE: once the stock is empty and no pozzetto remains to promote,
    // the round is over. A takeable discard pile no longer keeps it alive — the
    // table used to limp on with a permanently dead deck.
    const result = ActionHandlers._deckOutTerminal(room, 'p1');

    expect(result).to.not.equal(null);
    expect(result.roundEnded).to.not.equal(undefined);
    expect(room.status).to.equal(GameRoomStatus.FINISHED);
  });

  it('turn-timer expiry on a dead stock ends the round (decline), never skips seats', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeDeckOutRoom(service, {
      discardPile: [card('diamonds', '8'), card('diamonds', '9')],
      hands: {
        p1: [card('hearts', '5'), card('clubs', '7')],
        p2: [card('spades', '9'), card('clubs', '4')],
      },
    });
    const handlers = new SocketHandlers(fakeIo(), service);

    handlers._onTurnTimerExpired(room);

    // Round ended by score — the turn was NOT skipped to seat 1.
    expect(room.status).to.equal(GameRoomStatus.FINISHED);
    expect(room.currentTurn).to.equal(0);
  });

  it('endRoundOnDeckOut is a no-op while the stock is alive', function () {
    const service = new GameService();
    this.currentService = service;
    const room = makeDeckOutRoom(service, {
      discardPile: [card('diamonds', '8')],
      hands: {
        p1: [card('hearts', '5'), card('clubs', '7')],
        p2: [card('spades', '9'), card('clubs', '4')],
      },
    });
    room.deck.cards = [card('clubs', 'K'), card('clubs', 'Q')]; // stock alive

    const handlers = new SocketHandlers(fakeIo(), service);

    expect(handlers.endRoundOnDeckOut(room)).to.equal(false);
    expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);
  });
});
