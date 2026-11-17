const logger = require('../utils/logger');
const otaService = require('../utils/otaService');

class ESP32Handler {
  constructor(wss, database) {
    this.wss = wss;
    this.database = database;
    this.connectedDevices = new Map(); // Map<serial_number, {socket, deviceInfo, lastHeartbeat}>
    this.deviceIntervals = new Map(); // Map<serial_number, interval_ms> - client preference, not for automatic collection
    this.clientHandler = null; // Will be set by the main server
    
    // Default configuration
    this.defaultInterval = parseInt(process.env.DEFAULT_DATA_INTERVAL) || 5000;
    this.maxInterval = parseInt(process.env.MAX_DATA_INTERVAL) || 60000;
    this.minInterval = parseInt(process.env.MIN_DATA_INTERVAL) || 1000;
    this.authEnabled = process.env.ESP32_AUTH_ENABLED !== 'false';
    
    // Heartbeat monitoring
    this.heartbeatTimeout = parseInt(process.env.CONNECTION_TIMEOUT) || 30000;
    this.startHeartbeatMonitoring();
  }

  // Set reference to ClientHandler (called by main server)
  setClientHandler(clientHandler) {
    this.clientHandler = clientHandler;
  }

  async handleRegistration(socket, data) {
    try {
      const { serialNumber, authKey, deviceInfo } = data;

      if (!serialNumber) {
        logger.error('Registration failed: Missing serial number');
        this.sendMessage(socket, { type: 'esp32:auth_error', error: 'Serial number is required' });
        await this.database.logConnection('esp32', 'unknown', 'auth_failure', 'Missing serial number');
        return;
      }

      // Authenticate ESP32
      if (this.authEnabled && !await this.authenticateESP32(serialNumber, authKey)) {
        this.sendMessage(socket, { type: 'esp32:auth_error', error: 'Authentication failed' });
        await this.database.logConnection('esp32', serialNumber, 'auth_failure', 'Invalid auth key');
        return;
      }

      // Check if device is already connected
      if (this.connectedDevices.has(serialNumber)) {
        const existingConnection = this.connectedDevices.get(serialNumber);
        logger.warn(`ESP32 ${serialNumber} already connected, disconnecting old connection`);
        this.sendMessage(existingConnection.socket, { type: 'esp32:duplicate_connection' });
        existingConnection.socket.close();
        this.cleanupDevice(serialNumber);
      }

      // Register device
      await this.registerDevice(socket, serialNumber, authKey, deviceInfo);
      
      logger.info(`ESP32 device registered: ${serialNumber}`);
      await this.database.logConnection('esp32', serialNumber, 'connect', JSON.stringify(deviceInfo));

    } catch (error) {
      logger.error('ESP32 registration error:', error);
      this.sendMessage(socket, { type: 'esp32:error', error: 'Registration failed' });
    }
  }

  async authenticateESP32(serialNumber, providedAuthKey) {
    try {
      const device = await this.database.getESP32Device(serialNumber);
      
      if (!device) {
        // Auto-register new device if auth key is provided
        if (providedAuthKey) {
          await this.database.registerESP32(serialNumber, providedAuthKey);
          return true;
        }
        return false;
      }
      
      return device.auth_key === providedAuthKey;
    } catch (error) {
      logger.error('Authentication error:', error);
      return false;
    }
  }

