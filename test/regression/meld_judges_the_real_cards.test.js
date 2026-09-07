/**
 * A meld is judged on the cards that will actually be LAID, never on the
 * client's description of them.
 *
 * THE HOLE: ownership is matched by cardId alone — `_sameCard` returns
 * `String(aId) === String(bId)` whenever both sides carry an id — while every
 * rule (shape, wild count, one 2 per run, meld points) read the rank and suit
 * the CLIENT sent. So a payload could name a card it really owns and lie about
 * what that card is. The meld was checked against the lie and the truth landed
 * on the table:
 *
 *     hand 2♦ 3♦ 4♦ 2♠   send [2♦, 3♦, 4♦, {id of 2♠, rank:'5', suit:'♦'}]
 *     -> validates as 2-3-4-5 of diamonds, lands as 2♦ 3♦ 4♦ 2♠
 *
 * Found while auditing why "buraco gaboleh double kartu angka 2" kept leaking.
 * It is much larger than that one rule: it defeats EVERY meld rule at once, and
 * _calculateMeldPoints scored the lie too, so minPointsToGoDown went with it.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameValidator = require('../../src/validators/GameValidator');
const ActionHandlers = require('../../src/handlers/ActionHandlers');
const { GameRoom } = require('../../src/models');
const PlayerSession = require('../../src/models/PlayerSession');
const { GameRoomStatus } = require('../../src/constants');
const { Card } = require('../../src/models/Deck');

const idOf = (c) => c.cardId ?? c.instanceId ?? c.id;

function room() {
  const r = new GameRoom({ roomId: 'forge', maxPlayers: 2 });
  r.status = GameRoomStatus.IN_PROGRESS;
  r.ruleset = 'classic';
  r.currentTurn = 0;
  r.hasDrawnCard = true;
  for (let i = 0; i < 2; i += 1) {
    const id = `p${i + 1}`;
    r.addPlayer(new PlayerSession({ playerId: id, playerName: id, playerIndex: i, socketId: `s${i}` }));
    r.playerHands.set(id, []);
    r.playerMelds.set(id, []);
    r.playerHasTakenPozzetto.set(id, false);
    r.playerDeadPileCount.set(id, 0);
    r.meldDirtyFlags.set(id, new Set());
  }
  return r;
}

/** Spares so the unrelated "keep a discardable card" guard stays out of the way. */
const spares = () => [
  new Card('clubs', 'K'), new Card('clubs', '9'), new Card('hearts', '7'),
  new Card('spades', '8'), new Card('hearts', 'Q'),
];

describe('#a meld is judged on the REAL cards', () => {
  it('THE FORGERY: claiming a 2♠ is the 5♦ no longer builds a run', () => {
    const r = room();
    const twoD = new Card('diamonds', '2');
    const threeD = new Card('diamonds', '3');
    const fourD = new Card('diamonds', '4');
    const twoS = new Card('spades', '2');
    r.playerHands.set('p1', [twoD, threeD, fourD, twoS, ...spares()]);

    const forged = [
      { cardId: idOf(twoD), rank: '2', suit: 'diamonds' },
      { cardId: idOf(threeD), rank: '3', suit: 'diamonds' },
      { cardId: idOf(fourD), rank: '4', suit: 'diamonds' },
      { cardId: idOf(twoS), rank: '5', suit: 'diamonds' }, // <- the lie
    ];

    expect(GameValidator.validateMeld(r, 'p1', forged).isValid).to.equal(false);

    ActionHandlers.handlePlayMeld(r, 'p1', forged);
    expect(r.playerMelds.get('p1'), 'nothing may reach the table').to.have.length(0);
  });

  it('an HONEST legal meld still goes down', () => {
    const r = room();
    const a = new Card('diamonds', '3');
    const b = new Card('diamonds', '4');
    const c = new Card('diamonds', '5');
    r.playerHands.set('p1', [a, b, c, ...spares()]);

    const honest = [a, b, c].map((x) => ({ cardId: idOf(x), rank: x.rank, suit: x.suit }));
    expect(GameValidator.validateMeld(r, 'p1', honest).isValid).to.equal(true);
  });

  it('the ADD path cannot be lied to either', () => {
    const r = room();
    const a = new Card('clubs', 'A');
    const b = new Card('clubs', '2');
    const c = new Card('clubs', '3');
    const twoH = new Card('hearts', '2');
    r.playerHands.set('p1', [a, b, c, twoH, ...spares()]);

    ActionHandlers.handlePlayMeld(r, 'p1', [a, b, c]);
    expect(r.playerMelds.get('p1'), 'the honest opener lands').to.have.length(1);

    // The meld already holds one 2; the hand's 2♥ is claimed to be the 4♣.
    const forgedAdd = [{ cardId: idOf(twoH), rank: '4', suit: 'clubs' }];
    expect(
      GameValidator.validateAddCardsToMeld(r, 'p1', forgedAdd, 0, 0).isValid
    ).to.equal(false);
  });

  it('GOING DOWN cannot be lied to, and the points gate is scored on the truth', () => {
    const r = room();
    const a = new Card('diamonds', '2');
    const b = new Card('diamonds', '3');
    const c = new Card('diamonds', '4');
    const twoS = new Card('spades', '2');
    r.playerHands.set('p1', [a, b, c, twoS, ...spares()]);

    const forged = [[
      { cardId: idOf(a), rank: '2', suit: 'diamonds' },
      { cardId: idOf(b), rank: '3', suit: 'diamonds' },
      { cardId: idOf(c), rank: '4', suit: 'diamonds' },
      { cardId: idOf(twoS), rank: 'K', suit: 'diamonds' }, // a fat lie, for the points gate
    ]];
    expect(GameValidator.validateGoingDown(r, 'p1', forged).isValid).to.equal(false);
  });

  it('one physical card cannot be spent in two melds at once', () => {
    const r = room();
    const shared = new Card('clubs', '5');
    const h = [
      shared,
      new Card('clubs', '6'), new Card('clubs', '7'),
      new Card('hearts', '5'), new Card('diamonds', '5'),
      ...spares(),
    ];
    r.playerHands.set('p1', h);

    const dbl = [
      [h[0], h[1], h[2]].map((x) => ({ cardId: idOf(x), rank: x.rank, suit: x.suit })),
      // the SAME 5♣ id again, in a set of 5s
      [{ cardId: idOf(shared), rank: '5', suit: 'clubs' },
        { cardId: idOf(h[3]), rank: '5', suit: 'hearts' },
        { cardId: idOf(h[4]), rank: '5', suit: 'diamonds' }],
    ];
    expect(GameValidator.validateGoingDown(r, 'p1', dbl).isValid).to.equal(false);
  });
});
