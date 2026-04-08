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
        this.socket.on('privateTableRebuy', this.handlePrivateTableRebuy.bind(this));
        this.socket.on('privateTableLeave', this.handlePrivateTableLeave.bind(this));
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
            const privateTableId = this.socket.privateTableId;
            if (!tableId) return;

            const userId = this.socket.user?._id?.toString();
            if (!userId) return;

            const gameState = await require('../../state/game-state').getGame(tableId);
            const tableManager = require('../../table/table-manager.service');

            if (!gameState) {
                await tableManager.removePlayer(tableId, userId);
                await this.orchestrator.checkPrivateTableCompletion(tableId, 'TABLE_EMPTIED_BEFORE_HAND');
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

            // 🔌 Handle private table disconnect - send updated privateTableInfo
            if (privateTableId) {
                try {
                    const privateTableService = require('../../services/private-table.service');
                    const updatedPrivateTable = await privateTableService.getPrivateTableWithDetails(privateTableId);
                    
                    if (updatedPrivateTable) {
                        // Get all sockets in the private table room
                        const socketsInRoom = await this.io.in(`private_table_${privateTableId}`).fetchSockets();
                        
                        for (const socket of socketsInRoom) {
                            if (socket.user && socket.user._id) {
                                const socketUserId = socket.user._id.toString();
                                const hostIdToCompare = typeof updatedPrivateTable.hostId === 'object' && updatedPrivateTable.hostId._id 
                                    ? updatedPrivateTable.hostId._id.toString() 
                                    : updatedPrivateTable.hostId?.toString();
                                
                                // Create personalized table info for this user
                                const personalizedTableInfo = {
                                    ...updatedPrivateTable,
                                    isTableCreatedByYou: socketUserId === hostIdToCompare,
                                    canStart: socketUserId === hostIdToCompare && updatedPrivateTable.status === 'READY_TO_START',
                                    canCancel: socketUserId === hostIdToCompare && !['COMPLETED', 'CANCELLED'].includes(updatedPrivateTable.status),
                                    canJoin: socketUserId !== hostIdToCompare && updatedPrivateTable.status === 'WAITING_FOR_PLAYERS',
                                    isPlayerInTable: updatedPrivateTable.registeredPlayers?.some(p => p.userId?.toString() === socketUserId)
                                };
                                
                                socket.emit('privateTableInfo', {
                                    success: true,
                                    data: personalizedTableInfo,
                                    message: 'Player disconnected - table info updated'
                                });
                            }
                        }
                        
                        console.log(`🔌 [PRIVATE DISCONNECT] Updated privateTableInfo for all players in room private_table_${privateTableId}`);
                    }
                } catch (error) {
                    console.error('Failed to update private table info on disconnect:', error.message);
                }
            }

            console.log(`⚠ ${userId} disconnected`);

        } catch (err) {
            console.error('Disconnect error:', err.message);
        }
    }

    async handleJoinTable(data) {
        try {
            const { tableId, blockChainTableId, buyIn, chipsInPlay, token, privateTableId } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();

            this.socket.user = user;

            // 🆕 Handle private table join
            if (privateTableId) {
                return await this.handlePrivateTableJoin(privateTableId, userId, user, buyIn || chipsInPlay);
            }

            // Use chipsInPlay if provided, otherwise buyIn
            const finalBuyIn = chipsInPlay || buyIn;

            if (!finalBuyIn) {
                throw new Error('No buyIn or chipsInPlay provided');
            }

            // Get table ID from blockChainTableId if provided
            let finalTableId = tableId;
            if (blockChainTableId && !tableId) {
                const mongoHelper = require('../../models/customdb');
                const tableResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, { 
                    tableBlockchainId: blockChainTableId 
                });
                
                if (!tableResult.success || !tableResult.data || tableResult.data.length === 0) {
                    throw new Error('Table not found with blockchain ID: ' + blockChainTableId);
                }
                
                finalTableId = tableResult.data[0]._id.toString();
                console.log(`🔗 Resolved blockChainTableId ${blockChainTableId} to tableId ${finalTableId}`);
            }

            if (!finalTableId) {
                throw new Error('No tableId or blockChainTableId provided');
            }

            // Get table and fetch subTier to validate buyIn
            const mongoHelper = require('../../models/customdb');
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, finalTableId);
            
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
            if (finalBuyIn < minBuyIn || finalBuyIn > maxBuyIn) {
                throw new Error(`Buy-in must be between ${minBuyIn} and ${maxBuyIn}`);
            }

            const { tableState, isReconnect } = await tableManager.seatPlayer(
                finalTableId,
                {
                    userId,
                    username: user.username,
                    chips: finalBuyIn,
                    socketId: this.socket.id
                }
            );

            if (!isReconnect) {
                try {
                    const walletIntegrationService = require('../../services/wallet-integration.service');
                    await walletIntegrationService.chargeBuyInToTable(userId, finalBuyIn, finalTableId, table, {
                        paymentContext: 'NORMAL_TABLE_JOIN'
                    });
                    console.log(`💰 [BLOCKCHAIN] Confirmed transfer for ${finalBuyIn} chips to table ${finalTableId}`);
                } catch (paymentError) {
                    await tableManager.removePlayer(finalTableId, userId);
                    throw new Error(`Join payment failed: ${paymentError.message}`);
                }
            }

            this.socket.join(finalTableId);
            this.socket.tableId = finalTableId;
            this.socket.handsPlayed = 0; // Track hands played

            // Sync to MongoDB TABLES.currentPlayers
            this.syncPlayerToMongoTable(finalTableId, userId, 'join').catch(err => 
                console.error('Failed to sync to MongoDB:', err.message)
            );

            const gameState = await require('../../state/game-state').getGame(finalTableId);
            
            // showLoading: true if waiting for game to start (30s timer), false if game already ongoing
            const tableStatus = await tableManager.getStatus(finalTableId);
            const showLoading = !gameState || tableStatus === 'WAITING' || tableStatus === 'IDLE';
            
            emitSuccess(this.socket, 'roomJoined', { 
                tableId: finalTableId, 
                tableState, 
                showLoading 
            }, 'Joined table successfully');


            // Format data for frontend
            const formattedData = this.formatTableData(tableState, gameState);
            emitSuccess(this.socket, 'tableInfo', formattedData, 'Table info');

            if (!isReconnect) {
                emitSuccess(this.io.to(finalTableId), 'playerJoined', formattedData, `${user.username} joined`);
                const seatedCount = tableState.players.length;
                await this.orchestrator.onPlayerSeated(finalTableId, seatedCount);
                console.log(`👤 ${userId} seated at table ${finalTableId}`);
            } else {
                console.log(`🔄 ${userId} reconnected to table ${finalTableId}`);
                
                // Check if we need to start waiting timer
                const seatedCount = tableState.players.filter(p => !p.disconnected).length;
                if (seatedCount >= 2 && !gameState) {
                    console.log(`⏳ Triggering waiting timer after reconnect`);
                    await this.orchestrator.onPlayerSeated(finalTableId, seatedCount);
                }
                
                // If game is active and it's player's turn, restart timer
                if (gameState && gameState.currentPlayerId === userId) {
                    console.log(`⏱️ Restarting timer for reconnected player ${userId}`);
                    this.orchestrator.timerManager.startTimer(finalTableId, userId);
                }
            }

            // Send mid-game state if game is active
            if (gameState && gameState.phase !== 'COMPLETED') {
                const player = gameState.players.find(p => p.id === userId);
                
                // Send player's hole cards if they're in the game
                if (player && player.cards) {
                    emitSuccess(this.socket, 'receiveHand', {playerId : player.id, hand: player.cards }, 'Your cards');
                }
                
                // Send community cards if any are dealt
                if (gameState.boardCards && gameState.boardCards.length > 0) {
                    emitSuccess(this.socket, 'communityCardsDealt', gameState.boardCards, 'Community cards');
                }
                
                // Send current player turn info only when that player can still act.
                const currentPlayer = gameState.currentPlayerId
                    ? gameState.players.find(p => p.id === gameState.currentPlayerId)
                    : null;

                if (currentPlayer && currentPlayer.status === 'ACTIVE') {
                    const PlayerActionService = require('../../game/player-action.service');
                    const actionService = new PlayerActionService(this.io, this.orchestrator.timerManager, this.orchestrator);
                    const turnData = await actionService.formatPlayerTurnData(gameState, gameState.currentPlayerId, tableState);
                    
                    if (gameState.currentPlayerId === userId) {
                        emitSuccess(this.socket, 'playerTurn', turnData, 'Your turn');
                    } else {
                        emitSuccess(this.socket, 'currentPlayerTurn', turnData, 'Current turn');
                    }
                }
                
                console.log(`🎮 Sent mid-game state to ${userId}: cards=${player?.cards?.length || 0}, board=${gameState.boardCards?.length || 0}`);
            }

        } catch (err) {
            console.log(err)
            emitError(this.socket, 'unableToJoin', err.message);
        }
    }

    /**
     * Handle private table join - players join the underlying table after private table starts
     */
    async handlePrivateTableJoin(privateTableId, userId, user, buyIn) {
        try {
            // Get the private table with populated user details
            const privateTableService = require('../../services/private-table.service');
            const privateTableWithDetails = await privateTableService.getPrivateTableWithDetails(privateTableId);
            
            if (!privateTableWithDetails) {
                throw new Error('Private table not found');
            }
            
            const privateTable = privateTableWithDetails;
            
            if (privateTable.status !== 'ACTIVE') {
                throw new Error('Private table is not active');
            }
            
            // Check if user is registered for this private table
            const isRegistered = privateTable.registeredPlayers.some(
                p => p.userId?.toString() === userId.toString()
            );
            
            if (!isRegistered) {
                throw new Error('You are not registered for this private table');
            }
            
            // Get the underlying table ID
            const underlyingTableId = privateTable.underlyingTableId;
            if (!underlyingTableId) {
                throw new Error('Underlying table not found');
            }
            
            // Use private table buy-in settings
            const config = privateTable.privateConfig || {};
            const finalBuyIn = config.buyInSettings?.min || privateTable.buyIn;
            
            const { tableState, isReconnect } = await tableManager.seatPlayer(
                underlyingTableId,
                {
                    userId,
                    username: user.username,
                    chips: finalBuyIn,
                    socketId: this.socket.id
                }
            );
            
            if (!isReconnect) {
                try {
                    const mongoHelper = require('../../models/customdb');
                    const underlyingTableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, underlyingTableId);
                    if (!underlyingTableDoc.success || !underlyingTableDoc.data) {
                        throw new Error('Underlying table document not found');
                    }

                    const walletIntegrationService = require('../../services/wallet-integration.service');
                    await walletIntegrationService.chargeBuyInToTable(userId, finalBuyIn, underlyingTableId, underlyingTableDoc.data, {
                        paymentContext: 'PRIVATE_TABLE_JOIN'
                    });
                    const updatedRegisteredPlayers = (privateTable.registeredPlayers || []).map(player => ({
                        ...player,
                        buyInPaid: player.userId?.toString() === userId.toString() ? true : !!player.buyInPaid
                    }));
                    await mongoHelper.updateById(
                        mongoHelper.COLLECTIONS.PRIVATE_TABLES,
                        privateTableId,
                        { registeredPlayers: updatedRegisteredPlayers }
                    );
                    console.log(`💰 [PRIVATE BLOCKCHAIN] Confirmed transfer for ${finalBuyIn} chips to table ${underlyingTableId}`);
                } catch (paymentError) {
                    await tableManager.removePlayer(underlyingTableId, userId);
                    throw new Error(`Private join payment failed: ${paymentError.message}`);
                }
            }

            this.socket.join(underlyingTableId);
            this.socket.tableId = underlyingTableId;
            this.socket.privateTableId = privateTableId;
            this.socket.handsPlayed = 0;
            
            // Sync to MongoDB
            this.syncPlayerToMongoTable(underlyingTableId, userId, 'join').catch(err => 
                console.error('Failed to sync to MongoDB:', err.message)
            );
            
            const gameState = await require('../../state/game-state').getGame(underlyingTableId);
            const tableStatus = await tableManager.getStatus(underlyingTableId);
            const showLoading = !gameState || tableStatus === 'WAITING' || tableStatus === 'IDLE';
            
            emitSuccess(this.socket, 'roomJoined', { 
                tableId: underlyingTableId,
                privateTableId,
                tableState, 
                showLoading,
                    privateTableInfo: {
                        gameType: privateTable.gameType,
                        stakes: config.stakes,
                        features: {
                            rebuy: config.rebuy,
                            antes: config.antes || false,
                            anteValue: config.anteValue || 0,
                            antesStraddles: config.antesStraddles
                        },
                        registeredPlayers: privateTable.registeredPlayers || []
                    }
            }, 'Joined private table game successfully');
            
            const formattedData = this.formatTableData(tableState, gameState);
            emitSuccess(this.socket, 'tableInfo', formattedData, 'Private table info');
            
            if (!isReconnect) {
                emitSuccess(this.io.to(underlyingTableId), 'playerJoined', formattedData, `${user.username} joined private table`);
                
                // Use tableState from seatPlayer() which has the correct cumulative count
                const seatedCount = tableState.players.length;
                
                console.log(`🎮 [PRIVATE JOIN DEBUG] About to call onPlayerSeated for table ${underlyingTableId} with ${seatedCount} players`);
                console.log(`🎮 [PRIVATE JOIN DEBUG] Orchestrator exists: ${!!this.orchestrator}`);
                
                try {
                    await this.orchestrator.onPlayerSeated(underlyingTableId, seatedCount);
                    console.log(`✅ [PRIVATE JOIN DEBUG] onPlayerSeated completed successfully`);
                } catch (error) {
                    console.error(`❌ [PRIVATE JOIN DEBUG] onPlayerSeated failed:`, error.message);
                }
                
                console.log(`🎮 [PRIVATE] ${userId} seated at private table ${privateTableId} -> underlying table ${underlyingTableId}`);
            }
            
            // Send mid-game state if needed
            if (gameState && gameState.phase !== 'COMPLETED') {
                const player = gameState.players.find(p => p.id === userId);
                
                if (player && player.cards) {
                    emitSuccess(this.socket, 'receiveHand', {playerId : player.id, hand: player.cards }, 'Your cards');
                }
                
                if (gameState.boardCards && gameState.boardCards.length > 0) {
                    emitSuccess(this.socket, 'communityCardsDealt', gameState.boardCards, 'Community cards');
                }
                
                // Send private table specific game state
                if (gameState.privateTableConfig) {
                    emitSuccess(this.socket, 'privateTableGameState', {
                        stakes: gameState.privateTableConfig.stakes,
                        timer: gameState.privateTableConfig.timer,
                        features: gameState.privateTableConfig.features
                    }, 'Private table game configuration');
                }
            }
            
        } catch (err) {
            console.error('Private table join error:', err.message);
            emitError(this.socket, 'unableToJoinPrivateTable', err.message);
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
            await this.orchestrator.markPrivateTablePlayerLeaving(tableId, userId);

            // Get full user document for walletAddress
            const mongoHelper = require('../../models/customdb');
            const userDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
            const walletAddress = userDoc.success && userDoc.data ? userDoc.data.walletAddress : null;
            
            if (finalChips > 0 && walletAddress) {
                // Get user email for blockchain service
                const userEmail = userDoc.success && userDoc.data ? userDoc.data.email : null;
                const username = user.username;
                const tableBlockchainId = tableStateBefore.tableBlockchainId;
                
                blockchainService.queueWithdrawal(
                    userId,
                    tableId, 
                    tableBlockchainId,
                    finalChips,
                    walletAddress,
                    userEmail,
                    username
                ).catch(err => 
                    console.error('💰 [BLOCKCHAIN] Withdrawal queue error:', err.message)
                );
                console.log(`💰 [BLOCKCHAIN] Queued withdrawal for ${finalChips} chips (async)`);
            } else {
                console.log(`⚠️ [BLOCKCHAIN] Skipping withdrawal - chips: ${finalChips}, wallet: ${walletAddress ? 'present' : 'missing'}`);
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
                const completed = await this.orchestrator.checkPrivateTableCompletion(tableId, 'PLAYER_LEFT_WAITING_TABLE');
                if (!completed) {
                    await tableManager.setStatus(tableId, 'IDLE');
                }
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

    async handlePrivateTableRebuy(data) {
        try {
            const { token, amount } = data;
            const user = await verifyEventToken(token, this.socket);
            const tableId = this.socket.tableId;
            console.log(tableId , "tableId in rebuy--------------", user.username);
            if (!tableId) {
                emitError(this.socket, 'privateTableRebuyError', 'Not in a table');
                return;
            }

            const result = await this.orchestrator.handlePrivateTableRebuy(tableId, user, amount);

            emitSuccess(
                this.socket,
                'privateTableRebuySuccess',
                {
                    tableId,
                    amount: result.amount,
                    totalChips: result.totalChips,
                },
                'Rebuy successful'
            );
        } catch (err) {
            emitError(this.socket, 'privateTableRebuyError', err.message);
        }
    }

    async handlePrivateTableLeave(data) {
        await this.handleLeaveTable(data);
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
