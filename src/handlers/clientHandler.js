const logger = require('../utils/logger');

class ClientHandler {
  constructor(wss, database, esp32Handler) {
    this.wss = wss;
    this.database = database;
    this.esp32Handler = esp32Handler;
    this.connectedClients = new Map(); // Map<socket_id, {socket, subscriptions, lastActivity}>
    this.pendingDataRequests = new Map(); // Map<requestId, {clientId, requestTime, targetESP32}>
    
    // Configuration
    this.maxESP32PerClient = parseInt(process.env.MAX_ESP32_PER_CLIENT) || 20;
    this.maxClientsPerESP32 = parseInt(process.env.MAX_CLIENTS_PER_ESP32) || 10;
    this.requestTimeout = 10000; // 10 seconds timeout for data requests
  }

  sendMessage(socket, message) {
    if (socket.readyState === 1) { // WebSocket.OPEN
      socket.send(JSON.stringify(message));
    }
  }

  async handleConnection(socket) {
    try {
      // Register client session
      await this.registerClient(socket);
      logger.info(`Web client connected: ${socket.id}`);
      
    } catch (error) {
      logger.error('Client connection error:', error);
      this.sendMessage(socket, { type: 'client:error', error: 'Connection registration failed' });
    }
  }

  async registerClient(socket) {
    // Add to connected clients registry
    this.connectedClients.set(socket.id, {
      socket,
      subscriptions: new Set(),
      lastActivity: Date.now()
    });

    // Create database session
    try {
      await this.database.createClientSession(socket.id);
      await this.database.logConnection('client', socket.id, 'connect');
    } catch (dbError) {
      logger.warn('Failed to create client session in database:', dbError.message);
    }

    // Add client metadata
    socket.connectionType = 'client';
    socket.clientId = socket.id;

    // Send welcome message with available ESP32s
    this.sendMessage(socket, {
      type: 'client:connected',
      clientId: socket.id,
      availableESP32s: this.esp32Handler.getConnectedDevices(),
      maxSubscriptions: this.maxESP32PerClient
    });
  }

  async handleSubscription(socket, data) {
    try {
      const { serialNumbers } = data;
      const clientId = socket.id;

      if (!Array.isArray(serialNumbers)) {
        this.sendMessage(socket, { type: 'client:error', error: 'Invalid serialNumbers format - must be array' });
        return;
      }

      // Validate subscription limits
      if (serialNumbers.length > this.maxESP32PerClient) {
        this.sendMessage(socket, { 
          type: 'client:error',
          error: `Too many subscriptions. Maximum allowed: ${this.maxESP32PerClient}` 
        });
        return;
      }

      const client = this.connectedClients.get(clientId);
      if (!client) {
        // Auto-register client if not already registered
        await this.registerClient(socket);
      }
      
      const finalClient = this.connectedClients.get(clientId);
      if (!finalClient) {
        this.sendMessage(socket, { type: 'client:error', error: 'Client registration failed' });
        return;
      }

      // Validate ESP32 devices exist and are connected
      const validSerialNumbers = [];
      const invalidSerialNumbers = [];
      const connectedDevices = this.esp32Handler.getConnectedDevices().map(d => d.serialNumber);
      
      // Log detailed ESP32 state for debugging if no devices are connected
      if (connectedDevices.length === 0) {
        this.esp32Handler.logConnectedDevicesState();
      }

      for (const serialNumber of serialNumbers) {
        if (this.esp32Handler.isDeviceConnected(serialNumber)) {
          validSerialNumbers.push(serialNumber);
        } else {
          invalidSerialNumbers.push(serialNumber);
          logger.warn(`ESP32 ${serialNumber} is NOT connected or not available for subscription`);
        }
      }

      if (invalidSerialNumbers.length > 0) {
        this.sendMessage(socket, {
          type: 'client:subscription_partial',
          subscribed: validSerialNumbers,
          failed: invalidSerialNumbers,
          reason: 'ESP32 devices not connected'
        });
      }

      // Check client limits per ESP32
      const subscriptionResults = [];
      const finalSubscriptions = [];

      for (const serialNumber of validSerialNumbers) {
        const currentSubscribers = this.getESP32SubscriberCount(serialNumber);
        
        if (currentSubscribers >= this.maxClientsPerESP32) {
          subscriptionResults.push({
            serialNumber,
            success: false,
            reason: 'ESP32 subscriber limit reached'
          });
        } else {
          // Add subscription
          finalClient.subscriptions.add(serialNumber);
          finalSubscriptions.push(serialNumber);
          subscriptionResults.push({
            serialNumber,
            success: true
          });
        }
      }

      // Update database
      try {
        await this.database.updateClientSubscriptions(clientId, Array.from(finalClient.subscriptions));
      } catch (dbError) {
        logger.warn('Failed to update client subscriptions in database:', dbError.message);
      }
      finalClient.lastActivity = Date.now();

      // Send subscription response
      this.sendMessage(socket, {
        type: 'client:subscription_result',
        results: subscriptionResults,
        currentSubscriptions: Array.from(finalClient.subscriptions)
      });

      logger.info(`Client ${clientId} subscription completed:`, {
        successful: finalSubscriptions,
        failed: invalidSerialNumbers,
        totalSubscriptions: finalClient.subscriptions.size
      });

    } catch (error) {
      logger.error('Client subscription error:', error);
      this.sendMessage(socket, { type: 'client:error', error: 'Subscription failed' });
    }
  }

