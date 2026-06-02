// src/websocket/handlers/connection.handler.js

const tableManager = require('../../table/table-manager.service');
const { emitSuccess, emitError } = require('../socket-emitter');
const verifyEventToken = require('../verify-event-token');
const provablyFairSessionService = require('../../services/provably-fair-session.service');

class ConnectionHandler {
    constructor(io, socket, orchestrator) {
        this.io = io;
        this.socket = socket;
        this.orchestrator = orchestrator;
        this.awayManager = require('../../game/away-manager.service');
        this.registerEvents();
    }

    registerEvents() {
        this.socket.on('authorize', this.handleAuthorize.bind(this));
        this.socket.on('joinTable', this.handleJoinTable.bind(this));
        this.socket.on('checkActiveSession', this.handleCheckActiveSession.bind(this));
        this.socket.on('leaveTable', this.handleLeaveTable.bind(this));
        this.socket.on('leaveRoom', this.handleLeaveTable.bind(this));
        this.socket.on('disconnect', this.handleDisconnect.bind(this));
        this.socket.on('setAway', async (data) => this.handleAway(data));
        this.socket.on('setBack', async (data) => this.handleBack(data));
        this.socket.on('getTableInfo', async (data) => this.handleGetTableInfo(data));
        this.socket.on('getPlayerInfo', async (data) => this.handleGetPlayerInfo(data));
        this.socket.on('getFriendUserInfo', async (data) => this.handleGetFriendUserInfo(data));
        this.socket.on('getFriendSummary', async (data) => this.handleGetFriendUserInfo(data));
        this.socket.on('submitFairnessCommitment', this.handleSubmitFairnessCommitment.bind(this));
        this.socket.on('revealFairnessSeed', this.handleRevealFairnessSeed.bind(this));
        this.socket.on('getFairnessState', this.handleGetFairnessState.bind(this));
        this.socket.on('privateTableRebuy', this.handlePrivateTableRebuy.bind(this));
        this.socket.on('privateTableLeave', this.handlePrivateTableLeave.bind(this));
    }

    async handleAuthorize(data = {}) {
        try {
            const { token } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();

            this.socket.user = user;
            this.socket.join(`user_${userId}`);

            emitSuccess(
                this.socket,
                'authorized',
                {
                    userId,
                    username: user.username,
                    room: `user_${userId}`
                },
                'Socket authorized successfully'
            );
        } catch (err) {
            emitError(this.socket, 'authorizeError', err.message);
        }
    }

