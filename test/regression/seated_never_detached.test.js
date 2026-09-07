/* eslint-env mocha */

/**
 * A SEATED player must never be told they have no seat.
 *
 * REPORTED: "user tiba-tiba reconnect padahal koneksi oke ... usernya kaya
 * kedetach jadi seakan dia play tapi terlihat kaya spectator mode."
 *
 * Both halves are one bug. _sendInitialGameState emits the seated frame first
 * and the spectator frame second, and the spectator builder carries
 * `yourPlayerIndex: -1`. A socket present in BOTH lists therefore ENDS the
 * update with no seat — the client cannot rotate the board to them or let them
 * act (which is precisely what spectator mode looks like), and after four such
 * frames its strand recovery gives up with "Could not determine your seat at
 * this table. Please reconnect to continue.": a reconnect prompt on a healthy
 * connection.
 *
 * The invariant is asserted at the fan-out rather than at each registration
 * site, because there is more than one way into both lists.
 */
const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function table(roomId) {
  const frames = [];
  const reg = new Map();
  const mk = (id) => ({
    id,
    emit: (event, payload) => frames.push({ to: id, event, payload }),
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
  });
  reg.set('s1', mk('s1'));
  reg.set('s2', mk('s2'));

  const io = {
    to: () => ({ emit: () => {} }),
    sockets: { sockets: reg },
  };
  const service = new GameService();
  const room = service.createRoom(roomId, 2);
  service.joinRoom(roomId, 'p1', 'P1', 's1');
  service.joinRoom(roomId, 'p2', 'P2', 's2');
  room.startGame();
  room.dealCards();

  const handlers = new SocketHandlers(io, service);
  handlers._stopTurnTimer(room);
  return { service, room, handlers, frames, reg };
}

/** Every state frame that landed on one socket, in order. */
const framesTo = (frames, id) =>
  frames.filter((f) => f.to === id && f.event === 'game_state_update');

describe('#a seated player is never handed a spectator frame', () => {
  it('a stale spectator registration cannot detach a seat', () => {
    const { service, room, handlers, frames, reg } = table('det1');
    // Seat 0's socket is ALSO registered as a viewer of the same room.
    handlers._addSpectator(reg.get('s1'), room.roomId, 'p1', 'P1', null);

    handlers._sendInitialGameState(room);

    const mine = framesTo(frames, 's1');
    expect(mine.length).to.be.greaterThan(0, 'they were told something');
    expect(
      mine[mine.length - 1].payload.yourPlayerIndex,
      'the LAST frame decides what the client believes'
    ).to.equal(0);
    expect(mine.some((f) => f.payload.isSpectator === true)).to.equal(
      false,
      'no spectator frame at all'
    );
    service.deleteRoom('det1');
  });

  it('and the stale registration is dropped, not just skipped', () => {
    const { service, room, handlers, reg } = table('det2');
    handlers._addSpectator(reg.get('s1'), room.roomId, 'p1', 'P1', null);

    handlers._sendInitialGameState(room);

    const specs = handlers.roomSpectators.get(room.roomId);
    expect(specs ? specs.has('s1') : false).to.equal(
      false,
      'a player is not also a viewer'
    );
    service.deleteRoom('det2');
  });

  it('the owner-controller hook cannot detach a seat either', () => {
    const { service, room, handlers, frames } = table('det3');
    room.ownerControllerSocketId = 's2'; // seat 1's own socket

    handlers._sendInitialGameState(room);

    const theirs = framesTo(frames, 's2');
    expect(theirs[theirs.length - 1].payload.yourPlayerIndex).to.equal(1);
    service.deleteRoom('det3');
  });

  it('a REAL spectator still gets their frame', () => {
    // The guard must not silence genuine viewers.
    const { service, room, handlers, frames, reg } = table('det4');
    const viewer = { ...reg.get('s1'), id: 's9' };
    viewer.emit = (event, payload) => frames.push({ to: 's9', event, payload });
    handlers.io.sockets.sockets.set('s9', viewer);
    handlers._addSpectator(viewer, room.roomId, 'u9', 'Nadia', null);

    handlers._sendInitialGameState(room);

    const watched = framesTo(frames, 's9');
    expect(watched.length).to.be.greaterThan(0);
    expect(watched[watched.length - 1].payload.yourPlayerIndex).to.equal(-1);
    service.deleteRoom('det4');
  });
});
