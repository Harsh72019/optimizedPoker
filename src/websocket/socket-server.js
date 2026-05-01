// src/websocket/socket-server.js

const { Server } = require('socket.io');
const AuthMiddleware = require('./middleware/auth.js');
const ConnectionHandler = require('./handlers/connection.js');
const PrivateTableGameOrchestrator = require('../game/private-table-game-orchestrator.js');
const GameActionHandler = require('./handlers/game-actions.js');
const PrivateTableHandler = require('./handlers/private-table.handler.js');
const TournamentHandler = require('./handlers/tournament.handler.js');
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
        this.timerManager = new TurnTimerManager(this.io, null); // orchestrator will be set after creation
        this.orchestrator = new GameOrchestrator(this.io, this.timerManager);
        this.privateOrchestrator = new PrivateTableGameOrchestrator(this.io);
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
            new PrivateTableHandler(this.io, socket, this.privateOrchestrator);
            new TournamentHandler(this.io, socket);

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
