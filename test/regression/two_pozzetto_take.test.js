/**
 * House rule: ONE team/player may take BOTH pozzetti, up to a hard cap of 2 per
 * team. Only two pozzetti exist, so a fast side takes both and the other gets
 * none. Covers classic (no Brazilia gate) and professional (Brazilia required,
 * but still 2 allowed).
 *
 * BOTH wells may be reached indirectly (by discarding the last card) as well as
 * by melding out — the 2-per-team cap is the only limit. The scenarios below
 * therefore exercise the second take BOTH ways.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameService = require('../../src/services/GameService');

function dealtRoom(ruleset) {
  const service = new GameService();
  const room = service.createRoom(`two-well-${ruleset}`, 2);
  service.joinRoom(room.roomId, 'p1', 'P1', 's1');
  service.joinRoom(room.roomId, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.ruleset = ruleset;
  room.currentTurn = 0;
  return { service, room };
}

describe('#two-pozzetto take (one side takes both wells)', () => {
  it('classic: a team takes the first then the second pozzetto, then is capped', () => {
    const { service, room } = dealtRoom('classic');

    // Emptying the hand takes the FIRST well.
    room.playerHands.set('p1', []);
    const first = ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true);
    expect(first && first.takenCount).to.equal(11);
    expect(GameValidator._teamDeadPileCount(room, 'p1')).to.equal(1);

    // The SECOND well is reachable by a DISCARD too (the house-rule change).
    room.playerHands.set('p1', []);
    const second = ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true);
    expect(second && second.takenCount).to.equal(11);
    expect(GameValidator._teamDeadPileCount(room, 'p1')).to.equal(2);

    // Both wells gone → capped: no third take by EITHER route, and
    // validateTakePozzetto rejects. The cap is the only remaining limit, so it
    // is what has to hold.
    room.playerHands.set('p1', []);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true)).to.equal(null);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', false)).to.equal(null);
    const capped = GameValidator.validateTakePozzetto(room, 'p1');
    expect(capped.isValid).to.equal(false);

    service.deleteRoom(room.roomId);
  });

  it('classic: taking both wells leaves the opponent with none', () => {
    const { service, room } = dealtRoom('classic');

    room.playerHands.set('p1', []);
    ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true);
    room.playerHands.set('p1', []);
    ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', false);

    // p2 (team B) now has no well available at all.
    expect(GameValidator._pozzettoAvailable(room)).to.equal(false);
    expect(GameValidator._canTakeWellAfterEmptyHand(room, 'p2', true)).to.equal(false);

    service.deleteRoom(room.roomId);
  });

  it('professional: still allows 2 wells per side once a Brazilia is held', () => {
    const { service, room } = dealtRoom('professional');
    // A Brazilia (7-card meld) is required to take any professional well.
    const brazilia = Array.from({ length: 7 }, (_, i) => ({ suit: 'hearts', rank: '3', cardId: 100 + i }));
    room.playerMelds.set('p1', [brazilia]);

    room.playerHands.set('p1', []);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true)).to.not.equal(null);
    room.playerHands.set('p1', []);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', false)).to.not.equal(null);
    expect(GameValidator._teamDeadPileCount(room, 'p1')).to.equal(2);

    service.deleteRoom(room.roomId);
  });

  it('professional: the SECOND well by discard STILL needs the Brazilia', () => {
    const { service, room } = dealtRoom('professional');
    const brazilia = Array.from({ length: 7 }, (_, i) => ({ suit: 'hearts', rank: '3', cardId: 100 + i }));
    room.playerMelds.set('p1', [brazilia]);

    room.playerHands.set('p1', []);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true)).to.not.equal(null);

    // Lose the Brazilia (e.g. a rolled-back meld) and the remaining well is out
    // of reach again. Dropping the "first well only" gate must not have dropped
    // the professional requirement with it.
    room.playerMelds.set('p1', []);
    room.playerHands.set('p1', []);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true)).to.equal(null);
    expect(GameValidator._canTakeWellAfterEmptyHand(room, 'p1', true)).to.equal(false);

    service.deleteRoom(room.roomId);
  });

  it('direct well mode still refuses BOTH wells to a discard', () => {
    const { service, room } = dealtRoom('classic');
    room.professionalWellMode = 'direct';

    // Direct mode is orthogonal to the house rule: every card must be melded
    // down, so no discard ever reaches a well — first or second.
    room.playerHands.set('p1', []);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true)).to.equal(null);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', false)).to.not.equal(null);
    room.playerHands.set('p1', []);
    expect(ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true)).to.equal(null);

    service.deleteRoom(room.roomId);
  });

  it('the validator and the handler agree on every well question', () => {
    // The two predicates are hand-copied mirrors. A disagreement means the
    // validator accepts a discard the handler then refuses to act on, which
    // hangs the turn — the exact failure this suite exists to catch.
    const { service, room } = dealtRoom('classic');

    for (let take = 0; take <= 2; take += 1) {
      for (const byDiscard of [true, false]) {
        expect(
          ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', byDiscard),
          `take=${take} byDiscard=${byDiscard}`
        ).to.equal(GameValidator._canTakeWellAfterEmptyHand(room, 'p1', byDiscard));
      }
      room.playerHands.set('p1', []);
      ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true);
    }

    service.deleteRoom(room.roomId);
  });
});
