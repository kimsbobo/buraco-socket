/**
 * Error Handler Middleware
 * Centralized error handling for Socket.IO events
 */

const logger = require('../utils/logger');

class ErrorHandler {
  /**
   * Wrap a socket event handler with error handling. The SOCKET must be passed
   * explicitly: the Socket.IO listener receives the event PAYLOAD as its first
   * arg, so the socket cannot be recovered from `args[0]`. The old code did that
   * — so a thrown handler could never emit an error and the client hung forever.
   * @param {Socket} socket  the connection the handler runs for
   * @param {Function} handler
   * @returns {Function}
   */
  static wrap(socket, handler) {
    return async (...args) => {
      try {
        await handler(...args);
      } catch (error) {
        logger.error('Socket event handler error:', error);

        // Prefer an ack callback if the client supplied one.
        const callback = args[args.length - 1];
        if (typeof callback === 'function') {
          callback({
            success: false,
            error: 'Internal server error',
            message: error.message,
          });
        } else if (socket && typeof socket.emit === 'function') {
          // Otherwise emit an error event so the client never hangs waiting.
          socket.emit('error', {
            success: false,
            error: 'Internal server error',
            message: error.message,
            timestamp: new Date().toISOString(),
          });
        }
      }
    };
  }

  /**
   * Handle socket errors
   * @param {Socket} socket
   * @param {Error} error
   */
  static handleSocketError(socket, error) {
    logger.error(`Socket error for ${socket.id}:`, error);
    socket.emit('error', {
      message: 'An error occurred',
      code: error.code || 'UNKNOWN_ERROR',
    });
  }

  /**
   * Create error response
   * @param {string} message
   * @param {string} code
   * @returns {Object}
   */
  static createErrorResponse(message, code = 'ERROR') {
    return {
      success: false,
      error: message,
      code,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Create success response
   * @param {Object} data
   * @returns {Object}
   */
  static createSuccessResponse(data = {}) {
    return {
      success: true,
      ...data,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = ErrorHandler;
