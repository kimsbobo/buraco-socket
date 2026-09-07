/**
 * Brazilia Game SDK for Node.js
 * 
 * A comprehensive SDK for integrating Brazilia game into any Node.js application
 * 
 * Features:
 * - Full game logic and rules
 * - Online multiplayer with Socket.IO
 * - Event-driven architecture
 * - Clean, developer-friendly API
 * 
 * @example
 * ```javascript
 * const { BraziliaSDK } = require('./sdk');
 * 
 * const sdk = new BraziliaSDK({ port: 8080 });
 * 
 * // Listen to events
 * sdk.on('game.completed', (event) => {
 *   console.log(`Winner: ${event.winner.name}`);
 *   console.log(`Duration: ${event.duration}`);
 * });
 * 
 * // Start server
 * await sdk.start();
 * ```
 */

const { GameService } = require('../src/services');
const { GameRoom } = require('../src/models');
const { SocketEvents } = require('../src/constants');
const SDKEventEmitter = require('./events/SDKEventEmitter');
const logger = require('../src/utils/logger');

class BraziliaSDK {
  /**
   * Create a new Brazilia SDK instance
   * @param {Object} options - SDK configuration
   * @param {number} options.port - Server port (default: 8080)
   * @param {string} options.host - Server host (default: '0.0.0.0')
   * @param {Object} options.cors - CORS configuration
   * @param {boolean} options.enableEvents - Enable webhook events (default: true)
   */
  constructor(options = {}) {
    this.options = {
      port: options.port || 8080,
      host: options.host || '0.0.0.0',
      cors: options.cors || { origin: '*', methods: ['GET', 'POST'] },
      enableEvents: options.enableEvents !== false,
    };
    
    this.gameService = null;
    this.io = null;
    this.server = null;
    this.eventEmitter = new SDKEventEmitter();
    this.isRunning = false;
    
    // Game sessions tracking
    this.gameSessions = new Map(); // gameId -> { startTime, players, etc }
  }
  
  /**
   * Start the SDK server
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isRunning) {
      throw new Error('SDK already running');
    }
    
    const { Server } = require('socket.io');
    
    // Initialize Socket.IO server
    this.io = new Server(this.options.port, {
      cors: this.options.cors,
      pingTimeout: 60000,
      pingInterval: 25000,
    });
    
    // Initialize game service
    this.gameService = new GameService();
    
    // Setup Socket.IO event handlers
    this._setupSocketHandlers();
    
    this.isRunning = true;
    logger.info(`Brazilia SDK started on ${this.options.host}:${this.options.port}`);
    
    return this;
  }
  
  /**
   * Stop the SDK server
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.isRunning) return;
    
    if (this.io) {
      await new Promise((resolve) => {
        this.io.close(resolve);
      });
    }
    
    if (this.gameService) {
      this.gameService.shutdown();
    }
    
    this.isRunning = false;
    logger.info('Brazilia SDK stopped');
  }
  
  /**
   * Subscribe to SDK events
   * @param {string} eventName - Event name
   * @param {Function} callback - Callback function
   * 
   * Available events:
   * - 'game.started'
   * - 'game.completed'
   * - 'player.status'
   * - 'turn.played'
   * 
   * @example
   * ```javascript
   * sdk.on('game.completed', (event) => {
   *   console.log(`Game ${event.gameId} completed`);
   *   console.log(`Winner: ${event.winner.name} with score ${event.winner.score}`);
   * });
   * ```
   */
  on(eventName, callback) {
    this.eventEmitter.on(eventName, callback);
    return this;
  }
  
  /**
   * Unsubscribe from an event
   * @param {string} eventName - Event name
   * @param {Function} callback - Callback function
   */
  off(eventName, callback) {
    this.eventEmitter.off(eventName, callback);
    return this;
  }
  
  /**
   * Get game state
   * @param {string} gameId - Game ID (room ID)
   * @returns {Object} Game state
   */
  getGameState(gameId) {
    const room = this.gameService.getRoom(gameId);
    if (!room) {
      throw new Error(`Game not found: ${gameId}`);
    }
    
    const session = this.gameSessions.get(gameId) || {};
    const duration = session.startTime 
      ? this._formatDuration(Date.now() - session.startTime.getTime())
      : '00:00:00';
    
    return {
      gameId,
      status: room.status,
      currentPlayerIndex: room.currentTurn,
      players: room.getPlayers().map(p => ({
        id: p.playerId,
        name: p.playerName,
        index: p.playerIndex,
        connected: p.isConnected,
      })),
      duration,
    };
  }
  
  /**
   * End a game programmatically
   * @param {string} gameId - Game ID
   * @param {string} winnerId - Winner player ID (optional)
   */
  endGame(gameId, winnerId = null) {
    const room = this.gameService.getRoom(gameId);
    if (!room) {
      throw new Error(`Game not found: ${gameId}`);
    }
    
    room.endGame(winnerId);
    this._emitGameCompleted(gameId, room);
  }
  
