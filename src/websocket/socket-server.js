// src/websocket/socket-server.js

const { Server } = require('socket.io');
const AuthMiddleware = require('./middleware/auth.js');
const ConnectionHandler = require('./handlers/connection.js');
const GameActionHandler = require('./handlers/game-actions.js');
const TurnTimerManager = require('../game/turn-timer.manager.js');
const PlayerActionService = require('../game/player-action.service.js');
const GameOrchestrator = require('../game/game-orchestrator.service');

class SocketServer {
    constructor(httpServer) {
        this.io = new Server(httpServer, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST'],
            },
        });
        this.timerManager = new TurnTimerManager(this.io);
        this.orchestrator = new GameOrchestrator(this.io, this.timerManager);
        this.timerManager.orchestrator = this.orchestrator;
        this.timerManager.botManager = new (require('../game/bot/bot.manager.js'))(this.io, this.timerManager, this.orchestrator);
        this.actionService = new PlayerActionService(this.io, this.timerManager, this.orchestrator);
        this.timerManager.setActionService(this.actionService);
        this.initialize();
    }

    initialize() {
        console.log('🔌 Initializing Socket Server...');

        this.io.on('connection', (socket) => {
            console.log(`✅ Client connected: ${socket.id}`);

            new ConnectionHandler(this.io, socket , this.orchestrator);
            new GameActionHandler(this.io, socket, this.timerManager, this.actionService);

            socket.on('disconnect', () => {
                console.log(`❌ Client disconnected: ${socket.id}`);
            });
        });
    }

    getIO() {
        return this.io;
    }
}

module.exports = SocketServer;