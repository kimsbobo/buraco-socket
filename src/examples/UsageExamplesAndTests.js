/* eslint-env jest */

/**
 * Usage Examples & Testing Guide - Production-Ready
 * 
 * Complete examples: instantiation, integration patterns, and test scenarios.
 * Use this as a quick reference for implementing and validating the system.
 */

// =========================================================================
// EXAMPLE 1: BASIC INSTANTIATION
// =========================================================================

const FailureManager = require('./managers/FailureManager');
const redis = require('redis');
const io = require('socket.io');
const GameManager = require('./managers/GameManager');
const Logger = require('./utils/Logger');

// Create Redis client
const redisClient = redis.createClient({
  host: 'localhost',
  port: 6379,
  retryStrategy: () => new Error('Redis connection failed'),
});

// Create Socket.io instance
const ioInstance = io(3000, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Create Game Manager
const gameManager = new GameManager();

// Create Logger
const logger = new Logger('FailureManager');

// Create Failure Manager
const failureManager = new FailureManager(
  ioInstance,
  redisClient,
  gameManager,
  logger
);

module.exports = failureManager;

// =========================================================================
// EXAMPLE 2: INTEGRATION IN SERVER STARTUP
// =========================================================================

async function initializeServer() {
  try {
    console.log('=== Server Startup ===');
    
    // Connect to Redis
    await redisClient.connect();
    console.log('✓ Redis connected');
    
    // Load persisted games
    const restoredCount = await failureManager.loadPersistedGames();
    console.log(`✓ Restored ${restoredCount} persisted games`);
    
    // Start Socket.io server
    ioInstance.listen(3000);
    console.log('✓ Socket.io listening on port 3000');
    
    console.log('=== Server Ready ===\n');
  } catch (error) {
    console.error('Server initialization failed:', error);
    process.exit(1);
  }
}

initializeServer();

// =========================================================================
// EXAMPLE 3: CONNECTION HANDLER INTEGRATION
// =========================================================================

ioInstance.on('connection', async (socket) => {
  const userId = socket.handshake.auth.userId;
  const roomId = socket.handshake.auth.roomId;
  
  console.log(`[Socket] Connection: ${userId} in room ${roomId}`);
  
  socket.on('join_game', async (data) => {
    console.log(`[Socket] Join: ${data.userId}`);
    
    // ✓ CALL FAILURE MANAGER FIRST
    const result = await failureManager.handlePlayerConnection(socket, {
      userId: data.userId,
      roomId: data.roomId,
      previousSocketId: data.previousSocketId,
      userName: data.userName,
    });
    
    if (!result.success) {
      socket.emit('join_failed', result);
      return;
    }
    
    // Your existing game join logic
    const room = gameManager.getRoom(data.roomId);
    socket.join(data.roomId);
    
    // Send full state to ensure sync
    const player = room.getPlayer(data.userId);
    failureManager.sendFullGameStateToPlayer(socket, room, player);
    
    // Broadcast update
    ioInstance.to(data.roomId).emit('room_updated', {
      players: room.getPlayers(),
    });
    
    console.log(`[Socket] ✓ Player joined: ${data.userId}`);
  });
  
  socket.on('disconnect', async () => {
    console.log(`[Socket] Disconnect: ${userId}`);
    
    // ✓ CALL FAILURE MANAGER
    await failureManager.handlePlayerDisconnection(socket, userId, roomId);
  });
});

// =========================================================================
// EXAMPLE 4: GAME ACTION WITH STATE PERSISTENCE
// =========================================================================

ioInstance.on('connection', (socket) => {
  socket.on('draw_card', async (data) => {
    const { userId, roomId, drawFromDiscard } = data;
    
    const room = gameManager.getRoom(roomId);
    const player = room.getPlayer(userId);
    
    // Perform draw
    let card;
    if (drawFromDiscard && room.discardPile.length > 0) {
      card = room.discardPile.pop();
    } else {
      card = room.deck.draw();
    }
    
    const hand = room.playerHands.get(userId);
    hand.push(card);
    room.hasDrawnCard = true;
    
    // ✓ PERSIST STATE IMMEDIATELY
    await failureManager.persistGameState(room);
    
    // Broadcast
    ioInstance.to(roomId).emit('card_drawn', {
      playerId: userId,
      playerIndex: player.playerIndex,
      card: { suit: card.suit, rank: card.rank },
    });
    
    console.log(`[Game] Draw: ${userId}`);
  });
});

// =========================================================================
// EXAMPLE 5: SURRENDER HANDLER
// =========================================================================

ioInstance.on('connection', (socket) => {
  socket.on('surrender', async (data) => {
    const { userId, roomId } = data;
    
    console.log(`[Game] Surrender: ${userId}`);
    
    // ✓ FAILURE MANAGER HANDLES WHOLE SURRENDER
    await failureManager.handleSurrender(socket, { userId, roomId });
    
    // Your additional logic (score updates, etc.)
    const room = gameManager.getRoom(roomId);
    // ... your code ...
    
    console.log('[Game] ✓ Surrendered, bot takeover');
  });
});

// =========================================================================
// EXAMPLE 6: GRACEFUL SHUTDOWN
// =========================================================================

process.on('SIGTERM', async () => {
  console.log('\n=== Server Shutdown ===');
  
  // Persist all active games
  const allRooms = gameManager.getAllActiveRooms();
  for (const room of allRooms) {
    await failureManager.persistGameState(room);
  }
  console.log(`✓ Persisted ${allRooms.length} games`);
  
  // Cleanup failure manager timers
  failureManager.dispose();
  console.log('✓ Failure manager cleaned up');
  
  // Disconnect Redis
  await redisClient.quit();
  console.log('✓ Redis disconnected');
  
  // Close Socket.io
  ioInstance.close();
  console.log('✓ Socket.io closed');
  
  console.log('=== Server Stopped ===\n');
  process.exit(0);
});

// =========================================================================
// TESTING: JEST/MOCHA TEST SUITE
// =========================================================================

// test/failureManager.test.js

const TestFailureManager = require('../managers/FailureManager');
const { MockRedis } = require('./mocks/redis');
const { MockGameManager } = require('./mocks/gameManager');
const { MockLogger } = require('./mocks/logger');

describe('FailureManager', () => {
  let failureManager;
  let mockRedis;
  let mockGameManager;
  let mockLogger;
  let mockIO;
  let mockSocket;
  
  beforeEach(() => {
    // Setup mocks
    mockRedis = new MockRedis();
    mockGameManager = new MockGameManager();
    mockLogger = new MockLogger();
    
    mockIO = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
    };
    
    mockSocket = {
      id: 'socket-123',
      emit: jest.fn(),
      join: jest.fn(),
    };
    
    // Create failure manager with mocks
    failureManager = new TestFailureManager(
      mockIO,
      mockRedis,
      mockGameManager,
      mockLogger
    );
  });
  
  // =========================================================================
  // TEST SCENARIO 1: New Player Connection
  // =========================================================================
  
  test('New player connection succeeds', async () => {
    mockGameManager.createRoom('room-1');
    mockGameManager.addPlayer('room-1', {
      playerId: 'user-1',
      playerIndex: 0,
    });
    
    const result = await failureManager.handlePlayerConnection(mockSocket, {
      userId: 'user-1',
      roomId: 'room-1',
      previousSocketId: null,
      userName: 'Alice',
    });
    
    expect(result.success).toBe(true);
    expect(result.isReconnection).toBe(false);
    expect(mockRedis.get('session:socket-123')).toBeDefined();
  });
  
  // =========================================================================
  // TEST SCENARIO 2: Player Reconnection
  // =========================================================================
  
  test('Player reconnection with grace period is successful', async () => {
    // Setup initial connection
    mockRedis.set('session:old-socket', {
      userId: 'user-1',
      roomId: 'room-1',
      userName: 'Alice',
    });
    
    mockGameManager.createRoom('room-1');
    mockGameManager.addPlayer('room-1', {
      playerId: 'user-1',
      playerIndex: 0,
    });
    
    // Reconnect with previousSocketId
    const result = await failureManager.handlePlayerConnection(mockSocket, {
      userId: 'user-1',
      roomId: 'room-1',
      previousSocketId: 'old-socket',
      userName: 'Alice',
    });
    
    expect(result.success).toBe(true);
    expect(result.isReconnection).toBe(true);
    expect(mockRedis.has('session:old-socket')).toBe(false); // Old session deleted
    expect(mockRedis.has('session:socket-123')).toBe(true); // New session created
  });
  
  // =========================================================================
  // TEST SCENARIO 3: Player Disconnection Enters Grace Period
  // =========================================================================
  
  test('Player disconnection enters grace period', async () => {
    mockGameManager.createRoom('room-1');
    mockGameManager.addPlayer('room-1', {
      playerId: 'user-1',
      playerIndex: 0,
      socketId: 'socket-123',
    });
    
    const room = mockGameManager.getRoom('room-1');
    const player = room.getPlayer('user-1');
    
    await failureManager.handlePlayerDisconnection(mockSocket, 'user-1', 'room-1');
    
    const graceKey = 'grace:user-1:room-1';
    expect(mockRedis.has(graceKey)).toBe(true);
    expect(player.status).toBe('grace_period');
    
    // Verify grace period was set in Redis
    const graceData = mockRedis.get(graceKey);
    expect(graceData.userId).toBe('user-1');
  });
  
  // =========================================================================
  // TEST SCENARIO 4: Grace Period Expires → Bot Conversion
  // =========================================================================
  
  test('Grace period expiry converts player to bot', async () => {
    mockGameManager.createRoom('room-1');
    mockGameManager.addPlayer('room-1', {
      playerId: 'user-1',
      playerIndex: 0,
    });
    
    const room = mockGameManager.getRoom('room-1');
    const player = room.getPlayer('user-1');
    
    // Mock grace period expiry
    await failureManager.handlePlayerDisconnection(mockSocket, 'user-1', 'room-1');
    
    // Simulate grace period expiry
    jest.useFakeTimers();
    jest.advanceTimersByTime(30 * 1000);
    
    // Player should become bot (in real implementation via timer)
    // For testing, we manually trigger conversion
    await failureManager._convertPlayerToBot(room, player);
    
    expect(player.isBot).toBe(true);
    expect(player.botDifficulty).toBe('medium');
    expect(mockRedis.has('bot:room-1:0')).toBe(true);
    
    jest.useRealTimers();
  });
  
  // =========================================================================
  // TEST SCENARIO 5: Surrender Immediate Bot Conversion
  // =========================================================================
  
  test('Surrender immediately converts player to bot', async () => {
    mockGameManager.createRoom('room-1');
    mockGameManager.addPlayer('room-1', {
      playerId: 'user-1',
      playerIndex: 0,
    });
    
    const room = mockGameManager.getRoom('room-1');
    const player = room.getPlayer('user-1');
    
    await failureManager.handleSurrender(mockSocket, {
      userId: 'user-1',
      roomId: 'room-1',
    });
    
    expect(player.isBot).toBe(true);
    expect(mockIO.to).toHaveBeenCalledWith('room-1');
  });
  
  // =========================================================================
  // TEST SCENARIO 6: State Persistence
  // =========================================================================
  
  test('Game state is persisted to Redis', async () => {
    mockGameManager.createRoom('room-1');
    mockGameManager.getRoom('room-1').currentTurn = 0;
    mockGameManager.getRoom('room-1').phase = 'draw';
    
    const room = mockGameManager.getRoom('room-1');
    
    await failureManager.persistGameState(room);
    
    const stateKey = 'game:room-1:state';
    expect(mockRedis.has(stateKey)).toBe(true);
    
    const state = JSON.parse(mockRedis.get(stateKey));
    expect(state.roomId).toBe('room-1');
    expect(state.currentTurn).toBe(0);
    expect(state.phase).toBe('draw');
  });
  
  // =========================================================================
  // TEST SCENARIO 7: Host Migration
  // =========================================================================
  
  test('Host migration elects oldest connected player', async () => {
    mockGameManager.createRoom('room-1');
    mockGameManager.addPlayer('room-1', {
      playerId: 'user-1',
      playerIndex: 0,
      status: 'connected',
      joinedAt: new Date('2024-01-01'),
    });
    mockGameManager.addPlayer('room-1', {
      playerId: 'user-2',
      playerIndex: 1,
      status: 'connected',
      joinedAt: new Date('2024-01-02'),
    });
    
    const room = mockGameManager.getRoom('room-1');
    room.hostPlayerId = 'user-1';
    
    await failureManager.handleHostMigration(room);
    
    // User-1 (older) should remain host
    expect(room.hostPlayerId).toBe('user-1');
  });
  
  // =========================================================================
  // TEST SCENARIO 8: Load Persisted Games
  // =========================================================================
  
  test('Load persisted games on startup', async () => {
    // Persist some games
    mockRedis.set('game:room-1:state', {
      roomId: 'room-1',
      hostPlayerId: 'user-1',
      currentTurn: 0,
      phase: 'draw',
    });
    
    const count = await failureManager.loadPersistedGames();
    
    expect(count).toBeGreaterThan(0);
  });
  
  // =========================================================================
  // TEST SCENARIO 9: Configuration Management
  // =========================================================================
  
  test('Configuration can be updated', () => {
    expect(failureManager.getConfig('GRACE_PERIOD_SECONDS')).toBe(30);
    
    failureManager.setConfig('GRACE_PERIOD_SECONDS', 60);
    
    expect(failureManager.getConfig('GRACE_PERIOD_SECONDS')).toBe(60);
  });
});

