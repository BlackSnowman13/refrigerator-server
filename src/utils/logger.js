const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.logToFile = process.env.LOG_TO_FILE === 'true';
    this.logFilePath = process.env.LOG_FILE_PATH || './logs/server.log';
    
    if (this.logToFile) {
      this.ensureLogDirectory();
    }
  }

  ensureLogDirectory() {
    const logDir = path.dirname(this.logFilePath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  formatMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length > 0 ? ' ' + args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ') : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${formattedArgs}`;
  }

  log(level, message, ...args) {
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    const currentLevel = levels[this.logLevel] || 2;
    const messageLevel = levels[level] || 2;

    if (messageLevel <= currentLevel) {
      const formattedMessage = this.formatMessage(level, message, ...args);
      
      // Console output
      console.log(formattedMessage);
      
      // File output
      if (this.logToFile) {
        try {
          fs.appendFileSync(this.logFilePath, formattedMessage + '\n');
        } catch (error) {
          console.error('Failed to write to log file:', error);
        }
      }
    }
  }

  error(message, ...args) {
    this.log('error', message, ...args);
  }

  warn(message, ...args) {
    this.log('warn', message, ...args);
  }

  info(message, ...args) {
    this.log('info', message, ...args);
  }

  debug(message, ...args) {
    this.log('debug', message, ...args);
  }
}

module.exports = new Logger();