/**
 * handleStartGame authority: a socket that is not in the room (not the host /
 * not a seated player) must NOT be able to start the game. (The former
 * replace-host-with-bot start case was removed together with that feature —
 * Items 7/B.)
 */

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function fakeIo(reg) {
  return { to: () => ({ emit: () => {} }), sockets: { sockets: reg } };
}
function fakeSocket(id, emitted) {
  return {
    id,
    handshake: { headers: {}, auth: {}, query: {} },
    emit: (event, payload) => emitted.push({ event, payload }),
    join: () => {},
    leave: () => {},
    to: () => ({ emit: () => {} }),
  };
}

describe('#replace-host-with-bot start', () => {
  it('rejects a random non-owner socket from starting', () => {
    const service = new GameService();
    const room = service.createRoom('rh2', 2);
    service.joinRoom('rh2', 'p1', 'P1', 's1');
    service.joinRoom('rh2', 'p2', 'P2', 's2');
    room.hostPlayerId = 'p1';

    const reg = new Map();
    const emitted = [];
    reg.set('s1', fakeSocket('s1', emitted));
    reg.set('s2', fakeSocket('s2', emitted));
    reg.set('s3', fakeSocket('s3', emitted)); // unknown socket, not in room
    const handlers = new SocketHandlers(fakeIo(reg), service);

    handlers.handleStartGame(reg.get('s3'), { roomId: 'rh2' });
    expect(room.isInProgress()).to.equal(false);

    service.deleteRoom('rh2');
  });
});
