const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class Database {
  constructor() {
    this.dbPath = process.env.DB_PATH || './data/refrigerator.db';
    this.db = null;
  }

  async initialize() {
    try {
      // Ensure data directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Connect to database
      this.db = new sqlite3.Database(this.dbPath);
      
      // Enable foreign keys
      await this.run('PRAGMA foreign_keys = ON');
      
      // Create tables
      await this.createTables();
      
      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error('Database initialization failed:', error);
      throw error;
    }
  }

  async createTables() {
    const tables = [
      // ESP32 devices table
      `CREATE TABLE IF NOT EXISTS esp32_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serial_number TEXT UNIQUE NOT NULL,
        auth_key TEXT NOT NULL,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'offline',
        device_info TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Sensor data table
      `CREATE TABLE IF NOT EXISTS sensor_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        esp32_serial TEXT NOT NULL,
        data_json TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (esp32_serial) REFERENCES esp32_devices(serial_number)
      )`,
      
      // Connection logs table
      `CREATE TABLE IF NOT EXISTS connection_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_type TEXT NOT NULL, -- 'esp32' or 'client'
        identifier TEXT NOT NULL, -- serial_number for ESP32, socket_id for client
        event_type TEXT NOT NULL, -- 'connect', 'disconnect', 'auth_success', 'auth_failure'
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      // Client sessions table (for tracking active subscriptions)
      `CREATE TABLE IF NOT EXISTS client_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        socket_id TEXT UNIQUE NOT NULL,
        subscribed_devices TEXT, -- JSON array of serial numbers
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    for (const table of tables) {
      await this.run(table);
    }

    // Create indexes for better performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_sensor_data_serial ON sensor_data(esp32_serial)',
      'CREATE INDEX IF NOT EXISTS idx_sensor_data_timestamp ON sensor_data(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_connection_logs_timestamp ON connection_logs(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_esp32_devices_serial ON esp32_devices(serial_number)'
    ];

    for (const index of indexes) {
      await this.run(index);
    }
  }

  // Promisify database operations
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          logger.error('Database run error:', err);
          reject(err);
        } else {
          resolve({ id: this.lastID, changes: this.changes });
        }
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, result) => {
        if (err) {
          logger.error('Database get error:', err);
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          logger.error('Database all error:', err);
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // ESP32 Device operations
  async registerESP32(serialNumber, authKey, deviceInfo = null) {
    const sql = `INSERT OR REPLACE INTO esp32_devices 
                 (serial_number, auth_key, device_info, updated_at) 
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)`;
    return await this.run(sql, [serialNumber, authKey, deviceInfo]);
  }

  async getESP32Device(serialNumber) {
    const sql = 'SELECT * FROM esp32_devices WHERE serial_number = ?';
    return await this.get(sql, [serialNumber]);
  }

  async updateESP32Status(serialNumber, status) {
    const sql = `UPDATE esp32_devices 
                 SET status = ?, last_seen = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                 WHERE serial_number = ?`;
    return await this.run(sql, [status, serialNumber]);
  }

  async getConnectedESP32Devices() {
    const sql = 'SELECT * FROM esp32_devices WHERE status = "online"';
    return await this.all(sql);
  }

  // Sensor data operations
  async logSensorData(esp32Serial, dataJson) {
    const sql = 'INSERT INTO sensor_data (esp32_serial, data_json) VALUES (?, ?)';
    return await this.run(sql, [esp32Serial, JSON.stringify(dataJson)]);
  }

  async getSensorHistory(esp32Serial, limit = 100, offset = 0) {
    const sql = `SELECT * FROM sensor_data 
                 WHERE esp32_serial = ? 
                 ORDER BY timestamp DESC 
                 LIMIT ? OFFSET ?`;
    const results = await this.all(sql, [esp32Serial, limit, offset]);
    return results.map(row => ({
      ...row,
      data_json: JSON.parse(row.data_json)
    }));
  }

  async getLatestSensorData(esp32Serial) {
    const sql = `SELECT * FROM sensor_data 
                 WHERE esp32_serial = ? 
                 ORDER BY timestamp DESC 
                 LIMIT 1`;
    const result = await this.get(sql, [esp32Serial]);
    if (result) {
      result.data_json = JSON.parse(result.data_json);
    }
    return result;
  }

  // Connection logging
  async logConnection(connectionType, identifier, eventType, details = null) {
    const sql = `INSERT INTO connection_logs 
                 (connection_type, identifier, event_type, details) 
                 VALUES (?, ?, ?, ?)`;
    return await this.run(sql, [connectionType, identifier, eventType, details]);
  }

  // Client session management
  async createClientSession(socketId) {
    const sql = `INSERT OR REPLACE INTO client_sessions 
                 (socket_id, connected_at, last_activity) 
                 VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
    return await this.run(sql, [socketId]);
  }

  async updateClientSubscriptions(socketId, subscribedDevices) {
    const sql = `UPDATE client_sessions 
                 SET subscribed_devices = ?, last_activity = CURRENT_TIMESTAMP 
                 WHERE socket_id = ?`;
    return await this.run(sql, [JSON.stringify(subscribedDevices), socketId]);
  }

  async getClientSession(socketId) {
    const sql = 'SELECT * FROM client_sessions WHERE socket_id = ?';
    const result = await this.get(sql, [socketId]);
    if (result && result.subscribed_devices) {
      result.subscribed_devices = JSON.parse(result.subscribed_devices);
    }
    return result;
  }

  async removeClientSession(socketId) {
    const sql = 'DELETE FROM client_sessions WHERE socket_id = ?';
    return await this.run(sql, [socketId]);
  }

  // Data cleanup operations
  async cleanupOldData(daysToKeep = 30) {
    const sql = 'DELETE FROM sensor_data WHERE timestamp < datetime("now", "-" || ? || " days")';
    return await this.run(sql, [daysToKeep]);
  }

  async cleanupOldLogs(daysToKeep = 7) {
    const sql = 'DELETE FROM connection_logs WHERE timestamp < datetime("now", "-" || ? || " days")';
    return await this.run(sql, [daysToKeep]);
  }

  // Close database connection
  close() {
    if (this.db) {
      this.db.close((err) => {
        if (err) {
          logger.error('Error closing database:', err);
        } else {
          logger.info('Database connection closed');
        }
      });
    }
  }
}

module.exports = Database;