  async handleUnsubscription(socket, data) {
    try {
      const { serialNumbers } = data;
      const clientId = socket.id;

      if (!Array.isArray(serialNumbers)) {
        this.sendMessage(socket, { type: 'client:error', error: 'Invalid serialNumbers format - must be array' });
        return;
      }

      const client = this.connectedClients.get(clientId);
      if (!client) {
        this.sendMessage(socket, { type: 'client:error', error: 'Client not registered' });
        return;
      }

      // Remove subscriptions
      const unsubscriptionResults = [];
      
      for (const serialNumber of serialNumbers) {
        if (client.subscriptions.has(serialNumber)) {
          client.subscriptions.delete(serialNumber);
          // No socket.leave needed for WebSocket
          unsubscriptionResults.push({
            serialNumber,
            success: true
          });
        } else {
          unsubscriptionResults.push({
            serialNumber,
            success: false,
            reason: 'Not subscribed to this ESP32'
          });
        }
      }

      // Update database
      await this.database.updateClientSubscriptions(clientId, Array.from(client.subscriptions));
      client.lastActivity = Date.now();

      // Send response
      this.sendMessage(socket, {
        type: 'client:unsubscription_result',
        results: unsubscriptionResults,
        currentSubscriptions: Array.from(client.subscriptions)
      });

      logger.info(`Client ${clientId} unsubscribed from ESP32s: ${serialNumbers.join(', ')}`);

    } catch (error) {
      logger.error('Client unsubscription error:', error);
      this.sendMessage(socket, { type: 'client:error', error: 'Unsubscription failed' });
    }
  }

