/**
 * GameService
 * Manages all game rooms and coordinates game logic
 */

const { GameRoom, PlayerSession } = require('../models');
const { GameRoomStatus } = require('../constants');
const { ActionHandlers } = require('../handlers');
const logger = require('../utils/logger');
const config = require('../config');

class GameService {
  constructor() {
    this.rooms = new Map(); // roomId -> GameRoom
    this.playerToRoom = new Map(); // playerId -> roomId
    this.socketToPlayer = new Map(); // socketId -> playerId
    this.inactivityTimeout = config.game.inactivityTimeout;
    this.roomCleanupInterval = config.game.roomCleanupInterval;

    // Start cleanup timer
    this._startCleanupTimer();
  }

  /**
   * Normalize room ID to a stable Map key type.
   * @private
   * @param {string|number|null|undefined} roomId
   * @returns {string|null|undefined}
   */
  _normalizeRoomId(roomId) {
    if (roomId === null || roomId === undefined) return roomId;
    return String(roomId);
  }

  _logRoomLifecycle(event, payload = {}) {
    logger.info(`[ROOM_LIFECYCLE] ${event}`, {
      source: 'socket',
      event,
      ...payload,
    });
  }

  /**
   * Create a new game room
   * @param {string|null} roomId
   * @param {number} maxPlayers
   * @returns {GameRoom}
   */
  createRoom(roomId = null, maxPlayers = null) {
    const normalizedRoomId = this._normalizeRoomId(roomId);
    const id = normalizedRoomId || this._generateRoomId();

    const existingRoom = this.rooms.get(id);
    if (existingRoom) {
      if (maxPlayers && Number.isInteger(maxPlayers) && maxPlayers > 0) {
        existingRoom.maxPlayers = Math.max(maxPlayers, existingRoom.players.size);
      }
      this._logRoomLifecycle('room_reused', {
        roomId: id,
        maxPlayers: existingRoom.maxPlayers,
        playerCount: existingRoom.players.size,
      });
      return existingRoom;
    }

    const max = maxPlayers || config.game.maxPlayersPerRoom;
    const room = new GameRoom({ roomId: id, maxPlayers: max });
    this.rooms.set(id, room);
    this._logRoomLifecycle('room_created', {
      roomId: id,
      maxPlayers: max,
      playerCount: 0,
    });
    return room;
  }

  /**
   * Get a room by ID
   * @param {string} roomId
   * @returns {GameRoom|undefined}
   */
  getRoom(roomId) {
    return this.rooms.get(this._normalizeRoomId(roomId));
  }

  /**
   * Find or create a room for matchmaking
   * @returns {GameRoom}
   */
  findOrCreateRoom() {
    // Find first available room that's not full
    for (const room of this.rooms.values()) {
      if (!room.isFull() && room.status === GameRoomStatus.WAITING) {
        logger.info(`Found available room ${room.roomId}`);
        return room;
      }
    }
    logger.info('No available room found, creating new one');
    return this.createRoom();
  }

  /**
   * Move a SEAT onto a new socket, evicting the one it is leaving.
   *
   * The eviction is the point. Both reconnect branches used to only ADD the new
   * socketId -> playerId entry, so the superseded socket kept resolving to the
   * live player. When its `disconnect` finally landed — on mobile that is at
   * ping timeout, tens of seconds after the rejoin — the server processed it as
   * that player's disconnect and detached them from their own seat. With the
   * old mapping gone, getPlayerIdBySocket returns nothing for the corpse and it
   * is dropped where it belongs. (SocketHandlers.handleDisconnect carries a
   * second, independent guard for the same invariant.)
   *
   * markActive() is what undoes a `grace_period` / `disconnected` stamp that an
   * in-flight async disconnect may have applied — handleJoinRoom calls
   * markPlayerActive BEFORE joinRoom, so it cannot clean up after this point.
   *
   * @param {PlayerSession} player
   * @param {string} socketId
   */
  _rebindSeatSocket(player, socketId) {
    if (player.socketId && player.socketId !== socketId) {
      this.socketToPlayer.delete(player.socketId);
    }
    player.socketId = socketId;
    player.markActive();
    this.socketToPlayer.set(socketId, player.playerId);
  }

