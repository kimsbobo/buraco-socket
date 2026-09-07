/**
 * GameService Tests
 * Unit tests for the GameService class
 */

const { expect } = require('chai');
const { GameService } = require('../../src/services');
const { GameRoomStatus } = require('../../src/constants');

describe('GameService', () => {
  let gameService;

  beforeEach(() => {
    gameService = new GameService();
  });

  afterEach(() => {
    if (gameService) {
      gameService.shutdown();
    }
  });

  describe('Room Creation', () => {
    it('should create a new room with generated ID', () => {
      const room = gameService.createRoom();

      expect(room).to.not.be.undefined;
      expect(room.roomId).to.be.a('string');
      expect(gameService.rooms.has(room.roomId)).to.be.true;
    });

    it('should create a room with specific ID', () => {
      const room = gameService.createRoom('my-room');

      expect(room.roomId).to.equal('my-room');
      expect(gameService.rooms.has('my-room')).to.be.true;
    });

    it('should create a room with custom max players', () => {
      const room = gameService.createRoom(null, 4);

      expect(room.maxPlayers).to.equal(4);
    });
  });

  describe('Room Retrieval', () => {
    it('should get a room by ID', () => {
      const room = gameService.createRoom('test-room');
      const retrieved = gameService.getRoom('test-room');

      expect(retrieved).to.equal(room);
    });

    it('should normalize numeric and string room IDs to same room', () => {
      const room = gameService.createRoom(1234);
      const fromString = gameService.getRoom('1234');
      const fromNumber = gameService.getRoom(1234);

      expect(room.roomId).to.equal('1234');
      expect(fromString).to.equal(room);
      expect(fromNumber).to.equal(room);
    });

    it('should reuse existing room on repeated createRoom with same ID', () => {
      const first = gameService.createRoom('stable-room', 2);
      const second = gameService.createRoom('stable-room', 4);

      expect(second).to.equal(first);
      expect(second.maxPlayers).to.equal(4);
      expect(gameService.rooms.size).to.equal(1);
    });

    it('should return undefined for non-existent room', () => {
      const retrieved = gameService.getRoom('non-existent');

      expect(retrieved).to.be.undefined;
    });
  });

  describe('Matchmaking', () => {
    it('should find existing waiting room', () => {
      const room1 = gameService.createRoom('room1');
      room1.status = GameRoomStatus.WAITING;

      const found = gameService.findOrCreateRoom();

      expect(found).to.equal(room1);
    });

    it('should create new room if no waiting rooms', () => {
      const room1 = gameService.createRoom('room1');
      room1.status = GameRoomStatus.IN_PROGRESS; // Not waiting

      const found = gameService.findOrCreateRoom();

      expect(found).to.not.equal(room1);
      expect(found.status).to.equal(GameRoomStatus.WAITING);
    });

    it('should not match full rooms', () => {
      const room1 = gameService.createRoom('room1', 2);
      room1.status = GameRoomStatus.WAITING;

      // Fill the room
      const result1 = gameService.joinRoom('room1', 'p1', 'Alice', 's1');
      const result2 = gameService.joinRoom('room1', 'p2', 'Bob', 's2');

      const found = gameService.findOrCreateRoom();

      expect(found).to.not.equal(room1);
    });
  });

  describe('Player Joining', () => {
    it('should add player to room successfully', () => {
      const room = gameService.createRoom('test-room');
      const result = gameService.joinRoom('test-room', 'p1', 'Alice', 's1');

      expect(result.success).to.be.true;
      expect(result.player.playerId).to.equal('p1');
      expect(result.player.playerName).to.equal('Alice');
      expect(gameService.playerToRoom.get('p1')).to.equal('test-room');
      expect(gameService.socketToPlayer.get('s1')).to.equal('p1');
    });

    it('should assign sequential player indices', () => {
      const room = gameService.createRoom('test-room', 4);

      const result1 = gameService.joinRoom('test-room', 'p1', 'Alice', 's1');
      const result2 = gameService.joinRoom('test-room', 'p2', 'Bob', 's2');
      const result3 = gameService.joinRoom('test-room', 'p3', 'Charlie', 's3');

      expect(result1.player.playerIndex).to.equal(0);
      expect(result2.player.playerIndex).to.equal(1);
      expect(result3.player.playerIndex).to.equal(2);
    });

    it('should not add player to full room', () => {
      const room = gameService.createRoom('test-room', 2);

      gameService.joinRoom('test-room', 'p1', 'Alice', 's1');
      gameService.joinRoom('test-room', 'p2', 'Bob', 's2');

      const result = gameService.joinRoom('test-room', 'p3', 'Charlie', 's3');

      expect(result.success).to.be.false;
      expect(result.error).to.include('full');
    });

    it('should not add player to non-existent room', () => {
      const result = gameService.joinRoom('fake-room', 'p1', 'Alice', 's1');

      expect(result.success).to.be.false;
      expect(result.error).to.include('not found');
    });

    it('should handle player reconnection', () => {
      const room = gameService.createRoom('test-room', 2);

      // First connection
      gameService.joinRoom('test-room', 'p1', 'Alice', 's1');

      // Reconnection with new socket
      const result = gameService.joinRoom('test-room', 'p1', 'Alice', 's2');

      expect(result.success).to.be.true;
      expect(result.reconnected).to.be.true;
      expect(result.player.socketId).to.equal('s2');
      expect(gameService.socketToPlayer.get('s2')).to.equal('p1');
    });

    it('should add a server-side bot without a real socket', () => {
      const room = gameService.createRoom('bot-room', 2);

      const result = gameService.addBotToRoom('bot-room', {
        botId: 'bot-1',
        botName: 'Bot One',
      });

      expect(result.success).to.equal(true);
      expect(result.player.isBot).to.equal(true);
      expect(result.player.socketId).to.equal('bot:bot-1');
      expect(result.player.playerIndex).to.equal(0);
      expect(room.getPlayer('bot-1')).to.equal(result.player);
      expect(gameService.playerToRoom.get('bot-1')).to.equal('bot-room');
      expect(gameService.socketToPlayer.get('bot:bot-1')).to.equal('bot-1');
    });

    it('should respect requested bot seat when available', () => {
      const room = gameService.createRoom('bot-seat-room', 4);
      gameService.joinRoom('bot-seat-room', 'p1', 'Alice', 's1');

      const result = gameService.addBotToRoom('bot-seat-room', {
        botId: 'bot-3',
        botName: 'Bot Three',
        playerIndex: 2,
      });

      expect(result.success).to.equal(true);
      expect(result.player.playerIndex).to.equal(2);
      expect(room.getPlayers().map((p) => p.playerIndex)).to.deep.equal([0, 2]);
    });
  });

  describe('Player Leaving', () => {
    it('should remove player from room', () => {
      const room = gameService.createRoom('test-room');
      gameService.joinRoom('test-room', 'p1', 'Alice', 's1');

      const result = gameService.leaveRoom('p1');

      expect(result.success).to.be.true;
      expect(gameService.playerToRoom.has('p1')).to.be.false;
      expect(result.roomDeleted).to.be.true;
      expect(gameService.rooms.has('test-room')).to.be.false;
    });

    it('should delete room when host leaves', () => {
      const room = gameService.createRoom('test-room', 2);
      gameService.joinRoom('test-room', 'p1', 'Alice', 's1'); // Host
      gameService.joinRoom('test-room', 'p2', 'Bob', 's2');

      const result = gameService.leaveRoom('p1');

      expect(result.success).to.be.true;
      // Items 7: host is immutable — host leaving CLOSES the room (no migration).
      expect(result.roomDeleted).to.be.true;
      expect(result.reason).to.equal('HOST_LEFT');
      expect(gameService.rooms.has('test-room')).to.be.false;
      expect(result.removedPlayers.map((p) => p.playerId)).to.include.members([
        'p1',
        'p2',
      ]);
    });

    it('should not affect room when non-host leaves', () => {
      const room = gameService.createRoom('test-room', 2);
      gameService.joinRoom('test-room', 'p1', 'Alice', 's1'); // Host
      gameService.joinRoom('test-room', 'p2', 'Bob', 's2');

      const result = gameService.leaveRoom('p2');

      expect(result.success).to.be.true;
      expect(result.roomDeleted).to.be.undefined;
      expect(gameService.rooms.has('test-room')).to.be.true;
      expect(room.players.size).to.equal(1);
    });
  });

  describe('Room Cleanup', () => {
    it('should identify inactive rooms', () => {
      const room = gameService.createRoom('test-room');
      room.status = GameRoomStatus.FINISHED;
      room.gameEndedAt = new Date(Date.now() - 11 * 60 * 1000); // 11 minutes ago

      const inactive = gameService.getInactiveRooms();

      expect(inactive).to.include(room);
    });

    it('should not identify active rooms as inactive', () => {
      const room = gameService.createRoom('test-room');
      room.status = GameRoomStatus.IN_PROGRESS;

      const inactive = gameService.getInactiveRooms();

      expect(inactive).to.not.include(room);
    });
  });

  describe('Player Lookup', () => {
    it('should get player ID from socket ID', () => {
      gameService.createRoom('test-room');
      gameService.joinRoom('test-room', 'p1', 'Alice', 's1');

      const playerId = gameService.getPlayerIdBySocket('s1');

      expect(playerId).to.equal('p1');
    });

    it('should get room for player', () => {
      const room = gameService.createRoom('test-room');
      gameService.joinRoom('test-room', 'p1', 'Alice', 's1');

      const foundRoom = gameService.getPlayerRoom('p1');

      expect(foundRoom).to.equal(room);
    });

    it('should return undefined for non-existent socket', () => {
      const playerId = gameService.getPlayerIdBySocket('fake-socket');

      expect(playerId).to.be.undefined;
    });
  });

  describe('Active Rooms', () => {
    it('should get all active rooms', () => {
      const room1 = gameService.createRoom('room1');
      room1.status = GameRoomStatus.IN_PROGRESS;

      const room2 = gameService.createRoom('room2');
      room2.status = GameRoomStatus.WAITING;

      const room3 = gameService.createRoom('room3');
      room3.status = GameRoomStatus.FINISHED;

      const active = gameService.getActiveRooms();

      expect(active).to.include(room1);
      expect(active).to.include(room2);
      expect(active).to.not.include(room3);
    });
  });

  describe('Statistics', () => {
    it('should return game statistics', () => {
      gameService.createRoom('room1');
      gameService.createRoom('room2');
      gameService.joinRoom('room1', 'p1', 'Alice', 's1');
      gameService.joinRoom('room1', 'p2', 'Bob', 's2');

      const stats = gameService.getStatistics();

      expect(stats.totalRooms).to.equal(2);
      expect(stats.totalPlayers).to.equal(2);
      expect(stats.activeGames).to.equal(0); // Not started
    });
  });
});
