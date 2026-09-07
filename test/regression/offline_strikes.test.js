/* eslint-env mocha */

/**
 * OFFLINE STRIKES (product rule, 2026-08-20) — replaces the old
 * "5 consecutive turns without a manual action" forfeit.
 *
 * That rule counted IDLENESS and reset the instant a player did anything, so
 * someone could drop out, come back for a single move, drop out again, and never
 * accrue — while a present-but-slow player got timed out of the match.
 *
 * What ends a match now is being ABSENT: one strike each time a turn comes
 * around while the player is disconnected and the system resolves it without
 * them. Coming back online does NOT clear them. The count is per ROUND, and the
 * match is called at MAX_OFFLINE_STRIKES.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(emitted) {
  return {
    to: (roomId) => ({
      emit: (event, payload) => emitted.push({ roomId, event, payload }),
    }),
    sockets: { sockets: new Map() },
  };
}

function liveRoom() {
  const service = new GameService();
  const room = service.createRoom('strikes', 2);
  service.joinRoom('strikes', 'p1', 'P1', 's1');
  service.joinRoom('strikes', 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();
  const emitted = [];
  const handlers = new SocketHandlers(fakeIo(emitted), service);
  handlers._stopTurnTimer(room);
  return { service, room, handlers, emitted };
}

describe('#offline strikes end the match, idleness does not', () => {
  it('a CONNECTED player never accrues, however long they sit there', () => {
    const { service, room, handlers } = liveRoom();
    const present = room.getPlayer('p2');
    expect(present.isConnected).to.equal(true);

    for (let i = 0; i < 10; i += 1) {
      expect(handlers._handleInactiveTurnExpiry(room, present)).to.equal(false);
    }

    expect(room.offlineStrikes.get('p2') || 0).to.equal(0);
    service.deleteRoom('strikes');
  });

  it('coming back online does NOT wipe the strikes already earned', () => {
    // The hole in the old rule: drop out, return for one move, drop out again,
    // and the counter was back to zero every time.
    const { service, room, handlers } = liveRoom();
    const absent = room.getPlayer('p2');

    absent.disconnect();
    handlers._handleInactiveTurnExpiry(room, absent);
    handlers._handleInactiveTurnExpiry(room, absent);
    expect(room.offlineStrikes.get('p2')).to.equal(2);

    absent.reconnect ? absent.reconnect('s2') : (absent.isConnected = true);
    handlers._recordManualAction(room, 'p2'); // they play a turn
    expect(
      room.offlineStrikes.get('p2'),
      'the record of being away survives the return'
    ).to.equal(2);

    absent.disconnect();
    handlers._handleInactiveTurnExpiry(room, absent);
    expect(room.offlineStrikes.get('p2')).to.equal(3);
    service.deleteRoom('strikes');
  });

  it('the match is called at the cap, and the present player wins', () => {
    const { service, room, handlers, emitted } = liveRoom();
    const absent = room.getPlayer('p2');
    absent.disconnect();

    let ended = false;
    for (let i = 0; i < SocketHandlers.MAX_OFFLINE_STRIKES; i += 1) {
      ended = handlers._handleInactiveTurnExpiry(room, absent);
    }

    expect(ended, 'the last strike ends it').to.equal(true);
    const done = emitted.find((e) => e.event === 'game_ended');
    expect(done, 'game_ended went out').to.not.equal(undefined);
    expect(done.payload.reason).to.equal('offline_forfeit');
    expect(done.payload.offlineStrikes).to.equal(SocketHandlers.MAX_OFFLINE_STRIKES);
    expect(done.payload.winnerIndex, 'the player who stayed wins').to.equal(0);
    service.deleteRoom('strikes');
  });

  it('a BOT seat is never charged, even carrying a disconnected flag', () => {
    // A seat taken over by a bot keeps the disconnected flag of the human it
    // replaced. The seat is being played perfectly well — forfeiting the match
    // over it would punish the table for the bot doing its job.
    const { service, room, handlers } = liveRoom();
    const seat = room.getPlayer('p2');
    seat.disconnect();
    seat.isBot = true;

    for (let i = 0; i < SocketHandlers.MAX_OFFLINE_STRIKES + 2; i += 1) {
      expect(handlers._handleInactiveTurnExpiry(room, seat)).to.equal(false);
    }

    expect(room.offlineStrikes.get('p2') || 0).to.equal(0);
    service.deleteRoom('strikes');
  });

  it('a new deal wipes the slate', () => {
    const { service, room, handlers } = liveRoom();
    const absent = room.getPlayer('p2');
    absent.disconnect();
    handlers._handleInactiveTurnExpiry(room, absent);
    expect(room.offlineStrikes.get('p2')).to.equal(1);

    room.startGame(true); // the per-round reset

    expect(room.offlineStrikes.get('p2') || 0, 'strikes are per ROUND').to.equal(0);
    service.deleteRoom('strikes');
  });
});