  canReleaseWaitingSeat(room, playerId, proof) {
    const player = room?.getPlayer(playerId);
    return !!player && room.status === GameRoomStatus.WAITING && !room.awaitingNextRound &&
      !room._pendingBackendStart && String(room.hostPlayerId) !== String(playerId) &&
      proof?.room === room && proof.player === player && proof.socketId === player.socketId &&
      proof.reservationVersion === player.apiSeatReservationVersion;
  }

  /**
   * Join a player to a room
   * @param {string} roomId
   * @param {string} playerId
   * @param {string} playerName
   * @param {string} socketId
   * @returns {Object}
   */
  joinRoom(roomId, playerId, playerName, socketId, avatarUrl = null, preferredPlayerIndex = null, releasedSeatProof = null) {
    const normalizedRoomId = this._normalizeRoomId(roomId);
    const room = this.getRoom(normalizedRoomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }
    let roomToLeave = null;
    let previousRoom = null;
    let previousPlayer = null;

    // Check if player is already in a room (handle reconnection)
    if (this.playerToRoom.has(playerId)) {
      const currentRoomId = this.playerToRoom.get(playerId);

      if (currentRoomId !== normalizedRoomId) {
        const currentRoom = this.getRoom(currentRoomId);
        const currentPlayer = currentRoom?.getPlayer(playerId);
        const releasedWaitingSeat = this.canReleaseWaitingSeat(currentRoom, playerId, releasedSeatProof);
        if (currentRoom?.getPlayer(playerId) &&
            (currentRoom.isInProgress() || currentRoom.awaitingNextRound || currentRoom._pendingBackendStart ||
             (currentRoom.status === GameRoomStatus.WAITING && (currentRoom.backendManaged || room.backendManaged) && !releasedWaitingSeat))) {
          return { success: false, error: 'Player is already in another active room' };
        }
        // Keep standalone room switching compatible, but validate/admit the
        // destination before dropping the old seat. Live matches never switch
        // through this incidental join path: leaving one requires a forfeit.
        roomToLeave = currentRoomId;
        previousRoom = currentRoom;
        previousPlayer = currentPlayer;
        logger.info(
          `Player ${playerId} requesting switch from room ${currentRoomId} to room ${normalizedRoomId}.`
        );
        this._logRoomLifecycle('player_switch_room', {
          roomId: normalizedRoomId,
          previousRoomId: currentRoomId,
          playerId,
        });
      } else {
        // Player is reconnecting to the same room
        // Allow reconnection even if room is full
        const existingPlayer = room.getPlayer(playerId);
        if (existingPlayer) {
          room.restoreWaitingHostSeat();
          this._rebindSeatSocket(existingPlayer, socketId);
          if (avatarUrl) existingPlayer.avatarUrl = avatarUrl;
          logger.info(`Player ${playerId} reconnected to room ${normalizedRoomId}`);
          this._logRoomLifecycle('player_reconnected', {
            roomId: normalizedRoomId,
            playerId,
            socketId,
          });
          return {
            success: true,
            reconnected: true,
            room,
            player: existingPlayer,
          };
        }
      }
    }

    // Safety net: Check if player is physically in the room even if playerToRoom lost the mapping
    // This can happen if state became inconsistent or during rapid rejoin attempts
    const existingPlayerInRoom = room.getPlayer(playerId);
    if (existingPlayerInRoom) {
      if (roomToLeave) this.leaveRoom(playerId);
      room.restoreWaitingHostSeat();
      this._rebindSeatSocket(existingPlayerInRoom, socketId);
      if (avatarUrl) existingPlayerInRoom.avatarUrl = avatarUrl;
      this.playerToRoom.set(playerId, normalizedRoomId); // Restore mapping
      logger.info(`Player ${playerId} reconnected to room ${normalizedRoomId} (restored mapping)`);
      this._logRoomLifecycle('player_reconnected_mapping_restored', {
        roomId: normalizedRoomId,
        playerId,
        socketId,
      });
      return {
        success: true,
        reconnected: true,
        room,
        player: existingPlayerInRoom,
        previousRoom,
        previousPlayer,
      };
    }

    if (room.status !== GameRoomStatus.WAITING || room.awaitingNextRound) {
      return { success: false, error: 'Room is not open for new seats' };
    }
    if (room.isFull()) {
      return { success: false, error: 'Room is full' };
    }
    if (room._pendingBackendStart) {
      return { success: false, error: 'Room start is pending' };
    }

    const fixedHostSeats = room.status === GameRoomStatus.WAITING && !room.awaitingNextRound;
    const isHost = fixedHostSeats && room.hostPlayerId != null && String(room.hostPlayerId) === String(playerId);
    const reserveHostSeat = fixedHostSeats && room.hostPlayerId != null;
    const hasPreferredSeat = preferredPlayerIndex != null;
    if (hasPreferredSeat && (!Number.isInteger(preferredPlayerIndex) || preferredPlayerIndex < 0 ||
        preferredPlayerIndex >= room.maxPlayers || (isHost && preferredPlayerIndex !== 0) ||
        (reserveHostSeat && !isHost && preferredPlayerIndex === 0))) {
      return { success: false, error: 'Invalid reserved seat' };
    }
    const hostPresent = room.getPlayers().some((p) => String(p.playerId) === String(room.hostPlayerId));
    if (reserveHostSeat && !isHost && !hostPresent && room.players.size >= room.maxPlayers - 1) {
      return { success: false, error: 'No available seat for player' };
    }
    // Repair only an admissible join/reconnect: a rejected request must not
    // silently move players without its handler publishing a successful roster.
    const rosterChanged = room.restoreWaitingHostSeat();
    const usedIndices = room.getPlayers().map((p) => p.playerIndex);
    let playerIndex = hasPreferredSeat ? preferredPlayerIndex : isHost || !reserveHostSeat ? 0 : 1;
    while (!hasPreferredSeat && !isHost && playerIndex < room.maxPlayers && usedIndices.includes(playerIndex)) {
      playerIndex++;
    }
    if (playerIndex >= room.maxPlayers || usedIndices.includes(playerIndex)) {
      return { success: false, error: 'No available seat for player', room, rosterChanged };
    }

    const session = new PlayerSession({
      playerId,
      playerName,
      playerIndex,
      socketId,
      avatarUrl,
    });

    // Add player to room
    if (!room.addPlayer(session)) {
      return { success: false, error: 'Failed to add player to room' };
    }
    if (roomToLeave) this.leaveRoom(playerId);

    // Fallback host ONLY for a room the backend does not own. A backend-managed
    // room's host is authoritative from sync-room (wlive host_user_id); a joiner
    // must never become its host, or their leave would kill the whole room.
    if (!room.hostPlayerId && !room.backendManaged) {
      room.hostPlayerId = playerId;
    }

    this.playerToRoom.set(playerId, normalizedRoomId);
    this.socketToPlayer.set(socketId, playerId);

    logger.info(
      `Player ${playerId} (${playerName}) joined room ${normalizedRoomId} as player ${playerIndex}`
    );
    this._logRoomLifecycle('player_joined', {
      roomId: normalizedRoomId,
      playerId,
      socketId,
      playerIndex,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers,
    });

    return {
      success: true,
      room,
      player: session,
      gameStarted: false,
      previousRoom,
      previousPlayer,
    };
  }

