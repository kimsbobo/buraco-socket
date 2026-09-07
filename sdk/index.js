/**
 * Brazilia SDK - Main Entry Point
 * 
 * Export the SDK and types for easy importing
 */

const BraziliaSDK = require('./BraziliaSDK');

module.exports = {
  BraziliaSDK,
  
  // Re-export useful types from server
  GameRoomStatus: require('../src/constants').GameRoomStatus,
  SocketEvents: require('../src/constants').SocketEvents,
};
