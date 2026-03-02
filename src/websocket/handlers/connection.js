// src/websocket/handlers/connection.handler.js

const tableManager = require('../../table/table-manager.service');
const { emitSuccess, emitError } = require('../socket-emitter');
const verifyEventToken = require('../verify-event-token');
const blockchainService = require('../../services/blockchain.service');

class ConnectionHandler {
    constructor(io, socket, orchestrator) {
        this.io = io;
        this.socket = socket;
        this.orchestrator = orchestrator;
        this.awayManager = require('../../game/away-manager.service');
        this.registerEvents();
    }

    registerEvents() {
        this.socket.on('joinTable', this.handleJoinTable.bind(this));
        this.socket.on('leaveTable', this.handleLeaveTable.bind(this));
        this.socket.on('leaveRoom', this.handleLeaveTable.bind(this));
        this.socket.on('disconnect', this.handleDisconnect.bind(this));
        this.socket.on('setAway', async (data) => this.handleAway(data));
        this.socket.on('setBack', async (data) => this.handleBack(data));
        this.socket.on('getTableInfo', async (data) => this.handleGetTableInfo(data));
        this.socket.on('getPlayerInfo', async (data) => this.handleGetPlayerInfo(data));
    }

    async handleAway(data) {
        try {
            const { token } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();
            const tableId = this.socket.tableId;
            if (tableId) {
                await this.awayManager.setAway(tableId, userId);
                emitSuccess(this.socket, 'awaySet', { userId }, 'Away status set');
                
                const tableState = await tableManager.getTable(tableId);
                const canOthersPutAway = tableState.players.filter(p => p.status === 'ACTIVE').length > 2;
                emitSuccess(this.io.to(tableId), 'playerAway', { 
                    userId, 
                    canOthersPutAway 
                }, 'Player away');
            } else {
                emitError(this.socket, 'awayError', 'Not in table');
            }
        } catch (err) {
            emitError(this.socket, 'awayError', err.message);
        }
    }

    async handleBack(data) {
        try {
            const { token } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();
            const tableId = this.socket.tableId;
            if (tableId) {
                await this.awayManager.setBack(tableId, userId);
                emitSuccess(this.socket, 'backSet', { userId }, 'Back status set');
                
                const tableState = await tableManager.getTable(tableId);
                const canOthersPutAway = tableState.players.filter(p => p.status === 'ACTIVE').length > 2;
                emitSuccess(this.io.to(tableId), 'playerBack', { 
                    userId, 
                    canOthersPutAway 
                }, 'Player back');
            } else {
                emitError(this.socket, 'backError', 'Not in table');
            }
        } catch (err) {
            emitError(this.socket, 'backError', err.message);
        }
    }

    async handleDisconnect() {
        try {
            const tableId = this.socket.tableId;
            if (!tableId) return;

            const userId = this.socket.user?._id?.toString();
            if (!userId) return;

            const gameState = await require('../../state/game-state').getGame(tableId);
            const tableManager = require('../../table/table-manager.service');

            if (!gameState) {
                await tableManager.removePlayer(tableId, userId);
                this.syncPlayerToMongoTable(tableId, userId, 'leave').catch(err =>
                    console.error('Failed to sync disconnect to MongoDB:', err.message)
                );
                
                // Update reputation for disconnect
                const reputationService = require('../../services/reputation.service');
                reputationService.onPlayerLeave(userId, tableId, 0, 'DISCONNECT_CLIENT').catch(err =>
                    console.error('Failed to update reputation:', err.message)
                );
                return;
            }

            const player = gameState.players.find(p => p.id === userId);
            if (!player) return;

            await tableManager.markDisconnected(tableId, userId);
            player.disconnected = true;

            if (gameState.currentPlayerId === userId) {
                console.log(`🔄 Player ${userId} disconnected on their turn - auto folding`);
                const PlayerActionService = require('../../game/player-action.service');
                const actionService = new PlayerActionService(this.io, this.orchestrator.timerManager, this.orchestrator);
                await actionService.handle(tableId, userId, 'fold');
            } else {
                console.log(`⚠ Player ${userId} disconnected - will fold on] their turn`);
                await require('../../state/game-state').updateGame(tableId, gameState);
            }

            console.log(`⚠ ${userId} disconnected`);

        } catch (err) {
            console.error('Disconnect error:', err.message);
        }
    }