  async handleCommand(socket, data) {
    try {
      // Accept both 'targetESP32' and 'serialNumber' for backwards compatibility
      const { serialNumber, command, parameters } = data;
      // const serialNumber = targetESP32 || serialNumber;
      const clientId = socket.id;

      logger.info(`Client ${clientId} command: ${command}, target: ${serialNumber}`, { parameters });

      if (!serialNumber) {
        logger.warn(`Client ${clientId} command missing target ESP32`);
        this.sendMessage(socket, { type: 'client:error', error: 'Missing targetESP32 or serialNumber field' });
        return;
      }

      const client = this.connectedClients.get(clientId);
      if (!client) {
        logger.warn(`Client ${clientId} not registered for command: ${command}`);
        this.sendMessage(socket, { type: 'client:error', error: 'Client not registered' });
        return;
      }

      // Verify client is subscribed to target ESP32
      if (!client.subscriptions.has(serialNumber)) {
        logger.warn(`Client ${clientId} not subscribed to ESP32 ${serialNumber}`);
        this.sendMessage(socket, { 
          type: 'client:error',
          error: 'Not subscribed to target ESP32',
          targetESP32: serialNumber,
          currentSubscriptions: Array.from(client.subscriptions)
        });
        return;
      }

      // Verify ESP32 is connected
      if (!this.esp32Handler.isDeviceConnected(serialNumber)) {
        logger.warn(`ESP32 ${serialNumber} not connected for client ${clientId} command`);
        this.sendMessage(socket, {
          type: 'client:command_result',
          targetESP32: serialNumber,
          command,
          success: false,
          error: 'ESP32 not connected'
        });
        return;
      }

      logger.info(`Executing command ${command} for client ${clientId} on ESP32 ${serialNumber}`);

      // Handle different command types
      let commandResult;
      
      switch (command) {
        case 'set_interval':
          commandResult = await this.handleIntervalCommand(serialNumber, parameters);
          break;
          
        case 'request_all_data':
          commandResult = await this.handleDataRequestCommand(serialNumber, parameters, clientId);
          break;

        case 'request_readonly_data':
          commandResult = await this.handleReadOnlyDataRequestCommand(serialNumber, parameters, clientId);
          break;
          
        case 'write_register':
          commandResult = await this.handleWriteRegisterCommand(serialNumber, parameters, clientId);
          break;
          
        case 'write_multiple_registers':
          commandResult = await this.handleWriteMultipleRegistersCommand(serialNumber, parameters, clientId);
          break;
          
        case 'get_status':
          commandResult = await this.handleStatusCommand(serialNumber, parameters);
          break;
          
        default:
          // Forward custom command to ESP32
          commandResult = await this.forwardCustomCommand(serialNumber, command, parameters);
      }

      // Send result back to client
      this.sendMessage(socket, {
        type: 'client:command_result',
        targetESP32: serialNumber,
        command,
        ...commandResult
      });

      client.lastActivity = Date.now();

      logger.info(`Command ${command} completed for client ${clientId}`);

    } catch (error) {
      logger.error('Client command error:', error);
      this.sendMessage(socket, { type: 'client:error', error: 'Command execution failed' });
    }
  }

  async handleIntervalCommand(targetESP32, parameters) {
    const { interval } = parameters;
    
    if (typeof interval !== 'number' || interval <= 0) {
      return { success: false, error: 'Invalid interval value' };
    }

    const success = this.esp32Handler.updateDataInterval(targetESP32, interval);
    
    if (success) {
      return { 
        success: true, 
        newInterval: interval,
        message: 'Data interval preference updated for future requests'
      };
    } else {
      return { 
        success: false, 
        error: 'Interval value out of allowed range'
      };
    }
  }

