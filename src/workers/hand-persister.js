// src/workers/hand-persister.js

const gameStateManager = require('../state/game-state');
const mongoHelper = require('../models/customdb');
const reputationService = require('../services/reputation.service');

class HandPersister {
    async persist(tableId) {
        try {
            console.log(`💾 [PERSIST] Starting hand persist for table ${tableId}`);
            
            const gameState = await gameStateManager.getGame(tableId);
            if (!gameState) {
                console.log(`⚠️ [PERSIST] No game state found for table ${tableId}`);
                return;
            }

            if (gameState.phase !== 'COMPLETED') {
                console.log(`⚠️ [PERSIST] Game not completed (phase: ${gameState.phase}) for table ${tableId}`);
                return;
            }

            const handData = {
                tableId: gameState.tableId,
                pot: gameState.pot,
                boardCards: gameState.boardCards,
                players: gameState.players.map(p => ({
                    userId: p.id,
                    finalChips: p.chips,
                    cards: p.cards,
                    status: p.status,
                })),
                endedAt: new Date(),
            };

            console.log(`💾 [PERSIST] Saving hand data to GAME_HISTORY:`, JSON.stringify(handData, null, 2));
            
            const createResult = await mongoHelper.create(
                mongoHelper.COLLECTIONS.GAME_HISTORY,
                handData,
                mongoHelper.MODELS.GAME_HISTORY
            );
            
            if (!createResult.success) {
                console.error(`❌ [PERSIST] Failed to save hand data:`, createResult.error);
                return;
            }
            
            console.log(`✅ [PERSIST] Hand data saved successfully with ID: ${createResult.id}`);
            
            // Update player chips and reputation after hand completion
            for (const player of gameState.players) {
                await mongoHelper.updateById(
                    mongoHelper.COLLECTIONS.USERS,
                    player.id,
                    { chips: player.chips }
                );
                
                // Update reputation for completing hand (1 hand played)
                if (!player.isBot) {
                    reputationService.onPlayerLeave(player.id, tableId, 1, 'HAND_COMPLETE').catch(err =>
                        console.error(`Failed to update reputation for ${player.id}:`, err.message)
                    );
                }
            }

            console.log(`✅ [PERSIST] Hand persisted successfully for table ${tableId}`);
        } catch (error) {
            console.error(`❌ [PERSIST] Error persisting hand for table ${tableId}:`, error);
        }
    }
}

module.exports = new HandPersister();