/**
 * Matchmaking Service
 * 
 * Handles player queuing and automatic matching for online games
 */

const logger = require('../utils/logger');
const { GameRoomStatus } = require('../constants');
const EventEmitter = require('events');

class MatchmakingQueue extends EventEmitter {
  constructor(gameService) {
    super();
    this.gameService = gameService;
    this.queue = new Map(); // playerId -> MatchmakingEntry
    this.matchmakingTimeout = 30000; // 30 seconds max wait
    this.playersPerMatch = 2; // Default: 2 players per game
    this.checkInterval = null;
  }

  /**
   * Add player to matchmaking queue
   */
  addToQueue(playerId, playerName, socketId, preferences = {}) {
    if (this.queue.has(playerId)) {
      logger.warn(`Player ${playerId} already in queue`);
      return { success: false, error: 'Already in queue' };
    }

    const entry = {
      playerId,
      playerName,
      socketId,
      joinedAt: Date.now(),
      preferences: {
        skillLevel: preferences.skillLevel || 'any',
        gameMode: preferences.gameMode || 'standard',
        ...preferences,
      },
    };

    this.queue.set(playerId, entry);
    logger.info(`Player ${playerName} (${playerId}) joined matchmaking queue`);

    // Emit event
    this.emit('player_joined_queue', {
      playerId,
      playerName,
      queueSize: this.queue.size,
    });

    // Try to find match immediately
    this.tryMatchPlayers();

    // Start checking if not already started
    if (!this.checkInterval) {
      this.checkInterval = setInterval(() => {
        this.tryMatchPlayers();
        this.cleanupExpiredEntries();
      }, 2000);
    }

    return {
      success: true,
      queuePosition: this.queue.size,
      estimatedWait: this.estimateWaitTime(),
    };
  }

