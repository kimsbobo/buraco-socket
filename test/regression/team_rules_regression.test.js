/* eslint-env mocha */

const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const { GameRoom, PlayerSession } = require('../../src/models');
const { GameRoomStatus } = require('../../src/constants');

const card = (suit, rank) => ({ suit, rank });

function makeRoom({ ruleset = 'classic' } = {}) {
  const room = new GameRoom({ roomId: 'team-rules', maxPlayers: 4 });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.currentTurn = 0;
  room.hasDrawnCard = true;

  for (let i = 0; i < 4; i += 1) {
    const playerId = `p${i + 1}`;
    room.addPlayer(new PlayerSession({
      playerId,
      playerName: `P${i + 1}`,
      playerIndex: i,
      socketId: `s${i + 1}`,
    }));
    room.playerHands.set(playerId, []);
    room.playerMelds.set(playerId, []);
    room.playerHasTakenPozzetto.set(playerId, false);
    room.playerDeadPileCount.set(playerId, 0);
    room.meldDirtyFlags.set(playerId, new Set());
  }

  room.deadPiles = [[card('clubs', '3')]];
  return room;
}

describe('team-based rule regression', () => {
  it('applies no-POT/well score once per side, not once per player', () => {
    const room = makeRoom();
    room.playerHasTakenPozzetto.set('p2', true);
    room.playerHasTakenPozzetto.set('p4', true);

    const { playerScores, teamScores } = ActionHandlers._computeScores(room, 'p2', 'indirect');

    expect(teamScores.teamA.pozzettoBonus).to.equal(-100);
    expect(playerScores[0].pozzettoBonus).to.equal(-100);
    expect(playerScores[2].pozzettoBonus).to.equal(0);

    // Nobody melded anything here, so BOTH sides also take the flat -100
    // no-brazilia penalty — charged once per SIDE, exactly like the well penalty
    // above, not once per player.
    expect(teamScores.teamA.noBraziliaPenalty).to.equal(100);
    expect(playerScores[0].noBraziliaPenalty).to.equal(100);
    expect(playerScores[2].noBraziliaPenalty).to.equal(0);

    // The two failures STACK (2026-08-27): -100 for the well it never took and
    // -100 for the brazilia it never completed.
    expect(teamScores.teamA.total).to.equal(-200);
    expect(teamScores.teamA.flatPenalty.reasons).to.deep.equal([
      'no_pozzetto',
      'no_brazilia',
    ]);

    expect(teamScores.teamB.pozzettoBonus).to.equal(100);
    expect(teamScores.teamB.goOutBonus).to.equal(100);
    expect(teamScores.teamB.noBraziliaPenalty).to.equal(100);
  });

  it('scores mirrored 2v2 team melds, bonuses, and penalties once per side', () => {
    const room = makeRoom();
    const teamMeld = [
      { suit: 'hearts', rank: '3', cardId: 1 },
      { suit: 'hearts', rank: '4', cardId: 2 },
      { suit: 'hearts', rank: '5', cardId: 3 },
      { suit: 'hearts', rank: '6', cardId: 4 },
      { suit: 'hearts', rank: '7', cardId: 5 },
      { suit: 'hearts', rank: '8', cardId: 6 },
      { suit: 'hearts', rank: '9', cardId: 7 },
    ];
    room.playerMelds.set('p1', [teamMeld]);
    room.playerMelds.set('p3', [teamMeld.map((c) => ({ ...c }))]);
    room.playerHands.set('p1', [card('spades', 'A')]);
    room.playerHands.set('p3', [card('clubs', 'K')]);
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerHasTakenPozzetto.set('p3', true);
    room.teamTurnPenalty.set('teamA', 20);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');

    expect(teamScores.teamA.meldPoints).to.equal(45);
    // 3-to-9 is a clean buraco. Royal is a separate COUNT, not a separate
    // price, so since 2026-09-02 any clean buraco pays 200.
    expect(teamScores.teamA.buracoBonus).to.equal(200);
    expect(teamScores.teamA.handPenalty).to.equal(25);
    expect(teamScores.teamA.pozzettoBonus).to.equal(100);
    expect(teamScores.teamA.goOutBonus).to.equal(100);
    expect(teamScores.teamA.turnPenalty).to.equal(20);
    // Both obligations were met, so nothing is voided. The minimum-meld charge
    // is a line item like any other and the side banks what it actually scored.
    expect(teamScores.teamA.rawTotal).to.equal(400);
    expect(teamScores.teamA.total).to.equal(400);
    expect(teamScores.teamA.flatPenalty).to.equal(null);
  });

  it('uses partner Brazilia and partner well state for side-level professional well validation', () => {
    const room = makeRoom({ ruleset: 'professional' });
    room.playerMelds.set('p3', [Array.from({ length: 7 }, () => card('hearts', '3'))]);
    room.playerHands.set('p1', []);

    const allowed = GameValidator.validateTakePozzetto(room, 'p1');
    expect(allowed.isValid).to.equal(true);

    // Partner p3's takes count toward teamA. Two wells is the cap (both
    // rulesets), so after the SIDE has taken both, p1 is blocked.
    ActionHandlers._markTeamPozzettoTaken(room, 'p3', 'direct');
    ActionHandlers._markTeamPozzettoTaken(room, 'p3', 'direct');
    room.ruleset = 'classic';
    const blocked = GameValidator.validateTakePozzetto(room, 'p1');
    expect(blocked.isValid).to.equal(false);
    expect(blocked.error).to.match(/already taken|All wells/i);
  });

  it('raises the SIDE\'s bar when a player falls short, and charges nothing', () => {
    // The minimum belongs to the side: A going down short hands A its cards back
    // and leaves the partner facing the raised 95. Since 2026-09-01 that is the
    // whole cost — no points change hands.
    const room = makeRoom({ ruleset: 'professional' });
    room.cumulativeTeamScores.set('teamA', 1000);

    ActionHandlers._startTurnForPlayer(room, 'p1');
    expect(room.teamRequiredMeldPoints.get('teamA')).to.equal(75);

    ActionHandlers._trackTurnMeldPoints(room, 'p1', [
      card('hearts', '3'),
      card('hearts', '4'),
      card('hearts', '5'),
    ]);
    const verdict = ActionHandlers._applyMinimumMeldRule(room, 'p1');

    expect(verdict.satisfied).to.equal(false);
    expect(verdict.penalty, 'no charge on the wire').to.equal(0);
    expect(room.teamTurnPenalty.get('p1') || 0, 'the player pays nothing').to.equal(0);
    expect(room.teamTurnPenalty.get('teamA'), 'and neither does the side').to.equal(undefined);
    expect(room.teamRequiredMeldPoints.get('teamA'), 'the side\'s bar rises').to.equal(95);

    // The partner now has to clear 95 — and does.
    ActionHandlers._startTurnForPlayer(room, 'p3');
    ActionHandlers._trackTurnMeldPoints(room, 'p3', [
      card('hearts', 'A'),
      card('diamonds', 'A'),
      card('clubs', 'A'),
      card('spades', 'A'),
      card('hearts', 'K'),
      card('diamonds', 'K'),
      card('clubs', 'K'),
      card('spades', 'K'),
    ]);
    const partner = ActionHandlers._applyMinimumMeldRule(room, 'p3');

    expect(partner.satisfied).to.equal(true);
    expect(room.teamTurnPenalty.get('p3'), 'no second penalty').to.equal(undefined);
    expect(
      room.teamRequiredMeldPoints.get('teamA'),
      'and the requirement is spent for the round'
    ).to.equal(0);
  });
});