  /**
   * Add a server-side bot as a real player seat without requiring a Socket.IO
   * client connection.
   * @param {string} roomId
   * @param {Object} options
   * @param {string} options.botId
   * @param {string} options.botName
   * @param {number|null} options.playerIndex
   * @param {string} options.botLevel
   * @returns {Object}
   */
  addBotToRoom(roomId, options = {}) {
    const normalizedRoomId = this._normalizeRoomId(roomId);
    const room = this.getRoom(normalizedRoomId);
    if (!room) {
      return { success: false, error: 'Room not found' };
    }

    if (room.status !== GameRoomStatus.WAITING || room._pendingBackendStart) {
      return { success: false, error: 'Cannot add bot after game has started' };
    }

    if (room.isFull()) {
      return { success: false, error: 'Room is full' };
    }

    const botId = String(options.botId || `bot_${Date.now()}_${Math.floor(Math.random() * 10000)}`);
    if (room.getPlayer(botId) || this.playerToRoom.has(botId)) {
      return { success: false, error: 'Bot already exists in a room' };
    }

    // A backend may explicitly create a bot-only table without a human host.
    // Its first bot still owns zero; a known human/bot host reserves that chair.
    const isHost = room.hostPlayerId != null && String(room.hostPlayerId) === botId;
    const firstSeat = room.hostPlayerId != null && !isHost ? 1 : 0;
    const hostPresent = room.getPlayers().some((p) => String(p.playerId) === String(room.hostPlayerId));
    if (firstSeat === 1 && !hostPresent && room.players.size >= room.maxPlayers - 1) {
      return { success: false, error: 'No available seat for bot' };
    }
    room.restoreWaitingHostSeat();
    const usedIndices = room.getPlayers().map((p) => p.playerIndex);
    let playerIndex = isHost ? 0 : Number.isInteger(options.playerIndex) ? options.playerIndex : firstSeat;
    if (playerIndex < firstSeat || playerIndex >= room.maxPlayers || usedIndices.includes(playerIndex)) {
      playerIndex = firstSeat;
      while (playerIndex < room.maxPlayers && usedIndices.includes(playerIndex)) {
        playerIndex++;
      }
    }

    if (playerIndex >= room.maxPlayers) {
      return { success: false, error: 'No available seat for bot' };
    }

    const session = new PlayerSession({
      playerId: botId,
      playerName: options.botName || `Bot ${playerIndex + 1}`,
      playerIndex,
      socketId: `bot:${botId}`,
      isBot: true,
      botLevel: options.botLevel || 'normal',
    });

    if (!room.addPlayer(session)) {
      return { success: false, error: 'Failed to add bot to room' };
    }

    if (!room.hostPlayerId && playerIndex === 0) {
      room.hostPlayerId = botId;
    }

    this.playerToRoom.set(botId, normalizedRoomId);
    this.socketToPlayer.set(session.socketId, botId);

    logger.info(
      `Bot ${botId} (${session.playerName}) joined room ${normalizedRoomId} as player ${playerIndex}`
    );
    this._logRoomLifecycle('bot_joined', {
      roomId: normalizedRoomId,
      playerId: botId,
      playerIndex,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers,
    });

    return {
      success: true,
      room,
      player: session,
    };
  }

