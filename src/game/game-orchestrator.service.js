// src/game/game-orchestrator.service.js

const StartGameService = require('./start-game-service.js');
const PrivateTableGameOrchestrator = require('./private-table-game-orchestrator.js');
const gameStateManager = require('../state/game-state');
const handPersister = require('../workers/hand-persister');
const tableManager = require('../table/table-manager.service');
const financialIntegrationService = require('../services/financial-integration.service');
const { emitSuccess } = require('../websocket/socket-emitter.js');
const mongoHelper = require('../models/customdb');
const walletIntegrationService = require('../services/wallet-integration.service');
const blockchainService = require('../services/blockchain.service');
const privateTableGameConfigService = require('../services/private-table-game-config.service');

class GameOrchestrator {
    constructor(io, timerManager) {
        this.io = io;
        this.timerManager = timerManager;
        this.startGameService = new StartGameService(io, timerManager);
        
        // 🆕 Initialize private table orchestrator
        this.privateTableOrchestrator = new PrivateTableGameOrchestrator(io);
        
        // 🆕 Initialize action service for both regular and private tables
        const PlayerActionService = require('./player-action.service');
        this.actionService = new PlayerActionService(io, timerManager, this);
        
        // 🆕 Set action service for both timer managers
        this.timerManager.setActionService(this.actionService);
        this.privateTableOrchestrator.setActionService(this.actionService);
        
        // 🕐 Initialize table timer service
        const tableTimerService = require('../services/table-timer.service');
        tableTimerService.setIO(io);
        tableTimerService.setOrchestrator(this);

        this.waitingTimers = new Map();   // tableId -> timeout
        this.restartTimers = new Map();   // tableId -> timeout
        this.privateRebuyWindows = new Map(); // tableId -> rebuy window metadata
    }

    async getPrivateRebuyCandidates(tableId) {
        const tableState = await tableManager.getTable(tableId);
        const gameState = await gameStateManager.getGame(tableId);
        const gamePlayers = new Map(
            (gameState?.players || []).map(player => [player.id, player])
        );

        return tableState.players.map(player => {
            const gamePlayer = gamePlayers.get(player.userId);

            return {
                ...player,
                chips: Number(gamePlayer?.chips ?? player.chips ?? 0),
                gameStatus: gamePlayer?.status || null,
            };
        });
    }

    getPrivateRebuyThreshold(gameConfig) {
        const bigBlind = Number(gameConfig?.blinds?.big || 0);
        const configuredAnte = Number(gameConfig?.features?.anteValue || 0);
        const computedAnte = gameConfig?.features?.antesEnabled
            ? (configuredAnte > 0 ? configuredAnte : Math.max(1, Math.floor(bigBlind * 0.1)))
            : 0;

        return Math.max(bigBlind, computedAnte);
    }

    async shouldPauseForPrivateRebuy(tableId) {
        try {
            const privateConfig = await this.getPrivateTableConfig(tableId);
            if (!privateConfig?.gameConfig?.buyIn?.allowRebuy) {
                console.log(`💸 [PRIVATE REBUY] Rebuy disabled for table ${tableId}`);
                return false;
            }

            const rebuyThreshold = this.getPrivateRebuyThreshold(privateConfig.gameConfig);
            const playersForRebuy = await this.getPrivateRebuyCandidates(tableId);
            const playersSnapshot = playersForRebuy.map(player => ({
                userId: player.userId,
                username: player.username,
                chips: Number(player.chips || 0),
                disconnected: !!player.disconnected,
                gameStatus: player.gameStatus,
            }));
            const shouldPause = playersForRebuy.some(
                player => !player.disconnected && Number(player.chips || 0) < rebuyThreshold
            );
            console.log(`💸 [PRIVATE REBUY] Rebuy inspection for table ${tableId}:`, {
                shouldPause,
                rebuyThreshold,
                players: playersSnapshot,
            });
            return shouldPause;
        } catch (error) {
            console.error(`âŒ [PRIVATE REBUY] Failed to inspect table ${tableId}:`, error.message);
            return false;
        }
    }

