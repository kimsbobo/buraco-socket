/**
 * DIRECT well mode — the close, and who owns the brazilia that unlocks it.
 *
 * Direct means every card leaves the hand by being MELDED: no discarding a last
 * card to go out, and no reaching the well that way either. A meld-out is
 * therefore the ONLY close the mode has, which puts all the weight on
 * _checkInstantEnd.
 *
 * That clause used to read the ACTOR'S own melds while GameValidator's closing
 * discard, _canTakeWellAfterEmptyHand and the -200 noBrazilia penalty all read
 * the SIDE's. In 2v2 direct the mismatch was terminal: a team whose canasta sat
 * on the partner's half of the table could never end the round at all — the
 * Flutter client (which has always been team-scoped) called the close legal and
 * the server answered "You cannot go out by melding your last card".
 */
/* eslint-env mocha */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const { GameRoom } = require('../../src/models');
const { Card } = require('../../src/models/Deck');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');

const c = (rank, suit) => new Card(suit, rank);
const SPADE_RUN = (n = 7) =>
  ['4', '5', '6', '7', '8', '9', '10'].slice(0, n).map((r) => c(r, 'spades'));
const KINGS = () => [c('K', 'hearts'), c('K', 'diamonds'), c('K', 'clubs')];

/** Seated, dealt-by-hand room. Seats 0/2 are teamA, 1/3 teamB. */
function makeRoom({
  seats = 4,
  ruleset = 'classicWithNoJoker',
  wellMode = 'direct',
  wells = 0,
} = {}) {
  const room = new GameRoom({ roomId: 'direct-room', maxPlayers: seats });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.professionalWellMode = wellMode;
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  room.turnTimeLimit = 30;
  for (let i = 0; i < seats; i += 1) {
    room.addPlayer(
      new PlayerSession({
        playerId: `p${i + 1}`,
        playerName: `P${i + 1}`,
        playerIndex: i,
        socketId: `s${i + 1}`,
      })
    );
    room.playerHands.set(`p${i + 1}`, []);
    room.playerMelds.set(`p${i + 1}`, []);
  }
  room.deadPiles = Array.from({ length: wells }, () =>
    Array.from({ length: 11 }, () => c('3', 'clubs'))
  );
  return room;
}