  /**
   * Remove player from room
   * @param {string} playerId
   * @returns {Object}
   */
  leaveRoom(playerId) {
    const roomId = this.playerToRoom.get(playerId);
    if (!roomId) {
      return { success: false, error: 'Player not in any room' };
    }

    const room = this.getRoom(roomId);
    if (!room) {
      // Room is gone, but mapping exists. Clean it up.
      this.playerToRoom.delete(playerId);
      logger.warn(
        `Player ${playerId} tried to leave room ${roomId} but room not found. Cleared mapping.`
      );
      return { success: false, error: 'Room not found' };
    }

    const player = room.getPlayer(playerId);

    // Items 7: host is IMMUTABLE (creator-only) and the room dies with the host
    // — never migrate to another seat. Whether or not other players remain, the
    // room is closed; its members are returned so the caller can notify + detach
    // them (contract item 5). In-progress host leaves forfeit upstream
    // (SocketHandlers._handleForfeitOnLeave) before reaching here.
    if (player && room.hostPlayerId === playerId) {
      logger.info(`Host ${playerId} left room ${roomId}. Host is immutable; closing room.`);
      this._logRoomLifecycle('host_left_room_deleted', {
        roomId,
        playerId,
      });

      // Get all players to return them for notification BEFORE teardown.
      const removedPlayers = room.getPlayers();

      // Tell any sockets still in the room (idle players / spectators) it's gone
      // BEFORE deleting it — _deleteRoom only does backend bookkeeping, so without
      // this a lingering spectator is silently stranded (no ROOM_CLOSED).
      this._notifyRoomClosing(roomId, 'host_left');
      this._deleteRoom(roomId);

      return {
        success: true,
        roomDeleted: true,
        roomId,
        removedPlayers,
        reason: 'HOST_LEFT',
      };
    }

    room.removePlayer(playerId);
    this.playerToRoom.delete(playerId);

    if (player) {
      this.socketToPlayer.delete(player.socketId);
    }

    logger.info(`Player ${playerId} left room ${roomId}`);
    this._logRoomLifecycle('player_left', {
      roomId,
      playerId,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers,
    });

    // Clean up empty rooms. Route through _deleteRoom so per-room timers are
    // cleared AND the backend is notified (onRoomDeleted), instead of a bare
    // rooms.delete that leaked both.
    if (room.players.size === 0 && !(room.backendManaged && room.status === GameRoomStatus.WAITING && room.hostPlayerId != null)) {
      this._logRoomLifecycle('room_deleted_empty', { roomId });
      // Notify any lingering spectators before teardown (see host-left path above).
      this._notifyRoomClosing(roomId, 'closed');
      this._deleteRoom(roomId);
    } else if (
      room.status === GameRoomStatus.FINISHED ||
      room.status === GameRoomStatus.ABANDONED
    ) {
      // If the game is finished/abandoned and a player leaves, check if we should clean it up
    }

    return { success: true, room };
  }

