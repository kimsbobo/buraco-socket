/**
 * MessageSequencer
 * Handles message sequencing and ordering to prevent out-of-order delivery issues
 */

class MessageSequencer {
  constructor() {
    // Per-room message sequencing
    this.roomSequences = new Map(); // roomId -> current sequence number
  }

  /**
   * Get next sequence number for a room
   * @param {string} roomId
   * @returns {number}
   */
  getNextSequence(roomId) {
    const current = this.roomSequences.get(roomId) || 0;
    const next = current + 1;
    this.roomSequences.set(roomId, next);
    return next;
  }

  /**
   * Wrap a message with sequence number and metadata
   * @param {string} eventType
   * @param {Object} data
   * @param {string} roomId
   * @returns {Object}
   */
  wrapMessage(eventType, data, roomId) {
    const sequence = this.getNextSequence(roomId);
    const wrapped = {
      ...data,
      __messageSequence: sequence,
      __messageType: eventType,
      __timestamp: Date.now(),
      __roomId: roomId,
    };
    return wrapped;
  }

  /**
   * Reset sequence for a room (when game ends)
   * @param {string} roomId
   */
  resetSequence(roomId) {
    this.roomSequences.delete(roomId);
  }

  /**
   * Get current sequence for a room
   * @param {string} roomId
   * @returns {number}
   */
  getCurrentSequence(roomId) {
    return this.roomSequences.get(roomId) || 0;
  }
}

module.exports = new MessageSequencer();
