// src/game/game-orchestrator.service.js

const StartGameService = require('./start-game-service.js');
const PrivateTableGameOrchestrator = require('./private-table-game-orchestrator.js');
const gameStateManager = require('../state/game-state');
const handPersister = require('../workers/hand-persister');
const tableManager = require('../table/table-manager.service');
const financialIntegrationService = require('../services/financial-integration.service');
const { emitSuccess } = require('../websocket/socket-emitter.js');

class GameOrchestrator {
    constructor(io, timerManager) {
        this.io = io;
        this.timerManager = timerManager;
        this.startGameService = new StartGameService(io, timerManager);
        
        // 🆕 Initialize private table orchestrator
        this.privateTableOrchestrator = new PrivateTableGameOrchestrator(io);

        this.waitingTimers = new Map();   // tableId -> timeout
        this.restartTimers = new Map();   // tableId -> timeout
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
            if (seatedCount < 2) return;

            const gameState = await gameStateManager.getGame(tableId);

            if (gameState) {
                console.log(`🔄 Player joined mid-game at table ${tableId} - will join next hand`);
                return;
            }

            if (this.waitingTimers.has(tableId)) return;

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

            // 🆕 Check if this is the final hand (SNG completion)
            const shouldComplete = await this.checkGameCompletion(tableId);
            
            if (shouldComplete) {
                await this.handleGameCompletion(tableId);
                return;
            }

            const timeout = setTimeout(async () => {
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
            const tableState = await tableManager.getTable(tableId);
            const playersWithChips = tableState.players.filter(p => p.chips > 0 && !p.disconnected);
            
            // SNG is complete when only 1 player has chips
            return playersWithChips.length <= 1;
        } catch (err) {
            console.error(`❌ checkGameCompletion error:`, err.message);
            return false;
        }
    }

    /* ------------------------------------------------ */
    /* HANDLE GAME COMPLETION (FINANCIAL SETTLEMENT)  */
    /* ------------------------------------------------ */
    async handleGameCompletion(tableId) {
        try {
            console.log(`🏆 [GAME COMPLETE] Processing completion for table ${tableId}`);
            
            const tableState = await tableManager.getTable(tableId);
            const mongoHelper = require('../models/customdb');
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            
            // Determine winners
            const winners = tableState.players
                .filter(p => p.chips > 0)
                .sort((a, b) => b.chips - a.chips)
                .map((player, index) => ({
                    playerId: player.userId,
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
                    
                    await financialIntegrationService.onGameCompleted({
                        gameId: tableId,
                        tableId,
                        gameType: privateTable.gameType,
                        hostId: privateTable.hostId,
                        buyIn: privateTable.buyIn,
                        declaredCapacity: privateTable.declaredCapacity,
                        actualParticipants: tableState.players.length,
                        participationThreshold: privateTable.participationThreshold,
                        tierRake: privateTable.tierRake,
                        hostUplift: privateTable.hostUplift,
                        hostRewardPercent: privateTable.hostRewardPercent,
                        setupFeeAmount: privateTable.setupFeeAmount,
                        affiliateId: privateTable.affiliateId,
                        winners
                    });
                }
            }
            
            // Emit game completion
            emitSuccess(this.io.to(tableId), 'gameCompleted', {
                winners,
                finalStandings: tableState.players.map(p => ({
                    userId: p.userId,
                    username: p.username,
                    finalChips: p.chips,
                    position: winners.findIndex(w => w.playerId === p.userId) + 1 || tableState.players.length
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
            // Persist final hand
            await handPersister.persist(tableId);
            
            // Delete game state
            await gameStateManager.deleteGame(tableId);
            
            // Set table status
            await tableManager.setStatus(tableId, 'COMPLETED');
            
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

            // 1️⃣ Persist hand first
            await handPersister.persist(tableId);

            // 2️⃣ Rotate dealer for next hand
            await tableManager.rotateDealer(tableId);

            // 3️⃣ Delete game state
            await gameStateManager.deleteGame(tableId);

            // 4️⃣ Load fresh table state
            const tableState =
                await tableManager.getTable(tableId);

            // 5️⃣ Remove disconnected players
            for (const p of tableState.players) {
                if (p.disconnected) {
                    await tableManager.removePlayer(
                        tableId,
                        p.userId
                    );
                }
            }

            // 6️⃣ Reload table after cleanup
            const updatedTable =
                await tableManager.getTable(tableId);

            const seatedCount =
                updatedTable.players.filter(
                    p => p.chips > 0 && !p.disconnected
                ).length;

            if (seatedCount < 2) {
                console.log(`🔄 Not enough players to restart`);
                await tableManager.setStatus(tableId, 'WAITING');
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
            const mongoHelper = require('../models/customdb');
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
}

module.exports = GameOrchestrator;