  /**
   * Delete a room explicitly (e.g. when game ends and we want to clean up immediately)
   * @param {string} roomId
   */
  deleteRoom(roomId) {
    this._deleteRoom(this._normalizeRoomId(roomId));
  }

  /**
   * Get player's current room
   * @param {string} playerId
   * @returns {GameRoom|undefined}
   */
  getPlayerRoom(playerId) {
    const roomId = this.playerToRoom.get(playerId);
    const room = roomId ? this.getRoom(roomId) : undefined;
    if (room) return room;
    // Self-heal a lost binding (defense in depth for the class of bug where some
    // other teardown drops this player's mapping while they are still seated).
    // Every caller means "the room this player is in", so re-deriving it from
    // the rosters is safe — and it is the difference between one warn line and a
    // table where every action is rejected until the client rejoins. Mirrors the
    // same safety net joinRoom already has.
    return this._recoverPlayerRoom(playerId, roomId);
  }

  /**
   * Find the live room whose roster still seats `playerId` and rebind the
   * mapping to it. Only a room that has NOT ended qualifies.
   * @private
   * @param {string} playerId
   * @param {string|undefined} staleRoomId mapping that pointed at a room that is gone
   * @returns {GameRoom|undefined}
   */
  _recoverPlayerRoom(playerId, staleRoomId) {
    if (playerId === null || playerId === undefined) return undefined;
    if (staleRoomId) {
      // The mapping pointed at a room that no longer exists — drop it either way.
      this.playerToRoom.delete(playerId);
    }
    for (const [roomId, room] of this.rooms.entries()) {
      if (!room.getPlayer(playerId)) continue;
      if (room.hasEnded?.() === true && room.awaitingNextRound !== true) continue;
      this.playerToRoom.set(playerId, roomId);
      logger.warn(
        `[MAPPING] Player ${playerId} had no room binding but is seated in ${roomId} — rebound (stale: ${staleRoomId || 'none'})`
      );
      return room;
    }
    return undefined;
  }

  /**
   * Get player ID from socket ID
   * @param {string} socketId
   * @returns {string|undefined}
   */
  getPlayerIdBySocket(socketId) {
    return this.socketToPlayer.get(socketId);
  }