  async registerDevice(socket, serialNumber, authKey, deviceInfo) {
    // Update device info in database
    await this.database.registerESP32(serialNumber, authKey, deviceInfo);
    await this.database.updateESP32Status(serialNumber, 'online');

    // Store connection info
    this.connectedDevices.set(serialNumber, {
      socket,
      deviceInfo,
      lastHeartbeat: Date.now(),
      serialNumber
    });

    // Set default data interval
    this.deviceIntervals.set(serialNumber, this.defaultInterval);

    // Add socket metadata
    socket.esp32SerialNumber = serialNumber;
    socket.connectionType = 'esp32';

    // Send successful registration response
    this.sendMessage(socket, {
      type: 'esp32:registered',
      serialNumber,
      status: 'connected',
      dataInterval: this.defaultInterval
    });

    // Notify clients about new ESP32 connection
    this.notifyClientsDeviceStatusChange(serialNumber, 'connected');

    // Automatically check for OTA updates in the background when ESP32 connects
    if (process.env.GITHUB_TOKEN) {
      otaService
        .checkUpdateForVersion(deviceInfo?.firmwareVersion)
        .then((otaStatus) => {
          const dev = this.connectedDevices.get(serialNumber);
          if (dev) {
            dev.otaStatus = otaStatus;
          }
          this.broadcastToClients({
            type: 'esp32:ota_status',
            serialNumber,
            ...otaStatus,
            timestamp: new Date().toISOString()
          });
        })
        .catch((err) => {
          logger.warn(`Auto OTA check failed for ${serialNumber}: ${err.message}`);
        });
    }
  }

  sendMessage(socket, message) {
    if (socket.readyState === 1) { // WebSocket.OPEN = 1
      socket.send(JSON.stringify(message));
    } else {
      logger.error(`Cannot send message, WebSocket state: ${socket.readyState}`);
    }
  }

  handleSensorData(socket, data) {
    const serialNumber = socket.esp32SerialNumber;
    
    if (!serialNumber) {
      this.sendMessage(socket, { type: 'esp32:error', error: 'Device not registered' });
      return;
    }

    if (!this.connectedDevices.has(serialNumber)) {
      this.sendMessage(socket, { type: 'esp32:error', error: 'Device not found in registry' });
      return;
    }

    try {
      // Validate data format
      if (!data || typeof data !== 'object') {
        this.sendMessage(socket, { type: 'esp32:error', error: 'Invalid data format' });
        return;
      }

      // Add timestamp if not present, preserve requestId if present
      const sensorData = {
        ...data,
        timestamp: data.timestamp || new Date().toISOString(),
        serialNumber
      };

      // Log to database (but don't log the requestId in database)
      const dataForDb = { ...sensorData };
      delete dataForDb.requestId;
      this.database.logSensorData(serialNumber, dataForDb);

      // Broadcast to subscribed clients (preserving requestId for routing)
      this.broadcastDataToClients(serialNumber, sensorData);

      // Update last activity
      const device = this.connectedDevices.get(serialNumber);
      device.lastHeartbeat = Date.now();

    } catch (error) {
      logger.error('Error handling sensor data:', error);
      this.sendMessage(socket, { type: 'esp32:error', error: 'Data processing failed' });
    }
  }

  handleHeartbeat(socket, data) {
    const serialNumber = socket.esp32SerialNumber;
    
    if (serialNumber && this.connectedDevices.has(serialNumber)) {
      const device = this.connectedDevices.get(serialNumber);
      device.lastHeartbeat = Date.now();
      this.sendMessage(socket, { type: 'esp32:heartbeat_ack' });
    } else {
      // Handle unregistered heartbeat - request re-registration
      logger.warn(`Received heartbeat from unregistered socket. Socket serial: ${serialNumber || 'undefined'}. Requesting re-registration.`);
      this.sendMessage(socket, { 
        type: 'esp32:registration_required', 
        error: 'Device not registered. Please send registration message.' 
      });
    }
  }

  handleCommandResponse(socket, data) {
    const serialNumber = socket.esp32SerialNumber || data.serialNumber;
    if (!serialNumber) return;

    if (this.connectedDevices.has(serialNumber)) {
      const device = this.connectedDevices.get(serialNumber);
      device.lastHeartbeat = Date.now();
    }

    this.broadcastToClients({
      ...data,
      serialNumber,
      timestamp: data.timestamp || new Date().toISOString()
    });
  }

  async handleDisconnection(socket) {
    const serialNumber = socket.esp32SerialNumber;
    
    if (serialNumber && socket.connectionType === 'esp32') {
      logger.info(`ESP32 ${serialNumber} disconnected`);
      
      // Update database
      await this.database.updateESP32Status(serialNumber, 'offline');
      await this.database.logConnection('esp32', serialNumber, 'disconnect');
      
      // Cleanup
      this.cleanupDevice(serialNumber);
      
      // Notify clients
      this.notifyClientsDeviceStatusChange(serialNumber, 'disconnected');
    }
  }

