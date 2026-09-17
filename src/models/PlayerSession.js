/**
 * PlayerSession Model
 * Represents a player's connection session in an online game
 */

class PlayerSession {
  constructor({ playerId, playerName, playerIndex, socketId, isBot = false, botLevel = 'normal', avatarUrl = null }) {
    this.playerId = playerId;
    this.playerName = playerName;
    this.playerIndex = playerIndex;
    this.socketId = socketId;
    // Real-user profile photo URL, sent by the client on join and forwarded to
    // every seat + spectator so the spectator HUD can render "A vs B" with the
    // players' names and photos. Null for bots / clients that don't send one.
    this.avatarUrl = avatarUrl || null;
    this.connectedAt = new Date();
    this.isConnected = true;
    this.lastActivity = new Date();
    // Fields consumed by FailureManager (reconnection / host migration). Kept in
    // sync with isConnected so that subsystem never reads undefined (S-C9).
    this.joinedAt = this.connectedAt;
    this.status = 'connected';
    this.isBot = isBot === true;
    this.botLevel = botLevel;
    // Server-only proof of the API seat allocation admitted by join/claim.
    this.apiSeatReservationVersion = null;
  }

  /**
   * Mark player as active (called on any action)
   */
  markActive() {
    this.lastActivity = new Date();
    this.isConnected = true;
    this.status = 'connected';
  }

  /**
   * Mark player as disconnected
   */
  disconnect() {
    this.isConnected = false;
    this.status = 'disconnected';
  }

  /**
   * Check if player has been inactive for too long
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {boolean}
   */
  isInactive(timeoutMs) {
    if (!this.lastActivity) return false;
    return Date.now() - this.lastActivity.getTime() > timeoutMs;
  }

  /**
   * Serialize to JSON for network transmission
   * @returns {Object}
   */
  toJSON() {
    return {
      playerId: this.playerId,
      playerName: this.playerName,
      playerIndex: this.playerIndex,
      avatarUrl: this.avatarUrl,
      isConnected: this.isConnected,
      isBot: this.isBot,
      botLevel: this.botLevel,
      connectedAt: this.connectedAt.toISOString(),
      lastActivity: this.lastActivity?.toISOString(),
    };
  }

  /**
   * Create PlayerSession from JSON
   * @param {Object} json - JSON object
   * @returns {PlayerSession}
   */
  static fromJSON(json) {
    const session = new PlayerSession({
      playerId: json.playerId,
      playerName: json.playerName,
      playerIndex: json.playerIndex,
      socketId: json.socketId,
      avatarUrl: json.avatarUrl,
    });
    session.isConnected = json.isConnected ?? true;
    session.connectedAt = new Date(json.connectedAt);
    session.lastActivity = json.lastActivity ? new Date(json.lastActivity) : null;
    session.isBot = json.isBot === true;
    session.botLevel = json.botLevel || 'normal';
    return session;
  }

  /**
   * String representation
   * @returns {string}
   */
  toString() {
    return `PlayerSession(${this.playerName}, index: ${this.playerIndex}, connected: ${this.isConnected})`;
  }
}

module.exports = PlayerSession;
