/**
 * Round-scoring and close rules reported as broken:
 *
 *  - a side that fails an obligation scores a FLAT -100 for the round: no well,
 *    no brazilia, or a minimum-meld charge. Terminal, not a deduction — every
 *    point it laid on the table is void (product decision 2026-08-23);
 *  - buraco bonuses: 2000 for a brazilia of 2s, 200 for a ROYAL run (one suit,
 *    natural, 2 through Ace), 100 for every other buraco;
 *  - the higher TOTAL wins the round — a 2000-point brazilia of 2s does not
 *    override it, and no longer ends the round on the spot;
 *  - DIRECT well mode: no discarding a last card to go out or to reach a well;
 *    melding the final cards onto an EXISTING meld is a legal close.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const { GameRoom } = require('../../src/models');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');

const c = (suit, rank, cardId) => ({ suit, rank, cardId });
const run = (suit, ranks, base) => ranks.map((r, i) => c(suit, r, base + i));

function makeRoom({ ruleset = 'classic', players = 2, wellMode = 'indirect' } = {}) {
  const room = new GameRoom({ roomId: `scoring-${ruleset}-${wellMode}`, maxPlayers: players });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.professionalWellMode = wellMode;
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

describe('#round scoring penalties', () => {
  it('charges -100 to a side that completed no brazilia', () => {
    const room = makeRoom();
    // A meld, but only 6 cards — not a brazilia.
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8'], 10)]);
    room.playerHasTakenPozzetto.set('p1', true);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.noBraziliaPenalty).to.equal(100);
  });

  it('charges nothing once the side completes a brazilia', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 20)]);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.noBraziliaPenalty).to.equal(0);
  });

  it('spares BOTH partners when the brazilia sits on the partner\'s melds', () => {
    const room = makeRoom({ players: 4 });
    // p3 is p1's partner (both even seats -> teamA).
    room.playerMelds.set('p3', [run('spades', ['3', '4', '5', '6', '7', '8', '9'], 30)]);

    const { teamScores, playerScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.noBraziliaPenalty).to.equal(0);
    expect(playerScores[0].noBraziliaPenalty).to.equal(0);
    // The opposing side still has nothing, so it takes the penalty.
    expect(teamScores.teamB.noBraziliaPenalty).to.equal(100);
  });

  it('charges -100 to a side that never took a well, +100 to one that did', () => {
    const room = makeRoom();
    room.playerHasTakenPozzetto.set('p1', true);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.pozzettoBonus).to.equal(100);
    expect(teamScores.teamB.pozzettoBonus).to.equal(-100);
  });

  it('STACKS: a side that failed both pays -100 twice', () => {
    const room = makeRoom();
    const { teamScores } = ActionHandlers._computeScores(room, 'p2', 'indirect');
    // Product decision 2026-08-27, reversing the flat charge of 2026-08-23:
    // missing the well and missing the brazilia are two separate failures and
    // cost -100 each. Before this they cost the same -100 between them.
    expect(teamScores.teamA.total).to.equal(-200);
    expect(teamScores.teamA.flatPenalty.value).to.equal(-200);
    expect(teamScores.teamA.flatPenalty.reasons).to.deep.equal([
      'no_pozzetto',
      'no_brazilia',
    ]);
  });
});

describe('#only failing BOTH obligations voids the round', () => {
  it('a fat round with a brazilia but no well is DENTED, not voided', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
    room.playerHasTakenPozzetto.set('p1', false);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    // Product decision 2026-08-27: "scorenya dikurangi -100 aja". The -100 for
    // the well it never took is already a line item, so the side simply keeps
    // what it earned minus that: 45 melded + 100 buraco - 100 no-well + 100
    // go-out.
    expect(teamScores.teamA.flatPenalty).to.equal(null);
    expect(teamScores.teamA.pozzettoBonus).to.equal(-100);
    // +100 vs before 2026-09-02: the clean buraco in this fixture pays 200 now.
    expect(teamScores.teamA.total).to.equal(245);
    expect(teamScores.teamA.total).to.equal(teamScores.teamA.rawTotal);
  });

  it('a turn penalty DENTS the round, it does not void it', () => {
    // No live rule produces a turn penalty any more — the minimum-meld charge
    // was removed 2026-09-01 — but the SCORING TERM stays: FailureManager
    // restores rooms persisted while the charge was live, and the wire field is
    // contract. Planted here the way a restored room carries one.
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
    room.playerHasTakenPozzetto.set('p1', true);
    room.teamTurnPenalty.set('p1', 100);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    // Both OBLIGATIONS were met — a well and a brazilia — so nothing is voided.
    // The charge is subtracted like any other line item.
    expect(teamScores.teamA.flatPenalty).to.equal(null);
    expect(teamScores.teamA.turnPenalty).to.equal(100);
    expect(teamScores.teamA.total).to.equal(teamScores.teamA.rawTotal);
    // +100: clean is 200 since 2026-09-02.
    expect(teamScores.teamA.total).to.equal(345); // 445 scored, minus the 100
  });

  it('a voided round does NOT count the cards left in hand', () => {
    // REVERSED 2026-09-02 by the product owner, who had asked for the opposite
    // on 2026-08-27: "yang ditangan player itu ga perlu dihitung". The void is
    // a flat verdict, so the hand is reported but not charged.
    const room = makeRoom();
    room.playerHands.set('p1', [c('spades', 'A', 90), c('clubs', 'K', 91)]);

    const { teamScores } = ActionHandlers._computeScores(room, 'p2', 'indirect');
    expect(teamScores.teamA.handPenalty).to.equal(25); // A=15, K=10 — reported
    expect(teamScores.teamA.total).to.equal(-200); // but not charged
  });

  it('the side that WENT OUT keeps its bonus and its round', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
    // Went out with a brazilia but no well — one failure, so a deduction only.
    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.goOutBonus).to.equal(100);
    expect(teamScores.teamA.flatPenalty).to.equal(null);
    // +100: clean is 200 since 2026-09-02.
    expect(teamScores.teamA.total).to.equal(245);
  });

  it('the cards in hand count when a PLAYER closed the round', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerHands.set('p1', [c('spades', 'A', 90), c('clubs', 'K', 91)]);

    // A non-null winnerId IS the "a player closed it" signal.
    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.handPenalty).to.equal(25);
  });

  it('and are FREE when nobody closed it', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerHands.set('p1', [c('spades', 'A', 90), c('clubs', 'K', 91)]);

    // Product decision 2026-08-27: "Jika game tertutup bukan oleh pemain,
    // artinya tidak ada kalkulasi pemotongan dari score ditangan." The figure is
    // reported as CHARGED, not raw, so a board drawing this row can never show a
    // deduction the ledger did not take.
    const { teamScores } = ActionHandlers._computeScores(room, null, null);
    expect(teamScores.teamA.handPenalty).to.equal(0);
  });

  it('scores normally once every obligation is met', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
    room.playerHasTakenPozzetto.set('p1', true);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.flatPenalty).to.equal(null);
    // 45 melds + 100 buraco + 100 well + 100 go-out.
    // +100: clean is 200 since 2026-09-02.
    expect(teamScores.teamA.total).to.equal(445);
  });

  it('carries the same verdict to BOTH partners of a 2v2 side, and charges it ONCE', () => {
    const room = makeRoom({ players: 4 });
    // No brazilia AND no well: both obligations failed, so the side is voided —
    // and the well and the buraco are both TEAM obligations, so the verdict
    // lands on the partner as hard as on p1.
    room.playerHasTakenPozzetto.set('p1', false);

    const { teamScores, playerScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.flatPenalty.reasons).to.deep.equal([
      'no_pozzetto',
      'no_brazilia',
    ]);
    expect(teamScores.teamA.total).to.equal(-200);

    // The VERDICT is on both rows...
    expect(playerScores[0].flatPenalty.reasons).to.deep.equal(playerScores[2].flatPenalty.reasons);
    expect(playerScores[0].flatPenalty.value).to.equal(-200);
    expect(playerScores[2].flatPenalty.value).to.equal(-200);
    // ...but the CHARGE lands once, on the lead. Both rows used to carry the
    // full -200, so the seats summed to -400 against a side that lost 200 — the
    // board contradicted itself, and _finalizeWith banked the doubled figure
    // into room.cumulativeScores.
    expect(playerScores[0].flatPenalty.chargedHere).to.equal(true);
    expect(playerScores[2].flatPenalty.chargedHere).to.equal(false);
    expect(playerScores[0].total).to.equal(-200);
    expect(playerScores[2].total).to.equal(0);
  });

  it('the seat rows always add up to the side', () => {
    // The invariant the void doubling broke. Every once-per-side item —
    // pozzettoBonus, noBraziliaPenalty and now the void charge — lands on the
    // lead only, so sum(seats) === team.total in EVERY branch.
    const sumSeats = (playerScores, teamId) =>
      Object.values(playerScores)
        .filter((row) => row.teamId === teamId)
        .reduce((sum, row) => sum + row.total, 0);

    const cases = {
      'a normal 2v2 round': () => {
        const room = makeRoom({ players: 4 });
        room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
        room.playerHasTakenPozzetto.set('p1', true);
        return [room, 'p1', 'indirect'];
      },
      'a 2v2 round voided for both reasons': () => {
        const room = makeRoom({ players: 4 });
        room.playerHasTakenPozzetto.set('p1', false);
        return [room, 'p1', 'indirect'];
      },
      'a 2v2 round with a PARTNER-charged turn penalty': () => {
        const room = makeRoom({ players: 4 });
        room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
        room.playerHasTakenPozzetto.set('p1', true);
        room.teamTurnPenalty.set('p3', 100);
        return [room, 'p1', 'indirect'];
      },
      'a no-batida round (nobody closed)': () => {
        const room = makeRoom({ players: 4 });
        room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 10)]);
        room.playerHasTakenPozzetto.set('p1', true);
        return [room, null, null];
      },
    };

    for (const [label, build] of Object.entries(cases)) {
      const [room, winner, batida] = build();
      const { playerScores, teamScores } = ActionHandlers._computeScores(room, winner, batida);
      for (const teamId of Object.keys(teamScores)) {
        expect(sumSeats(playerScores, teamId), `${label} / ${teamId}`).to.equal(
          teamScores[teamId].total
        );
      }
    }
  });
});

describe('#buraco bonuses', () => {
  const ROYAL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

  // 2026-09-02: the ladder is graded again. Reaching the Ace is no longer what
  // earns 200 -- holding no substitute wild is, and a 2-to-9 run whose 2 is
  // natural is clean. Royal remains a distinct COUNT, not a distinct price.
  it('pays 200 for a clean 2-to-9 run, though it is not royal', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ['2', '3', '4', '5', '6', '7', '8', '9'], 10)]);
    room.playerHasTakenPozzetto.set('p1', true);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.buracoCleanCount).to.equal(1);
    expect(teamScores.teamA.buracoRoyalCount).to.equal(0);
    expect(teamScores.teamA.buracoBonus).to.equal(200);
  });

  it('pays 200 only once the ladder is carried to the Ace', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [run('hearts', ROYAL, 10)]);
    room.playerHasTakenPozzetto.set('p1', true);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.buracoRoyalCount).to.equal(1);
    expect(teamScores.teamA.buracoBonus).to.equal(200);
  });

  it('pays 200 for a clean SET, however long', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [
      ['hearts', 'spades', 'clubs', 'diamonds', 'hearts', 'spades', 'clubs'].map((suit, i) =>
        c(suit, 'K', 60 + i)
      ),
    ]);
    room.playerHasTakenPozzetto.set('p1', true);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.buracoBonus).to.equal(200);
  });

  it('refuses the royal bonus to a ladder held together by a joker', () => {
    // Same 13 ranks, but the queen is a joker standing in for it.
    const jokered = run('hearts', ROYAL, 10);
    jokered[10] = c('hearts', 'joker', 99);
    expect(ActionHandlers._isRoyalRun(jokered)).to.equal(false);
  });

  it('refuses the royal bonus to a ladder whose 2 is a foreign suit', () => {
    const foreign = run('hearts', ROYAL, 10);
    foreign[0] = c('spades', '2', 98);
    expect(ActionHandlers._isRoyalRun(foreign)).to.equal(false);
  });

  it('still pays 2000 for a brazilia of 2s', () => {
    const room = makeRoom();
    room.playerMelds.set('p1', [Array.from({ length: 7 }, (_, i) => c('spades', '2', 400 + i))]);
    room.playerHasTakenPozzetto.set('p1', true);

    const { teamScores } = ActionHandlers._computeScores(room, 'p1', 'indirect');
    expect(teamScores.teamA.buracoBonus).to.equal(2000);
  });
});

describe('#winner is the higher total', () => {
  it('gives the round to the higher total even when the loser holds a 2000-point brazilia of 2s', () => {
    const room = makeRoom({ players: 4 });
    // BOTH sides build the 2s brazilia, so the 2000 cancels out and only the
    // surrounding score decides it: teamA took its well and went out, teamB did
    // neither and is caught holding cards.
    room.playerMelds.set('p1', [Array.from({ length: 7 }, (_, i) => c('spades', '2', 400 + i))]);
    room.playerMelds.set('p2', [Array.from({ length: 7 }, (_, i) => c('hearts', '2', 420 + i))]);
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerHands.set('p2', [c('spades', 'A', 440), c('hearts', 'A', 441)]);

    const { teamScores, winningTeam } = ActionHandlers._computeScores(room, 'p1', 'direct');
    expect(teamScores.teamB.buracoTwosCount).to.equal(1);
    expect(teamScores.teamB.buracoBonus).to.equal(2000);
    // teamA: 140 melds + 2000 + 100 well + 100 go-out = 2340.
    // teamB: 140 melds + 2000 - 100 no well - 30 hand      = 2010.
    expect(teamScores.teamA.total).to.be.above(teamScores.teamB.total);
    expect(winningTeam).to.equal('teamA');
  });

  it('hands the round to whichever side has the higher total, full stop', () => {
    const room = makeRoom({ players: 4 });
    // teamB melds more and wins on total, even though teamA is the side that
    // went out (the go-out bonus is only 100 — it does not decide the round).
    room.playerMelds.set('p2', [
      run('spades', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], 500),
      run('clubs', ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], 600),
    ]);
    room.playerHasTakenPozzetto.set('p2', true);
    room.playerMelds.set('p1', [run('hearts', ['3', '4', '5', '6', '7', '8', '9'], 700)]);
    room.playerHasTakenPozzetto.set('p1', true);

    const { teamScores, winningTeam } = ActionHandlers._computeScores(room, 'p1', 'direct');
    expect(teamScores.teamA.goOutBonus).to.equal(100);
    expect(teamScores.teamB.total).to.be.above(teamScores.teamA.total);
    expect(winningTeam).to.equal('teamB');
  });

  it('does NOT end the round the moment a brazilia of 2s is formed', () => {
    const room = makeRoom({ ruleset: 'professional', wellMode: 'indirect' });
    room.playerMelds.set('p1', [Array.from({ length: 7 }, (_, i) => c('spades', '2', 700 + i))]);
    room.playerHands.set('p1', [c('hearts', '9', 799)]);

    // Used to instant-win here, handing the round over regardless of totals.
    expect(ActionHandlers._checkInstantEnd(room, 'p1')).to.equal(null);
  });
});

describe('#direct well mode closes only on the fly', () => {
  it('rejects discarding a last card to go out', () => {
    const room = makeRoom({ wellMode: 'direct' });
    const last = c('hearts', '9', 800);
    room.playerHands.set('p1', [last]);
    room.playerMelds.set('p1', [run('spades', ['3', '4', '5', '6', '7', '8', '9'], 810)]);
    room.playerHasTakenPozzetto.set('p1', true);

    const check = GameValidator.validateDiscard(room, 'p1', last);
    expect(check.isValid).to.equal(false);
    expect(check.reason).to.equal('invalidClose');
  });

  it('rejects discarding a last card to reach the well', () => {
    const room = makeRoom({ wellMode: 'direct' });
    room.deadPiles = [Array.from({ length: 11 }, (_, i) => c('clubs', '3', 950 + i))];
    room.playerHands.set('p1', []);
    expect(ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', true)).to.equal(false);
    // Melding out for it is the only route.
    expect(ActionHandlers._canTakeWellAfterEmptyHand(room, 'p1', false)).to.equal(true);
  });

  it('closes the round when the LAST cards go onto an existing meld', () => {
    const room = makeRoom({ wellMode: 'direct' });
    // Side already has its brazilia and its well; two cards left in hand.
    room.playerMelds.set('p1', [run('spades', ['3', '4', '5', '6', '7', '8', '9'], 900)]);
    room.playerHasTakenPozzetto.set('p1', true);
    room.playerHands.set('p1', [c('spades', '10', 910), c('spades', 'J', 911)]);

    // Nothing to close yet — the hand is not empty.
    expect(ActionHandlers._checkInstantEnd(room, 'p1')).to.equal(null);

    // Extending the existing meld with the final two cards empties the hand,
    // which IS the close in direct mode (no discard involved).
    room.playerMelds.get('p1')[0].push(c('spades', '10', 910), c('spades', 'J', 911));
    room.playerHands.set('p1', []);

    const ended = ActionHandlers._checkInstantEnd(room, 'p1');
    expect(ended).to.not.equal(null);
    expect(ended.type).to.equal('round_ended');
    expect(ended.winnerId).to.equal('p1');
  });
});