  async handleWriteMultipleRegistersCommand(targetESP32, parameters, clientId) {
    const esp32Socket = this.esp32Handler.getDeviceSocket(targetESP32);
    
    if (!esp32Socket) {
      return { success: false, error: 'ESP32 socket not available' };
    }

    // Validate required parameters
    const { registers } = parameters;
    if (!registers || !Array.isArray(registers) || registers.length === 0) {
      return { success: false, error: 'Missing or invalid registers array. Expected: [{registerCode, value}, ...]' };
    }

    // Validate each register entry
    for (let i = 0; i < registers.length; i++) {
      const reg = registers[i];
      if (!reg.registerCode || reg.value === undefined || reg.value === null) {
        return { 
          success: false, 
          error: `Invalid register entry at index ${i}. Each entry needs registerCode and value fields` 
        };
      }
    }

    // Generate unique request ID and track the request
    const requestId = `${clientId}_multi_write_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    // Store request tracking info
    this.pendingDataRequests.set(requestId, {
      clientId,
      requestTime: Date.now(),
      targetESP32,
      commandType: 'write_multiple_registers',
      registers: registers
    });

    // Clean up old requests (timeout cleanup)
    this.cleanupExpiredRequests();

    // Send multiple write command to ESP32
    this.esp32Handler.sendMessage(esp32Socket, {
      type: 'esp32:write_multiple_registers',
      registers: registers,
      requestId: requestId,
      timestamp: new Date().toISOString()
    });

    return { 
      success: true, 
      message: 'Multiple write command sent to ESP32', 
      requestId,
      registerCount: registers.length,
      registers: registers
    };
  }

  async handleWriteRegisterCommand(targetESP32, parameters, clientId) {
    const esp32Socket = this.esp32Handler.getDeviceSocket(targetESP32);
    
    if (!esp32Socket) {
      return { success: false, error: 'ESP32 socket not available' };
    }

    // Validate required parameters
    const { registerCode, value } = parameters;
    if (!registerCode || value === undefined || value === null) {
      return { success: false, error: 'Missing required parameters: registerCode and value' };
    }

    // Generate unique request ID and track the request
    const requestId = `${clientId}_write_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    // Store request tracking info
    this.pendingDataRequests.set(requestId, {
      clientId,
      requestTime: Date.now(),
      targetESP32,
      commandType: 'write_register',
      registerCode,
      requestedValue: value
    });

    // Clean up old requests (timeout cleanup)
    this.cleanupExpiredRequests();

    // Send write command to ESP32
    this.esp32Handler.sendMessage(esp32Socket, {
      type: 'esp32:write_register',
      registerCode: registerCode,
      value: value,
      requestId: requestId,
      timestamp: new Date().toISOString()
    });

    return { 
      success: true, 
      message: 'Write command sent to ESP32', 
      requestId,
      registerCode,
      requestedValue: value
    };
  }

  async handleDataRequestCommand(targetESP32, parameters, clientId) {
    const esp32Socket = this.esp32Handler.getDeviceSocket(targetESP32);
    
    if (!esp32Socket) {
      return { success: false, error: 'ESP32 socket not available' };
    }

    // Generate unique request ID and track the request
    const requestId = `${clientId}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    // Store request tracking info
    this.pendingDataRequests.set(requestId, {
      clientId,
      requestTime: Date.now(),
      targetESP32
    });

    // Clean up old requests (timeout cleanup)
    this.cleanupExpiredRequests();

    // Request immediate data using ESP32Handler's sendMessage
    this.esp32Handler.sendMessage(esp32Socket, {
      type: 'esp32:command',
      command: 'request_all_data',
      // immediate: true,
      requestId: requestId,
      timestamp: new Date().toISOString()
    });

    return { success: true, message: 'Data request sent to ESP32', requestId };
  }

    async handleReadOnlyDataRequestCommand(targetESP32, parameters, clientId) {
    const esp32Socket = this.esp32Handler.getDeviceSocket(targetESP32);
    
    if (!esp32Socket) {
      return { success: false, error: 'ESP32 socket not available' };
    }

    // Generate unique request ID and track the request
    const requestId = `${clientId}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    // Store request tracking info
    this.pendingDataRequests.set(requestId, {
      clientId,
      requestTime: Date.now(),
      targetESP32
    });

    // Clean up old requests (timeout cleanup)
    this.cleanupExpiredRequests();

    // Request immediate data using ESP32Handler's sendMessage
    this.esp32Handler.sendMessage(esp32Socket, {
      type: 'esp32:command',
      command: 'request_readonly_data',
      // immediate: true,
      requestId: requestId,
      timestamp: new Date().toISOString()
    });

    return { success: true, message: 'Data request sent to ESP32', requestId };
  }