  cleanupDevice(serialNumber) {
    // Remove from registries
    this.connectedDevices.delete(serialNumber);
    this.deviceIntervals.delete(serialNumber);
  }

  updateDataInterval(serialNumber, newInterval) {
    // Validate interval range
    if (newInterval < this.minInterval || newInterval > this.maxInterval) {
      return false;
    }
    
    this.deviceIntervals.set(serialNumber, newInterval);
    
    // Notify ESP32 of new interval (for client-initiated requests)
    if (this.connectedDevices.has(serialNumber)) {
      const device = this.connectedDevices.get(serialNumber);
      this.sendMessage(device.socket, {
        type: 'esp32:interval_update',
        interval: newInterval,
        timestamp: new Date().toISOString()
      });
    }
    
    return true;
  }

  broadcastDataToClients(serialNumber, sensorData) {
    // Send to subscribed clients only via ClientHandler
    if (this.clientHandler) {
      this.clientHandler.broadcastToSubscribers(serialNumber, sensorData);
    } else {
      // Fallback: broadcast to all clients (should not happen in normal operation)
      logger.warn('ClientHandler not available, broadcasting to all clients');
      this.broadcastToClients({
        type: 'esp32:data_broadcast',
        serialNumber,
        data: sensorData,
        timestamp: new Date().toISOString()
      });
    }
  }

  broadcastToClients(message) {
    this.wss.clients.forEach((client) => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify(message));
      }
    });
  }

  notifyClientsDeviceStatusChange(serialNumber, status) {
    this.broadcastToClients({
      type: 'esp32:status_change',
      serialNumber,
      status,
      timestamp: new Date().toISOString()
    });
  }

  startHeartbeatMonitoring() {
    setInterval(() => {
      const now = Date.now();
      const devicesToRemove = [];
      
      for (const [serialNumber, device] of this.connectedDevices.entries()) {
        if (now - device.lastHeartbeat > this.heartbeatTimeout) {
          logger.warn(`ESP32 ${serialNumber} heartbeat timeout`);
          devicesToRemove.push(serialNumber);
        }
      }
      
      // Remove timed out devices
      devicesToRemove.forEach(serialNumber => {
        const device = this.connectedDevices.get(serialNumber);
        if (device) {
          device.socket.close(); // WebSocket close method
          this.handleDisconnection(device.socket);
        }
      });
    }, this.heartbeatTimeout / 2); // Check every half timeout period
  }

  // Public methods for other handlers
  getConnectedDevices() {
    return Array.from(this.connectedDevices.entries()).map(([serialNumber, device]) => ({
      serialNumber,
      deviceInfo: device.deviceInfo,
      otaStatus: device.otaStatus || null,
      lastHeartbeat: device.lastHeartbeat,
      dataInterval: this.deviceIntervals.get(serialNumber)
    }));
  }

  getConnectedDevicesCount() {
    return this.connectedDevices.size;
  }

  isDeviceConnected(serialNumber) {
    return this.connectedDevices.has(serialNumber);
  }

  getDeviceSocket(serialNumber) {
    const device = this.connectedDevices.get(serialNumber);
    return device ? device.socket : null;
  }

  logConnectedDevicesState() {
    logger.info(`ESP32 connected devices: ${this.connectedDevices.size}`);
    
    if (this.connectedDevices.size === 0) {
      logger.info('No ESP32 devices connected');
    } else {
      for (const [serialNumber, device] of this.connectedDevices.entries()) {
        logger.info(`ESP32 ${serialNumber} state`, {
          socketReadyState: device.socket.readyState,
          lastHeartbeat: new Date(device.lastHeartbeat).toISOString(),
          deviceInfo: device.deviceInfo,
          intervalMs: this.deviceIntervals.get(serialNumber)
        });
      }
    }
  }
}

module.exports = ESP32Handler;