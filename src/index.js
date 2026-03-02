const http = require('http');
const mongoose = require('mongoose');
const app = require('./app');
const config = require('./config/config');
const SocketServer = require('./websocket/socket-server');
const RecoveryManager = require('./system/recovery.manager');
const GamingHistory = require('./models/gameHistory.model');
const gameQueueWorker = require('./workers/game-queue.worker');

mongoose.connect(config.MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

console.log('✅ BullMQ worker started');

this.recoveryManager = new RecoveryManager(this.io, this.orchestrator);
this.recoveryManager.recover();

const server = http.createServer(app);
new SocketServer(server);

server.listen(3000, () => {
    console.log('🚀 Server running on port 3000');
});