/**
 * The bot planner MIRRORS server validation, so when the well/close rules moved
 * it had to move with them — otherwise bots plan actions GameValidator rejects
 * and burn (or wedge) their turn. These pin the three that changed:
 *
 *   1. DIRECT well mode governs EVERY ruleset, not just professional;
 *   2. EITHER well may be taken indirectly (by discarding), capped at 2 per team;
 *   3. a brazilia of 2s no longer ends the round, so it is not a safe shed.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const BotStrategy = require('../../src/bots/BotStrategy');

let nextId = 0;
function card(rank, suit) {
  nextId += 1;
  return { cardId: `w${nextId}`, instanceId: `w${nextId}`, rank, suit, isJoker: rank === 'joker' };
}

function baseState(overrides = {}) {
  return {
    roomId: 'r1',
    playerId: 'bot-1',
    playerIndex: 1,
    currentPlayerIndex: 1,
    cardsDealt: true,
    hasDrawnCard: true,
    meldedThisTurn: false,
    ruleset: 'classic',
    professionalWellMode: 'indirect',
    yourHand: [],
    playerMelds: {},
    discardPile: [],
    deckCount: 40,
    deadPileCounts: [11],
    pozzettosAvailable: true,
    teamHasTakenPozzetto: false,
    teamWellsTaken: 0,
    opponentWellsTaken: 0,
    wellsTakenThisRound: 0,
    mustMeldCard: null,
    drawnCardRestriction: [],
    ...overrides,
  };
}

const strategy = new BotStrategy();
const ctxFor = (overrides) => strategy._context(baseState(overrides));

describe('BotStrategy well-rule mirror', () => {
  describe('direct mode applies to every ruleset', () => {
    it('classic + direct cannot reach the well by discarding', () => {
      const ctx = ctxFor({ ruleset: 'classic', professionalWellMode: 'direct' });
      expect(strategy._wellTakeableOnEmpty(ctx, true)).to.equal(false);
      // Melding out for it is still fine.
      expect(strategy._wellTakeableOnEmpty(ctx, false)).to.equal(true);
    });

    it('classic + direct never closes on a discard', () => {
      const ctx = ctxFor({
        ruleset: 'classic',
        professionalWellMode: 'direct',
        pozzettosAvailable: false,
        deadPileCounts: [0],
        teamHasTakenPozzetto: true,
      });
      expect(
        strategy._legalCloseDiscard(baseState(), ctx, card('9', 'hearts'))
      ).to.equal(false);
    });

    it('classic + indirect still closes on a discard once it qualifies', () => {
      const ctx = ctxFor({
        ruleset: 'classic',
        professionalWellMode: 'indirect',
        pozzettosAvailable: false,
        deadPileCounts: [0],
        teamHasTakenPozzetto: true,
        playerMelds: {
          1: [[
            card('4', 'spades'), card('5', 'spades'), card('6', 'spades'),
            card('7', 'spades'), card('8', 'spades'), card('9', 'spades'),
            card('10', 'spades'),
          ]],
        },
      });
      expect(
        strategy._legalCloseDiscard(baseState(), ctx, card('9', 'hearts'))
      ).to.equal(true);
    });
  });

  describe('either well may be taken indirectly (house rule)', () => {
    it('still allows the discard take once a well has already gone', () => {
      const ctx = ctxFor({ wellsTakenThisRound: 1 });
      expect(strategy._wellTakeableOnEmpty(ctx, true)).to.equal(true);
      expect(strategy._wellTakeableOnEmpty(ctx, false)).to.equal(true);
    });

    it('allows the discard take while no well has gone', () => {
      const ctx = ctxFor({ wellsTakenThisRound: 0 });
      expect(strategy._wellTakeableOnEmpty(ctx, true)).to.equal(true);
    });

    it('is capped at two wells per TEAM, by discard or by melding out', () => {
      // The cap is the only limit left, so it is the one that must hold — a bot
      // that planned a third take would burn its turn on a rejected action.
      const ctx = ctxFor({ teamWellsTaken: 2, wellsTakenThisRound: 2 });
      expect(strategy._wellTakeableOnEmpty(ctx, true)).to.equal(false);
      expect(strategy._wellTakeableOnEmpty(ctx, false)).to.equal(false);
    });

    it('still requires a brazilia in professional', () => {
      const ctx = ctxFor({
        ruleset: 'professional',
        teamWellsTaken: 1,
        wellsTakenThisRound: 1,
      });
      expect(strategy._wellTakeableOnEmpty(ctx, true)).to.equal(false);
    });

    it('still refuses an indirect take in direct well mode', () => {
      const ctx = ctxFor({
        professionalWellMode: 'direct',
        teamWellsTaken: 1,
        wellsTakenThisRound: 1,
      });
      expect(strategy._wellTakeableOnEmpty(ctx, true)).to.equal(false);
      expect(strategy._wellTakeableOnEmpty(ctx, false)).to.equal(true);
    });

    it('falls back to the per-side counts when the host omits the figure', () => {
      // Older BotCoordinator payloads carry only the two team counts. The figure
      // is informational now, but the derivation must stay correct because it is
      // still shipped to clients.
      const state = baseState({ teamWellsTaken: 1, opponentWellsTaken: 0 });
      delete state.wellsTakenThisRound;
      const ctx = strategy._context(state);
      expect(ctx.wellsTakenThisRound).to.equal(1);
    });
  });

  describe('a brazilia of 2s is no longer an instant win', () => {
    const twos = () => [
      card('2', 'hearts'), card('2', 'spades'), card('2', 'clubs'),
      card('2', 'diamonds'), card('2', 'hearts'), card('2', 'spades'),
      card('2', 'clubs'),
    ];

    // What was removed is the INSTANT WIN, not the canasta. Seven 2s is still a
    // completed brazilia, so it satisfies the close requirement like any other —
    // and with no well left on the table none is owed, so the meld-out is legal.
    // Verified against the live handler: this state returns
    // { success:true, roundEnded:<result> }. The bot used to answer `false` here
    // purely because it demanded DIRECT mode, and declined a won round.
    it('still satisfies the close requirement — the shed is safe', () => {
      const ctx = ctxFor({
        pozzettosAvailable: false,
        deadPileCounts: [0],
        professionalWellMode: 'indirect',
        ruleset: 'professional',
        playerMelds: { 1: [twos()] },
      });
      expect(strategy._safeToShed(baseState(), ctx, [])).to.equal(true);
    });

    // ...but the close requirement is the ONLY thing it satisfies: with a well
    // still sitting on the table the side owes it first, exactly as
    // _checkInstantEnd's wellStillOwed clause states.
    it('does not excuse an unpaid well', () => {
      const ctx = ctxFor({
        pozzettosAvailable: true,
        deadPileCounts: [11],
        teamHasTakenPozzetto: false,
        teamWellsTaken: 0,
        professionalWellMode: 'indirect',
        ruleset: 'professional',
        playerMelds: { 1: [twos()] },
      });
      // The well is takeable on an empty hand, so shedding is safe for THAT
      // reason (the server refills the hand) — not because the round closes.
      expect(strategy._wellTakeableOnEmpty(ctx, false)).to.equal(true);
    });
  });
});
