/* eslint-env mocha */

/**
 * Deck-exhaustion rule (hybrid): when the stock empties, an UNTAKEN pozzetto
 * (dead pile / morto) is promoted into the deck so play continues — but only
 * while it hasn't been taken as a morto yet (emptying your hand still takes it
 * first; whichever happens first consumes it). The discard pile is NOT
 * reshuffled into the deck. When no untaken pozzetto remains the only way to
 * continue is to take the discard pile; if that pile is also empty the round
 * ends with no batida. Chokepoint: ActionHandlers._refillStockOrEndRound; the
 * bot draws (to trigger promotion) while a pozzetto is available.
 */

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const BotStrategy = require('../../src/bots/BotStrategy');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Deck } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => ({ suit, rank });

// Build an in-progress room whose stock is EMPTY. Pass `deadPiles` to seat an
// untaken pozzetto and `discardPile` to control the discard contents.
function makeRoom({ maxPlayers = 2, deadPiles = [], discardPile = [] } = {}) {
  const room = new GameRoom({ roomId: 'deck-exhaust', maxPlayers });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = 'classic';
  room.currentTurn = 0;
  room.hasDrawnCard = false;
  room.deck = new Deck();
  room.deck.cards = []; // stock exhausted (count === 0)
  room.deadPiles = deadPiles;
  room.discardPile = discardPile;

  for (let i = 0; i < maxPlayers; i += 1) {
    const playerId = `p${i + 1}`;
    room.addPlayer(new PlayerSession({
      playerId,
      playerName: `P${i + 1}`,
      playerIndex: i,
      socketId: `s${i + 1}`,
    }));
    room.playerHands.set(playerId, [card('hearts', '5'), card('spades', '9')]);
    room.playerMelds.set(playerId, []);
    room.playerHasTakenPozzetto.set(playerId, false);
    room.playerDeadPileCount.set(playerId, 0);
    room.meldDirtyFlags.set(playerId, new Set());
  }

  return room;
}

// An 11-card pozzetto pile.
const pozzetto = () => Array.from({ length: 11 }, (_, i) => card('clubs', String((i % 9) + 2)));