  /**
   * Get all active games
   * @returns {Array} List of active games
   */
  getActiveGames() {
    return this.gameService.getActiveRooms().map(room => ({
      gameId: room.roomId,
      status: room.status,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers,
    }));
  }
  
  /**
   * Get SDK statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      ...this.gameService.getStats(),
      uptime: process.uptime(),
      isRunning: this.isRunning,
    };
  }
  
  // Private methods
  
  _setupSocketHandlers() {
    this.io.on(SocketEvents.CONNECTION, (socket) => {
      logger.info(`Player connected: ${socket.id}`);
      
      // Join room
      socket.on(SocketEvents.JOIN_ROOM, ({ playerId, playerName, roomId }) => {
        const room = roomId 
          ? this.gameService.getRoom(roomId)
          : this.gameService.findOrCreateRoom();
        
        const targetRoom = room || this.gameService.findOrCreateRoom();
        const result = this.gameService.joinRoom(
          targetRoom.roomId,
          playerId,
          playerName,
          socket.id
        );
        
        if (result.success) {
          socket.join(targetRoom.roomId);
          
          // Notify player
          socket.emit(SocketEvents.PLAYER_JOINED, {
            success: true,
            playerId,
            playerName,
            playerIndex: result.player.playerIndex,
            roomId: targetRoom.roomId,
            timestamp: new Date().toISOString(),
          });
          
          // Notify others
          socket.to(targetRoom.roomId).emit(SocketEvents.PLAYER_JOINED, {
            playerId,
            playerName,
            playerIndex: result.player.playerIndex,
            timestamp: new Date().toISOString(),
          });
          
          // Emit player status event
          this._emitPlayerStatus(targetRoom.roomId, playerId, playerName, 'connected');
          
          // If game started
          if (result.gameStarted) {
            this._trackGameSession(targetRoom);
            this._emitGameStarted(targetRoom.roomId, targetRoom);
            
            this.io.to(targetRoom.roomId).emit(SocketEvents.GAME_STARTED, {
              players: targetRoom.getPlayers().map(p => p.toJSON()),
              currentPlayerIndex: targetRoom.currentTurn,
              timestamp: new Date().toISOString(),
            });
          }
        } else {
          socket.emit(SocketEvents.ERROR, { error: result.error });
        }
      });
      
      // Disconnect
      socket.on(SocketEvents.DISCONNECT, () => {
        const playerId = this.gameService.getPlayerIdBySocket(socket.id);
        if (playerId) {
          const room = this.gameService.getPlayerRoom(playerId);
          if (room) {
            const player = room.getPlayer(playerId);
            if (player) {
              player.disconnect();
              this._emitPlayerStatus(room.roomId, playerId, player.playerName, 'disconnected');
            }
          }
        }
        logger.info(`Player disconnected: ${socket.id}`);
      });
    });
  }
  
  _trackGameSession(room) {
    this.gameSessions.set(room.roomId, {
      startTime: new Date(),
      players: room.getPlayers().map(p => ({
        id: p.playerId,
        name: p.playerName,
        score: 0,
      })),
    });
  }
  
  _emitGameStarted(gameId, room) {
    if (!this.options.enableEvents) return;
    
    const event = {
      event: 'game.started',
      timestamp: new Date().toISOString(),
      gameId,
      players: room.getPlayers().map(p => ({
        id: p.playerId,
        name: p.playerName,
      })),
      currentPlayerIndex: room.currentTurn,
    };
    
    this.eventEmitter.emit('game.started', event);
  }
  
  _emitGameCompleted(gameId, room) {
    if (!this.options.enableEvents) return;
    
    const session = this.gameSessions.get(gameId);
    const duration = session 
      ? this._formatDuration(Date.now() - session.startTime.getTime())
      : '00:00:00';
    
    const players = room.getPlayers().map(p => ({
      id: p.playerId,
      name: p.playerName,
      score: 0, // TODO: Get actual scores from game state
    }));
    
    const winner = room.winnerId 
      ? players.find(p => p.id === room.winnerId)
      : players[0];
    
    const event = {
      event: 'game.completed',
      timestamp: new Date().toISOString(),
      gameId,
      players,
      winner: winner || players[0],
      duration,
    };
    
    this.eventEmitter.emit('game.completed', event);
    this.gameSessions.delete(gameId);
  }
  
  _emitPlayerStatus(gameId, playerId, playerName, status) {
    if (!this.options.enableEvents) return;
    
    const event = {
      event: 'player.status',
      timestamp: new Date().toISOString(),
      gameId,
      playerId,
      playerName,
      status,
    };
    
    this.eventEmitter.emit('player.status', event);
  }
  
  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${hours}:${minutes}:${secs}`;
  }
}

module.exports = BraziliaSDK;
