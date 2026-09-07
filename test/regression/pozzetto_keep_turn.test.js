/**
 * An INDIRECT well take ENDS the turn.
 *
 * Discarding the last card auto-takes the well, and — like any other discard —
 * that is the end of the turn. The refilled 11-card hand is played from the next
 * time the table comes around.
 *
 * This file used to assert the opposite: a house rule handed the turn back to
 * the taker so they played the whole well out immediately. That is the reported
 * bug ("first player to take the 11 deck; they dont continue playing the round
 * even if there is time left"), so the expectations below are inverted on
 * purpose — the scenarios are kept because they still cover the take itself, the
 * two-well cap, and the professional 75-point interaction.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const GameService = require('../../src/services/GameService');

function dealtRoom(ruleset) {
  const service = new GameService();
  const room = service.createRoom(`keep-turn-${ruleset}`, 2);
  service.joinRoom(room.roomId, 'p1', 'P1', 's1');
  service.joinRoom(room.roomId, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  room.ruleset = ruleset;
  room.currentTurn = 0;
  return { service, room };
}

const lastCard = () => ({ suit: 'hearts', rank: '5', cardId: 9001 });

describe('#pozzetto indirect take (the take ENDS the turn)', () => {
  it('classic: discarding the last card takes the pot and ENDS the turn', () => {
    const { service, room } = dealtRoom('classic');
    room.hasDrawnCard = true;
    room.playerHands.set('p1', [lastCard()]);

    const result = ActionHandlers.handleDiscard(room, 'p1', lastCard());
    expect(result.success).to.equal(true);
    expect(result.broadcast.pozzettoTaken).to.equal(11);
    // The well is taken, but the turn moves on — the taker does NOT play it now.
    expect(result.turnKept).to.equal(undefined);
    expect(result.turnChanged).to.not.equal(undefined);
    expect(room.currentTurn).to.equal(1);
    expect((room.playerHands.get('p1') || []).length).to.equal(11);
    expect(room.hasDrawnCard).to.equal(false);

    service.deleteRoom(room.roomId);
  });

  it('classic: the refilled hand waits for the taker\'s next turn', () => {
    const { service, room } = dealtRoom('classic');
    room.hasDrawnCard = true;
    room.playerHands.set('p1', [lastCard()]);
    ActionHandlers.handleDiscard(room, 'p1', lastCard());

    // Opponent is on turn; p1's 11 cards are untouched and p1 must draw again
    // when play returns, exactly like any other seat starting a turn.
    expect(room.currentTurn).to.equal(1);
    expect((room.playerHands.get('p1') || []).length).to.equal(11);
    expect(room.hasDrawnCard).to.equal(false);

    service.deleteRoom(room.roomId);
  });

  it('classic: the SECOND well of the round IS takeable by discarding', () => {
    const { service, room } = dealtRoom('classic');

    // First well already gone (taken by this side).
    room.playerHands.set('p1', []);
    ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true);
    expect(room.wellsTakenThisRound).to.equal(1);

    // House rule: emptying the hand by DISCARDING reaches the remaining well
    // too. Only the 2-per-team cap limits it.
    expect(
      ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', true)
    ).to.equal(true);
    expect(
      ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', false)
    ).to.equal(true);

    // End to end, the validator accepts the discard AND flags the take, so the
    // client is told the turn continues rather than the round closing.
    room.hasDrawnCard = true;
    room.playerHands.set('p1', [lastCard()]);
    const check = GameValidator.validateDiscard(room, 'p1', lastCard());
    expect(check.isValid).to.equal(true);
    expect(check.willTakePozzetto).to.equal(true);

    service.deleteRoom(room.roomId);
  });

  it('classic: a THIRD take is refused once the team is capped at two', () => {
    const { service, room } = dealtRoom('classic');

    room.playerHands.set('p1', []);
    ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true);
    room.playerHands.set('p1', []);
    ActionHandlers._autoTakeDeadIfNeeded(room, 'p1', true);
    expect(GameValidator._teamDeadPileCount(room, 'p1')).to.equal(2);

    // The cap is what stops the loop now that the "first well only" gate is
    // gone. Client and server must agree here or the turn hangs.
    expect(
      ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', true)
    ).to.equal(false);
    expect(
      GameValidator._canTakeWellAfterEmptyHand(room, 'p1', true)
    ).to.equal(false);

    service.deleteRoom(room.roomId);
  });

  it('professional (indirect mode): the take still ends the turn once a Brazilia is held', () => {
    const { service, room } = dealtRoom('professional');
    room.professionalWellMode = 'indirect';
    const brazilia = Array.from({ length: 7 }, (_, i) => ({ suit: 'spades', rank: '4', cardId: 200 + i }));
    room.playerMelds.set('p1', [brazilia]);

    room.hasDrawnCard = true;
    room.playerHands.set('p1', [lastCard()]);
    const result = ActionHandlers.handleDiscard(room, 'p1', lastCard());
    expect(result.success).to.equal(true);
    expect(result.broadcast.pozzettoTaken).to.equal(11);
    expect(result.turnKept).to.equal(undefined);
    expect(room.currentTurn).to.equal(1);
    expect((room.playerHands.get('p1') || []).length).to.equal(11);
    expect(room.hasDrawnCard).to.equal(false);

    service.deleteRoom(room.roomId);
  });

  it('a turn that melds NOTHING is not charged the minimum-meld penalty', () => {
    const { service, room } = dealtRoom('professional');
    room.professionalWellMode = 'indirect';
    const brazilia = Array.from({ length: 7 }, (_, i) => ({ suit: 'spades', rank: '4', cardId: 300 + i }));
    room.playerMelds.set('p1', [brazilia]);

    // Arm the 75-point requirement for p1's team with no meld points this turn.
    const teamKey = ActionHandlers._teamKeyForPlayer(room, 'p1');
    room.teamRequiredMeldPoints.set(teamKey, 75);
    room.teamMeldPointsThisTurn.set(teamKey, 0);

    room.hasDrawnCard = true;
    room.playerHands.set('p1', [lastCard()]);
    ActionHandlers.handleDiscard(room, 'p1', lastCard());

    // A turn that lays NOTHING is not a failed going-down — it is every ordinary
    // turn before a side goes down, and charging 100 for each of those would be
    // punitive nonsense. The penalty needs an actual meld that fell short.
    expect(room.teamTurnPenalty.get(teamKey) || 0).to.equal(0);
    expect(room.teamTurnPenalty.get('p1') || 0).to.equal(0);
    expect(
      room.teamRequiredMeldPoints.get(teamKey),
      'and the bar is left where it was'
    ).to.equal(75);

    service.deleteRoom(room.roomId);
  });
});