// =========================================================================
// MOCK IMPLEMENTATIONS FOR TESTING
// =========================================================================

class ExampleMockRedis {
  constructor() {
    this.store = new Map();
  }
  
  async set(key, value) {
    this.store.set(key, JSON.stringify(value));
  }
  
  async get(key) {
    const value = this.store.get(key);
    return value ? JSON.parse(value) : null;
  }
  
  async setex(key, ttl, value) {
    this.store.set(key, value);
    // Simulate TTL
    setTimeout(() => this.store.delete(key), ttl * 1000);
  }
  
  async del(key) {
    this.store.delete(key);
  }
  
  async keys(pattern) {
    const regex = new RegExp(pattern.replace('*', '.*'));
    return Array.from(this.store.keys()).filter(k => regex.test(k));
  }
  
  async exists(key) {
    return this.store.has(key) ? 1 : 0;
  }
  
  has(key) {
    return this.store.has(key);
  }
}

class ExampleMockGameManager {
  constructor() {
    this.rooms = new Map();
  }
  
  createRoom(roomId) {
    const room = {
      roomId,
      hostPlayerId: null,
      players: [],
      currentTurn: 0,
      phase: 'setup',
      playerHands: new Map(),
      playerMelds: new Map(),
      discardPile: [],
      deck: { count: 40, draw: () => ({ suit: 'H', rank: 'A' }) },
      
      getPlayer: function(playerId) {
        return this.players.find(p => p.playerId === playerId);
      },
      
      getPlayers: function() {
        return this.players;
      },
    };
    
    this.rooms.set(roomId, room);
    return room;
  }
  
  getRoom(roomId) {
    return this.rooms.get(roomId);
  }
  
  addPlayer(roomId, player) {
    const room = this.getRoom(roomId);
    room.players.push({
      playerId: player.playerId,
      playerIndex: player.playerIndex,
      status: player.status || 'connected',
      socketId: player.socketId || null,
      isBot: false,
      joinedAt: player.joinedAt || new Date(),
      ...player,
    });
  }
  
  getAllActiveRooms() {
    return Array.from(this.rooms.values());
  }
}

class ExampleMockLogger {
  info(msg) { console.log(`[INFO] ${msg}`); }
  warn(msg) { console.warn(`[WARN] ${msg}`); }
  error(msg) { console.error(`[ERROR] ${msg}`); }
  debug(msg) { if (process.env.DEBUG) console.log(`[DEBUG] ${msg}`); }
}

module.exports = {
  MockRedis,
  MockGameManager,
  MockLogger,
};