describe('#deck-exhaustion (promote an untaken pozzetto into the stock)', () => {
  it('promotes an untaken pozzetto into the deck and CONTINUES play (no finalize)', () => {
    const room = makeRoom({ deadPiles: [pozzetto()], discardPile: [card('diamonds', '8')] });

    const result = ActionHandlers._refillStockOrEndRound(room);

    // Not terminal — the deck was refilled from the pozzetto.
    expect(result).to.equal(null);
    expect(room.deck.count).to.equal(11); // pozzetto promoted into the deck
    // The pozzetto is consumed off the table, but its SLOT survives: the index
    // is the well's identity on the wire (deadPileCounts), so a taken/promoted
    // well reports 0 rather than renumbering the pile beside it.
    expect(room.deadPiles.every((p) => p.length === 0)).to.equal(true);
    expect(room.deadPiles).to.have.length(1);
    expect(room.status).to.equal(GameRoomStatus.IN_PROGRESS);

    // A subsequent draw succeeds against the promoted stock.
    const drawn = room.deck.draw();
    expect(drawn).to.not.equal(null);
    expect(room.deck.count).to.equal(10);
  });

  it('promotion is a STOCK refill, NOT a player taking the well (no team credited)', () => {
    const room = makeRoom({ deadPiles: [pozzetto()], discardPile: [] });

    ActionHandlers._refillStockOrEndRound(room);

    expect(room.playerHasTakenPozzetto.get('p1')).to.equal(false);
    expect(room.playerDeadPileCount.get('p1')).to.equal(0);
  });

  it('does NOT reshuffle the discard pile into the deck (no untaken pozzetto)', () => {
    const room = makeRoom({
      deadPiles: [],
      discardPile: [card('diamonds', '8'), card('diamonds', '9'), card('diamonds', '10')],
    });

    const result = ActionHandlers._refillStockOrEndRound(room);

    // PRODUCT RULE: no pozzetto left to promote and an empty stock ENDS the
    // round — a takeable discard pile no longer keeps play alive. What must
    // never happen either way is a reshuffle: the discard stays put and the deck
    // is not refilled from it.
    expect(result).to.not.equal(null);
    expect(result.roundEnded).to.not.equal(undefined);
    expect(room.deck.count).to.equal(0);
    expect(room.discardPile).to.have.length(3);
  });

  it('finalizes the round when the deck, all pozzetti AND the discard are empty', () => {
    const room = makeRoom({ deadPiles: [], discardPile: [] });

    const result = ActionHandlers._refillStockOrEndRound(room);

    expect(result).to.not.equal(null);
    expect(result.roundEnded).to.be.an('object');
    expect(result.roundEnded.type).to.equal('round_ended');
    expect(result.roundEnded.batidaType).to.equal(null); // no go-out bonus
    expect(room.status).to.equal(GameRoomStatus.FINISHED);
  });

  it('returns null (deck usable) when the deck still has cards', () => {
    const room = makeRoom({ deadPiles: [], discardPile: [] });
    room.deck.cards = [card('hearts', '2'), card('hearts', '3')];

    expect(ActionHandlers._refillStockOrEndRound(room)).to.equal(null);
  });

  describe('bot awareness', () => {
    const strategy = new BotStrategy();
    const botState = (overrides = {}) => ({
      roomId: 'r1',
      playerId: 'bot-1',
      playerIndex: 1,
      currentPlayerIndex: 1,
      cardsDealt: true,
      hasDrawnCard: false,
      meldedThisTurn: false,
      ruleset: 'classic',
      yourHand: [{ cardId: 'h1', rank: '9', suit: 'hearts' }],
      playerMelds: {},
      discardPile: [],
      deckCount: 0,
      deadPileCounts: [],
      pozzettosAvailable: false,
      mustMeldCard: null,
      drawnCardRestriction: [],
      ...overrides,
    });

    it('draws from the empty deck when a pozzetto is available so the server promotes it', () => {
      const intent = strategy.decide(botState({ deckCount: 0, deadPileCounts: [11], pozzettosAvailable: true }));
      expect(intent.type).to.equal('draw_card');
      expect(intent.fromDeck).to.equal(true);
    });

    it('takes the discard pile on an empty deck when NO pozzetto remains', () => {
      const intent = strategy.decide(botState({
        deckCount: 0,
        deadPileCounts: [],
        pozzettosAvailable: false,
        discardPile: [
          { cardId: 'd1', rank: '8', suit: 'diamonds' },
          { cardId: 'd2', rank: '4', suit: 'clubs' },
        ],
      }));
      expect(intent.type).to.equal('pick_up_pile');
    });

    // A SINGLE useless card is the one case where taking the pile cannot change
    // anything: take one, discard one, hand unchanged — and with every seat
    // doing it the same card circles the table and the round never ends (~5% of
    // simulated rounds deadlocked exactly here). Declining is the sanctioned
    // exit: endRoundOnDeckOut ends a round no-batida when the stock is dead
    // "and the pile was declined".
    it('declines a single USELESS card on a dead stock so the round can end', () => {
      const intent = strategy.decide(botState({
        deckCount: 0,
        deadPileCounts: [],
        pozzettosAvailable: false,
        discardPile: [{ cardId: 'd1', rank: '8', suit: 'diamonds' }],
      }));
      expect(intent.type).to.equal('wait');
    });

    it('still takes a single card on a dead stock when it extends one of our melds', () => {
      const intent = strategy.decide(botState({
        deckCount: 0,
        deadPileCounts: [],
        pozzettosAvailable: false,
        playerMelds: {
          1: [[
            { cardId: 'm1', rank: '4', suit: 'diamonds' },
            { cardId: 'm2', rank: '5', suit: 'diamonds' },
            { cardId: 'm3', rank: '6', suit: 'diamonds' },
          ]],
        },
        discardPile: [{ cardId: 'd1', rank: '7', suit: 'diamonds' }],
      }));
      expect(intent.type).to.equal('pick_up_pile');
    });

    it('does NOT draw a truly-empty table (no deck, no pozzetto, no pile)', () => {
      const intent = strategy.decide(botState({ deckCount: 0, deadPileCounts: [], discardPile: [] }));
      expect(intent.type).to.not.equal('draw_card');
    });
  });
});
