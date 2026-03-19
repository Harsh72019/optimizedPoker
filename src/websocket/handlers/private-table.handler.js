// src/websocket/handlers/private-table.handler.js

const verifyEventToken = require('../verify-event-token');
const { emitSuccess, emitError } = require('../socket-emitter');
const privateTableService = require('../../services/private-table.service');
const financialIntegrationService = require('../../services/financial-integration.service');

class PrivateTableHandler {
    constructor(io, socket, orchestrator) {
        this.io = io;
        this.socket = socket;
        this.orchestrator = orchestrator;
        this.registerEvents();
    }

    registerEvents() {
        this.socket.on('createPrivateTable', this.handleCreatePrivateTable.bind(this));
        this.socket.on('joinPrivateTable', this.handleJoinPrivateTable.bind(this));
        this.socket.on('startPrivateTable', this.handleStartPrivateTable.bind(this));
        this.socket.on('spectatePrivateTable', this.handleSpectatePrivateTable.bind(this));
        this.socket.on('getPrivateTableInfo', this.handleGetPrivateTableInfo.bind(this));
        this.socket.on('getPrivateTablePreview', this.handleGetPrivateTablePreview.bind(this));
        this.socket.on('getHostTables', this.handleGetHostTables.bind(this));
        this.socket.on('cancelPrivateTable', this.handleCancelPrivateTable.bind(this));
    }

    async handleCreatePrivateTable(data) {
        try {
            const { token, tableConfig } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();

            // Validate required fields
            const requiredFields = ['name', 'gameType', 'buyIn', 'declaredCapacity', 'participationThreshold', 'tier', 'estimatedHours', 'timerSeconds'];
            for (const field of requiredFields) {
                if (!tableConfig[field]) {
                    throw new Error(`Missing required field: ${field}`);
                }
            }

            // Create private table with financial setup
            const result = await privateTableService.createPrivateTable(hostId, tableConfig);

            emitSuccess(this.socket, 'privateTableCreated', {
                privateTable: result.privateTable,
                setupFee: result.setupFee.chargedAmount,
                financialPreview: result.financialPreview
            }, 'Private table created successfully');

            console.log(`🎮 Private table created: ${result.privateTable._id} by ${user.username}`);

        } catch (err) {
            console.error('Create private table error:', err.message);
            emitError(this.socket, 'createPrivateTableError', err.message);
        }
    }

    async handleJoinPrivateTable(data) {
        try {
            const { token, tableId, password } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();

            // Check if table exists and is joinable
            const privateTable = await privateTableService.getPrivateTable(tableId);
            if (!privateTable) {
                throw new Error('Private table not found');
            }

            if (!['WAITING_FOR_PLAYERS', 'READY_TO_START'].includes(privateTable.status)) {
                throw new Error('Table is not accepting players');
            }

            // Check password if required
            if (privateTable.password && privateTable.password !== password) {
                throw new Error('Invalid password');
            }

            // Register player
            const result = await privateTableService.registerPlayer(tableId, userId);

            // Join socket room for updates
            this.socket.join(`private_table_${tableId}`);

            emitSuccess(this.socket, 'privateTableJoined', {
                tableId,
                registered: result.registered,
                waitlisted: result.waitlisted,
                position: result.position,
                tableStatus: result.tableStatus,
                playersRegistered: result.playersRegistered,
                spotsRemaining: result.spotsRemaining
            }, result.registered ? 'Joined private table' : 'Added to waitlist');

            // Notify other players and host
            emitSuccess(this.io.to(`private_table_${tableId}`), 'playerRegistered', {
                username: user.username,
                playersRegistered: result.playersRegistered,
                spotsRemaining: result.spotsRemaining,
                canStart: result.tableStatus === 'READY_TO_START'
            }, `${user.username} joined the table`);

            console.log(`👤 ${user.username} joined private table ${tableId}`);

        } catch (err) {
            console.error('Join private table error:', err.message);
            emitError(this.socket, 'joinPrivateTableError', err.message);
        }
    }

