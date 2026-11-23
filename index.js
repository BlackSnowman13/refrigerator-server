require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const WebSocket = require('ws');
const path = require('path');

const Database = require('./src/database/database');
const ESP32Handler = require('./src/handlers/esp32Handler');
const ClientHandler = require('./src/handlers/clientHandler');
const otaService = require('./src/utils/otaService');
const logger = require('./src/utils/logger');
const V1Server = require('./src/v1');

class RefrigeratorServer {
  constructor() {
    this.app = express();
    
    // Configure CORS for Express routes
    this.app.use(cors({
      origin: "*",
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"]
    }));
    
    // Parse JSON bodies
    this.app.use(express.json());
    
    this.server = createServer(this.app);
    this.wss = new WebSocket.Server({
      noServer: true,
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 3
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 128 // Only compress messages larger than 128 bytes
      }
    });
    this.port = process.env.PORT || 3000;
    
    // Ping/pong heartbeat interval (30 seconds)
    this.pingInterval = parseInt(process.env.WS_PING_INTERVAL) || 30000;
    
    this.database = new Database();
    this.esp32Handler = new ESP32Handler(this.wss, this.database);
    this.clientHandler = new ClientHandler(this.wss, this.database, this.esp32Handler);
    
    // Set cross-references so handlers can communicate
    this.esp32Handler.setClientHandler(this.clientHandler);

    // Initialize v1 WebSocket server (routed on /v1)
    this.v1Server = new V1Server({
      legacyEsp32Handler: this.esp32Handler
    });
    
    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupUpgradeRouter();
    this.startPingInterval();
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/', (req, res) => {
      res.json({ 
        message: 'ESP32-WebClient Bridge Server',
        status: 'running',
        timestamp: new Date().toISOString(),
        connectedESP32s: this.esp32Handler.getConnectedDevicesCount(),
        connectedClients: this.clientHandler.getConnectedClientsCount(),
        v1: this.v1Server.getStats()
      });
    });

    // API routes for historical data
    this.app.get('/api/esp32/list', (req, res) => {
      const devices = this.esp32Handler.getConnectedDevices();
      res.json({ devices });
    });

    this.app.get('/api/esp32/:serial/history', async (req, res) => {
      try {
        const { serial } = req.params;
        const { limit = 100, offset = 0 } = req.query;
        const history = await this.database.getSensorHistory(serial, limit, offset);
        res.json({ data: history });
      } catch (error) {
        logger.error('Error fetching sensor history:', error);
        res.status(500).json({ error: 'Failed to fetch sensor history' });
      }
    });

    // OTA Firmware Update Endpoints
    this.app.get('/api/firmware/check', async (req, res) => {
      try {
        const { serial, refresh } = req.query;
        const devices = this.esp32Handler.getConnectedDevices();
        const targetDevice = serial
          ? devices.find((d) => d.serialNumber === serial)
          : devices[0];

        const currentVersion =
          req.query.currentVersion ||
          targetDevice?.deviceInfo?.firmwareVersion ||
          'unknown';

        const status = await otaService.checkUpdateForVersion(
          currentVersion,
          refresh === 'true'
        );

        res.json({
          serialNumber: targetDevice?.serialNumber || serial || null,
          ...status
        });
      } catch (error) {
        logger.error('Error checking firmware update:', error);
        res.status(500).json({ error: error.message || 'Failed to check firmware update' });
      }
    });

    this.app.get('/api/firmware/download', async (req, res) => {
      try {
        logger.info(`Firmware download requested by ${req.socket.remoteAddress}`);
        await otaService.streamLatestBinary(res);
      } catch (error) {
        logger.error('Error downloading firmware binary:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message || 'Failed to download firmware binary' });
        }
      }
    });

    this.app.post('/api/esp32/:serial/ota', async (req, res) => {
      try {
        const { serial } = req.params;
        const { url } = req.body || {};
        const result = await this.clientHandler.handleOTAUpdateCommand(serial, { url });
        res.status(result.success ? 200 : 400).json(result);
      } catch (error) {
        logger.error('Error triggering OTA update:', error);
        res.status(500).json({ error: error.message || 'Failed to trigger OTA update' });
      }
    });
  }

  setupSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      logger.info(`WebSocket connected from ${req.socket.remoteAddress}`);
      
      // Add unique ID to websocket
      ws.id = Math.random().toString(36).substr(2, 9);
      
      // Mark connection as alive for ping/pong heartbeat
      ws.isAlive = true;
      
      ws.on('pong', () => {
        // Client responded to ping - connection is alive
        ws.isAlive = true;
      });
      
      ws.on('message', (message) => {
        // Any message also indicates connection is alive
        ws.isAlive = true;
        try {
          const data = JSON.parse(message.toString());
          this.handleMessage(ws, data);
        } catch (error) {
          logger.warn('Invalid JSON payload received');
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON format' }));
        }
      });

      ws.on('close', () => {
        logger.info(`WebSocket closed: ${ws.id}`);
        this.esp32Handler.handleDisconnection(ws);
        this.clientHandler.handleDisconnection(ws);
      });

      ws.on('error', (error) => {
        logger.error(`WebSocket error on ${ws.id}:`, error);
      });
    });
  }

  setupUpgradeRouter() {
    this.server.on('upgrade', (request, socket, head) => {
      let pathname = '/';
      try {
        pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
      } catch (_) {
        pathname = (request.url || '/').split('?')[0];
      }

      if (pathname === '/v1' || pathname === '/v1/') {
        this.v1Server.handleUpgrade(request, socket, head);
      } else {
        // Default: route "/" and any other legacy path to existing unversioned WebSocket server
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      }
    });
  }

  startPingInterval() {
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          // Connection didn't respond to previous ping - terminate it
          logger.warn(`WebSocket ${ws.id} did not respond to ping; terminating`);
          return ws.terminate();
        }
        
        // Mark as not alive and send ping - will be marked alive on pong
        ws.isAlive = false;
        ws.ping();
      });
    }, this.pingInterval);
  }

  handleMessage(ws, data) {
    const { type, ...payload } = data;
    
    switch(type) {
      case 'esp32:register':
        this.esp32Handler.handleRegistration(ws, payload);
        break;
      case 'esp32:data':
        this.esp32Handler.handleSensorData(ws, payload);
        break;
      case 'esp32:heartbeat':
        this.esp32Handler.handleHeartbeat(ws, payload);
        break;
      case 'esp32:command_response':
      case 'esp32:status':
        this.esp32Handler.handleCommandResponse(ws, data);
        break;
      case 'client:subscribe':
        this.clientHandler.handleSubscription(ws, payload);
        break;
      case 'client:unsubscribe':
        this.clientHandler.handleUnsubscription(ws, payload);
        break;
      case 'client:command':
        this.clientHandler.handleCommand(ws, payload);
        break;
      default:
        logger.warn(`Unknown message type: ${type}`);
        ws.send(JSON.stringify({ type: 'error', error: 'Unknown message type' }));
    }
  }

  async start() {
    try {
      // Initialize database
      await this.database.initialize();
      logger.info('Database initialized successfully');

      // Initialize v1 server
      await this.v1Server.initialize();

      // Start server
      this.server.listen(this.port, () => {
        logger.info(`ESP32-WebClient Bridge Server running on port ${this.port}`);
      });
    } catch (error) {
      logger.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Create and start the server
const server = new RefrigeratorServer();
server.start();

module.exports = RefrigeratorServer;