    async startPrivateRebuyWindow(tableId) {
        try {
            this.clearRestartTimer(tableId);
            this.clearPrivateRebuyWindow(tableId);

            const privateConfig = await this.getPrivateTableConfig(tableId);
            if (!privateConfig?.gameConfig?.buyIn?.allowRebuy) {
                await this.prepareNextHand(tableId);
                return;
            }

            const rebuyThreshold = this.getPrivateRebuyThreshold(privateConfig.gameConfig);
            const playersForRebuy = await this.getPrivateRebuyCandidates(tableId);
            const pendingPlayers = playersForRebuy.filter(
                player => !player.disconnected && Number(player.chips || 0) < rebuyThreshold
            );
            console.log(`💸 [PRIVATE REBUY] Starting rebuy window evaluation for table ${tableId}:`, {
                players: playersForRebuy.map(player => ({
                    userId: player.userId,
                    username: player.username,
                    chips: Number(player.chips || 0),
                    disconnected: !!player.disconnected,
                    socketId: player.socketId,
                    gameStatus: player.gameStatus,
                })),
                pendingPlayers: pendingPlayers.map(player => ({
                    userId: player.userId,
                    username: player.username,
                    chips: Number(player.chips || 0),
                })),
            });

            if (pendingPlayers.length === 0) {
                console.log(`💸 [PRIVATE REBUY] No pending rebuy players found for table ${tableId}; preparing next hand`);
                await this.prepareNextHand(tableId);
                return;
            }

            const seconds = 30;
            const minAmount = privateConfig.gameConfig.buyIn.min;
            const maxAmount = privateConfig.gameConfig.buyIn.max;

            const timeout = setTimeout(async () => {
                await this.resolvePrivateRebuyWindow(tableId, 'timeout');
            }, seconds * 1000);

            this.privateRebuyWindows.set(tableId, {
                timeout,
                startedAt: Date.now(),
                seconds,
                players: new Map(
                    pendingPlayers.map(player => [
                        player.userId,
                        {
                            socketId: player.socketId,
                            username: player.username,
                            status: 'pending',
                        },
                    ])
                ),
            });

            emitSuccess(
                this.io.to(tableId),
                'waitingCountdown',
                {
                    seconds,
                    reason: 'PRIVATE_REBUY_WINDOW',
                    pendingPlayers: pendingPlayers.map(player => ({
                        playerId: player.userId,
                        username: player.username,
                    })),
                },
                'Waiting for rebuy decisions'
            );

            for (const player of pendingPlayers) {
                if (!player.socketId) {
                    console.log(`⚠️ [PRIVATE REBUY] Skipping rebuyRequired emit for ${player.username} (${player.userId}) because socketId is missing`);
                    continue;
                }

                console.log(`📣 [PRIVATE REBUY] Emitting rebuyRequired to ${player.username} (${player.userId}) on socket ${player.socketId}`);

                emitSuccess(
                    this.io.to(player.socketId),
                    'rebuyRequired',
                    {
                        tableId,
                        playerId: player.userId,
                        currentChips: Number(player.chips || 0),
                        rebuyThreshold,
                        minAmount,
                        maxAmount,
                        secondsRemaining: seconds,
                        canLeave: true,
                    },
                    'Rebuy or leave within 30 seconds to meet the next-hand minimum'
                );
            }

            await tableManager.setStatus(tableId, 'WAITING');
        } catch (error) {
            console.error(`âŒ [PRIVATE REBUY] Failed to start rebuy window for ${tableId}:`, error.message);
            await this.prepareNextHand(tableId);
        }
    }

    async handlePrivateTableRebuy(tableId, user, amount) {
        const userId = user._id.toString();
        const rebuyWindow = this.privateRebuyWindows.get(tableId);

        if (!rebuyWindow) {
            throw new Error('No active rebuy window for this table');
        }

        const pendingPlayer = rebuyWindow.players.get(userId);
        if (!pendingPlayer || pendingPlayer.status !== 'pending') {
            throw new Error('You do not have a pending rebuy decision');
        }

        const privateConfig = await this.getPrivateTableConfig(tableId);
        const requestedAmount = Number(amount || privateConfig?.gameConfig?.buyIn?.min || 0);
        if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
            throw new Error('Invalid rebuy amount');
        }

        const rebuyEligibility = privateTableGameConfigService.canPlayerRebuy(
            privateConfig.gameConfig,
            { chips: 0 },
            'between_hands'
        );

        if (!rebuyEligibility.allowed) {
            throw new Error(rebuyEligibility.reason || 'Rebuy not allowed');
        }

        if (requestedAmount < rebuyEligibility.minAmount || requestedAmount > rebuyEligibility.maxAmount) {
            throw new Error(`Rebuy amount must be between ${rebuyEligibility.minAmount} and ${rebuyEligibility.maxAmount}`);
        }

