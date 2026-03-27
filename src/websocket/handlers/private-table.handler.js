// src/websocket/handlers/private-table.handler.js

const verifyEventToken = require('../verify-event-token');
const { emitSuccess, emitError } = require('../socket-emitter');
const privateTableService = require('../../services/private-table.service');
const financialIntegrationService = require('../../services/financial-integration.service');
const PrivateTableValidator = require('../../utils/private-table-validator');

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
        this.socket.on('removePlayerFromPrivateTable', this.handleRemovePlayerFromPrivateTable.bind(this));
    }

    async handleCreatePrivateTable(data) {
        try {
            const { token, tableConfig } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();

            // Validate table configuration
            console.log(token , tableConfig);
            const validation = PrivateTableValidator.validate(tableConfig);
            if (!validation.valid) {
                throw new Error('Invalid table configuration: ' + validation.errors.join(', '));
            }

            // Create private table with financial setup
            const result = await privateTableService.createPrivateTable(hostId, tableConfig);

            emitSuccess(this.socket, 'privateTableCreated', {
                privateTable: result.privateTable,
                setupFee: result.setupFee.chargedAmount,
                financialPreview: result.financialPreview,
                hostAutoRegistered: result.hostAutoRegistered || false
            }, 'Private table created successfully - you are automatically registered as a player');

            console.log(`🎮 Private table created: ${result.privateTable._id} by ${user.username}`);

        } catch (err) {
            console.error('Create private table error:', err);
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

            if (!['WAITING_FOR_PLAYERS', 'READY_TO_START' , 'ACTIVE'].includes(privateTable.status)) {
                throw new Error('Table is not accepting players');
            }

            // Check password if required
            if (privateTable.password && privateTable.password !== password) {
                throw new Error('Invalid password');
            }

            // Register player
            const result = await privateTableService.registerPlayer(tableId, userId);

            // Join socket room for updates (always join, even if already registered)
            this.socket.join(`private_table_${tableId}`);

            const message = result.alreadyRegistered 
                ? 'Already registered - joined room for updates'
                : result.registered ? 'Joined private table' : 'Added to waitlist';

            emitSuccess(this.socket, 'privateTableJoined', {
                tableId,
                registered: result.registered,
                waitlisted: result.waitlisted,
                position: result.position,
                tableStatus: result.tableStatus,
                playersRegistered: result.playersRegistered,
                spotsRemaining: result.spotsRemaining,
                alreadyRegistered: result.alreadyRegistered || false
            }, message);

            // Only notify other players if this is a new registration
            if (!result.alreadyRegistered) {
                // Notify other players and host
                emitSuccess(this.io.to(`private_table_${tableId}`), 'playerRegistered', {
                    username: user.username,
                    playersRegistered: result.playersRegistered,
                    spotsRemaining: result.spotsRemaining,
                    canStart: result.tableStatus === 'READY_TO_START'
                }, `${user.username} joined the table`);
            }

            // Send updated table info with personalized permissions to each user in room
            const updatedTableInfo = await privateTableService.getPrivateTableWithDetails(tableId);
            if (updatedTableInfo) {
                const socketsInRoom = await this.io.in(`private_table_${tableId}`).fetchSockets();
                
                // Get active players for the updated table info
                const activePlayers = await this.getActivePlayersInTable(tableId, updatedTableInfo.registeredPlayers);
                
                for (const socket of socketsInRoom) {
                    if (socket.user && socket.user._id) {
                        const socketUserId = socket.user._id.toString();
                        const hostIdToCompare = typeof updatedTableInfo.hostId === 'object' && updatedTableInfo.hostId._id 
                            ? updatedTableInfo.hostId._id.toString() 
                            : updatedTableInfo.hostId?.toString();
                        
                        // Create personalized table info for this user
                        const personalizedTableInfo = {
                            ...updatedTableInfo,
                            isTableCreatedByYou: socketUserId === hostIdToCompare,
                            canStart: socketUserId === hostIdToCompare && updatedTableInfo.status === 'READY_TO_START' && activePlayers.length >= 2,
                            canCancel: socketUserId === hostIdToCompare && !['COMPLETED', 'CANCELLED'].includes(updatedTableInfo.status),
                            canJoin: socketUserId !== hostIdToCompare && updatedTableInfo.status === 'WAITING_FOR_PLAYERS',
                            isPlayerInTable: updatedTableInfo.registeredPlayers?.some(p => p.userId?.toString() === socketUserId),
                            playersRegistered: updatedTableInfo.registeredPlayers?.length || 0,
                            playersActive: activePlayers.length,
                            activePlayers: activePlayers,
                            spotsRemaining: updatedTableInfo.declaredCapacity - (updatedTableInfo.registeredPlayers?.length || 0)
                        };
                        
                        socket.emit('privateTableInfo', {
                            success: true,
                            data: personalizedTableInfo,
                            message: 'Table info updated'
                        });
                    }
                }
            }

            console.log(`👤 ${user.username} joined private table ${tableId}`);

        } catch (err) {
            console.error('Join private table error:', err);
            emitError(this.socket, 'joinPrivateTableError', err.message);
        }
    }

    async handleStartPrivateTable(data) {
        try {
            const { token, tableId } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();

            // Start the private table
            const result = await privateTableService.startPrivateTable(tableId, hostId, this.orchestrator);

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
                
                // 🎯 EMIT TO ENTIRE ROOM: All registered players should be connected to this room
                emitSuccess(this.io.to(`private_table_${tableId}`), 'redirectToTable', {
                    tableId: underlyingTableId,
                    buyIn: privateTable.buyIn,
                    gameType: 'PRIVATE_SNG',
                    privateTableId: tableId
                }, 'Redirecting to game table');
                
                console.log(`🎮 [REDIRECT] Sent redirectToTable to all players in room private_table_${tableId}`);
            }

            emitSuccess(this.socket, 'privateTableStartSuccess', result, 'Private table started successfully');

            console.log(`🚀 Private table ${tableId} started by ${user.username}`);

        } catch (err) {
            console.error('Start private table error:', err);
            emitError(this.socket, 'startPrivateTableError', err.message);
        }
    }

    async handleGetPrivateTableInfo(data) {
        try {
            const { token, tableId } = data;
            const user = await verifyEventToken(token, this.socket);
            console.log(user , "user in handleGetPrivateTableInfo ------------")
            const currentUserId = user._id.toString();
            const privateTable = await privateTableService.getPrivateTableWithDetails(tableId);
            console.log(privateTable.hostId , "privateTable.hostId --------------")
            if (!privateTable) {
                throw new Error('Private table not found');
            }

            // Get active/connected players by checking socket connections
            const activePlayers = await this.getActivePlayersInTable(tableId, privateTable.registeredPlayers);

            // Add ownership and permission flags
            const hostIdToCompare = typeof privateTable.hostId === 'object' && privateTable.hostId._id 
                ? privateTable.hostId._id.toString() 
                : privateTable.hostId?.toString();
            
            privateTable.isTableCreatedByYou = currentUserId && hostIdToCompare === currentUserId;
            privateTable.canStart = privateTable.isTableCreatedByYou && privateTable.status === 'READY_TO_START' && activePlayers.length >= 2;
            privateTable.canCancel = privateTable.isTableCreatedByYou && !['COMPLETED', 'CANCELLED'].includes(privateTable.status);
            privateTable.canJoin = !privateTable.isTableCreatedByYou && privateTable.status === 'WAITING_FOR_PLAYERS';
            privateTable.isPlayerInTable = privateTable.registeredPlayers?.some(p => p.userId?.toString() === currentUserId);
            
            // Add player counts
            privateTable.playersRegistered = privateTable.registeredPlayers?.length || 0;
            privateTable.playersActive = activePlayers.length;
            privateTable.activePlayers = activePlayers;
            privateTable.spotsRemaining = privateTable.declaredCapacity - privateTable.playersRegistered;

            emitSuccess(this.socket, 'privateTableInfo', privateTable, 'Private table info');

        } catch (err) {
            console.error('Get private table info error:', err);
            emitError(this.socket, 'getPrivateTableInfoError', err.message);
        }
    }
    
    /**
     * Get active/connected players in the private table
     */
    async getActivePlayersInTable(tableId, registeredPlayers) {
        try {
            // Get all sockets in the private table room
            const socketsInRoom = await this.io.in(`private_table_${tableId}`).fetchSockets();
            const connectedUserIds = socketsInRoom.map(socket => socket.user?._id?.toString()).filter(Boolean);
            
            // Filter registered players to only include those who are connected
            const activePlayers = (registeredPlayers || []).filter(player => {
                const playerId = player.userId?.toString() || player.userId;
                return connectedUserIds.includes(playerId);
            }).map(player => ({
                userId: player.userId,
                username: player.user?.username || 'Player',
                registeredAt: player.registeredAt,
                isHost: player.isHost || false,
                status: 'CONNECTED'
            }));
            
            console.log(`🔍 [ACTIVE_PLAYERS] Table ${tableId}: ${activePlayers.length}/${registeredPlayers?.length || 0} players active`);
            
            return activePlayers;
        } catch (error) {
            console.error('Error getting active players:', error);
            return [];
        }
    }

    async handleGetPrivateTablePreview(data) {
        try {
            const { token, tableConfig } = data;
            await verifyEventToken(token, this.socket);

            let preview;
            
            if (tableConfig.gameType === 'SNG' || tableConfig.gameType === 'PRIVATE_SNG') {
                // Use SNG-specific commission preview
                const sngCommissionPreview = require('../../services/sng-commission-preview.service');
                preview = await sngCommissionPreview.generateSNGCommissionPreview({
                    declaredCapacity: tableConfig.declaredCapacity || tableConfig.playerCapacity?.max,
                    buyIn: tableConfig.buyIn || tableConfig.buyInSettings?.min,
                    duration: tableConfig.estimatedHours || 2,
                    timerSeconds: tableConfig.timerSeconds || tableConfig.turnTimer || 30,
                    tier: tableConfig.tier || 3,
                    hostUplift: tableConfig.hostUplift || 0,
                    bigBlind: tableConfig.stakes?.blinds?.big || (tableConfig.buyIn || 50) / 25 // Estimate BB as buyIn/25
                });
            } else {
                // Use tournament preview for tournaments
                preview = await financialIntegrationService.getTableFinancialPreview(tableConfig);
            }

            emitSuccess(this.socket, 'privateTablePreview', preview, 'Financial preview generated');

        } catch (err) {
            console.error('Get private table preview error:', err);
            emitError(this.socket, 'getPrivateTablePreviewError', err.message);
        }
    }

    async handleGetHostTables(data) {
        try {
            const { token, status } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();
            const currentUserId = user._id.toString();

            const tables = await privateTableService.getHostTables(hostId, status);

            // Add ownership flags to each table
            const tablesWithFlags = tables.map(table => {
                const hostIdToCompare = typeof table.hostId === 'object' && table.hostId._id 
                    ? table.hostId._id.toString() 
                    : table.hostId?.toString();
                
                return {
                    ...table,
                    isTableCreatedByYou: currentUserId && hostIdToCompare === currentUserId,
                    canStart: currentUserId && hostIdToCompare === currentUserId && table.status === 'READY_TO_START',
                    canCancel: currentUserId && hostIdToCompare === currentUserId && !['COMPLETED', 'CANCELLED'].includes(table.status),
                    canJoin: false, // Host is already registered as player
                    isPlayerInTable: true // Host is always a player in their own table
                };
            });

            emitSuccess(this.socket, 'hostTables', tablesWithFlags, 'Host tables retrieved');

        } catch (err) {
            console.error('Get host tables error:', err);
            emitError(this.socket, 'getHostTablesError', err.message);
        }
    }

    async handleCancelPrivateTable(data) {
        try {
            const { token, tableId, reason } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();
            console.log("🚀 Cancel table called", tableId, hostId, reason)
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
            console.error('Cancel private table error:', err);
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
            const hostIdToCompare = typeof privateTable.hostId === 'object' && privateTable.hostId._id 
                ? privateTable.hostId._id.toString() 
                : privateTable.hostId?.toString();
            
            const isHost = hostIdToCompare === userId;
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
            console.error('Spectate private table error:', err);
            emitError(this.socket, 'spectatePrivateTableError', err.message);
        }
    }

    async handleRemovePlayerFromPrivateTable(data) {
        try {
            const { token, tableId, playerUserId } = data;
            const user = await verifyEventToken(token, this.socket);
            const hostId = user._id.toString();

            // Get private table
            const privateTable = await privateTableService.getPrivateTable(tableId);
            if (!privateTable) {
                throw new Error('Private table not found');
            }

            // Verify host permissions
            const hostIdToCompare = typeof privateTable.hostId === 'object' && privateTable.hostId._id 
                ? privateTable.hostId._id.toString() 
                : privateTable.hostId?.toString();
            
            if (hostIdToCompare !== hostId) {
                throw new Error('Only the host can remove players');
            }

            // Check if table allows player removal
            if (!['WAITING_FOR_PLAYERS', 'READY_TO_START'].includes(privateTable.status)) {
                throw new Error('Cannot remove players from table in current status');
            }

            // Check if player is registered
            const playerIndex = privateTable.registeredPlayers.findIndex(
                p => p.userId?.toString() === playerUserId.toString()
            );

            if (playerIndex === -1) {
                throw new Error('Player is not registered for this table');
            }

            // Cannot remove the host
            if (playerUserId.toString() === hostId.toString()) {
                throw new Error('Host cannot remove themselves');
            }

            // Remove player from registered players
            const removedPlayer = privateTable.registeredPlayers[playerIndex];
            privateTable.registeredPlayers.splice(playerIndex, 1);

            // Update table status if needed
            const newCount = privateTable.registeredPlayers.length;
            const requiredPlayers = Math.ceil(privateTable.declaredCapacity * privateTable.participationThreshold / 100);
            const thresholdMet = newCount >= requiredPlayers;
            
            let newStatus = privateTable.status;
            if (!thresholdMet && privateTable.status === 'READY_TO_START') {
                newStatus = 'WAITING_FOR_PLAYERS';
            }

            // Update database
            const mongoHelper = require('../../models/customdb');
            const updateResult = await mongoHelper.updateById(
                mongoHelper.COLLECTIONS.PRIVATE_TABLES,
                tableId,
                { 
                    registeredPlayers: privateTable.registeredPlayers,
                    status: newStatus
                }
            );

            if (!updateResult.success) {
                throw new Error('Failed to remove player: ' + updateResult.error);
            }

            // Get player details for notification
            const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerUserId);
            const playerUsername = playerResult.success && playerResult.data ? playerResult.data.username : 'Unknown';

            // Remove player from socket room and disconnect them
            const socketsInRoom = await this.io.in(`private_table_${tableId}`).fetchSockets();
            const playerSocket = socketsInRoom.find(s => s.user && s.user._id.toString() === playerUserId.toString());
            
            if (playerSocket) {
                // Notify the removed player
                emitError(playerSocket, 'removedFromPrivateTable', {
                    tableId,
                    reason: 'Removed by host',
                    hostUsername: user.username
                }, 'You have been removed from the private table');
                
                // Remove from socket room
                playerSocket.leave(`private_table_${tableId}`);
            }

            // Send updated table info to remaining players
            const updatedTableInfo = await privateTableService.getPrivateTableWithDetails(tableId);
            if (updatedTableInfo) {
                const remainingSockets = await this.io.in(`private_table_${tableId}`).fetchSockets();
                
                for (const socket of remainingSockets) {
                    if (socket.user && socket.user._id) {
                        const socketUserId = socket.user._id.toString();
                        const hostIdToCompare = typeof updatedTableInfo.hostId === 'object' && updatedTableInfo.hostId._id 
                            ? updatedTableInfo.hostId._id.toString() 
                            : updatedTableInfo.hostId?.toString();
                        
                        // Create personalized table info for this user
                        const personalizedTableInfo = {
                            ...updatedTableInfo,
                            isTableCreatedByYou: socketUserId === hostIdToCompare,
                            canStart: socketUserId === hostIdToCompare && updatedTableInfo.status === 'READY_TO_START',
                            canCancel: socketUserId === hostIdToCompare && !['COMPLETED', 'CANCELLED'].includes(updatedTableInfo.status),
                            canJoin: socketUserId !== hostIdToCompare && updatedTableInfo.status === 'WAITING_FOR_PLAYERS',
                            isPlayerInTable: updatedTableInfo.registeredPlayers?.some(p => p.userId?.toString() === socketUserId)
                        };
                        
                        socket.emit('privateTableInfo', {
                            success: true,
                            data: personalizedTableInfo,
                            message: `${playerUsername} was removed from the table`
                        });
                    }
                }
            }

            // Notify host of successful removal
            emitSuccess(this.socket, 'playerRemovedSuccess', {
                tableId,
                removedPlayerId: playerUserId,
                removedPlayerUsername: playerUsername,
                newPlayerCount: newCount,
                newStatus,
                canStart: newStatus === 'READY_TO_START'
            }, `${playerUsername} removed successfully`);

            console.log(`🚫 Host ${user.username} removed player ${playerUsername} from private table ${tableId}`);

        } catch (err) {
            console.error('Remove player from private table error:', err);
            emitError(this.socket, 'removePlayerError', err.message);
        }
    }
}

module.exports = PrivateTableHandler;