    async handleJoinTable(data) {
        try {
            const { tableId, buyIn, token } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();

            this.socket.user = user;

            // Get table and fetch subTier to validate buyIn
            const mongoHelper = require('../../models/customdb');
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            
            if (!tableDoc.success || !tableDoc.data) {
                throw new Error('Table not found');
            }

            const table = tableDoc.data;
            
            // Fetch SubTier to get bb and calculate buy-in range
            const subTierDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, table.subTierId);
            
            if (!subTierDoc.success || !subTierDoc.data) {
                throw new Error('SubTier configuration not found');
            }

            const subTier = subTierDoc.data;
            const bb = subTier.tableConfig.bb;
            const minBuyIn = parseFloat((bb * 20).toFixed(2));
            const maxBuyIn = parseFloat((bb * 100).toFixed(2));

            // Validate buyIn against calculated range
            if (buyIn < minBuyIn || buyIn > maxBuyIn) {
                throw new Error(`Buy-in must be between ${minBuyIn} and ${maxBuyIn}`);
            }

            const { tableState, isReconnect } = await tableManager.seatPlayer(
                tableId,
                {
                    userId,
                    username: user.username,
                    chips: buyIn,
                    socketId: this.socket.id
                }
            );

            this.socket.join(tableId);
            this.socket.tableId = tableId;
            this.socket.handsPlayed = 0; // Track hands played

            // Get full user document for walletAddress
            const userDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
            const walletAddress = userDoc.success && userDoc.data ? userDoc.data.walletAddress : null;

            // Transfer buy-in from player to table (async with retry) - using existing blockchain service
            if (walletAddress) {
                blockchainService.prepareTableForJoin(table, buyIn, walletAddress).catch(err => 
                    console.error('💰 [BLOCKCHAIN] Transfer error:', err.message)
                );
                console.log(`💰 [BLOCKCHAIN] Initiated transfer for ${buyIn} chips (async)`);
            } else {
                console.warn(`⚠️ [BLOCKCHAIN] No wallet address for user ${userId}, skipping transfer`);
            }

            // Sync to MongoDB TABLES.currentPlayers
            this.syncPlayerToMongoTable(tableId, userId, 'join').catch(err => 
                console.error('Failed to sync to MongoDB:', err.message)
            );

            emitSuccess(this.socket, 'roomJoined', { tableId, tableState }, 'Joined table successfully');

            const gameState = await require('../../state/game-state').getGame(tableId);

            // Format data for frontend
            const formattedData = this.formatTableData(tableState, gameState);
            emitSuccess(this.socket, 'tableInfo', formattedData, 'Table info');

            if (!isReconnect) {
                emitSuccess(this.io.to(tableId), 'playerJoined', formattedData, `${user.username} joined`);
                const seatedCount = tableState.players.length;
                await this.orchestrator.onPlayerSeated(tableId, seatedCount);
                console.log(`👤 ${userId} seated at table ${tableId}`);
            } else {
                console.log(`🔄 ${userId} reconnected to table ${tableId}`);
                
                // Check if we need to start waiting timer
                const seatedCount = tableState.players.filter(p => !p.disconnected).length;
                if (seatedCount >= 2 && !gameState) {
                    console.log(`⏳ Triggering waiting timer after reconnect`);
                    await this.orchestrator.onPlayerSeated(tableId, seatedCount);
                }
                
                // If game is active and it's player's turn, restart timer
                if (gameState && gameState.currentPlayerId === userId) {
                    console.log(`⏱️ Restarting timer for reconnected player ${userId}`);
                    this.orchestrator.timerManager.startTimer(tableId, userId);
                }
            }

        } catch (err) {
            console.log(err)
            emitError(this.socket, 'unableToJoin', err.message);
        }
    }
    async handleLeaveTable(data) {
        try {
            const { token } = data;
            const user = await verifyEventToken(token, this.socket);

            const tableId = this.socket.tableId;
            if (!tableId) {
                emitError(this.socket, 'unableToLeave', 'Not in a table');
                return;
            }

            const userId = user._id.toString();

            const gameState = await require('../../state/game-state').getGame(tableId);

            if (gameState) {
                const player = gameState.players.find(p => p.id === userId);
                if (player && gameState.currentPlayerId === userId) {
                    console.log(`🚪 Player ${userId} leaving on their turn - auto folding`);
                    const PlayerActionService = require('../../game/player-action.service');
                    const actionService = new PlayerActionService(this.io, this.orchestrator.timerManager, this.orchestrator);
                    await actionService.handle(tableId, userId, 'fold');
                }
            }

            // Get player's chips BEFORE removing from table
            const tableStateBefore = await tableManager.getTable(tableId);
            const playerBefore = tableStateBefore.players.find(p => p.userId === userId);
            const finalChips = playerBefore?.chips || 0;

            const tableState = await tableManager.removePlayer(tableId, userId);

            // Get full user document for walletAddress
            const mongoHelper = require('../../models/customdb');
            const userDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
            const walletAddress = userDoc.success && userDoc.data ? userDoc.data.walletAddress : null;
            
            if (finalChips > 0 && walletAddress) {
                blockchainService.queueWithdrawal({
                    userAddress: walletAddress,
                    amount: finalChips,
                    tableId: tableId,
                    userId: userId
                }).catch(err => 
                    console.error('💰 [BLOCKCHAIN] Withdrawal queue error:', err.message)
                );
                console.log(`💰 [BLOCKCHAIN] Queued withdrawal for ${finalChips} chips (async)`);
            }

            // Sync to MongoDB TABLES.currentPlayers
            this.syncPlayerToMongoTable(tableId, userId, 'leave').catch(err =>
                console.error('Failed to sync to MongoDB:', err.message)
            );

            // Update reputation for leaving
            const reputationService = require('../../services/reputation.service');
            const handsPlayed = this.socket.handsPlayed || 0;
            reputationService.onPlayerLeave(userId, tableId, handsPlayed, 'NORMAL').catch(err =>
                console.error('Failed to update reputation:', err.message)
            );

            const seatedCount = tableState.players.length;
            const status = await tableManager.getStatus(tableId);

            if (status === 'WAITING' && seatedCount < 2) {
                this.orchestrator.cancelWaiting(tableId);
                await tableManager.setStatus(tableId, 'IDLE');
            }
            
            this.socket.leave(tableId);
            this.socket.tableId = null;
            this.socket.handsPlayed = 0;

            emitSuccess(this.socket, 'roomLeft', { tableId }, 'Left table successfully');
            
            const updatedTableState = await tableManager.getTable(tableId);
            const updatedGameState = await require('../../state/game-state').getGame(tableId);
            const formattedData = this.formatTableData(updatedTableState, updatedGameState);
            emitSuccess(this.io.to(tableId), 'playerLeft', formattedData, 'Player left');

            console.log(`👤 ${userId} left table ${tableId}`);

        } catch (err) {
            emitError(this.socket, 'unableToLeave', err.message);
        }
    }

    async handleGetTableInfo(data) {
        try {
            const { token } = data;
            await verifyEventToken(token, this.socket);

            const tableId = this.socket.tableId;
            if (!tableId) {
                emitError(this.socket, 'unableToGetTableInfo', 'Not in table');
                return;
            }

            const gameState = await require('../../state/game-state').getGame(tableId);
            const tableState = await tableManager.getTable(tableId);

            const formattedData = this.formatTableData(tableState, gameState);
            emitSuccess(this.socket, 'tableInfo', formattedData, 'Table info');
        } catch (err) {
            emitError(this.socket, 'unableToGetTableInfo', err.message);
        }
    }

    async handleGetPlayerInfo(data) {
        try {
            const { token } = data;
            const user = await verifyEventToken(token, this.socket);
            const tableId = this.socket.tableId;

            if (!tableId) {
                emitError(this.socket, 'unableToGetPlayerInfo', 'Not in table');
                return;
            }

            const tableState = await tableManager.getTable(tableId);
            const player = tableState.players.find(p => p.userId === user._id.toString());

            emitSuccess(this.socket, 'playerInfo', { player }, 'Player info');
        } catch (err) {
            emitError(this.socket, 'unableToGetPlayerInfo', err.message);
        }
    }

    async syncPlayerToMongoTable(tableId, userId, action) {
        const mongoHelper = require('../../models/customdb');
        const findResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
        
        if (findResult.success && findResult.data) {
            const table = findResult.data;
            let updatedPlayers = table.currentPlayers || [];
            
            if (action === 'join') {
                const exists = updatedPlayers.some(p => p.user?.toString() === userId);
                if (!exists) {
                    updatedPlayers.push({ user: userId });
                }
            } else if (action === 'leave') {
                updatedPlayers = updatedPlayers.filter(p => p.user?.toString() !== userId);
            }
            
            await mongoHelper.updateById(
                mongoHelper.COLLECTIONS.TABLES,
                tableId,
                { 
                    currentPlayers: updatedPlayers,
                    lastActivityAt: new Date()
                }
            );
            console.log(`✅ Synced ${action} for ${userId} to MongoDB TABLES`);
        }
    }

    formatTableData(tableState, gameState) {
        const formattedPlayers = tableState.players.map(player => {
            const gamePlayer = gameState?.players.find(p => p.id === player.userId);
            return {
                _id: player.userId,
                username: player.username,
                chips: player.chips,
                seatPosition: player.seatPosition,
                status: gamePlayer?.status || 'waiting',
                socketId: player.socketId,
                isAway: player.isAway || false,
                currentRoundBet: gameState ? (gameState.streetBets[player.userId] || 0) : 0
            };
        });

        return {
            maxPlayers: tableState.maxPlayers || 9,
            currentPlayers: formattedPlayers,
            gameState: gameState ? {
                pot: gameState.pot || 0,
                phase: gameState.phase,
                currentPlayerId: gameState.currentPlayerId,
                currentBet: gameState.currentBet || 0,
                boardCards: gameState.boardCards || [],
                dealerPosition: gameState.dealerPosition,
                smallBlindPosition: gameState.smallBlindPosition,
                bigBlindPosition: gameState.bigBlindPosition
            } : null
        };
    }
}

module.exports = ConnectionHandler;