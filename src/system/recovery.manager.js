// src/system/recovery.manager.js

const redisClient = require('../state/redis-client').getClient();
const tableManager = require('../table/table-manager.service');
const gameStateManager = require('../state/game-state');

class RecoveryManager {
  constructor(io, orchestrator) {
    this.io = io;
    this.orchestrator = orchestrator;
  }

  async recover() {
    console.log('🔄 Starting crash recovery...');

    const activeTables =
      await redisClient.smembers('tables:active');

    for (const tableId of activeTables) {
      const tableState =
        await tableManager.getTable(tableId);

      const gameState =
        await gameStateManager.getGame(tableId);

      if (!tableState || tableState.players.length === 0) {
        await redisClient.srem('tables:active', tableId);
        continue;
      }

      if (!gameState) {
        // Table had no active hand → reset status
        await tableManager.setStatus(tableId, 'IDLE');
        continue;
      }

      console.log(`♻ Recovering table ${tableId}`);

      // Restart correct lifecycle behavior
      await this.recoverHand(tableId, tableState, gameState);
    }

    console.log('✅ Recovery complete');
  }

  async recoverHand(tableId, tableState, gameState) {
    if (gameState.phase === 'COMPLETED') {
      // Hand finished but restart timer lost
      await this.orchestrator.onHandCompleted(tableId);
      return;
    }

    if (tableState.players.length < 2) {
      await tableManager.setStatus(tableId, 'IDLE');
      return;
    }

    // Resume timer for current turn
    this.orchestrator.timerManager.startTimer(
      tableId,
      gameState.currentTurn
    );

    await tableManager.setStatus(tableId, 'IN_PROGRESS');

    console.log(`▶ Resumed game at table ${tableId}`);
  }
}

module.exports = RecoveryManager;