describe('#direct well mode', () => {
  // WHICH WINS when both are legal: the second pozzetto is still takeable (the
  // side is under the 2-per-team cap) AND the close requirements are met (a well
  // already taken, a brazilia down). The TAKE wins — handleAddToMeld runs
  // _autoTakeDeadIfNeeded BEFORE _checkInstantEnd, so the hand refills to 11 and
  // the turn carries on. Consequence worth knowing: a round cannot end while a
  // pozzetto is still on the table and the closing side is under the cap. The
  // Flutter client agrees (maybeTakeDeadPileAfterHandEmpty runs before its
  // round-end failsafe).
  describe('second pozzetto vs closing the round', () => {
    const board = ({ wellsLeft, wellsTaken }) => {
      const room = makeRoom({ seats: 2, ruleset: 'professional', wellMode: 'indirect', wells: wellsLeft });
      room.playerMelds.set('p1', [SPADE_RUN(7)]);
      room.playerMeldOrders.set('p1', [1]);
      room.discardPile = [c('9', 'clubs'), c('4', 'diamonds')];
      for (let i = 0; i < wellsTaken; i += 1) ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      room.playerHands.set('p1', [c('J', 'spades'), c('Q', 'spades')]);
      return room;
    };

    it('under the cap: emptying the hand TAKES the second pozzetto', () => {
      const room = board({ wellsLeft: 1, wellsTaken: 1 });
      const hand = [...room.playerHands.get('p1')];
      const res = ActionHandlers.handleAddToMeld(room, 'p1', hand, 0, 0);

      expect(res.success, res.error).to.equal(true);
      expect(res.roundEnded, 'the well is collected, not declined').to.equal(undefined);
      expect(room.playerHands.get('p1')).to.have.length(11);
      expect(ActionHandlers._teamDeadPileCount(room, 'p1')).to.equal(2);
    });

    it('at the cap (none left): the same meld-out CLOSES the round', () => {
      const room = board({ wellsLeft: 0, wellsTaken: 2 });
      const hand = [...room.playerHands.get('p1')];
      const res = ActionHandlers.handleAddToMeld(room, 'p1', hand, 0, 0);

      expect(res.success, res.error).to.equal(true);
      expect(room.playerHands.get('p1')).to.have.length(0);
      expect(res.roundEnded).to.not.equal(undefined);
    });

    it('one well each: nothing left to take, so it closes', () => {
      const room = board({ wellsLeft: 0, wellsTaken: 1 });
      const hand = [...room.playerHands.get('p1')];
      const res = ActionHandlers.handleAddToMeld(room, 'p1', hand, 0, 0);

      expect(res.success, res.error).to.equal(true);
      expect(res.roundEnded).to.not.equal(undefined);
    });
  });

  // END-TO-END for the exact reported hand: 2♠ + 3♥ against a heart run ♥4..K and
  // a spade run ♠5-8. Direct never lets the last card be DISCARDED, so the whole
  // turn hangs on the meld-out exit being open — walk it to the end, because "the
  // add went through" is only half an answer while the leftover is still in hand.
  describe('the reported hand, played to the end of the turn', () => {
    const board = (wells) => {
      const room = makeRoom({ seats: 2, ruleset: 'professional', wellMode: 'direct', wells });
      const heart = ['4','5','6','7','8','9','10','J','Q','K'].map((r) => c(r, 'hearts'));
      const spade = ['5','6','7','8'].map((r) => c(r, 'spades'));
      room.playerMelds.set('p1', [heart, spade]);
      room.playerMeldOrders.set('p1', [1, 2]);
      room.discardPile = [c('9', 'clubs'), c('4', 'diamonds')];
      room.playerHands.set('p1', [c('2', 'spades'), c('3', 'hearts')]);
      if (!wells) ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      return room;
    };

    it('a well on the table: the meld-out COLLECTS it, turn continues', () => {
      const room = board(2);
      // The hand's OWN instance: _takeCardsFromHand matches on cardId, so a
      // freshly built 3♥ is "not found in hand".
      const three = room.playerHands.get('p1').find((x) => x.rank === '3');
      const first = ActionHandlers.handleAddToMeld(room, 'p1', [three], 0, 0);
      expect(first.success, first.error).to.equal(true);
      const lone = room.playerHands.get('p1')[0];
      const disc = GameValidator.validateDiscard(room, 'p1', lone);
      expect(disc.isValid, 'direct never discards the last card').to.equal(false);
      expect(disc.reason).to.equal('invalidClose');
      const out = ActionHandlers.handleAddToMeld(room, 'p1', [lone], 0, 1);
      expect(out.success, out.error).to.equal(true);
      expect(room.playerHands.get('p1')).to.have.length(11);
      expect(out.roundEnded).to.equal(undefined);
    });

    it('no well left: the same meld-out CLOSES the round', () => {
      const room = board(0);
      const three = room.playerHands.get('p1').find((x) => x.rank === '3');
      const first = ActionHandlers.handleAddToMeld(room, 'p1', [three], 0, 0);
      expect(first.success, first.error).to.equal(true);
      const lone = room.playerHands.get('p1')[0];
      expect(GameValidator.validateDiscard(room, 'p1', lone).isValid).to.equal(false);
      const out = ActionHandlers.handleAddToMeld(room, 'p1', [lone], 0, 1);
      expect(out.success, out.error).to.equal(true);
      expect(room.playerHands.get('p1')).to.have.length(0);
      expect(out.roundEnded, 'the round closed on the meld-out').to.not.equal(undefined);
    });
  });

  // The leftover that PAYS FOR ITSELF: shed down to the card that completes a
  // six-long meld, lay it as the seventh, and collect the well with the brazilia
  // it just earned. The most natural professional line there is — and the guard
  // refused it in BOTH well modes.
  //
  // _handHasLegalMeldOut asked _canTakeWellAfterEmptyHand about the table BEFORE
  // the add, so with no brazilia down yet it answered "no legal meld-out" and
  // _rejectIllegalMeldOut rolled the whole shed back ("cards jump back"). The
  // same add, actually performed, reaches _autoTakeDeadIfNeeded with the meld
  // already seven long, takes the well and refills the hand to 11 — the guard was
  // stricter than the executor it guards.
  describe('the leftover completes the brazilia that unlocks the well', () => {
    ['direct', 'indirect'].forEach((wellMode) => {
      it(`${wellMode}: the guard agrees with the executor`, () => {
        const room = makeRoom({ seats: 2, ruleset: 'professional', wellMode, wells: 2 });
        room.playerMelds.set('p1', [SPADE_RUN(6)]);
        room.playerMeldOrders.set('p1', [1]);
        const lone = c('10', 'spades');
        room.playerHands.set('p1', [lone]);

        expect(
          ActionHandlers._teamHasAnyBrazilia(room, 'p1'),
          'the run is six long — no brazilia YET'
        ).to.equal(false);
        expect(
          ActionHandlers._handHasLegalMeldOut(room, 'p1'),
          'the add completes the brazilia, which is what unlocks the well'
        ).to.equal(true);

        const res = ActionHandlers.handleAddToMeld(room, 'p1', [lone], 0, 0);
        expect(res.success, 'and the executor performs it').to.equal(true);
        expect(
          (room.playerHands.get('p1') || []).length,
          'the well refilled the hand — the turn continues'
        ).to.equal(11);
      });
    });

    it('a leftover with no legal add is still refused', () => {
      // The fix must not degrade into "any leftover is fine".
      const room = makeRoom({ seats: 2, ruleset: 'professional', wellMode: 'direct', wells: 2 });
      room.playerMelds.set('p1', [SPADE_RUN(6)]);
      room.playerMeldOrders.set('p1', [1]);
      room.playerHands.set('p1', [c('4', 'hearts')]);

      expect(ActionHandlers._handHasLegalMeldOut(room, 'p1')).to.equal(false);
    });
  });

  describe('the meld-out close is TEAM scoped', () => {
    it('closes when the PARTNER holds the brazilia', () => {
      const room = makeRoom();
      // p1 is seat 0 (teamA); p3 is seat 2, its partner.
      room.playerMelds.set('p3', [SPADE_RUN()]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      const kings = KINGS();
      room.playerHands.set('p1', [...kings]);

      const res = ActionHandlers.handlePlayMeld(room, 'p1', kings);

      expect(res.success).to.equal(true);
      expect(res.roundEnded, 'the round closed on the meld-out').to.not.equal(undefined);
      expect(room.playerHands.get('p1')).to.have.length(0);
    });

    it('closes when the ACTOR holds it, unchanged', () => {
      const room = makeRoom();
      room.playerMelds.set('p1', [SPADE_RUN()]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      const kings = KINGS();
      room.playerHands.set('p1', [...kings]);

      const res = ActionHandlers.handlePlayMeld(room, 'p1', kings);
      expect(res.success).to.equal(true);
      expect(res.roundEnded).to.not.equal(undefined);
    });

    it('an OPPONENT brazilia unlocks nothing', () => {
      const room = makeRoom();
      // p2 is seat 1 — the other side.
      room.playerMelds.set('p2', [SPADE_RUN()]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      const kings = KINGS();
      room.playerHands.set('p1', [...kings]);

      const res = ActionHandlers.handlePlayMeld(room, 'p1', kings);
      expect(res.success).to.equal(false);
      expect(res.reason).to.equal('mustKeepDiscard');
      expect(room.playerHands.get('p1'), 'rolled back').to.have.length(3);
    });

    it('still owes a well while one is on the table', () => {
      const room = makeRoom({ wells: 1 });
      room.playerMelds.set('p3', [SPADE_RUN()]);
      const kings = KINGS();
      room.playerHands.set('p1', [...kings]);

      const res = ActionHandlers.handlePlayMeld(room, 'p1', kings);

      // Not a close — the empty hand pulls the well in and the turn continues.
      expect(res.success).to.equal(true);
      expect(res.roundEnded).to.equal(undefined);
      expect(room.playerHands.get('p1'), 'refilled from the well').to.have.length(11);
    });
  });

  describe('an add-to-meld may both complete the brazilia and close', () => {
    // The last card of a direct hand is very often the seventh of a run, and
    // that add is what earns the brazilia the close requires. The handler
    // applies the add BEFORE asking _checkInstantEnd, so it sees the finished
    // canasta — the Flutter client used to judge the same play on the pre-add
    // table and refuse it.
    it('closes on the seventh card played as the last card in hand', () => {
      const room = makeRoom({ seats: 2 });
      room.playerMelds.set('p1', [SPADE_RUN(6)]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      const seventh = c('10', 'spades');
      room.playerHands.set('p1', [seventh]);

      const res = ActionHandlers.handleAddToMeld(room, 'p1', [seventh], 0, 0);

      expect(res.success).to.equal(true);
      expect(res.roundEnded).to.not.equal(undefined);
      expect(room.playerHands.get('p1')).to.have.length(0);
    });
  });

  describe('the TWO-STEP direct close: meld the run, then lay the last card', () => {
    // A turn does not have to end on a DISCARD, and in DIRECT it cannot. The
    // guard only asked "is a discardable card left?", so melding three of four
    // cards left one card with no legal discard and the whole meld was rolled
    // back — the ordinary way a direct hand ends was impossible, the entire hand
    // had to go down in a SINGLE action. The Flutter client allows the shed, so
    // this was also a client-allows/server-rejects desync: the board applied the
    // meld and the server snapped it back.
    it('the leftover extends a canasta already on the table', () => {
      const room = makeRoom({ seats: 2 });
      room.playerMelds.set('p1', [SPADE_RUN()]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      const jack = c('J', 'spades'); // extends the 4..10 run
      const kings = KINGS();
      room.playerHands.set('p1', [jack, ...kings]);

      const step1 = ActionHandlers.handlePlayMeld(room, 'p1', kings);
      expect(step1.success, step1.error).to.equal(true);
      expect(step1.roundEnded, 'not a close yet — one card left').to.equal(undefined);
      expect(room.playerHands.get('p1')).to.have.length(1);

      const step2 = ActionHandlers.handleAddToMeld(room, 'p1', [jack], 0, 0);
      expect(step2.success, step2.error).to.equal(true);
      expect(step2.roundEnded, 'the add closed the round').to.not.equal(undefined);
    });

    it('the leftover is the SEVENTH card and earns the canasta itself', () => {
      const room = makeRoom({ seats: 2 });
      room.playerMelds.set('p1', [SPADE_RUN(6)]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      const seventh = c('10', 'spades');
      const kings = KINGS();
      room.playerHands.set('p1', [seventh, ...kings]);

      expect(ActionHandlers.handlePlayMeld(room, 'p1', kings).success).to.equal(true);
      const step2 = ActionHandlers.handleAddToMeld(room, 'p1', [seventh], 0, 0);
      expect(step2.success).to.equal(true);
      expect(step2.roundEnded).to.not.equal(undefined);
    });

    it('the leftover meld-out would TAKE the well, so the shed is fine', () => {
      const room = makeRoom({ seats: 2, wells: 1 });
      room.playerMelds.set('p1', [SPADE_RUN()]);
      const jack = c('J', 'spades');
      const kings = KINGS();
      room.playerHands.set('p1', [jack, ...kings]);

      const step1 = ActionHandlers.handlePlayMeld(room, 'p1', kings);
      expect(step1.success, step1.error).to.equal(true);
      expect(room.playerHands.get('p1')).to.have.length(1);
    });

    // ...and the guard still does its original job.
    it('a leftover that fits NOTHING is still rolled back', () => {
      const room = makeRoom({ seats: 2 });
      room.playerMelds.set('p1', [SPADE_RUN()]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      const orphan = c('3', 'hearts');
      const kings = KINGS();
      room.playerHands.set('p1', [orphan, ...kings]);

      const res = ActionHandlers.handlePlayMeld(room, 'p1', kings);
      expect(res.success).to.equal(false);
      expect(res.reason).to.equal('mustKeepDiscard');
      expect(room.playerHands.get('p1'), 'rolled back').to.have.length(4);
    });

    it('a leftover that fits but whose meld-out is an ILLEGAL close is rolled back', () => {
      // Three 9s is a legal meld, not a canasta, and no well is left — so
      // emptying the hand onto it is neither a well take nor a legal close.
      const room = makeRoom({ seats: 2 });
      room.playerMelds.set('p1', [[c('9', 'hearts'), c('9', 'spades'), c('9', 'clubs')]]);
      const fourth = c('9', 'diamonds');
      const kings = KINGS();
      room.playerHands.set('p1', [fourth, ...kings]);

      const res = ActionHandlers.handlePlayMeld(room, 'p1', kings);
      expect(res.success).to.equal(false);
      expect(res.reason).to.equal('mustKeepDiscard');
    });
  });

  describe('a discard never closes and never reaches the well', () => {
    it('the last card is refused outright', () => {
      const room = makeRoom({ seats: 2 });
      room.playerMelds.set('p1', [SPADE_RUN()]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
      const lone = c('9', 'hearts');
      room.playerHands.set('p1', [lone]);

      const res = GameValidator.validateDiscard(room, 'p1', lone);
      expect(res.isValid).to.equal(false);
      expect(res.reason).to.equal('invalidClose');
    });

    it('and the same position in INDIRECT closes normally', () => {
      const room = makeRoom({ seats: 2, wellMode: 'indirect' });
      room.playerMelds.set('p1', [SPADE_RUN()]);
      ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'indirect');
      const lone = c('9', 'hearts');
      room.playerHands.set('p1', [lone]);

      expect(GameValidator.validateDiscard(room, 'p1', lone).isValid).to.equal(true);
    });

    it('the well is reachable by a meld-out and not by a discard', () => {
      const room = makeRoom({ seats: 2, wells: 1 });
      expect(ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', true)).to.equal(false);
      expect(ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', false)).to.equal(true);
      expect(GameValidator._canTakeWellAfterEmptyHand(room, 'p1', true)).to.equal(false);
      expect(GameValidator._canTakeWellAfterEmptyHand(room, 'p1', false)).to.equal(true);
    });
  });
});