    async handleStartPrivateTable(data) {
        try {
            const { token, tableId } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();

            // Start the private table
            const result = await privateTableService.startPrivateTable(tableId, hostId);

            // Notify all registered players
            emitSuccess(this.io.to(`private_table_${tableId}`), 'privateTableStarted', {
                tableId,
                gameType: result.privateTable.gameType,
                underlyingTableId: result.gameResult.underlyingTable?._id,
                tournamentId: result.gameResult.tournament?._id,
                message: result.message
            }, 'Private table started!');

            // If it's an SNG, redirect players to the underlying table
            if (result.privateTable.gameType === 'PRIVATE_SNG' && result.gameResult.underlyingTable) {
                const underlyingTableId = result.gameResult.underlyingTable._id;
                
                // Get all registered players and move them to the game table
                const privateTable = result.privateTable;
                
                // Add host to spectator room if they're not playing
                const hostIsPlaying = privateTable.registeredPlayers.some(
                    p => p.userId?.toString() === hostId.toString()
                );
                
                if (!hostIsPlaying) {
                    // Host joins as spectator
                    this.socket.join(`table_${underlyingTableId}`);
                    emitSuccess(this.socket, 'joinedAsSpectator', {
                        tableId: underlyingTableId,
                        role: 'HOST_SPECTATOR',
                        privateTableId: tableId
                    }, 'Joined as spectator');
                }
                
                for (const player of privateTable.registeredPlayers) {
                    const playerId = player.userId?.toString() || player.userId;
                    // Emit table join event to each player
                    const playerSockets = await this.io.in(`private_table_${tableId}`).fetchSockets();
                    const playerSocket = playerSockets.find(s => s.user?._id?.toString() === playerId);
                    
                    if (playerSocket) {
                        emitSuccess(playerSocket, 'redirectToTable', {
                            tableId: underlyingTableId,
                            buyIn: privateTable.buyIn,
                            gameType: 'PRIVATE_SNG',
                            privateTableId: tableId
                        }, 'Redirecting to game table');
                    }
                }
            }

            emitSuccess(this.socket, 'privateTableStartSuccess', result, 'Private table started successfully');

            console.log(`🚀 Private table ${tableId} started by ${user.username}`);

        } catch (err) {
            console.error('Start private table error:', err.message);
            emitError(this.socket, 'startPrivateTableError', err.message);
        }
    }

    async handleGetPrivateTableInfo(data) {
        try {
            const { token, tableId } = data;
            await verifyEventToken(token, this.socket);

            const privateTable = await privateTableService.getPrivateTableWithDetails(tableId);
            if (!privateTable) {
                throw new Error('Private table not found');
            }

            emitSuccess(this.socket, 'privateTableInfo', privateTable, 'Private table info');

        } catch (err) {
            console.error('Get private table info error:', err.message);
            emitError(this.socket, 'getPrivateTableInfoError', err.message);
        }
    }

    async handleGetPrivateTablePreview(data) {
        try {
            const { token, tableConfig } = data;
            await verifyEventToken(token, this.socket);

            const preview = await financialIntegrationService.getTableFinancialPreview(tableConfig);

            emitSuccess(this.socket, 'privateTablePreview', preview, 'Financial preview generated');

        } catch (err) {
            console.error('Get private table preview error:', err.message);
            emitError(this.socket, 'getPrivateTablePreviewError', err.message);
        }
    }

    async handleGetHostTables(data) {
        try {
            const { token, status } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();

            const tables = await privateTableService.getHostTables(hostId, status);

            emitSuccess(this.socket, 'hostTables', tables, 'Host tables retrieved');

        } catch (err) {
            console.error('Get host tables error:', err.message);
            emitError(this.socket, 'getHostTablesError', err.message);
        }
    }

    async handleCancelPrivateTable(data) {
        try {
            const { token, tableId, reason } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();

            const result = await privateTableService.cancelPrivateTable(tableId, hostId, reason);

            // Notify all registered players
            emitSuccess(this.io.to(`private_table_${tableId}`), 'privateTableCancelled', {
                tableId,
                reason: reason || 'Cancelled by host',
                refundAmount: result.refundAmount
            }, 'Private table cancelled');

            emitSuccess(this.socket, 'privateTableCancelSuccess', result, 'Private table cancelled successfully');

            console.log(`❌ Private table ${tableId} cancelled by ${user.username}`);

        } catch (err) {
            console.error('Cancel private table error:', err.message);
            emitError(this.socket, 'cancelPrivateTableError', err.message);
        }
    }

    async handleSpectatePrivateTable(data) {
        try {
            const { token, tableId } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();

            // Get private table info
            const privateTable = await privateTableService.getPrivateTable(tableId);
            if (!privateTable) {
                throw new Error('Private table not found');
            }

            // Check if game has started
            if (privateTable.status !== 'ACTIVE') {
                throw new Error('Game has not started yet');
            }

            // Get underlying table ID
            const underlyingTableId = privateTable.underlyingTableId;
            if (!underlyingTableId) {
                throw new Error('No active game table found');
            }

            // Join spectator room for the underlying table
            this.socket.join(`table_${underlyingTableId}`);
            this.socket.join(`spectator_${underlyingTableId}`);

            // Check if user is host or admin
            const isHost = privateTable.hostId.toString() === userId;
            const role = isHost ? 'HOST_SPECTATOR' : 'SPECTATOR';

            emitSuccess(this.socket, 'spectatingTable', {
                tableId: underlyingTableId,
                privateTableId: tableId,
                role,
                gameType: privateTable.gameType,
                buyIn: privateTable.buyIn
            }, `Spectating as ${role}`);

            console.log(`👁️ ${user.username} spectating table ${underlyingTableId} as ${role}`);

        } catch (err) {
            console.error('Spectate private table error:', err.message);
            emitError(this.socket, 'spectatePrivateTableError', err.message);
        }
    }
}

module.exports = PrivateTableHandler;