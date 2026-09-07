/**
 * "pas J gw ambil lagi, J yang gw ambil sebelumnya masih bisa di discard,
 * harusnya engga, ke lock, jadi ini ga hanya berlaku 1vs1 aja" — 2026-08-26.
 *
 * The shoe is two decks, so an opponent can hold both copies of a card and
 * volley them: throw copy A, you take the pile for it; they throw copy B, you
 * take that too. Holding only the newest copy under lock sets the older one free
 * to go straight back, and the volley runs forever on the pair.
 *
 * `armDiscardLock` used to build the lock from whatever lock was ALIVE, and a
 * deck draw releases the lock. In 2v2 a full turn cycle guarantees at least one
 * draw between two takes, so copy A was always free again by the time copy B
 * arrived. 1v1 only hid it behind a shorter cycle — it was never a 2v2-only bug.
 *
 * Rule from 2026-08-27: the seat's TAKE HISTORY is what the lock is built from.
 * A deck draw or a multi-card take still releases the active lock ("unlock
 * semua"), but taking the same rank+suit again puts the whole family back under
 * it. Only a new deal forgets, because only then is it a different pile.
 */
/* eslint-env mocha */
const { expect } = require('chai');
const GameRoom = require('../../src/models/GameRoom');

const J_SPADES = (cardId) => ({ suit: 'spades', rank: 'J', cardId });
const SEAT = 'p1';

/** ids currently under lock for SEAT, as strings, sorted for comparison. */
function locked(room) {
  const lock = room.discardLocks.get(SEAT);
  if (!lock) return [];
  return (lock.cardIds || []).map(String).sort();
}

describe('anti ping-pong — the lock remembers what this seat took', () => {
  let room;

  beforeEach(() => {
    room = new GameRoom('pp1', 4);
  });

  it('a single-card take locks that card', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    expect(locked(room)).to.deep.equal(['1']);
  });

  it('THE REPORT: taking the second copy re-locks the first', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    // The turn goes right round the table. Somewhere in there this seat draws
    // from the deck, which releases the active lock.
    room.clearDiscardLock(SEAT);
    expect(locked(room), 'the draw does release it').to.deep.equal([]);

    // The opponent throws the OTHER J of spades and this seat takes it.
    room.armDiscardLock(SEAT, J_SPADES(2));

    expect(
      locked(room),
      'both copies are held — the volley has nowhere to go'
    ).to.deep.equal(['1', '2']);
  });

  it('the newest id is still reported on its own for older clients', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    room.clearDiscardLock(SEAT);
    room.armDiscardLock(SEAT, J_SPADES(2));
    expect(room.discardLocks.get(SEAT).cardId).to.equal(2);
  });

  it('a different card does not drag the J family along', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    room.clearDiscardLock(SEAT);
    room.armDiscardLock(SEAT, { suit: 'hearts', rank: '7', cardId: 9 });

    expect(locked(room)).to.deep.equal(['9']);
    expect(room.discardLocks.get(SEAT).rank).to.equal('7');
  });

  it('and taking a J again after that still brings both Js back', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    room.clearDiscardLock(SEAT);
    room.armDiscardLock(SEAT, { suit: 'hearts', rank: '7', cardId: 9 });
    room.clearDiscardLock(SEAT);
    room.armDiscardLock(SEAT, J_SPADES(2));

    expect(locked(room)).to.deep.equal(['1', '2']);
  });

  it('history is per SEAT — one seat cannot lock another', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    room.armDiscardLock('p2', J_SPADES(2));

    expect(locked(room)).to.deep.equal(['1']);
    expect((room.discardLocks.get('p2').cardIds || []).map(String)).to.deep.equal(['2']);
  });

  it('taking the very same copy twice does not duplicate it', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    room.clearDiscardLock(SEAT);
    room.armDiscardLock(SEAT, J_SPADES(1));
    expect(locked(room)).to.deep.equal(['1']);
  });

  it('a new deal forgets — it is a different pile', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    // startGame() is the per-round reset, and it refuses a room under two seats.
    const PlayerSession = require('../../src/models/PlayerSession');
    room.addPlayer(
      new PlayerSession({ playerId: SEAT, playerName: 'A', playerIndex: 0, socketId: 's1' })
    );
    room.addPlayer(
      new PlayerSession({ playerId: 'p2', playerName: 'B', playerIndex: 1, socketId: 's2' })
    );
    expect(room.startGame(true), 'the reset must actually run').to.equal(true);

    room.armDiscardLock(SEAT, J_SPADES(2));
    expect(
      locked(room),
      'last round\'s J is not evidence about this round\'s pile'
    ).to.deep.equal(['2']);
  });

  it('the lock still expires on its own clock', () => {
    room.armDiscardLock(SEAT, J_SPADES(1));
    const { turnsLeft } = room.discardLocks.get(SEAT);
    for (let i = 0; i < turnsLeft; i++) room.tickDiscardLock(SEAT);
    expect(room.discardLocks.get(SEAT)).to.equal(undefined);
  });
});
