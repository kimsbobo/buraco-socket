/* eslint-env mocha */

/**
 * INVARIANT: a round cannot end while a pozzetto is still on the table.
 *
 * It has to be gone — collected by somebody, or promoted into the stock — before
 * anyone can go out. That is what makes the -100 "you never got a well" penalty
 * fair: by the time it is charged, nobody could have taken one any more.
 *
 * Nothing in the code SAYS this. It falls out of three separate gates:
 *
 *   * a meld-out with a well available takes the well instead of closing,
 *   * a last-card discard in INDIRECT does the same,
 *   * and DIRECT refuses the closing discard outright.
 *
 * Three gates, no single owner — precisely the shape that rots quietly. If one of
 * them is ever relaxed, this file fails instead of the scoreboard going wrong.
 */
const { expect } = require('chai');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const GameValidator = require('../../src/validators/GameValidator');
const { GameRoom, PlayerSession } = require('../../src/models');
const { Card } = require('../../src/models/Deck');
const { GameRoomStatus } = require('../../src/constants');

const c = (rank, suit) => new Card(suit, rank);

/** p1's side holds a brazilia and ONE well; the OTHER well is still on the table. */
function oneWellLeft({ ruleset, wellMode }) {
  const room = new GameRoom({ roomId: 'invariant', maxPlayers: 2 });
  room.status = GameRoomStatus.IN_PROGRESS;
  room.ruleset = ruleset;
  room.professionalWellMode = wellMode;
  room.currentTurn = 0;
  room.hasDrawnCard = true;
  for (let i = 0; i < 2; i += 1) {
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
  room.deadPiles = [Array.from({ length: 11 }, () => c('3', 'clubs'))];
  room.playerMelds.set('p1', [
    ['3', '4', '5', '6', '7', '8', '9'].map((r) => c(r, 'hearts')),
  ]);
  room.playerMeldOrders.set('p1', [1]);
  ActionHandlers._markTeamPozzettoTaken(room, 'p1', 'indirect');
  return room;
}

const COMBOS = [];
for (const ruleset of ['classicWithNoJoker', 'professional']) {
  for (const wellMode of ['indirect', 'direct']) COMBOS.push({ ruleset, wellMode });
}

describe('#a round cannot end while a pozzetto is on the table', () => {
  COMBOS.forEach(({ ruleset, wellMode }) => {
    it(`${ruleset}/${wellMode}: a MELD-OUT collects the well instead of closing`, () => {
      const room = oneWellLeft({ ruleset, wellMode });
      const lone = c('10', 'hearts'); // extends the heart run
      room.playerHands.set('p1', [lone]);

      const res = ActionHandlers.handleAddToMeld(room, 'p1', [lone], 0, 0);

      expect(res.success, res.error).to.equal(true);
      expect(res.roundEnded, 'the round did NOT close').to.equal(undefined);
      expect(room.playerHands.get('p1'), 'the well came in').to.have.length(11);
      expect(
        (room.deadPiles || []).filter((p) => p.length).length,
        'and the table is clear of wells'
      ).to.equal(0);
    });

    it(`${ruleset}/${wellMode}: a last-card DISCARD never closes it either`, () => {
      const room = oneWellLeft({ ruleset, wellMode });
      const last = c('K', 'spades');
      room.playerHands.set('p1', [last]);

      const v = GameValidator.validateDiscard(room, 'p1', last);

      if (wellMode === 'direct') {
        // Direct has no closing discard at all.
        expect(v.isValid).to.equal(false);
        expect(v.reason).to.equal('invalidClose');
      } else {
        // Indirect allows it — but as a well TAKE, not as a go-out.
        expect(v.isValid).to.equal(true);
        expect(
          v.willTakePozzetto,
          'the discard collects the well rather than ending the round'
        ).to.equal(true);
      }
    });
  });

  it('with the wells gone, closing is allowed again', () => {
    // The control: the invariant must not block a legitimate close.
    const room = oneWellLeft({ ruleset: 'classicWithNoJoker', wellMode: 'indirect' });
    room.deadPiles = [];
    const last = c('K', 'spades');
    room.playerHands.set('p1', [last]);

    const v = GameValidator.validateDiscard(room, 'p1', last);

    expect(v.isValid, v.error).to.equal(true);
    expect(v.willTakePozzetto, 'nothing left to take — this is a real go-out').to.not.equal(true);
  });
});
