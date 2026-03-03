// src/game/game-orchestrator.service.js

const StartGameService = require('./start-game-service.js');
const gameStateManager = require('../state/game-state');
const handPersister = require('../workers/hand-persister');
const tableManager = require('../table/table-manager.service');
class GameOrchestrator {
    constructor(io, timerManager) {
        this.io = io;
        this.timerManager = timerManager;
        this.startGameService = new StartGameService(io, timerManager);

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

            this.io.to(tableId).emit('waitingCountdown', { seconds: 30 });

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

            await this.startGameService.start(tableId);
        } catch (err) {
            console.error(`❌ startHand error for ${tableId}:`, err.message);
        }
    }

    /* ------------------------------------------------ */
    /* HAND COMPLETED                                  */
    /* ------------------------------------------------ */

    async onHandCompleted(tableId) {
        try {
            await tableManager.setStatus(tableId, 'SHOWDOWN_DELAY');
            console.log(`🏁 Hand completed at table ${tableId}`);
            this.io.to(tableId).emit('showdownDelay', { seconds: 10 });
            this.io.to(tableId).emit('newRoundStarting', { seconds: 10 });

            // Increment handsPlayed for all connected players
            const sockets = await this.io.in(tableId).fetchSockets();
            sockets.forEach(socket => {
                if (socket.handsPlayed !== undefined) {
                    socket.handsPlayed++;
                    console.log(`🎴 Player ${socket.user?._id} hands: ${socket.handsPlayed}`);
                }
            });

            const timeout = setTimeout(async () => {
                await this.prepareNextHand(tableId);
            }, 10000);

            await tableManager.setStatus(tableId, 'WAITING');
            this.restartTimers.set(tableId, timeout);
        } catch (err) {
            console.error(`❌ onHandCompleted error for ${tableId}:`, err.message);
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
            const tableState = await tableManager.getTable(tableId);

            // 5️⃣ Update cooldowns for all players
            const mongoHelper = require('../models/customdb');
            const cooldownService = require('../services/cooldown.service');
            const participantIds = tableState.players
                .filter(p => p.userId && !p.userId.startsWith('bot'))
                .map(p => p.userId);
            
            if (participantIds.length > 0) {
                try {
                    const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
                    if (tableDoc.success && tableDoc.data && tableDoc.data.subTierId) {
                        const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, tableDoc.data.subTierId);
                        if (subTierResult.success && subTierResult.data && subTierResult.data.tierId) {
                            await cooldownService.updateCooldownsOnSeat(tableId, subTierResult.data.tierId, participantIds);
                            console.log(`📊 Updated cooldowns for ${participantIds.length} players`);
                        }
                    }
                } catch (cooldownError) {
                    console.error(`❌ Error updating cooldowns:`, cooldownError.message);
                }
            }

            // 6️⃣ Handle rebuy logic for players with insufficient chips
            const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
            if (tableDoc.success && tableDoc.data && tableDoc.data.subTierId) {
                const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, tableDoc.data.subTierId);
                if (subTierResult.success && subTierResult.data) {
                    const bb = subTierResult.data.tableConfig.bb;
                    const minChipsRequired = bb * 2.5;
                    const maxBuyIn = bb * 100;

                    for (const player of tableState.players) {
                        if (player.chips < minChipsRequired) {
                            if (player.isBot) {
                                // Replenish bot chips
                                player.chips = maxBuyIn;
                                console.log(`🤖 Bot ${player.username} replenished with ${maxBuyIn} chips`);
                            } else {
                                // Check if player has autoRenew enabled
                                const userDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, player.userId);
                                if (userDoc.success && userDoc.data && userDoc.data.autoRenew) {
                                    // Auto-rebuy for human player
                                    player.chips = maxBuyIn;
                                    console.log(`💰 Auto-rebuy for ${player.username}: ${maxBuyIn} chips`);
                                } else {
                                    // Mark for manual rebuy
                                    console.log(`⚠️ ${player.username} needs manual rebuy (${player.chips} < ${minChipsRequired})`);
                                }
                            }
                        }
                    }

                    await tableManager.saveTable(tableId, tableState);
                }
            }

            // 7️⃣ Remove disconnected players
            for (const p of tableState.players) {
                if (p.disconnected) {
                    await tableManager.removePlayer(tableId, p.userId);
                }
            }

            // 8️⃣ Reload table after cleanup
            const updatedTable = await tableManager.getTable(tableId);

            const seatedCount = updatedTable.players.filter(
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