  async handleStatusCommand(targetESP32, parameters) {
    const device = this.esp32Handler.getConnectedDevices().find(d => d.serialNumber === targetESP32);
    
    if (!device) {
      return { success: false, error: 'Device not found' };
    }

    return {
      success: true,
      status: {
        serialNumber: device.serialNumber,
        connected: true,
        lastHeartbeat: device.lastHeartbeat,
        dataInterval: device.dataInterval,
        deviceInfo: device.deviceInfo
      }
    };
  }

  async forwardCustomCommand(targetESP32, command, parameters) {
    const esp32Socket = this.esp32Handler.getDeviceSocket(targetESP32);
    
    if (!esp32Socket) {
      return { success: false, error: 'ESP32 socket not available' };
    }

    // Forward command to ESP32 using ESP32Handler's sendMessage
    this.esp32Handler.sendMessage(esp32Socket, {
      type: 'esp32:custom_command',
      command,
      parameters,
      requestId: Date.now().toString(),
      timestamp: new Date().toISOString()
    });

    return { success: true, message: 'Custom command forwarded to ESP32' };
  }

  async handleDisconnection(socket) {
    const clientId = socket.id;
    
    if (socket.connectionType === 'client') {
      logger.info(`Web client disconnected: ${clientId}`);
      
      // Log disconnection
      await this.database.logConnection('client', clientId, 'disconnect');
      
      // Cleanup client session
      await this.database.removeClientSession(clientId);
      
      // Remove from registry
      this.connectedClients.delete(clientId);
    }
  }

  // Utility methods
  getESP32SubscriberCount(serialNumber) {
    let count = 0;
    for (const client of this.connectedClients.values()) {
      if (client.subscriptions.has(serialNumber)) {
        count++;
      }
    }
    return count;
  }

  getConnectedClientsCount() {
    return this.connectedClients.size;
  }

  getClientSubscriptions(clientId) {
    const client = this.connectedClients.get(clientId);
    return client ? Array.from(client.subscriptions) : [];
  }

  // Broadcast methods (called by ESP32Handler)
  broadcastToSubscribers(serialNumber, data) {
    // Check if this is a response to a specific data request
    if (data.requestId && this.pendingDataRequests.has(data.requestId)) {
      // This is a response to a specific client request
      const request = this.pendingDataRequests.get(data.requestId);
      const client = this.connectedClients.get(request.clientId);
      
      if (client && client.socket.readyState === 1) {
        let messageType = 'client:data_response';
        
        // Determine response type based on request type
        if (request.commandType === 'write_register') {
          messageType = 'client:write_response';
        } else if (request.commandType === 'write_multiple_registers') {
          messageType = 'client:write_multiple_response';
        }
        
        this.sendMessage(client.socket, {
          type: messageType,
          serialNumber,
          data,
          requestId: data.requestId,
          timestamp: new Date().toISOString()
        });
        
      }
      
      // Clean up the request
      this.pendingDataRequests.delete(data.requestId);
    } else {
      // This is regular periodic sensor data - broadcast to all subscribers
      for (const [clientId, client] of this.connectedClients.entries()) {
        if (client.subscriptions.has(serialNumber) && client.socket.readyState === 1) {
          this.sendMessage(client.socket, {
            type: 'esp32:data_broadcast',
            serialNumber,
            data,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  }

  // Request cleanup method
  cleanupExpiredRequests() {
    const now = Date.now();
    for (const [requestId, request] of this.pendingDataRequests.entries()) {
      if (now - request.requestTime > this.requestTimeout) {
        this.pendingDataRequests.delete(requestId);
      }
    }
  }

  // Health check method
  getHealthStatus() {
    const now = Date.now();
    const activeClients = Array.from(this.connectedClients.values())
      .filter(client => now - client.lastActivity < 300000); // Active in last 5 minutes

    return {
      totalClients: this.connectedClients.size,
      activeClients: activeClients.length,
      totalSubscriptions: Array.from(this.connectedClients.values())
        .reduce((sum, client) => sum + client.subscriptions.size, 0),
      pendingDataRequests: this.pendingDataRequests.size
    };
  }
}

module.exports = ClientHandler;