/* eslint-env mocha */

// The BACKEND (wlive) is authoritative for the room host. The socket must never
// let a joiner become/stay the host of a backend-managed room — otherwise the
// joiner's leave kills the room for everyone while the real host's leave does
// nothing (the room stays listed). See brazilia_game_flow_audit.md.

const { expect } = require('chai');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const GameService = require('../../src/services/GameService');

function ioMock() {
  const io = {
    roomEmits: [],
    sockets: { sockets: new Map() },
    to: (roomId) => ({ emit: (event, payload) => io.roomEmits.push({ roomId, event, payload }) }),
  };
  return io;
}

describe('host authority (backend is the source of truth)', () => {
  it('a backend sync CORRECTS a host wrongly guessed from the first joiner', () => {
    const service = new GameService();
    const handler = new SocketHandlers(ioMock(), service);

    // Simulate a socket that rebuilt the room from a raw join (e.g. after a
    // restart) with NO backend sync yet — the joiner B becomes host via the
    // first-joiner fallback.
    service.createRoom('r-auth', 2);
    service.joinRoom('r-auth', 'B', 'B', 'sB');
    let room = service.getRoom('r-auth');
    expect(room.hostPlayerId).to.equal('B');
    expect(room.backendManaged).to.equal(false);

    // The backend now syncs the authoritative host A — it must win.
    handler.syncRoomFromBackend({ roomId: 'r-auth', hostPlayerId: 'A', maxPlayers: 2, name: 'R' });
    room = service.getRoom('r-auth');
    expect(room.hostPlayerId).to.equal('A');
    expect(room.backendManaged).to.equal(true);

    service.shutdown();
  });

  it('a joiner never becomes host of a backend-managed room', () => {
    const service = new GameService();
    const handler = new SocketHandlers(ioMock(), service);

    // Room created authoritatively by the backend (host A).
    handler.syncRoomFromBackend({ roomId: 'r-mgd', hostPlayerId: 'A', maxPlayers: 2, name: 'R' });
    let room = service.getRoom('r-mgd');
    expect(room.hostPlayerId).to.equal('A');
    expect(room.backendManaged).to.equal(true);

    // A joiner connects on the socket — the fallback must NOT hijack the host.
    service.joinRoom('r-mgd', 'B', 'B', 'sB');
    room = service.getRoom('r-mgd');
    expect(room.hostPlayerId).to.equal('A');

    service.shutdown();
  });
});
