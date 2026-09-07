/**
 * Brazilia-pro revision — SOCKET rules regression.
 * Covers: #2 wild-2 gap ordering, #5 brazilia badge flags, #11 target score
 * match-end, the single-card squeeze guard, and #6 discarding a deck-drawn
 * card. Handlers are driven directly (no real timers / sockets).
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const { GameRoom } = require('../../src/models');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus, SocketEvents } = require('../../src/constants');
const { Card, Deck } = require('../../src/models/Deck');

const c = (suit, rank) => new Card(suit, rank);

function makeRoom({ ruleset = 'professional', players = 2 } = {}) {
  const room = new GameRoom({ roomId: 'pro-rev', maxPlayers: players });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  for (let i = 0; i < players; i += 1) {
    const id = `p${i + 1}`;
    room.addPlayer(new PlayerSession({ playerId: id, playerName: id, playerIndex: i, socketId: `s${i + 1}` }));
    room.playerHands.set(id, []);
    room.playerMelds.set(id, []);
    room.playerHasTakenPozzetto.set(id, false);
    room.playerDeadPileCount.set(id, 0);
    room.meldDirtyFlags.set(id, new Set());
    const teamId = i % 2 === 0 ? 'teamA' : 'teamB';
    if (!room.cumulativeTeamScores.has(teamId)) room.cumulativeTeamScores.set(teamId, 0);
  }
  return room;
}

describe('Brazilia-pro revision (socket rules)', () => {
  describe('#2 wild-2 gap placement / canonical ordering', () => {
    it('orders a sequence with the wild-2 in its interior gap and stamps representedRank', () => {
      // [2,8,10] -> the wild plugs the single interior gap at 9.
      const cards = [c('hearts', '10'), c('hearts', '8'), c('hearts', '2')];
      const ordered = GameValidator.orderMeldCards(cards, 'professional');
      expect(ordered.map((x) => x.rank)).to.deep.equal(['8', '2', '10']);
      const wild = ordered[1];
      expect(wild.rank).to.equal('2');
      expect(wild.representedRank).to.equal('9');
      // representedRank survives serialization for the client.
      expect(wild.toJSON().representedRank).to.equal('9');
    });

    it('professional ACCEPTS a wild that pure-extends a complete run (no interior gap)', () => {
      // 8,9,10 + 2 -> the 2 cannot be natural here (not adjacent to a 3), so it
      // is a wild that EXTENDS the complete run at an end. This is now valid in
      // BOTH professional and classic.
      const pureExtend = [c('hearts', '8'), c('hearts', '9'), c('hearts', '10'), c('hearts', '2')];
      expect(GameValidator._isValidSequence(pureExtend, 'professional')).to.equal(true);
      expect(GameValidator._isValidSequence(pureExtend, 'classic')).to.equal(true);
      // A wild that plugs a real gap is still accepted in professional.
      const plugged = [c('hearts', '8'), c('hearts', '9'), c('hearts', '2'), c('hearts', 'J')];
      expect(GameValidator._isValidSequence(plugged, 'professional')).to.equal(true);
    });

    it('places a pure-extend wild at the canonical HIGH end (topNatural + 1)', () => {
      // [8,9,10] + 2 -> no interior gap; the wild extends at the HIGH end as J.
      const cards = [c('hearts', '8'), c('hearts', '9'), c('hearts', '10'), c('hearts', '2')];
      const ordered = GameValidator.orderMeldCards(cards, 'professional');
      expect(ordered.map((x) => x.rank)).to.deep.equal(['8', '9', '10', '2']);
      const wild = ordered[3];
      expect(wild.rank).to.equal('2');
      expect(wild.representedRank).to.equal('J');
    });

    it('places a pure-extend wild at the LOW end when the top natural is an Ace', () => {
      // [Q,K,A] + 2 -> cannot extend above an ace-high run, so the wild drops to
      // the LOW end representing J (bottomNatural - 1).
      const cards = [c('hearts', 'Q'), c('hearts', 'K'), c('hearts', 'A'), c('hearts', '2')];
      const ordered = GameValidator.orderMeldCards(cards, 'professional');
      expect(ordered.map((x) => x.rank)).to.deep.equal(['2', 'Q', 'K', 'A']);
      const wild = ordered[0];
      expect(wild.rank).to.equal('2');
      expect(wild.representedRank).to.equal('J');
    });

    it('re-floats the wild to an end when the natural it filled is added, then accepts another card', () => {
      const room = makeRoom();
      // p1 melds [8, 2(=9), 10] (wild plugs the 9-gap).
      const seq = [c('hearts', '8'), c('hearts', '10'), c('hearts', '2')];
      // Keep TWO spare off-meld cards (5♠, 4♠) so that even after adding BOTH the
      // 9 and the Q the hand still holds a discardable card — this test exercises
      // wild re-float ordering, not a close. The keep-a-discardable-card guard
      // rightly rejects a meld/add that would strand you on a lone un-closeable
      // card (here: one card with no Brazilia), so a single spare is not enough.
      room.playerHands.set('p1', [
        ...seq, c('hearts', '9'), c('hearts', 'Q'), c('spades', '5'), c('spades', '4'),
      ]);
      const meldRes = ActionHandlers.handlePlayMeld(room, 'p1', seq, undefined);
      expect(meldRes.success).to.equal(true);
      expect(meldRes.broadcast.cards.map((x) => x.rank)).to.deep.equal(['8', '2', '10']);
      expect(meldRes.broadcast.cards[1].representedRank).to.equal('9');

      // p1 adds the NATURAL 9 -> the wild must re-float to an end (HIGH = J).
      const nine = room.playerHands.get('p1').find((x) => x.rank === '9');
      const addRes = ActionHandlers.handleAddToMeld(room, 'p1', nine, 0, 0);
      expect(addRes.success).to.equal(true);
      expect(addRes.broadcast.meldCards.map((x) => x.rank)).to.deep.equal(['8', '9', '10', '2']);
      const reFloated = addRes.broadcast.meldCards[3];
      expect(reFloated.rank).to.equal('2');
      expect(reFloated.representedRank).to.equal('J');

      // p1 adds a Q -> meld stays valid; wild slides back into the new J-gap.
      const queen = room.playerHands.get('p1').find((x) => x.rank === 'Q');
      const addQ = ActionHandlers.handleAddToMeld(room, 'p1', queen, 0, 0);
      expect(addQ.success).to.equal(true);
      expect(addQ.broadcast.meldCards.map((x) => x.rank)).to.deep.equal(['8', '9', '10', '2', 'Q']);
      expect(addQ.broadcast.meldCards[3].representedRank).to.equal('J');
    });

    it('still rejects a sequence with two wilds', () => {
      const twoWilds = [c('hearts', '8'), c('hearts', '10'), c('hearts', '2'), c('clubs', '2')];
      expect(GameValidator._isValidSequence(twoWilds, 'professional')).to.equal(false);
      expect(GameValidator._isValidSequence(twoWilds, 'classic')).to.equal(false);
    });

    it('leaves a natural-2 sequence (A-2-3) untouched (the 2 is not wild)', () => {
      const natural = [c('hearts', 'A'), c('hearts', '2'), c('hearts', '3')];
      expect(GameValidator._isValidSequence(natural, 'professional')).to.equal(true);
      const ordered = GameValidator.orderMeldCards(natural, 'professional');
      expect(ordered.map((x) => x.rank)).to.deep.equal(['A', '2', '3']);
      // No representedRank stamped: the 2 is a natural card, not a wild.
      expect(ordered.find((x) => x.rank === '2').representedRank).to.equal(undefined);
    });

    it('does not reorder a set and clears any stale representedRank', () => {
      const set = [c('hearts', 'K'), c('diamonds', 'K'), c('clubs', 'K')];
      set[0].representedRank = '9'; // stale
      const ordered = GameValidator.orderMeldCards(set, 'professional');
      expect(ordered.every((x) => x.rank === 'K')).to.equal(true);
      expect(ordered[0].representedRank).to.equal(undefined);
    });
  });

  describe('#5 brazilia flag on meld payloads', () => {
    it('stamps isBuraco + clean=true on a clean 7-card sequence (meld_played)', () => {
      const room = makeRoom();
      const seq = ['3', '4', '5', '6', '7', '8', '9'].map((r) => c('hearts', r));
      const extra = [c('spades', 'A'), c('clubs', 'A')];
      room.playerHands.set('p1', [...seq, ...extra]);
      const res = ActionHandlers.handlePlayMeld(room, 'p1', seq, undefined);
      expect(res.success).to.equal(true);
      expect(res.broadcast.isBuraco).to.equal(true);
      expect(res.broadcast.clean).to.equal(true);
    });

    it('stamps clean=false on a dirty (wild-2) professional brazilia', () => {
      const room = makeRoom();
      // 3,4,5,6,7,9 + 2(=8): wild plugs the gap -> dirty brazilia of 7.
      const seq = [
        c('hearts', '3'), c('hearts', '4'), c('hearts', '5'),
        c('hearts', '6'), c('hearts', '7'), c('hearts', '9'), c('hearts', '2'),
      ];
      const extra = [c('spades', 'A'), c('clubs', 'A')];
      room.playerHands.set('p1', [...seq, ...extra]);
      const res = ActionHandlers.handlePlayMeld(room, 'p1', seq, undefined);
      expect(res.success).to.equal(true);
      expect(res.broadcast.isBuraco).to.equal(true);
      expect(res.broadcast.clean).to.equal(false);
      // Wild is ordered into the 8-gap.
      expect(res.broadcast.cards.map((x) => x.rank)).to.deep.equal(['3', '4', '5', '6', '7', '2', '9']);
    });

    it('toJSON.melds carries cards (ordered) + isBuraco + clean for reconnect', () => {
      const room = makeRoom();
      const seq = ['3', '4', '5', '6', '7', '8', '9'].map((r) => c('hearts', r));
      room.playerHands.set('p1', [...seq, c('spades', 'A'), c('clubs', 'A')]);
      ActionHandlers.handlePlayMeld(room, 'p1', seq, undefined);
      const json = room.toJSON();
      const p1Entry = json.melds.find((m) => m.playerIndex === 0);
      expect(p1Entry.melds[0].isBuraco).to.equal(true);
      expect(p1Entry.melds[0].clean).to.equal(true);
      expect(p1Entry.melds[0].cards).to.have.length(7);
    });
  });

  describe('natural-2 must match the run suit (off-suit 2 is a WILD => dirty)', () => {
    it('a 7-card spades run + a DIFFERENT-suit 2 (2♦) is DIRTY (clean=false)', () => {
      const room = makeRoom();
      // 3♠..8♠ (6 naturals, complete run) + 2♦ -> 7-card brazilia. The 2♦ can only
      // act as a WILD (no natural diamond fits a spades sequence), so the brazilia
      // is DIRTY -> clean=false (100), NOT a clean 200.
      const seq = ['3', '4', '5', '6', '7', '8'].map((r) => c('spades', r));
      seq.push(c('diamonds', '2'));
      room.playerHands.set('p1', [...seq, c('hearts', 'A'), c('clubs', 'A')]);
      const res = ActionHandlers.handlePlayMeld(room, 'p1', seq, undefined);
      expect(res.success).to.equal(true);
      expect(res.broadcast.isBuraco).to.equal(true);
      expect(res.broadcast.clean).to.equal(false);
    });

    it('a spades run with a SAME-suit 2 (2♠) sitting consecutively stays CLEAN', () => {
      const room = makeRoom();
      // A♠-2♠-...-7♠: the 2♠ matches the run suit AND sits consecutively (A-2-3)
      // -> it is a NATURAL 2, so the 7-card brazilia is CLEAN (200).
      const seq = ['A', '2', '3', '4', '5', '6', '7'].map((r) => c('spades', r));
      room.playerHands.set('p1', [...seq, c('hearts', 'A'), c('clubs', 'A')]);
      const res = ActionHandlers.handlePlayMeld(room, 'p1', seq, undefined);
      expect(res.success).to.equal(true);
      expect(res.broadcast.isBuraco).to.equal(true);
      expect(res.broadcast.clean).to.equal(true);
    });

    it('a different-suit 2 extending a complete run is WILD (dirty) and counts toward wildCount', () => {
      const ext = [c('spades', '3'), c('spades', '4'), c('spades', '5'), c('diamonds', '2')];
      // 2♦ is NOT natural (suit differs from the spades run) -> it is a WILD.
      expect(GameValidator._isNaturalTwo(c('diamonds', '2'), ext)).to.equal(false);
      expect(GameValidator._isValidSequence(ext, 'professional')).to.equal(true);
      // A SAME-suit 2♠ extending the run sits consecutively (2-3-4-5) -> natural.
      const natExt = [c('spades', '3'), c('spades', '4'), c('spades', '5'), c('spades', '2')];
      expect(GameValidator._isNaturalTwo(c('spades', '2'), natExt)).to.equal(true);
      // TWO different-suit 2s both count as WILD -> exceeds the 1-wild limit
      // (pre-fix they were wrongly treated as natural and accepted).
      const twoOffSuit = [
        c('spades', '3'), c('spades', '4'), c('spades', '5'),
        c('diamonds', '2'), c('hearts', '2'),
      ];
      expect(GameValidator._isValidSequence(twoOffSuit, 'professional')).to.equal(false);
    });

    it('a natural-2 sequence A-2-3 of the SAME suit is still CLEAN', () => {
      const natural = [c('spades', 'A'), c('spades', '2'), c('spades', '3')];
      expect(GameValidator._isNaturalTwo(c('spades', '2'), natural)).to.equal(true);
      expect(GameValidator._isCleanMeld(natural)).to.equal(true);
      expect(GameValidator.meldClean(natural, 'professional', false)).to.equal(true);
    });
  });

  describe('#11 target score ends the match', () => {
    it('flags matchEnded with the leading team when cumulative reaches the target', () => {
      const room = makeRoom();
      room.targetScore = 1000;
      room.cumulativeTeamScores.set('teamA', 1000);
      // Give the closing side a real winning round: a completed brazilia and its
      // well. Without them the round now carries -200 (no brazilia) and -100 (no
      // well), dragging the cumulative back BELOW the target — correct scoring,
      // but it would stop this test exercising the match-end flag it exists for.
      // A side that goes out is holding a brazilia anyway.
      room.playerMelds.set('p1', [Array.from({ length: 7 }, () => c('hearts', '3'))]);
      room.playerHasTakenPozzetto.set('p1', true);
      const result = ActionHandlers._finalizeRound(room, 'p1');
      expect(result.matchEnded).to.equal(true);
      expect(result.matchWinnerTeam).to.equal('teamA');
      expect(result.matchWinnerIndex).to.equal(0);
      expect(result.targetScore).to.equal(1000);
    });

    it('does not flag a match end when targetScore is 0 (single round)', () => {
      const room = makeRoom();
      room.targetScore = 0;
      room.cumulativeTeamScores.set('teamA', 5000);
      const result = ActionHandlers._finalizeRound(room, 'p1');
      expect(result.matchEnded).to.equal(undefined);
    });

    it('a terminal match emits the cumulative leader as winnerId/winnerIndex, not the round-out player', () => {
      const room = makeRoom();
      room.targetScore = 1000;
      // teamA leads on cumulative (the buffer survives the round's no-well
      // penalty); the round itself is won (batida) by p2 on teamB.
      room.cumulativeTeamScores.set('teamA', 2000);
      const result = ActionHandlers._finalizeRound(room, 'p2');
      expect(result.matchEnded).to.equal(true);
      // The standard winner fields point at the match (cumulative) winner...
      expect(result.matchWinnerTeam).to.equal('teamA');
      expect(result.winnerId).to.equal('p1');
      expect(result.winnerIndex).to.equal(0);
      expect(result.winningTeam).to.equal('teamA');
      // ...while the per-round (batida) winner is preserved separately.
      expect(result.roundWinnerId).to.equal('p2');
      expect(result.roundWinnerIndex).to.equal(1);
    });
  });

  describe('room settings revert (config default applied once)', () => {
    const apply = (room, data) =>
      SocketHandlers.prototype._applyRoomSettings.call({}, room, data);

    it('an omitted targetScore on a 2nd sync does NOT reset an explicit single-round 0', () => {
      const room = new GameRoom({ roomId: 'cfg', maxPlayers: 2 });
      // First sync explicitly chooses single-round (targetScore 0).
      apply(room, { targetScore: 0 });
      expect(room.targetScore).to.equal(0);
      // A later partial sync (e.g. _rebuildRoomFromBackend) omits the field.
      apply(room, {});
      expect(room.targetScore).to.equal(0);
    });

    it('seeds the config default only on the first configure when the field is omitted', () => {
      const room = new GameRoom({ roomId: 'cfg', maxPlayers: 2 });
      apply(room, {}); // first configure, omitted -> config default
      expect(room.targetScore).to.equal(1000);
      // A later sync that sets it explicitly still wins.
      apply(room, { targetScore: 1500 });
      expect(room.targetScore).to.equal(1500);
      // ...and a subsequent omission leaves the explicit value untouched.
      apply(room, {});
      expect(room.targetScore).to.equal(1500);
    });
  });

  describe('the single-card squeeze forces a deck draw', () => {
    it('rejects taking the pile at hand==1 & pile==1 (PRO base rule)', () => {
      const room = makeRoom();
      room.hasDrawnCard = false;
      // The rule's premise is "draw from the deck instead", so the guard only
      // holds while a deck draw is possible — keep the stock alive here (the
      // dead-stock suspension is covered by deck_out_stuck.test.js).
      room.deck = new Deck();
      room.deck.cards = [c('hearts', '9')];
      room.playerHands.set('p1', [c('spades', 'A')]);
      room.discardPile = [c('clubs', '7')];
      const res = ActionHandlers.handlePickUpPile(room, 'p1', room.discardPile.slice());
      expect(res.success).to.equal(false);
      expect(res.reason).to.equal('squeezedPileTake');
    });

    it('allows the same pile once the stock is dead — the guard suspends itself', () => {
      // No deck and no pozzetto: "draw instead" is unsatisfiable, so the guard
      // lifts rather than leaving the seat with no legal move at all.
      const room = makeRoom();
      room.hasDrawnCard = false;
      room.playerHands.set('p1', [c('spades', 'A')]);
      room.discardPile = [c('clubs', '7')];
      const res = ActionHandlers.handlePickUpPile(room, 'p1', room.discardPile.slice());
      expect(res.success).to.equal(true);
    });

    it('allows the pile when hand has more than one card', () => {
      const room = makeRoom();
      room.hasDrawnCard = false;
      room.playerHands.set('p1', [c('spades', 'A'), c('spades', 'K')]);
      room.discardPile = [c('clubs', '7')];
      const res = ActionHandlers.handlePickUpPile(room, 'p1', room.discardPile.slice());
      expect(res.success).to.equal(true);
    });

    it('is a no-op in classic — the guard is professional-only', () => {
      const room = makeRoom({ ruleset: 'classic' });
      room.hasDrawnCard = false;
      room.playerHands.set('p1', [c('spades', 'A')]);
      room.discardPile = [c('clubs', '7')];
      const res = ActionHandlers.handlePickUpPile(room, 'p1', room.discardPile.slice());
      expect(res.success).to.equal(true);
    });
  });

  describe('#6 discarding a deck-drawn card is allowed', () => {
    it('validateDiscard allows the drawn card when the deck-draw restriction is clear', () => {
      const room = makeRoom();
      const drawn = c('spades', '9');
      room.playerHands.set('p1', [drawn, c('hearts', '3'), c('hearts', '4')]);
      room.meldedThisTurn = false;
      // Deck draw no longer populates the restriction (#6).
      room.drawnCardThisTurnRestriction = new Set();
      const ok = GameValidator.validateDiscard(room, 'p1', drawn);
      expect(ok.isValid).to.equal(true);

      // House rule: a SINGLE-card take sets the restriction, which DOES block the
      // immediate discard of that card (the player must discard a different card).
      room.drawnCardThisTurnRestriction = new Set([String(drawn.cardId)]);
      const blocked = GameValidator.validateDiscard(room, 'p1', drawn);
      expect(blocked.isValid).to.equal(false);
      expect(blocked.reason).to.equal('drawnCardRestriction');
    });
  });
});