        const playerResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.PLAYERS, 'user', userId);
        if (!playerResult.success || !playerResult.data) {
            throw new Error('Player not found on table');
        }

        const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
        if (!tableDoc.success || !tableDoc.data) {
            throw new Error('Table not found');
        }

        await walletIntegrationService.chargeBuyIn(userId, requestedAmount, tableId);

        if (user.walletAddress) {
            await blockchainService.prepareTableForJoin(tableDoc.data, requestedAmount, user.walletAddress);
        }

        const tableState = await tableManager.getTable(tableId);
        const tablePlayer = tableState.players.find(player => player.userId === userId);
        const currentTableChips = Math.max(0, Number(tablePlayer?.chips || 0));
        const nextChipCount = currentTableChips + requestedAmount;
        const updateResult = await mongoHelper.updateById(
            mongoHelper.COLLECTIONS.PLAYERS,
            playerResult.data._id,
            {
                chipsInPlay: nextChipCount,
                status: 'waiting',
                rebuyCount: Number(playerResult.data.rebuyCount || 0) + 1,
            },
            mongoHelper.MODELS.PLAYER
        );

        if (!updateResult.success) {
            throw new Error(updateResult.error || 'Failed to update player stack after rebuy');
        }

        if (tablePlayer) {
            tablePlayer.chips = nextChipCount;
            await tableManager.saveTable(tableId, tableState);
        }

        pendingPlayer.status = 'rebought';

        emitSuccess(
            this.io.to(tableId),
            'playerRebuyCompleted',
            {
                playerId: userId,
                username: user.username,
                amount: requestedAmount,
                totalChips: nextChipCount,
            },
            `${user.username} re-bought for the next hand`
        );

        await this.checkPrivateRebuyResolution(tableId);

        return {
            amount: requestedAmount,
            totalChips: nextChipCount,
        };
    }

    async markPrivateTablePlayerLeaving(tableId, userId) {
        const rebuyWindow = this.privateRebuyWindows.get(tableId);
        if (rebuyWindow) {
            const playerEntry = rebuyWindow.players.get(userId);
            if (playerEntry && playerEntry.status === 'pending') {
                playerEntry.status = 'left';
                await this.checkPrivateRebuyResolution(tableId);
            }
        }

        await this.checkPrivateTableCompletion(tableId, 'PLAYER_LEFT');
    }

    async checkPrivateRebuyResolution(tableId) {
        const rebuyWindow = this.privateRebuyWindows.get(tableId);
        if (!rebuyWindow) {
            return;
        }

        const unresolvedPlayers = [...rebuyWindow.players.values()].filter(player => player.status === 'pending');
        if (unresolvedPlayers.length === 0) {
            await this.resolvePrivateRebuyWindow(tableId, 'all_resolved');
        }
    }

    async resolvePrivateRebuyWindow(tableId, reason = 'timeout') {
        const rebuyWindow = this.privateRebuyWindows.get(tableId);
        if (!rebuyWindow) {
            return;
        }

        this.clearPrivateRebuyWindow(tableId);

        const timedOutPlayers = [...rebuyWindow.players.entries()]
            .filter(([, player]) => player.status === 'pending')
            .map(([playerId]) => playerId);

        for (const playerId of timedOutPlayers) {
            const tableState = await tableManager.getTable(tableId);
            const player = tableState.players.find(entry => entry.userId === playerId);
            if (!player) {
                continue;
            }

            await tableManager.removePlayer(tableId, playerId);
            const playerSocket = player.socketId ? this.io.sockets.sockets.get(player.socketId) : null;
            if (playerSocket) {
                playerSocket.leave(tableId);
                playerSocket.tableId = null;
                emitSuccess(playerSocket, 'roomLeft', { tableId }, 'Removed from table after rebuy timeout');
            }

            emitSuccess(
                this.io.to(tableId),
                'playerAutoEliminated',
                {
                    playerId,
                    username: player.username,
                    reason: 'PRIVATE_TABLE_REBUY_TIMEOUT',
                },
                `${player.username} was eliminated after missing the rebuy window`
            );
        }

        const updatedTable = await tableManager.getTable(tableId);
        const activePlayers = updatedTable.players.filter(
            player => !player.disconnected && Number(player.chips || 0) > 0
        );

        if (activePlayers.length <= 1) {
            await this.handleGameCompletion(tableId, {
                reason: reason === 'timeout' ? 'PRIVATE_TABLE_REBUY_TIMEOUT' : 'PRIVATE_TABLE_REBUY_RESOLVED',
            });
            return;
        }

        emitSuccess(
            this.io.to(tableId),
            'newRoundStarting',
            {
                seconds: 0,
                reason: reason === 'timeout' ? 'PRIVATE_TABLE_REBUY_TIMEOUT' : 'PRIVATE_TABLE_REBUY_RESOLVED',
            },
            'Rebuy decisions resolved. Starting next hand.'
        );

        await this.prepareNextHand(tableId);
    }

    clearPrivateRebuyWindow(tableId) {
        const rebuyWindow = this.privateRebuyWindows.get(tableId);
        if (rebuyWindow?.timeout) {
            clearTimeout(rebuyWindow.timeout);
        }

        this.privateRebuyWindows.delete(tableId);
    }

    /* ------------------------------------------------ */
    /* PLAYER JOINED                                   */
    /* ------------------------------------------------ */
    cancelWaiting(tableId) {
        this.clearWaitingTimer(tableId);
    }

    cancelRestart(tableId) {
        this.clearRestartTimer(tableId);
    }
    async onPlayerSeated(tableId, seatedCount) {
        try {
            console.log(`🎮 [ORCHESTRATOR] onPlayerSeated called for table ${tableId} with ${seatedCount} players`);
            
            if (seatedCount < 2) {
                console.log(`🎮 [ORCHESTRATOR] Not enough players (${seatedCount} < 2) - skipping`);
                return;
            }

            const gameState = await gameStateManager.getGame(tableId);

            if (gameState) {
                console.log(`🔄 Player joined mid-game at table ${tableId} - will join next hand`);
                return;
            }

            if (this.waitingTimers.has(tableId)) {
                console.log(`⏳ Waiting timer already active for table ${tableId} - skipping`);
                return;
            }

            console.log(`⏳ Starting 30s waiting for table ${tableId}`);

            emitSuccess(this.io.to(tableId), 'waitingCountdown', { seconds: 30 }, 'Waiting countdown');

            const timeout = setTimeout(async () => {
                await this.startHand(tableId);
            }, 25000);
            this.clearRestartTimer(tableId);
            this.clearWaitingTimer(tableId);
            this.waitingTimers.set(tableId, timeout);
        } catch (err) {
            console.error(`❌ onPlayerSeated error for ${tableId}:`, err.message);
        }
    }

    /* ------------------------------------------------ */
    /* START HAND                                      */
    /* ------------------------------------------------ */

    async startHand(tableId) {
        try {
            this.clearWaitingTimer(tableId);
            await tableManager.setStatus(tableId, 'IN_PROGRESS');

            console.log(`🃏 Starting hand at table ${tableId}`);

            // 🆕 Check if this is a private table and handle financial setup
            await this.handleTableStart(tableId);

            // 🎯 CRITICAL: Use private table orchestrator for private tables
            const isPrivateTable = await this.isPrivateTable(tableId);
            
            if (isPrivateTable) {
                console.log(`🔒 [PRIVATE SNG] Starting private table game: ${tableId}`);
                await this.startTimedPrivateTableIfNeeded(tableId);
                await this.privateTableOrchestrator.startGame(tableId);
            } else {
                console.log(`🎲 [REGULAR SNG] Starting regular table game: ${tableId}`);
                await this.startGameService.start(tableId);
            }
        } catch (err) {
            console.error(`❌ startHand error for ${tableId}:`, err.message);
        }
    }

    /* ------------------------------------------------ */
    /* HANDLE TABLE START (FINANCIAL INTEGRATION)     */
    /* ------------------------------------------------ */
    async handleTableStart(tableId) {
        try {
            const mongoHelper = require('../models/customdb');
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            
            if (tableDoc.success && tableDoc.data && tableDoc.data.privateTableId) {
                console.log(`💰 [FINANCIAL] Private table detected: ${tableDoc.data.privateTableId}`);
                
                // Get private table details for financial integration
                const privateTableDoc = await mongoHelper.findById(
                    mongoHelper.COLLECTIONS.PRIVATE_TABLES, 
                    tableDoc.data.privateTableId
                );
                
                if (privateTableDoc.success && privateTableDoc.data) {
                    const privateTable = privateTableDoc.data;
                    
                    await financialIntegrationService.onTableCreated({
                        tableId,
                        hostId: privateTable.hostId,
                        gameType: privateTable.gameType,
                        config: {
                            buyIn: privateTable.buyIn,
                            maxPlayers: privateTable.declaredCapacity,
                            participationThreshold: privateTable.participationThreshold,
                            tier: privateTable.tier,
                            estimatedHours: privateTable.estimatedHours,
                            timerSeconds: privateTable.timerSeconds
                        }
                    });
                }
            }
        } catch (err) {
            console.error(`⚠️ [FINANCIAL] Error in handleTableStart:`, err.message);
            // Don't throw - financial errors shouldn't stop the game
        }
    }

    /* ------------------------------------------------ */
    /* HAND COMPLETED                                  */
    /* ------------------------------------------------ */

    async onHandCompleted(tableId) {
        try {
            await handPersister.persist(tableId);
            await tableManager.setStatus(tableId, 'SHOWDOWN_DELAY');
            console.log(`🏁 Hand completed at table ${tableId}`);
            emitSuccess(this.io.to(tableId), 'showdownDelay', { seconds: 10 }, 'Showdown delay');

            // Increment handsPlayed for all connected players
            const sockets = await this.io.in(tableId).fetchSockets();
            sockets.forEach(socket => {
                if (socket.handsPlayed !== undefined) {
                    socket.handsPlayed++;
                    console.log(`🎴 Player ${socket.user?._id} hands: ${socket.handsPlayed}`);
                }
            });

            const tableTimerService = require('../services/table-timer.service');
            if (await tableTimerService.shouldEndAfterHand(tableId)) {
                await this.handleGameCompletion(tableId);
                return;
            }

            const shouldPauseForRebuy = await this.shouldPauseForPrivateRebuy(tableId);
            console.log(`💸 [PRIVATE REBUY] Post-hand decision for table ${tableId}:`, {
                shouldPauseForRebuy,
            });

            // 🆕 Check if this is the final hand (SNG completion)
            const shouldComplete = await this.checkGameCompletion(tableId);
            console.log(`🏁 [HAND COMPLETE] Completion check for table ${tableId}:`, {
                shouldComplete,
                shouldPauseForRebuy,
            });
            
            if (shouldComplete && !shouldPauseForRebuy) {
                await this.handleGameCompletion(tableId);
                return;
            }

            const timeout = setTimeout(async () => {
                if (shouldPauseForRebuy) {
                    await this.startPrivateRebuyWindow(tableId);
                    return;
                }

                emitSuccess(this.io.to(tableId), 'newRoundStarting', { seconds: 8 }, 'New round starting');
                await this.prepareNextHand(tableId);
            }, 8000);

            await tableManager.setStatus(tableId, 'WAITING');
            this.restartTimers.set(tableId, timeout);
        } catch (err) {
            console.error(`❌ onHandCompleted error for ${tableId}:`, err.message);
        }
    }

    /* ------------------------------------------------ */
    /* CHECK GAME COMPLETION                           */
    /* ------------------------------------------------ */
    async checkGameCompletion(tableId) {
        try {
            const gameState = await gameStateManager.getGame(tableId);
            const playersWithChips = gameState
                ? gameState.players.filter(p => p.chips > 0 && !p.disconnected)
                : (await tableManager.getTable(tableId)).players.filter(p => p.chips > 0 && !p.disconnected);
            
            // SNG is complete when only 1 player has chips
            return playersWithChips.length <= 1;
        } catch (err) {
            console.error(`❌ checkGameCompletion error:`, err.message);
            return false;
        }
    }

    async checkPrivateTableCompletion(tableId, reason = 'PRIVATE_TABLE_CONDITION_MET') {
        try {
            const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            if (!tableResult.success || !tableResult.data?.privateTableId) {
                return false;
            }

            const tableDoc = tableResult.data;
            const privateTableResult = await mongoHelper.findById(
                mongoHelper.COLLECTIONS.PRIVATE_TABLES,
                tableDoc.privateTableId
            );

            if (!privateTableResult.success || !privateTableResult.data) {
                return false;
            }

            const privateTable = privateTableResult.data;
            if (['COMPLETED', 'CANCELLED'].includes(privateTable.status)) {
                return false;
            }

            const tableState = await tableManager.getTable(tableId);
            const gameState = await gameStateManager.getGame(tableId);
            const playersSnapshot = gameState?.players?.length ? gameState.players : tableState.players;
            const activePlayers = playersSnapshot.filter(
                player => Number(player.chips || 0) > 0 && !player.disconnected
            );

            console.log(`🏁 [PRIVATE TABLE CHECK] Completion inspection for ${tableId}:`, {
                reason,
                privateTableStatus: privateTable.status,
                tableStatus: tableState.status,
                playersRemaining: activePlayers.length,
                hasGameState: !!gameState,
            });

            if (activePlayers.length <= 1) {
                await this.handleGameCompletion(tableId, { reason });
                return true;
            }

            return false;
        } catch (error) {
            console.error(`❌ [PRIVATE TABLE CHECK] Error checking completion for ${tableId}:`, error.message);
            return false;
        }
    }

    /* ------------------------------------------------ */
    /* HANDLE GAME COMPLETION (FINANCIAL SETTLEMENT)  */
    /* ------------------------------------------------ */
    async handleGameCompletion(tableId, options = {}) {
        try {
            console.log(`🏆 [GAME COMPLETE] Processing completion for table ${tableId}`);
            
            const gameState = await gameStateManager.getGame(tableId);
            const tableState = await tableManager.getTable(tableId);
            const mongoHelper = require('../models/customdb');
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            const playersForStandings = gameState?.players || tableState.players;
             
            // Determine winners
            const winners = playersForStandings
                .filter(p => p.chips > 0)
                .sort((a, b) => b.chips - a.chips)
                .map((player, index) => ({
                    playerId: player.userId || player.id,
                    position: index + 1,
                    percentage: index === 0 ? 100 : 0 // Winner takes all for SNG
                }));
            
            // 🆕 Execute financial settlement if this is a private table
            if (tableDoc.success && tableDoc.data && tableDoc.data.privateTableId) {
                console.log(`💰 [SETTLEMENT] Processing settlement for private table`);
                
                // Get private table details for settlement
                const privateTableDoc = await mongoHelper.findById(
                    mongoHelper.COLLECTIONS.PRIVATE_TABLES, 
                    tableDoc.data.privateTableId
                );
                
                if (privateTableDoc.success && privateTableDoc.data) {
                    const privateTable = privateTableDoc.data;

                    if (privateTable.settlementCompleted) {
                        console.log(`💰 [SETTLEMENT] Skipping duplicate settlement for private table ${privateTable._id}`);
                    } else {
                        const financialResult = await financialIntegrationService.onGameCompleted({
                            gameId: tableId,
                            tableId,
                            gameType: privateTable.gameType,
                            hostId: privateTable.hostId,
                            buyIn: privateTable.buyIn,
                            declaredCapacity: privateTable.declaredCapacity,
                            actualParticipants: playersForStandings.length,
                            participationThreshold: privateTable.participationThreshold,
                            tierRake: privateTable.tierRake,
                            hostUplift: privateTable.hostUplift,
                            hostRewardPercent: privateTable.hostRewardPercent,
                            setupFeeAmount: privateTable.setupFeeAmount,
                            affiliateId: privateTable.affiliateId,
                            winners
                        });

                        await mongoHelper.updateById(
                            mongoHelper.COLLECTIONS.PRIVATE_TABLES,
                            privateTable._id,
                            {
                                settlementCompleted: true,
                                settlementCompletedAt: new Date(),
                                settlementSummary: financialResult.settlement,
                                walletResults: financialResult.walletResults
                            }
                        );
                    }
                }
            }
            
            // Emit game completion
            emitSuccess(this.io.to(tableId), 'gameCompleted', {
                winners,
                reason: options.reason || 'NORMAL_COMPLETION',
                finalStandings: playersForStandings.map(p => ({
                    userId: p.userId || p.id,
                    username: p.username,
                    finalChips: p.chips,
                    position: winners.findIndex(w => w.playerId === (p.userId || p.id)) + 1 || playersForStandings.length
                }))
            }, 'Game completed!');
            
            // Clean up
            await this.cleanupCompletedGame(tableId);
            
        } catch (err) {
            console.error(`❌ handleGameCompletion error:`, err.message);
        }
    }

    /* ------------------------------------------------ */
    /* CLEANUP COMPLETED GAME                          */
    /* ------------------------------------------------ */
    async cleanupCompletedGame(tableId) {
        try {
            const tableTimerService = require('../services/table-timer.service');
            this.clearPrivateRebuyWindow(tableId);

            // Delete game state
            await gameStateManager.deleteGame(tableId);

            const tableDoc = await mongoHelper.findById(
                mongoHelper.COLLECTIONS.TABLES,
                tableId
            );

            if (tableDoc.success && tableDoc.data && tableDoc.data.privateTableId) {
                await mongoHelper.updateById(
                    mongoHelper.COLLECTIONS.PRIVATE_TABLES,
                    tableDoc.data.privateTableId,
                    {
                        status: 'COMPLETED',
                        completedAt: new Date()
                    }
                );
            }

            // Clear seated players and mark the underlying table completed
            await tableManager.clearPlayers(tableId, 'COMPLETED');
            tableTimerService.clearTableTimer(tableId);
            
            console.log(`✅ [CLEANUP] Game ${tableId} cleaned up successfully`);
        } catch (err) {
            console.error(`❌ cleanupCompletedGame error:`, err.message);
        }
    }

    /* ------------------------------------------------ */
    /* PREPARE NEXT HAND                               */
    /* ------------------------------------------------ */

    async prepareNextHand(tableId) {
        try {
            this.clearRestartTimer(tableId);
            this.clearPrivateRebuyWindow(tableId);

            // 1️⃣ Rotate dealer for next hand
            await tableManager.rotateDealer(tableId);

            // 2️⃣ Delete game state
            await gameStateManager.deleteGame(tableId);

            // 3️⃣ Load fresh table state
            const tableState =
                await tableManager.getTable(tableId);

            // 4️⃣ Remove disconnected players
            for (const p of tableState.players) {
                if (p.disconnected) {
                    await tableManager.removePlayer(
                        tableId,
                        p.userId
                    );
                }
            }

            // 5️⃣ Reload table after cleanup
            const updatedTable =
                await tableManager.getTable(tableId);

            const seatedCount =
                updatedTable.players.filter(
                    p => p.chips > 0 && !p.disconnected
                ).length;

            if (seatedCount < 2) {
                console.log(`🔄 Not enough players to restart`);
                const completed = await this.checkPrivateTableCompletion(tableId, 'INSUFFICIENT_PLAYERS_FOR_NEXT_HAND');
                if (!completed) {
                    await tableManager.setStatus(tableId, 'WAITING');
                }
                return;
            }

            console.log(`🔁 Restarting next hand...`);
            await this.startHand(tableId);
        } catch (err) {
            console.error(`❌ prepareNextHand error for ${tableId}:`, err.message);
        }
    }

    /* ------------------------------------------------ */
    /* UTILITIES                                        */
    /* ------------------------------------------------ */

    /**
     * Check if table is a private table
     */
    async isPrivateTable(tableId) {
        try {
            const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            
            if (!tableResult.success || !tableResult.data) {
                return false;
            }
            
            return tableResult.data.isPrivate && tableResult.data.privateTableId;
            
        } catch (error) {
            console.error(`❌ [ORCHESTRATOR] Error checking if private table:`, error.message);
            return false;
        }
    }

    async getPrivateTableConfig(tableId) {
        return privateTableGameConfigService.getPrivateTableGameConfig(tableId);
    }

    clearWaitingTimer(tableId) {
        const t = this.waitingTimers.get(tableId);
        if (t) {
            clearTimeout(t);
            this.waitingTimers.delete(tableId);
        }
    }

    clearRestartTimer(tableId) {
        const t = this.restartTimers.get(tableId);
        if (t) {
            clearTimeout(t);
            this.restartTimers.delete(tableId);
        }
    }

    async startTimedPrivateTableIfNeeded(tableId) {
        try {
            const tableTimerService = require('../services/table-timer.service');
            if (tableTimerService.isTimerActive(tableId)) {
                return;
            }

            const privateTableGameConfig = require('../services/private-table-game-config.service');
            const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);

            if (!privateConfig || privateConfig.gameConfig.duration.type !== 'TIMED') {
                return;
            }

            const timeLimit = privateConfig.gameConfig.duration.timeLimit;
            if (!timeLimit) {
                return;
            }

            const mongoHelper = require('../models/customdb');
            await mongoHelper.updateById(
                mongoHelper.COLLECTIONS.TABLES,
                tableId,
                { gameStartedAt: new Date() }
            );

            await tableTimerService.startTableTimer(tableId, timeLimit);
        } catch (error) {
            console.error(`❌ [ORCHESTRATOR] Failed to start timed private table ${tableId}:`, error.message);
        }
    }
}

module.exports = GameOrchestrator;
