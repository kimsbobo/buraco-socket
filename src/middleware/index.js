/**
 * Middleware Export
 */

const ErrorHandler = require('./errorHandler');
const rateLimiter = require('./rateLimiter');
const { createSocketAuth, defaultVerify } = require('./socketAuth');

module.exports = {
  ErrorHandler,
  rateLimiter,
  createSocketAuth,
  defaultVerify,
};
