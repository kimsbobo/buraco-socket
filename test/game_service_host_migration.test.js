/* eslint-env mocha */
const { expect } = require('chai');
const GameService = require('../src/services/GameService');

describe('GameService immutable host contract', () => {
  it('closes the room when the host leaves, even when other players remain', () => {
    const service = new GameService();
    const room = service.createRoom('room1', 2);

    service.joinRoom(room.roomId, 'p1', 'P1', 's1');
    service.joinRoom(room.roomId, 'p2', 'P2', 's2');

    const result = service.leaveRoom('p1');
    expect(result.success).to.equal(true);
    expect(result.roomDeleted).to.equal(true);
    expect(result.reason).to.equal('HOST_LEFT');
    expect(result.removedPlayers.map((player) => player.playerId)).to.have.members(['p1', 'p2']);
    expect(service.getRoom(room.roomId)).to.not.exist;
  });
});
