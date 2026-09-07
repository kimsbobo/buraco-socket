/**
 * Stuck-room fix: when the realtime layer deletes a room, the backend lobby must
 * be told to delist it — but ONLY if the room was ever actually occupied. A
 * freshly synced room whose host is still connecting must NOT close the backend
 * row (that would kick the creator out of their brand-new room).
 */

const { expect } = require('chai');
const GameService = require('../../src/services/GameService');
const SocketHandlers = require('../../src/handlers/SocketHandlers');
const PlayerSession = require('../../src/models/PlayerSession');

function fakeIo() {
  return {
    to: () => ({ emit: () => {} }),
    sockets: { sockets: new Map() },
  };
}

describe('#stuck-rooms room deletion notifies backend', () => {
  it('GameService._deleteRoom fires onRoomDeleted with everHadPlayers=true for an occupied room', () => {
    const service = new GameService();
    const calls = [];
    service.onRoomDeleted = (roomId, everHad) => calls.push({ roomId, everHad });

    const room = service.createRoom('occupied', 2);
    room.addPlayer(new PlayerSession({ playerId: 'p1', playerName: 'P1', playerIndex: 0, socketId: 's1' }));

    service.deleteRoom('occupied');

    expect(calls).to.have.length(1);
    expect(calls[0].roomId).to.equal('occupied');
    expect(calls[0].everHad).to.equal(true);
  });

  it('fires onRoomDeleted with everHadPlayers=false for a synced room nobody joined', () => {
    const service = new GameService();
    const calls = [];
    service.onRoomDeleted = (roomId, everHad) => calls.push({ roomId, everHad });

    // Simulates /webhooks/sync-room creating an empty in-memory room.
    service.createRoom('fresh', 2);
    service.deleteRoom('fresh');

    expect(calls).to.have.length(1);
    expect(calls[0].everHad).to.equal(false);
  });

  it('fires onRoomDeleted when the last player leaves a lobby room', () => {
    const service = new GameService();
    const calls = [];
    service.onRoomDeleted = (roomId, everHad) => calls.push({ roomId, everHad });

    const room = service.createRoom('lobby', 2);
    const p1 = new PlayerSession({ playerId: 'p1', playerName: 'P1', playerIndex: 0, socketId: 's1' });
    room.addPlayer(p1);
    room.hostPlayerId = 'p1';
    service.playerToRoom.set('p1', 'lobby');
    service.socketToPlayer.set('s1', 'p1');

    const result = service.leaveRoom('p1');
    expect(result.success).to.equal(true);
    expect(service.getRoom('lobby')).to.equal(undefined); // room torn down
    expect(calls.some((c) => c.everHad === true)).to.equal(true);
  });

  it('SocketHandlers wiring notifies the backend ONLY for occupied rooms', () => {
    const service = new GameService();
    const handlers = new SocketHandlers(fakeIo(), service);

    const notified = [];
    handlers._notifyBackendRoomClosed = (roomId) => notified.push(roomId);

    // The constructor wired service.onRoomDeleted -> guarded notify.
    service.onRoomDeleted('occupied-room', true);
    service.onRoomDeleted('empty-room', false);

    expect(notified).to.deep.equal(['occupied-room']);
  });
});
