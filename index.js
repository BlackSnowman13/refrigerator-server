require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const WebSocket = require('ws');
const path = require('path');

const Database = require('./src/database/database');
const ESP32Handler = require('./src/handlers/esp32Handler');
const ClientHandler = require('./src/handlers/clientHandler');
const logger = require('./src/utils/logger');

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
    this.wss = new WebSocket.Server({ server: this.server });
    this.port = process.env.PORT || 3000;
    
    // Ping/pong heartbeat interval (30 seconds)
    this.pingInterval = parseInt(process.env.WS_PING_INTERVAL) || 30000;
    
    this.database = new Database();
    this.esp32Handler = new ESP32Handler(this.wss, this.database);
    this.clientHandler = new ClientHandler(this.wss, this.database, this.esp32Handler);
    
    // Set cross-references so handlers can communicate
    this.esp32Handler.setClientHandler(this.clientHandler);
    
    this.setupRoutes();
    this.setupSocketHandlers();
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
        connectedClients: this.clientHandler.getConnectedClientsCount()
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
  }

  setupSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      logger.info(`New WebSocket connection from: ${req.socket.remoteAddress}`);
      
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
          logger.error('Invalid JSON received:', error);
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON format' }));
        }
      });

      ws.on('close', () => {
        logger.info(`WebSocket connection closed: ${ws.id}`);
        this.esp32Handler.handleDisconnection(ws);
        this.clientHandler.handleDisconnection(ws);
      });

      ws.on('error', (error) => {
        logger.error(`WebSocket error on ${ws.id}:`, error);
      });
    });
  }

  startPingInterval() {
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          // Connection didn't respond to previous ping - terminate it
          logger.info(`WebSocket ${ws.id} failed to respond to ping, terminating`);
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
    logger.info(`=== MESSAGE RECEIVED ===`);
    logger.info(`WebSocket ID: ${ws.id}, Type: ${type}`, payload);
    
    switch(type) {
      case 'esp32:register':
        logger.info('Routing to ESP32 registration handler');
        this.esp32Handler.handleRegistration(ws, payload);
        break;
      case 'esp32:data':
        this.esp32Handler.handleSensorData(ws, payload);
        break;
      case 'esp32:heartbeat':
        this.esp32Handler.handleHeartbeat(ws, payload);
        break;
      case 'client:subscribe':
        logger.info('Routing to client subscription handler');
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
    logger.info(`=== MESSAGE PROCESSING COMPLETE ===`);
  }

  async start() {
    try {
      // Initialize database
      await this.database.initialize();
      logger.info('Database initialized successfully');

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