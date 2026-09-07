/**
 * Logger Utility
 * Simple logger with different log levels
 */

const config = require('../config');
const fs = require('fs');
const path = require('path');

const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

class Logger {
  constructor() {
    this.level = this._getLevelFromString(config.logging.level);
    this.enableConsole = config.logging.enableConsole;
    this.enableFile = config.logging.enableFile;
    this.logDirectory = config.logging.logDirectory;

    if (this.enableFile) {
      this._ensureLogDirectory();
    }
  }

  /**
   * Log error message
   * @param {string} message
   * @param {Error|Object} error
   */
  error(message, error = null) {
    if (this.level >= LogLevel.ERROR) {
      this._log('ERROR', message, error);
    }
  }

  /**
   * Log warning message
   * @param {string} message
   * @param {Object} data
   */
  warn(message, data = null) {
    if (this.level >= LogLevel.WARN) {
      this._log('WARN', message, data);
    }
  }

  /**
   * Log info message
   * @param {string} message
   * @param {Object} data
   */
  info(message, data = null) {
    if (this.level >= LogLevel.INFO) {
      this._log('INFO', message, data);
    }
  }

  /**
   * Log debug message
   * @param {string} message
   * @param {Object} data
   */
  debug(message, data = null) {
    if (this.level >= LogLevel.DEBUG) {
      this._log('DEBUG', message, data);
    }
  }

  /**
   * Internal log method
   * @private
   * @param {string} level
   * @param {string} message
   * @param {any} data
   */
  _log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;

    if (this.enableConsole) {
      const coloredMessage = this._colorize(level, logMessage);
      console.log(coloredMessage);
      if (data) {
        console.log(data);
      }
    }

    if (this.enableFile) {
      this._writeToFile(logMessage, data);
    }
  }

  /**
   * Colorize console output based on log level
   * @private
   * @param {string} level
   * @param {string} message
   * @returns {string}
   */
  _colorize(level, message) {
    const colors = {
      ERROR: '\x1b[31m', // Red
      WARN: '\x1b[33m',  // Yellow
      INFO: '\x1b[36m',  // Cyan
      DEBUG: '\x1b[90m', // Gray
    };
    const reset = '\x1b[0m';
    return `${colors[level] || ''}${message}${reset}`;
  }

  /**
   * Write log to file
   * @private
   * @param {string} message
   * @param {any} data
   */
  _writeToFile(message, data = null) {
    try {
      const date = new Date().toISOString().split('T')[0];
      const logFile = path.join(this.logDirectory, `${date}.log`);
      
      let fullMessage = message;
      if (data) {
        fullMessage += '\n' + JSON.stringify(data, null, 2);
      }
      fullMessage += '\n';

      fs.appendFileSync(logFile, fullMessage);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  /**
   * Ensure log directory exists
   * @private
   */
  _ensureLogDirectory() {
    try {
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create log directory:', error);
      this.enableFile = false;
    }
  }

  /**
   * Convert string to log level
   * @private
   * @param {string} levelStr
   * @returns {number}
   */
  _getLevelFromString(levelStr) {
    const levels = {
      error: LogLevel.ERROR,
      warn: LogLevel.WARN,
      info: LogLevel.INFO,
      debug: LogLevel.DEBUG,
    };
    return levels[levelStr.toLowerCase()] ?? LogLevel.INFO;
  }
}

// Export singleton instance
module.exports = new Logger();