  /**
   * Remove socket mapping
   * @param {string} socketId
   */
  removeSocket(socketId) {
    this.socketToPlayer.delete(socketId);
  }

  /**
   * Get all active rooms
   * @returns {GameRoom[]}
   */
  getActiveRooms() {
    return Array.from(this.rooms.values()).filter(
      (room) =>
        // #11 multi-round: a room in the round-over intermission is FINISHED but
        // very much alive. Excluding it would drop the match from the backend
        // liveness heartbeat and the occupancy monitor for the whole
        // interstitial, which is exactly what makes a live room look stale to the
        // backend's reaper.
        room.awaitingNextRound === true ||
        (room.status !== GameRoomStatus.FINISHED && room.status !== GameRoomStatus.ABANDONED)
    );
  }

  /**
   * Get game statistics
   * @returns {Object}
   */
  getStats() {
    const rooms = Array.from(this.rooms.values());
    return {
      totalRooms: rooms.length,
      activeRooms: rooms.filter((r) => r.isInProgress()).length,
      waitingRooms: rooms.filter((r) => r.status === GameRoomStatus.WAITING).length,
      finishedRooms: rooms.filter((r) => r.hasEnded()).length,
      totalPlayers: this.playerToRoom.size,
      activeSockets: this.socketToPlayer.size,
    };
  }

  /**
   * Get inactive rooms (finished/abandoned and older than threshold)
   * @param {number} thresholdMs
   * @returns {GameRoom[]}
   */
  getInactiveRooms(thresholdMs = 10 * 60 * 1000) {
    const now = Date.now();
    return Array.from(this.rooms.values()).filter((room) => {
      if (room.status !== GameRoomStatus.FINISHED && room.status !== GameRoomStatus.ABANDONED) {
        return false;
      }

      if (!room.gameEndedAt) return false;
      return now - room.gameEndedAt.getTime() > thresholdMs;
    });
  }

  /**
   * Get game statistics (compatibility wrapper)
   * @returns {Object}
   */
  getStatistics() {
    const stats = this.getStats();
    return {
      totalRooms: stats.totalRooms,
      totalPlayers: stats.totalPlayers,
      activeGames: stats.activeRooms,
      waitingRooms: stats.waitingRooms,
      finishedRooms: stats.finishedRooms,
    };
  }