    async handleCheckActiveSession(data = {}) {
        try {
            const { token } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();
            const activeSession = await tableManager.findActiveSessionForUser(userId);

            if (!activeSession) {
                emitSuccess(this.socket, 'activeSessionChecked', { active: false }, 'No active table session');
                return;
            }

            emitSuccess(
                this.socket,
                'activeSessionFound',
                {
                    active: true,
                    tableId: activeSession.tableId,
                    blockChainTableId: activeSession.tableBlockchainId,
                    chipsInPlay: activeSession.player.chips,
                    disconnected: !!activeSession.player.disconnected,
                    status: activeSession.status
                },
                'Active table session found'
            );
        } catch (err) {
            emitError(this.socket, 'activeSessionError', err.message);
        }
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
                await require('../../services/provably-fair-session.service').removePlayer(tableId, userId);
                this.orchestrator.cancelWaiting(tableId);
                this.orchestrator.cancelRestart(tableId);
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
            await require('../../state/game-state').updateGame(tableId, gameState);

            if (gameState.currentPlayerId === userId) {
                const PlayerActionService = require('../../game/player-action.service');
                const actionService = new PlayerActionService(this.io, this.orchestrator.timerManager, this.orchestrator);
                await actionService.handle(tableId, userId, 'fold');
            } else {
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
                        
                    }
                } catch (error) {
                    console.error('Failed to update private table info on disconnect:', error.message);
                }
            }


        } catch (err) {
            console.error('Disconnect error:', err.message);
        }
    }

    async handleJoinTable(data) {
        try {
            const { tableId, blockChainTableId, buyIn, chipsInPlay, token, privateTableId, fundingSource } = data;
            const user = await verifyEventToken(token, this.socket);
            const userId = user._id.toString();
            const mongoHelper = require('../../models/customdb');
            const fullUserResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
            const fullUser = fullUserResult.success && fullUserResult.data ? fullUserResult.data : user;
            const custodialWalletService = require('../../services/custodial-wallet.service');

            this.socket.user = user;
            this.socket.join(`user_${userId}`);

            // 🆕 Handle private table join
            if (privateTableId) {
                custodialWalletService.assertGameModeAllowed(fullUser, fundingSource, 'PRIVATE_TABLE');
                return await this.handlePrivateTableJoin(privateTableId, userId, user, buyIn || chipsInPlay, fundingSource);
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
            }

            if (!finalTableId) {
                throw new Error('No tableId or blockChainTableId provided');
            }

            const currentTableState = await tableManager.getTable(finalTableId);
            let existingPlayer = currentTableState.players.find(p => p.userId === userId);
            let isReconnectEligible = false;

            if (existingPlayer) {
                const isSameSocketSession = existingPlayer.socketId === this.socket.id;
                const hasLiveExistingSocket = !!existingPlayer.socketId
                    && this.io.sockets.sockets.has(existingPlayer.socketId);

                isReconnectEligible = !!existingPlayer.disconnected || isSameSocketSession;

                if (!isReconnectEligible) {
                    if (hasLiveExistingSocket) {
                        throw new Error('You are already seated at this table from another active connection');
                    }

                    // Stale "connected" seats must be cleared so a fresh join is charged again.
                    await tableManager.removePlayer(finalTableId, userId);
                    await provablyFairSessionService.removePlayer(finalTableId, userId);
                    this.syncPlayerToMongoTable(finalTableId, userId, 'leave').catch(err =>
                        console.error('Failed to clear stale seat from MongoDB:', err.message)
                    );

                    const refreshedTableState = await tableManager.getTable(finalTableId);
                    existingPlayer = refreshedTableState.players.find(p => p.userId === userId);
                    isReconnectEligible = !!existingPlayer?.disconnected;
                }
            }

            // Use chipsInPlay if provided, otherwise buyIn. True reconnects may omit both.
            const finalBuyIn = chipsInPlay || buyIn || (isReconnectEligible ? existingPlayer?.chips : null);

            if (!finalBuyIn) {
                throw new Error('No buyIn or chipsInPlay provided');
            }

            // Get table and fetch subTier to validate buyIn
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, finalTableId);
            
            if (!tableDoc.success || !tableDoc.data) {
                throw new Error('Table not found');
            }

            const table = tableDoc.data;
            const effectiveFundingSource = custodialWalletService.getFundingSource(fullUser, fundingSource);

            if (table.isTournament || data.tournamentId) {
                custodialWalletService.assertGameModeAllowed(fullUser, fundingSource, 'TOURNAMENT');
                return await this.handleTournamentTableJoin(
                    data.tournamentId || table.tournamentId,
                    finalTableId,
                    userId,
                    user
                );
            }

            if (!isReconnectEligible) {
                await this.assertNoCooldownConflictForTable(finalTableId, userId);
            }
            
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

            if (!isReconnectEligible) {
                const walletIntegrationService = require('../../services/wallet-integration.service');
                await walletIntegrationService.chargeBuyInToTable(userId, finalBuyIn, finalTableId, table, {
                    paymentContext: 'NORMAL_TABLE_JOIN',
                    fundingSource: effectiveFundingSource,
                });
            }

            const { tableState, isReconnect } = await tableManager.seatPlayer(
                finalTableId,
                {
                    userId,
                    username: user.username,
                    chips: finalBuyIn,
                    socketId: this.socket.id,
                    fundingSource: effectiveFundingSource,
                }
            );

            if (!isReconnect && table.subTierId) {
                const queueService = require('../../services/queue.service');
                await queueService.removeFromQueue(userId, table.subTierId.toString?.() || table.subTierId);
            }

            this.socket.join(finalTableId);
            this.socket.tableId = finalTableId;
            this.socket.handsPlayed = 0; // Track hands played

            // Sync to MongoDB TABLES.currentPlayers
            this.syncPlayerToMongoTable(finalTableId, userId, 'join').catch(err => 
                console.error('Failed to sync to MongoDB:', err.message)
            );

            const tableStatus = await tableManager.getStatus(finalTableId);
            let gameState = await require('../../state/game-state').getGame(finalTableId);
            const activeSeatedCount = tableState.players.filter(p => !p.disconnected).length;
            if (gameState && (activeSeatedCount < 2 || tableStatus === 'IDLE')) {
                await require('../../state/game-state').deleteGame(finalTableId);
                gameState = null;
            }
            
            // showLoading: true if waiting for game to start (30s timer), false if game already ongoing
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
            } else {
                
                // Check if we need to start waiting timer
                const seatedCount = tableState.players.filter(p => !p.disconnected).length;
                if (seatedCount >= 2 && !gameState) {
                    await this.orchestrator.onPlayerSeated(finalTableId, seatedCount);
                }
                
                // If game is active and it's player's turn, restart timer
                if (gameState && gameState.currentPlayerId === userId) {
                    this.orchestrator.timerManager.startTimer(finalTableId, userId);
                }
            }

            // Send mid-game state if game is active
            if (gameState && gameState.phase !== 'COMPLETED') {
                let player = gameState.players.find(p => p.id === userId);
                
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
                
            }

        } catch (err) {
            emitError(this.socket, 'unableToJoin', err.message);
        }
    }

    /**
     * Handle scheduled tournament table join.
     */
    async handleTournamentTableJoin(tournamentId, tableId, userId, user) {
        try {
            if (!tournamentId) {
                throw new Error('Tournament ID is required');
            }

            const tournamentGameService = require('../../services/tournament-game.service');
            const { assignment, player } = await tournamentGameService.buildTournamentSeat(
                tableId,
                tournamentId,
                userId,
                this.socket.id,
                user.username
            );

            const { tableState, isReconnect } = await tableManager.seatPlayer(tableId, player);

            this.socket.join(tableId);
            this.socket.join(`tournament_${tournamentId}`);
            this.socket.tableId = tableId;
            this.socket.tournamentId = tournamentId;
            this.socket.handsPlayed = 0;

            const gameState = await require('../../state/game-state').getGame(tableId);
            const tableStatus = await tableManager.getStatus(tableId);
            const showLoading = !gameState || tableStatus === 'WAITING' || tableStatus === 'IDLE';

            emitSuccess(this.socket, 'roomJoined', {
                tableId,
                tournamentId,
                tournamentTableId: assignment.tournamentTableId,
                tableNumber: assignment.tableNumber,
                tableState,
                showLoading
            }, 'Joined tournament table successfully');

            const formattedData = this.formatTableData(tableState, gameState);
            emitSuccess(this.socket, 'tableInfo', formattedData, 'Tournament table info');

            if (!isReconnect) {
                emitSuccess(this.io.to(tableId), 'playerJoined', formattedData, `${user.username} joined tournament table`);
                const seatedCount = tableState.players.length;
                await this.orchestrator.onPlayerSeated(tableId, seatedCount);
            } else if (gameState && gameState.currentPlayerId === userId) {
                this.orchestrator.timerManager.startTimer(tableId, userId);
            }

            if (gameState && gameState.phase !== 'COMPLETED') {
                const gamePlayer = gameState.players.find(p => p.id === userId);
                if (gamePlayer?.cards) {
                    emitSuccess(this.socket, 'receiveHand', { playerId: gamePlayer.id, hand: gamePlayer.cards }, 'Your cards');
                }
                if (gameState.boardCards?.length > 0) {
                    emitSuccess(this.socket, 'communityCardsDealt', gameState.boardCards, 'Community cards');
                }
            }
        } catch (err) {
            console.error('Tournament table join error:', err.message);
            emitError(this.socket, 'unableToJoinTournamentTable', err.message);
        }
    }

    /**
     * Handle private table join - players join the underlying table after private table starts
     */
    async handlePrivateTableJoin(privateTableId, userId, user, buyIn, fundingSource = null) {
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
            
            const currentUnderlyingTableState = await tableManager.getTable(underlyingTableId);
            const existingUnderlyingPlayer = currentUnderlyingTableState.players.find(p => p.userId === userId);
            const mongoHelper = require('../../models/customdb');
            const fullUserResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
            const fullUser = fullUserResult.success && fullUserResult.data ? fullUserResult.data : user;
            const custodialWalletService = require('../../services/custodial-wallet.service');
            const effectiveFundingSource = custodialWalletService.assertGameModeAllowed(fullUser, fundingSource, 'PRIVATE_TABLE');
            
            if (!existingUnderlyingPlayer) {
                    const underlyingTableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, underlyingTableId);
                    if (!underlyingTableDoc.success || !underlyingTableDoc.data) {
                        throw new Error('Underlying table document not found');
                    }

                    const walletIntegrationService = require('../../services/wallet-integration.service');
                    await walletIntegrationService.chargeBuyInToTable(userId, finalBuyIn, underlyingTableId, underlyingTableDoc.data, {
                        paymentContext: 'PRIVATE_TABLE_JOIN',
                        fundingSource: effectiveFundingSource,
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
            }

            const { tableState, isReconnect } = await tableManager.seatPlayer(
                underlyingTableId,
                {
                    userId,
                    username: user.username,
                    chips: finalBuyIn,
                    socketId: this.socket.id,
                    fundingSource: effectiveFundingSource,
                }
            );

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
                
                
                try {
                    await this.orchestrator.onPlayerSeated(underlyingTableId, seatedCount);
                } catch (error) {
                    console.error(`❌ [PRIVATE JOIN DEBUG] onPlayerSeated failed:`, error.message);
                }
                
            }
            
            // Send mid-game state if needed
            if (gameState && gameState.phase !== 'COMPLETED') {
                let player = gameState.players.find(p => p.id === userId);
                
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
            const mongoHelper = require('../../models/customdb');
            const gameStateManager = require('../../state/game-state');
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            let isPrivateSng = false;
            const isTournamentTable = tableDoc.success && !!tableDoc.data?.isTournament;

            if (tableDoc.success && tableDoc.data?.privateTableId) {
                const privateTableDoc = await mongoHelper.findById(
                    mongoHelper.COLLECTIONS.PRIVATE_TABLES,
                    tableDoc.data.privateTableId
                );
                isPrivateSng = privateTableDoc.success && privateTableDoc.data?.gameType === 'PRIVATE_SNG';
            }

            let gameState = await gameStateManager.getGame(tableId);

            if (gameState) {
                let player = gameState.players.find(p => p.id === userId);
                if (player && gameState.currentPlayerId === userId) {
                    const PlayerActionService = require('../../game/player-action.service');
                    const actionService = new PlayerActionService(this.io, this.orchestrator.timerManager, this.orchestrator);
                    await actionService.handle(tableId, userId, 'fold');
                    gameState = await gameStateManager.getGame(tableId);
                    player = gameState?.players?.find(p => p.id === userId);
                }

                if ((isPrivateSng || isTournamentTable) && player) {
                    player.status = 'folded';
                    player.disconnected = true;
                    player.chips = 0;

                    if (gameState.currentPlayerId === userId) {
                        gameState.currentPlayerId = null;
                    }

                    await gameStateManager.updateGame(tableId, gameState);
                    await tableManager.syncFromGameState(tableId, gameState);
                }
            }

            // Get player's chips BEFORE removing from table
            const tableStateBefore = await tableManager.getTable(tableId);
            const playerBefore = tableStateBefore.players.find(p => p.userId === userId);
            const finalChips = playerBefore?.chips || 0;

            const tableState = await tableManager.removePlayer(tableId, userId);
            await require('../../services/provably-fair-session.service').removePlayer(tableId, userId);
            await this.orchestrator.markPrivateTablePlayerLeaving(tableId, userId);

            // Get full user document for walletAddress
            const userDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
            const effectiveFundingSource = userDoc.success && userDoc.data
                ? (userDoc.data.currentGameFundingSource || playerBefore?.fundingSource || null)
                : (playerBefore?.fundingSource || null);
            
            if (isPrivateSng || isTournamentTable) {
            } else if (finalChips > 0) {
                const walletIntegrationService = require('../../services/wallet-integration.service');
                walletIntegrationService.queuePlayerTableCashout(
                    userId,
                    finalChips,
                    tableId,
                    tableId,
                    {
                        fundingSource: effectiveFundingSource,
                        payoutContext: 'PLAYER_LEAVE',
                        description: `Player leave cashout for table ${tableId}`
                    }
                ).catch(err =>
                    console.error('💰 [BLOCKCHAIN] Withdrawal queue error:', err.message)
                );
            } else {
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

            if (seatedCount < 2) {
                this.orchestrator.cancelWaiting(tableId);
                this.orchestrator.cancelRestart(tableId);
                if (!isPrivateSng && !isTournamentTable) {
                    await require('../../state/game-state').deleteGame(tableId);
                }
                const completed = await this.orchestrator.checkPrivateTableCompletion(tableId, 'PLAYER_LEFT_WAITING_TABLE');
                if (!completed) {
                    await tableManager.setStatus(tableId, 'IDLE');
                }
            }
            
            this.socket.leave(tableId);
            this.socket.tableId = null;
            this.socket.privateTableId = null;
            this.socket.tournamentId = null;
            this.socket.handsPlayed = 0;

            emitSuccess(this.socket, 'roomLeft', { tableId }, 'Left table successfully');
            
            const updatedTableState = await tableManager.getTable(tableId);
            const updatedGameState = await require('../../state/game-state').getGame(tableId);
            const formattedData = this.formatTableData(updatedTableState, updatedGameState);
            emitSuccess(this.io.to(tableId), 'playerLeft', formattedData, 'Player left');


        } catch (err) {
            emitError(this.socket, 'unableToLeave', err.message);
        }
    }

    async handlePrivateTableRebuy(data) {
        try {
            const { token, amount } = data;
            const user = await verifyEventToken(token, this.socket);
            const tableId = this.socket.tableId;
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

    async handleGetFriendUserInfo(data) {
        try {
            const { token } = data || {};
            await verifyEventToken(token, this.socket);

            const userId = data?.userId || data?.params?.userId || data?.query?.userId;
            if (!userId) {
                emitError(this.socket, 'getFriendUserInfoError', 'userId is required');
                return;
            }

            const userService = require('../../services/user.service');
            const userInfo = await userService.getSmallUserData(userId);

            emitSuccess(this.socket, 'friendUserInfo', userInfo, 'User info fetched successfully');
            emitSuccess(this.socket, 'friendSummary', userInfo, 'Friend summary fetched successfully');
        } catch (err) {
            emitError(this.socket, 'getFriendUserInfoError', err.message);
            emitError(this.socket, 'getFriendSummaryError', err.message);
        }
    }

    async handleSubmitFairnessCommitment(data = {}) {
        try {
            const { token, clientSeedHash } = data;
            const user = await verifyEventToken(token, this.socket);
            const tableId = data.tableId || this.socket.tableId;

            if (!tableId) {
                throw new Error('Not in table');
            }

            const fairnessState = await provablyFairSessionService.submitCommitment(tableId, {
                playerId: user._id.toString(),
                username: user.username,
                clientSeedHash
            });

            emitSuccess(this.socket, 'fairnessCommitmentAccepted', fairnessState, 'Fairness seed commitment accepted');
            emitSuccess(this.io.to(tableId), 'fairnessStateUpdated', fairnessState, 'Fairness state updated');

            const gameState = await require('../../state/game-state').getGame(tableId);
            if (!gameState) {
                await this.orchestrator.startHand(tableId);
            }
        } catch (err) {
            emitError(this.socket, 'fairnessCommitmentError', err.message);
        }
    }

    async handleRevealFairnessSeed(data = {}) {
        try {
            const { token, clientSeed } = data;
            const user = await verifyEventToken(token, this.socket);
            const tableId = data.tableId || this.socket.tableId;

            if (!tableId) {
                throw new Error('Not in table');
            }

            const result = await provablyFairSessionService.submitReveal(tableId, {
                playerId: user._id.toString(),
                clientSeed
            });

            emitSuccess(this.socket, 'fairnessSeedRevealAccepted', result.fairnessState, 'Fairness seed reveal accepted');
            emitSuccess(this.io.to(tableId), 'fairnessStateUpdated', result.fairnessState, 'Fairness state updated');

            if (result.status === 'READY') {
                emitSuccess(this.io.to(tableId), 'fairnessReady', result.fairnessState.currentHand, 'Provably fair hand ready');
                await this.orchestrator.startHand(tableId);
            }
        } catch (err) {
            emitError(this.socket, 'fairnessSeedRevealError', err.message);
        }
    }

    async handleGetFairnessState(data = {}) {
        try {
            const { token } = data;
            await verifyEventToken(token, this.socket);
            const tableId = data.tableId || this.socket.tableId;

            if (!tableId) {
                throw new Error('Not in table');
            }

            const fairnessState = await provablyFairSessionService.getPublicState(tableId);
            emitSuccess(this.socket, 'fairnessState', fairnessState, 'Fairness state');
        } catch (err) {
            emitError(this.socket, 'fairnessStateError', err.message);
        }
    }

    async assertNoCooldownConflictForTable(tableId, userId) {
        const mongoHelper = require('../../models/customdb');
        const cooldownService = require('../../services/cooldown.service');

        const tableResult = await mongoHelper.findByIdWithPopulate(
            mongoHelper.COLLECTIONS.TABLES,
            tableId,
            [
                {
                    path: 'currentPlayers',
                    collection: mongoHelper.COLLECTIONS.PLAYERS,
                    populate: {
                        path: 'user',
                        collection: mongoHelper.COLLECTIONS.USERS,
                        select: 'username'
                    }
                }
            ]
        );

        if (!tableResult.success || !tableResult.data || !tableResult.data.subTierId) {
            return;
        }

        const table = tableResult.data;
        const subTierResult = await mongoHelper.findByIdWithPopulate(
            mongoHelper.COLLECTIONS.SUB_TIERS,
            table.subTierId,
            [{ path: 'tierId', collection: mongoHelper.COLLECTIONS.TIERS }]
        );

        if (!subTierResult.success || !subTierResult.data) {
            return;
        }

        const liveTable = await tableManager.getLiveTable(tableId);
        const livePlayers = Array.isArray(liveTable?.players) ? liveTable.players : [];
        const seatedUserIds = livePlayers.length > 0
            ? livePlayers
                .filter(player => !player?.isBot)
                .map(player => player.userId?.toString?.() || player.id?.toString?.() || player.userId || player.id)
                .filter(Boolean)
                .filter(seatedUserId => seatedUserId !== userId)
            : (table.currentPlayers || [])
                .filter(player => !player?.isBot && player?.user?._id)
                .map(player => player.user._id.toString())
                .filter(seatedUserId => seatedUserId !== userId);

        if (seatedUserIds.length === 0) {
            return;
        }

        const requesterConflict = await cooldownService.hasCooldownConflict(userId, seatedUserIds);
        if (requesterConflict) {
            throw new Error('Cooldown conflict: you cannot be matched with the same player for the next 3 games');
        }

        const tier = subTierResult.data.tierId;
        if (tier?.mutualCooldownEnforced) {
            for (const seatedUserId of seatedUserIds) {
                const mutualConflict = await cooldownService.hasCooldownConflict(seatedUserId, [userId]);
                if (mutualConflict) {
                    throw new Error('Cooldown conflict: you cannot be matched with the same player for the next 3 games');
                }
            }
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
            fairnessState: provablyFairSessionService.getPublicStateFromTable(tableState),
            gameState: gameState ? {
                pot: gameState.pot || 0,
                phase: gameState.phase,
                currentPlayerId: gameState.currentPlayerId,
                currentBet: gameState.currentBet || 0,
                boardCards: gameState.boardCards || [],
                dealerPosition: gameState.dealerPosition,
                smallBlindPosition: gameState.smallBlindPosition,
                bigBlindPosition: gameState.bigBlindPosition,
                fairness: gameState.fairness || null
            } : null
        };
    }
}

module.exports = ConnectionHandler;
