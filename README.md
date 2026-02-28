# ESP32-WebClient Bridge Server

A real-time WebSocket server that enables web clients to monitor and control ESP32 devices by connecting through serial numbers. Perfect for IoT dashboards, sensor monitoring, and remote device management.

## Features

- 🔐 **Secure ESP32 authentication** with pre-shared keys
- 🌐 **Multi-client support** - multiple web clients can monitor the same ESP32
- 📊 **Real-time sensor data streaming** with configurable intervals
- 💾 **Full data logging** with SQLite database storage
- 🔄 **Automatic reconnection** handling for both ESP32s and clients
- 📱 **RESTful API** for historical data retrieval
- 🎯 **Command routing** from web clients to specific ESP32 devices
- 📈 **Connection monitoring** with heartbeat detection

## Architecture

```
Web Clients ←→ WebSocket Server ←→ ESP32 Devices
                      ↓
                SQLite Database
```

### Components

- **Express Server**: HTTP API endpoints and static file serving
- **Socket.IO Server**: Real-time WebSocket communication
- **Database Layer**: SQLite for data persistence and device management
- **ESP32 Handler**: Manages ESP32 connections, authentication, and data collection
- **Client Handler**: Manages web client sessions and subscriptions

## Quick Start

### 1. Installation

```bash
# Clone the repository
git clone <repository-url>
cd refrigerator-server

# Install dependencies
npm install

# Start the server
npm start
```

### 2. Configuration

Copy and modify the `.env` file:

```env
# Server Configuration
PORT=3000
NODE_ENV=development

# Database Configuration
DB_PATH=./data/refrigerator.db

# ESP32 Configuration
DEFAULT_DATA_INTERVAL=5000
MAX_DATA_INTERVAL=60000
MIN_DATA_INTERVAL=1000

# Security Configuration
ESP32_AUTH_ENABLED=true

# Connection Limits
MAX_CLIENTS_PER_ESP32=10
MAX_ESP32_PER_CLIENT=20
```

### 3. Connect an ESP32

Use the example ESP32 code in `examples/esp32_client.ino`:

1. Install required libraries:
   - WebSocketsClient by Markus Sattler
   - ArduinoJson by Benoit Blanchon

2. Update configuration:
   ```cpp
   const char* ssid = "YOUR_WIFI_SSID";
   const char* password = "YOUR_WIFI_PASSWORD";
   const char* serverHost = "192.168.1.100"; // Your server IP
   const char* serialNumber = "ESP32_001"; // Unique identifier
   const char* authKey = "your_auth_key_here";
   ```

3. Upload to ESP32

### 4. Connect Web Clients

Open `examples/web_client.html` in a web browser or create your own client using Socket.IO.

## API Documentation

### WebSocket Events

#### ESP32 Events

**ESP32 → Server:**
- `esp32:register` - Register ESP32 device
- `esp32:data` - Send sensor data
- `esp32:heartbeat` - Keep connection alive

**Server → ESP32:**
- `esp32:registered` - Registration successful
- `esp32:data_request` - Request sensor data
- `esp32:interval_update` - Update data transmission interval
- `esp32:custom_command` - Custom command from client

#### Client Events

**Client → Server:**
- `client:subscribe` - Subscribe to ESP32 devices
- `client:unsubscribe` - Unsubscribe from devices
- `client:command` - Send command to ESP32

**Server → Client:**
- `client:connected` - Connection established
- `esp32:data_broadcast` - Sensor data from ESP32
- `esp32:status_change` - ESP32 connection status change
- `client:subscription_result` - Subscription result

### HTTP API Endpoints

- `GET /` - Server status and statistics
- `GET /api/esp32/list` - List connected ESP32 devices
- `GET /api/esp32/:serial/history` - Get historical sensor data

## Message Formats

### ESP32 Registration

```json
{
  "serialNumber": "ESP32_001",
  "authKey": "your_auth_key_here",
  "deviceInfo": {
    "chipId": "0x1234567890",
    "firmware": "1.0.0",
    "flashChipSize": 4194304,
    "freeHeap": 280000
  }
}
```

### Sensor Data

```json
{
  "temperature": 25.6,
  "humidity": 60.2,
  "timestamp": 1640995200000,
  "battery": 3.7,
  "rssi": -45
}
```

### Client Subscription

```json
{
  "serialNumbers": ["ESP32_001", "ESP32_002"]
}
```

### Client Commands

```json
{
  "targetESP32": "ESP32_001",
  "command": "set_interval",
  "parameters": {
    "interval": 3000
  }
}
```

## Supported Commands

| Command | Description | Parameters |
|---------|-------------|------------|
| `set_interval` | Change data transmission interval | `{interval: number}` (ms) |
| `request_data` | Request immediate sensor data | `{}` |
| `get_status` | Get device status information | `{}` |
| Custom commands | Forward to ESP32 | Varies |

## Database Schema

### Tables

- **esp32_devices**: Device registration and authentication
- **sensor_data**: Historical sensor readings
- **connection_logs**: Connection events and debugging
- **client_sessions**: Active client session tracking

### Data Retention

Configure automatic cleanup in your application:

```javascript
// Clean up old data (30 days)
await database.cleanupOldData(30);

// Clean up old logs (7 days)  
await database.cleanupOldLogs(7);
```

## Security Considerations

1. **ESP32 Authentication**: Each ESP32 requires a unique serial number and auth key
2. **Network Security**: Use HTTPS/WSS in production environments
3. **Rate Limiting**: Implement rate limiting for API endpoints
4. **Data Validation**: All incoming data is validated before processing
5. **Connection Limits**: Configurable limits prevent resource exhaustion

## Monitoring and Logging

### Log Levels
- `error`: System errors and failures
- `warn`: Warnings and unusual events
- `info`: General information and connection events
- `debug`: Detailed debugging information

### Health Monitoring

```bash
# Check server health
curl http://localhost:3000/

# Monitor connection logs
tail -f logs/server.log
```

## Production Deployment

### Environment Setup

1. **Database**: Ensure SQLite file permissions are correct
2. **Logging**: Configure log rotation and monitoring
3. **Process Management**: Use PM2 or similar process manager
4. **Reverse Proxy**: Use nginx for SSL termination and load balancing

### Example PM2 Configuration

```json
{
  "apps": [{
    "name": "esp32-bridge-server",
    "script": "index.js",
    "instances": 1,
    "exec_mode": "fork",
    "env": {
      "NODE_ENV": "production",
      "PORT": 3000
    }
  }]
}
```

### Nginx Configuration

```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Troubleshooting

### Common Issues

1. **ESP32 won't connect**:
   - Check WiFi credentials and network connectivity
   - Verify server IP address and port
   - Ensure auth key matches database entry

2. **Data not appearing**:
   - Check ESP32 is sending data events
   - Verify client is subscribed to correct serial number
   - Check server logs for errors

3. **High memory usage**:
   - Configure data retention policies
   - Monitor connection counts
   - Check for memory leaks in custom code

### Debugging

Enable debug logging:
```bash
LOG_LEVEL=debug npm start
```

Monitor WebSocket connections:
```javascript
// Add to your client code
socket.on('connect', () => console.log('Connected'));
socket.on('disconnect', () => console.log('Disconnected'));
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Implement your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
- Create an issue on GitHub
- Check the troubleshooting section
- Review server logs for error messages