  /**
   * Generate unique room ID
   * @private
   * @returns {string}
   */
  _generateRoomId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 7);
    return `room_${timestamp}_${random}`;
  }

  /**
   * Start cleanup timer for inactive rooms
   * @private
   */
  _startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this._cleanupInactiveRooms();
    }, this.roomCleanupInterval);
    logger.info('Started room cleanup timer');
  }

  /**
   * Clean up inactive rooms
   * @private
   */
  _cleanupInactiveRooms() {
    const now = Date.now();
    let cleanedCount = 0;
    const INPROGRESS_TIMEOUT = 300000; // 5 minutes for IN_PROGRESS rooms with no activity

    for (const [roomId, room] of this.rooms.entries()) {
      // Clean up finished or abandoned rooms older than 1 hour.
      // #11 multi-round: skip a room parked in the round-over intermission —
      // getRoomAge() is MATCH age (from createdAt) and survives every round, so a
      // long match that happens to be between rounds when this ticks would be
      // deleted mid-match, taking its cumulative score with it. The next-round
      // scheduler owns that room and always resolves it (deal or terminal abort).
      if (
        (room.status === GameRoomStatus.FINISHED || room.status === GameRoomStatus.ABANDONED) &&
        room.awaitingNextRound !== true &&
        room.getRoomAge() > 3600000
      ) {
        this._deleteRoom(roomId);
        cleanedCount++;
        continue;
      }

      // Mark rooms with all inactive players as abandoned.
      // #11 multi-round: skip a room parked in the round-over intermission, for
      // the same reason the FINISHED sweep above skips it. The intermission is
      // idle BY DEFINITION (no seat can act), and allPlayersInactive() also
      // returns true outright for an empty roster — so this branch can fire
      // inside a live match. Deleting the room here strands the scheduler:
      // _startScheduledNextRound finds no room and returns SILENTLY, so it never
      // reaches _abortNextRound and every client is left on the round-over card
      // counting down to a deal nobody will ever send. The scheduler always
      // resolves the room within one intermission (deal or terminal abort), after
      // which this sweep applies normally.
      if (room.awaitingNextRound !== true && room.allPlayersInactive(this.inactivityTimeout)) {
        room.abandon();
        logger.info(
          `Room ${roomId} marked as abandoned due to inactivity (all players inactive for ${this.inactivityTimeout}ms)`
        );
        // Tell any sockets still in the room before we delete it, so idle players
        // and spectators aren't stranded staring at a room the backend has closed
        // (the kill/cancel paths emit ROOM_CLOSED; this abandon path must too).
        this._notifyRoomClosing(roomId, 'inactive');
        this._deleteRoom(roomId);
        cleanedCount++;
        continue;
      }

      // Handle IN_PROGRESS rooms that all HUMAN players have left for too long.
      // A disconnected human that grace-expired into a bot (FailureManager) leaves
      // a bot in the seat, and the bot's markActive() keeps lastActivity AND
      // isConnected fresh. So keying off getConnectedPlayers()/lastActivity (which
      // both count bots) would keep a fully human-abandoned room alive forever and
      // it would never be delisted from the lobby (A4). Count ONLY humans.
      if (room.status === GameRoomStatus.IN_PROGRESS) {
        const connectedHumans = room
          .getPlayers()
          .filter((p) => p.isBot !== true && p.isConnected);

        if (connectedHumans.length === 0) {
          // Stamp the moment the last human left (once), then reap after the
          // timeout so a brief blip / in-grace human still has a chance to return.
          if (!room._allHumansGoneAt) room._allHumansGoneAt = now;
          if (now - room._allHumansGoneAt > INPROGRESS_TIMEOUT) {
            logger.info(
              `Room ${roomId} (IN_PROGRESS) closed: all humans gone for >${INPROGRESS_TIMEOUT}ms (bots ignored). Auto-closing.`
            );
            room.abandon();
            this._notifyRoomClosing(roomId, 'inactive');
            this._deleteRoom(roomId);
            cleanedCount++;
            continue;
          }
        } else if (room._allHumansGoneAt) {
          // A human is connected again — clear the abandonment stamp.
          room._allHumansGoneAt = null;
        }
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} inactive rooms`);
    }
  }

  /**
   * Delete a room and clean up mappings
   * @private
   * @param {string} roomId
   */
  /**
   * Fire the optional onRoomClosing hook (wired by SocketHandlers) so the socket
   * layer can emit ROOM_CLOSED to clients BEFORE the room is deleted. GameService
   * has no io reference, so room-teardown notifications must go through this hook.
   * Best-effort: a throwing listener never blocks the cleanup.
   * @private
   * @param {string} roomId
   * @param {string} reason
   */
  _notifyRoomClosing(roomId, reason) {
    if (typeof this.onRoomClosing !== 'function') return;
    try {
      this.onRoomClosing(this._normalizeRoomId(roomId), reason);
    } catch (err) {
      logger.warn(`onRoomClosing hook failed for ${roomId}: ${err.message}`);
    }
  }

  _deleteRoom(roomId) {
    const normalizedRoomId = this._normalizeRoomId(roomId);
    const room = this.rooms.get(normalizedRoomId);
    if (room) {
      // Cancel every per-room timer so nothing keeps firing (or holding a
      // closure over) the room after it is gone (S-C8): turn timers, the deal
      // animation fallback, and the post-match finalize-cleanup timer.
      room.disposeTimers();
      // Remove the mappings THIS room still owns — never one that has since
      // moved on. A roster entry outlives the binding: a player who left via
      // claim-seat or the FailureManager reconnect path (both set playerToRoom
      // directly, without leaveRoom) is still listed on the old room while
      // playerToRoom already points at their LIVE room. Deleting unconditionally
      // meant reaping a dead room (inactivity sweep, host-left, or a zombie room
      // rehydrated from Redis at boot) unbound those players from the game they
      // were actually playing: every draw/discard/meld answered "Player X not in
      // room", while the turn timer and state broadcasts — which read the roster,
      // not this map — kept running. The table looked alive and rejected every
      // tap until the client happened to re-emit join-room.
      for (const player of room.getPlayers()) {
        if (this.playerToRoom.get(player.playerId) === normalizedRoomId) {
          this.playerToRoom.delete(player.playerId);
        }
        if (player.socketId && this.socketToPlayer.get(player.socketId) === player.playerId) {
          this.socketToPlayer.delete(player.socketId);
        }
      }
      const everHadPlayers = room.everHadPlayers === true;
      // Capture the room's per-backend callback URL BEFORE it is dropped — the
      // hook runs after the room object is gone, so it can't read it back. This
      // lets a single socket serving two backends route every teardown's
      // room-closed webhook to the correct backend, not just the kill path.
      const backendBaseUrl = room.backendBaseUrl || null;
      this.rooms.delete(normalizedRoomId);
      logger.info(`Deleted room ${normalizedRoomId}`);

      // Notify any listener (SocketHandlers) that this room is gone, so the
      // backend lobby can close it and detach its players immediately instead of
      // waiting up to 5 min for the reconcile job. `everHadPlayers` lets the
      // listener skip never-occupied rooms (avoids closing a just-synced room
      // whose host is still connecting).
      if (typeof this.onRoomDeleted === 'function') {
        try {
          this.onRoomDeleted(normalizedRoomId, everHadPlayers, backendBaseUrl);
        } catch (err) {
          logger.warn(`onRoomDeleted hook failed for ${normalizedRoomId}: ${err.message}`);
        }
      }
    }
  }

  /**
   * Handle player disconnection and mark room for monitoring
   * @param {string} playerId
   * @returns {Object}
   */
  handlePlayerDisconnection(playerId) {
    const roomId = this.playerToRoom.get(playerId);
    if (!roomId) {
      return { success: false, error: 'Player not in any room' };
    }

    const room = this.getRoom(roomId);
    if (!room) {
      this.playerToRoom.delete(playerId);
      return { success: false, error: 'Room not found' };
    }

    const player = room.getPlayer(playerId);
    if (player) {
      player.disconnect();
      logger.info(`Player ${playerId} marked as disconnected in room ${roomId}`);
    }

    // Check if room needs monitoring
    if (room.status === GameRoomStatus.IN_PROGRESS) {
      const connectedPlayers = room.getConnectedPlayers();
      if (connectedPlayers.length === 0) {
        logger.info(
          `Room ${roomId} (IN_PROGRESS) now has 0 connected players. Will auto-close in ~5 minutes if no reconnection.`
        );
      }
    }

    return { success: true, room };
  }

  /**
   * Mark a player as active (on any game action)
   * @param {string} playerId
   */
  markPlayerActive(playerId) {
    const roomId = this.playerToRoom.get(playerId);
    if (!roomId) return;

    const room = this.getRoom(roomId);
    if (!room) return;

    const player = room.getPlayer(playerId);
    if (player) {
      player.markActive();
    }
  }

  /**
   * Shutdown service and cleanup
   */
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('Stopped room cleanup timer');
    }
    // Sweep every live room's per-room timers so none survives shutdown and
    // keeps the event loop alive / fires into a torn-down server.
    let swept = 0;
    for (const room of this.rooms.values()) {
      if (typeof room.disposeTimers === 'function') {
        room.disposeTimers();
        swept++;
      }
    }
    if (swept > 0) {
      logger.info(`Disposed timers for ${swept} room(s) on shutdown`);
    }
  }
}

module.exports = GameService;
