/* eslint-env mocha */

/**
 * The 2-wells-per-team cap is PER ROUND. It was leaking across rounds.
 *
 * REPORTED: "A took one pozzetto in round 1. Next round A can only take one
 * more — the second take ends the game instead. It behaves as if a player gets
 * two takes for the WHOLE session, not two per round."
 *
 * Cause: _markTeamPozzettoTaken writes the count under the TEAM key
 * (`playerDeadPileCount.set('teamA', n)`) and _teamDeadPileCount reads that key
 * FIRST — but startGame()'s per-round reset only walks `this.players`, so it
 * clears the playerId keys and never touches teamA/teamB. Last round's total
 * survived and kept winning the lookup.
 *
 * The same leak hits playerHasTakenPozzetto, which is worse than a miscount: a
 * side starts round 2+ already flagged as having taken a well, so the "take the
 * well before going out" gate waves a close through and the scoring hands out
 * the +100 well bonus for a well nobody took.
 */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom, PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');

function seatedRoom() {
  const room = new GameRoom({ roomId: 'well-reset', maxPlayers: 2 });
  room.status = GameRoomStatus.IN_PROGRESS;
  for (let i = 0; i < 2; i += 1) {
    room.addPlayer(
      new PlayerSession({
        playerId: `p${i + 1}`,
        playerName: `P${i + 1}`,
        playerIndex: i,
        socketId: `s${i + 1}`,
      })
    );
  }
  return room;
}

describe('#the 2-well cap is per ROUND, not per session', () => {
  it('startGame() clears a count written under the TEAM key', () => {
    const room = seatedRoom();
    ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
    expect(ActionHandlers._teamDeadPileCount(room, 'p1')).to.equal(1);

    // This is the exact call the next-round scheduler makes.
    room.startGame(true);

    expect(
      ActionHandlers._teamDeadPileCount(room, 'p1'),
      'round 2 starts with both wells owed to nobody'
    ).to.equal(0);
  });

  it('startGame() clears the "already took a well" flag too', () => {
    // Worse than a miscount: this one lets a side CLOSE without taking a well,
    // and pays it the +100 well bonus at scoring.
    const room = seatedRoom();
    ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
    expect(ActionHandlers._teamHasTakenPozzetto(room, 'p1')).to.equal(true);

    room.startGame(true);

    expect(ActionHandlers._teamHasTakenPozzetto(room, 'p1')).to.equal(false);
  });

  it('a full round 1 does not eat into round 2 allowance', () => {
    const room = seatedRoom();
    // Round 1: this side takes BOTH wells — the cap, legitimately.
    ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
    ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'indirect');
    expect(ActionHandlers._teamDeadPileCount(room, 'p1')).to.equal(2);

    room.startGame(true);
    room.deadPiles = [
      Array.from({ length: 11 }, () => ({ suit: 'clubs', rank: '3' })),
      Array.from({ length: 11 }, () => ({ suit: 'clubs', rank: '3' })),
    ];

    expect(
      ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', false),
      'the new round hands the wells back'
    ).to.equal(true);
    ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'direct');
    expect(
      ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', false),
      'and one take in round 2 is only the FIRST of two'
    ).to.equal(true);
  });
});