  /**
   * Remove player from queue
   */
  removeFromQueue(playerId) {
    const entry = this.queue.get(playerId);
    if (!entry) {
      return { success: false, error: 'Not in queue' };
    }

    this.queue.delete(playerId);
    logger.info(`Player ${entry.playerName} left matchmaking queue`);

    this.emit('player_left_queue', {
      playerId,
      playerName: entry.playerName,
      queueSize: this.queue.size,
    });

    // Stop interval if queue is empty
    if (this.queue.size === 0 && this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    return { success: true };
  }

  /**
   * Remove a player from the queue by their socket id (P1-11). Used on socket
   * disconnect, where only the socket id is known. No-op if not queued.
   * @param {string} socketId
   * @returns {{success: boolean, error?: string}}
   */
  removeBySocketId(socketId) {
    if (!socketId) return { success: false, error: 'Not in queue' };
    for (const [playerId, entry] of this.queue.entries()) {
      if (entry.socketId === socketId) {
        return this.removeFromQueue(playerId);
      }
    }
    return { success: false, error: 'Not in queue' };
  }

  /**
   * Try to match players in the queue
   */
  tryMatchPlayers() {
    if (this.queue.size < this.playersPerMatch) {
      return;
    }

    // Group players by preferences
    const groups = this.groupPlayersByPreferences();

    // Try to create matches for each group
    for (const [groupKey, players] of Object.entries(groups)) {
      while (players.length >= this.playersPerMatch) {
        const matchedPlayers = players.splice(0, this.playersPerMatch);
        this.createMatch(matchedPlayers);
      }
    }
  }

  /**
   * Group players by their matchmaking preferences
   */
  groupPlayersByPreferences() {
    const groups = {};

    for (const entry of this.queue.values()) {
      const key = `${entry.preferences.skillLevel}_${entry.preferences.gameMode}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(entry);
    }

    return groups;
  }

  /**
   * Create a match with the given players
   */
  createMatch(players) {
    try {
      // Create a new game room
      const room = this.gameService.findOrCreateRoom();

      // Apply ruleset preference when available
      const preferredMode = players[0]?.preferences?.gameMode;
      if (preferredMode === 'classic' || preferredMode === 'classicWithNoJoker' || preferredMode === 'professional') {
        room.ruleset = preferredMode;
      }
      
      logger.info(`Creating match with players: ${players.map(p => p.playerName).join(', ')}`);

      // Add all players to the room
      const joinResults = [];
      for (const player of players) {
        const result = this.gameService.joinRoom(
          room.roomId,
          player.playerId,
          player.playerName,
          player.socketId
        );
        joinResults.push({ player, result });
        
        // Remove from queue
        this.queue.delete(player.playerId);
      }

      // Emit match found event
      this.emit('match_found', {
        roomId: room.roomId,
        players: players.map(p => ({
          playerId: p.playerId,
          playerName: p.playerName,
        })),
        gameStarted: room.status === GameRoomStatus.IN_PROGRESS,
      });

      logger.info(`Match created: Room ${room.roomId}`);

      return {
        success: true,
        roomId: room.roomId,
        players: joinResults,
      };
    } catch (error) {
      logger.error(`Failed to create match: ${error.message}`);
      
      // Put players back in queue
      for (const player of players) {
        if (!this.queue.has(player.playerId)) {
          this.queue.set(player.playerId, player);
        }
      }
      
      return { success: false, error: error.message };
    }
  }

  /**
   * Clean up entries that have been waiting too long
   */
  cleanupExpiredEntries() {
    const now = Date.now();
    const expired = [];

    for (const [playerId, entry] of this.queue.entries()) {
      if (now - entry.joinedAt > this.matchmakingTimeout) {
        expired.push({ playerId, entry });
      }
    }

    for (const { playerId, entry } of expired) {
      this.queue.delete(playerId);
      logger.warn(`Player ${entry.playerName} matchmaking timeout`);
      
      this.emit('matchmaking_timeout', {
        playerId,
        playerName: entry.playerName,
        waitTime: now - entry.joinedAt,
      });
    }
  }

  /**
   * Estimate wait time based on queue size and historical data
   */
  estimateWaitTime() {
    const queueSize = this.queue.size;
    
    if (queueSize === 0) return 0;
    if (queueSize === 1) return 15000; // 15 seconds average
    
    // Simple estimation: less wait if more players
    return Math.max(5000, 20000 - (queueSize * 2000));
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueSize: this.queue.size,
      players: Array.from(this.queue.values()).map(entry => ({
        playerId: entry.playerId,
        playerName: entry.playerName,
        waitTime: Date.now() - entry.joinedAt,
        preferences: entry.preferences,
      })),
      estimatedWait: this.estimateWaitTime(),
    };
  }

  /**
   * Get player's queue position
   */
  getPlayerPosition(playerId) {
    if (!this.queue.has(playerId)) {
      return null;
    }

    const entries = Array.from(this.queue.values());
    const index = entries.findIndex(e => e.playerId === playerId);
    
    return {
      position: index + 1,
      queueSize: entries.length,
      waitTime: Date.now() - entries[index].joinedAt,
      estimatedWait: this.estimateWaitTime(),
    };
  }

  /**
   * Set matchmaking configuration
   */
  configure(config) {
    if (config.playersPerMatch) {
      this.playersPerMatch = config.playersPerMatch;
    }
    if (config.matchmakingTimeout) {
      this.matchmakingTimeout = config.matchmakingTimeout;
    }
    
    logger.info(`Matchmaking configured: ${JSON.stringify(config)}`);
  }

  /**
   * Shutdown matchmaking service
   */
  shutdown() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    // Notify all players in queue
    for (const entry of this.queue.values()) {
      this.emit('matchmaking_cancelled', {
        playerId: entry.playerId,
        playerName: entry.playerName,
        reason: 'Server shutdown',
      });
    }
    
    this.queue.clear();
    logger.info('Matchmaking service shut down');
  }
}

module.exports = MatchmakingQueue;
