// src/game/private-table-game-orchestrator.js

const StartGameService = require('./start-game-service');
const PrivateTableStartGameService = require('./private-table-start-game.service');
const TurnTimerManager = require('./turn-timer.manager');
const PrivateTableTurnTimerManager = require('./private-table-turn-timer.manager');
const privateTableGameConfig = require('../services/private-table-game-config.service');
const mongoHelper = require('../models/customdb');

class PrivateTableGameOrchestrator {
  constructor(io) {
    this.io = io;
    
    // Initialize both timer managers
    this.regularTimerManager = new TurnTimerManager(io, this);
    this.privateTimerManager = new PrivateTableTurnTimerManager(io, this);
    
    // Initialize both start game services
    this.regularStartService = new StartGameService(io, this.regularTimerManager);
    this.privateStartService = new PrivateTableStartGameService(io, this.privateTimerManager);
  }

  setActionService(actionService) {
    // Only set action service for regular timer manager since we're using it for all tables
    this.regularTimerManager.setActionService(actionService);
  }

  /**
   * Detect if table is a private table and route to appropriate service
   */
  async startGame(tableId) {
    try {
      console.log(`🎮 [ORCHESTRATOR] Starting game for table ${tableId}`);
      
      // Check if this is a private table
      const isPrivateTable = await this.isPrivateTable(tableId);
      
      if (isPrivateTable) {
        console.log(`🔒 [ORCHESTRATOR] Detected private table, using regular SNG flow`);
        // Use regular SNG flow for private tables to ensure proper game mechanics
        return await this.regularStartService.start(tableId);
      } else {
        console.log(`🎲 [ORCHESTRATOR] Regular table, using standard game service`);
        return await this.regularStartService.start(tableId);
      }
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error starting game for table ${tableId}:`, error.message);
      throw error;
    }
  }

  /**
   * Start timer with appropriate manager
   */
  async startTimer(tableId, playerId, seconds) {
    try {
      const isPrivateTable = await this.isPrivateTable(tableId);
      
      if (isPrivateTable) {
        console.log(`⏱️ [ORCHESTRATOR] Using regular timer for private table ${tableId}`);
        // Use regular timer for private tables to ensure proper action handling
        return await this.regularTimerManager.startTimer(tableId, playerId, seconds);
      } else {
        console.log(`⏱️ [ORCHESTRATOR] Using regular timer for ${tableId}`);
        return await this.regularTimerManager.startTimer(tableId, playerId, seconds);
      }
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error starting timer for table ${tableId}:`, error.message);
      throw error;
    }
  }

  /**
   * Clear timer with appropriate manager
   */
  async clearTimer(tableId) {
    try {
      // Always use regular timer manager for consistency
      this.regularTimerManager.clearTimer(tableId);
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error clearing timer for table ${tableId}:`, error.message);
    }
  }

  /**
   * Use time bank (private tables only)
   */
  async useTimeBank(tableId, playerId) {
    try {
      const isPrivateTable = await this.isPrivateTable(tableId);
      
      if (isPrivateTable) {
        return await this.privateTimerManager.useTimeBank(tableId, playerId);
      } else {
        console.log(`⚠️ [ORCHESTRATOR] Time bank not available for regular tables`);
        return false;
      }
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error using time bank for table ${tableId}:`, error.message);
      return false;
    }
  }

  /**
   * Get available actions for player
   */
  async getAvailableActions(tableId, playerId, gameState) {
    try {
      const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
      
      if (privateConfig) {
        const player = gameState.players.find(p => p.id === playerId);
        if (!player) {
          throw new Error('Player not found in game state');
        }
        
        return privateTableGameConfig.getAvailableActions(
          privateConfig.gameConfig,
          player,
          gameState
        );
      } else {
        // Fall back to regular poker engine
        const PokerEngine = require('../engine/poker-engine');
        const player = gameState.players.find(p => p.id === playerId);
        return PokerEngine.validateAction(player, gameState);
      }
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error getting available actions:`, error.message);
      throw error;
    }
  }

  /**
   * Validate bet amount based on table type
   */
  async validateBetAmount(tableId, playerId, betAmount, gameState) {
    try {
      const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
      
      if (privateConfig) {
        const player = gameState.players.find(p => p.id === playerId);
        if (!player) {
          throw new Error('Player not found in game state');
        }
        
        return privateTableGameConfig.validateBetAmount(
          privateConfig.gameConfig,
          player,
          betAmount,
          gameState.currentBet || 0,
          gameState.pot || 0
        );
      } else {
        // Regular table validation (implement as needed)
        return { valid: true };
      }
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error validating bet amount:`, error.message);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Check if player can rebuy
   */
  async canPlayerRebuy(tableId, playerId, gamePhase = 'preflop') {
    try {
      const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
      
      if (privateConfig) {
        // Get player info from database
        const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.PLAYERS, playerId);
        if (!playerResult.success) {
          return { allowed: false, reason: 'Player not found' };
        }
        
        return privateTableGameConfig.canPlayerRebuy(
          privateConfig.gameConfig,
          playerResult.data,
          gamePhase
        );
      } else {
        // Regular table rebuy logic (implement as needed)
        return { allowed: false, reason: 'Rebuy not available for regular tables' };
      }
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error checking rebuy eligibility:`, error.message);
      return { allowed: false, reason: error.message };
    }
  }

  /**
   * Get table configuration summary
   */
  async getTableConfig(tableId) {
    try {
      const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
      
      if (privateConfig) {
        return {
          type: 'PRIVATE_TABLE',
          gameType: privateConfig.gameType,
          stakes: privateConfig.gameConfig.stakes,
          timer: privateConfig.gameConfig.timer,
          features: privateConfig.gameConfig.features,
          buyIn: privateConfig.gameConfig.buyIn,
          players: privateConfig.gameConfig.players
        };
      } else {
        // Get regular table config
        const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
        if (!tableResult.success) {
          return null;
        }
        
        return {
          type: 'REGULAR_TABLE',
          maxPlayers: tableResult.data.maxPlayers,
          subTierId: tableResult.data.subTierId
        };
      }
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error getting table config:`, error.message);
      return null;
    }
  }

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

  /**
   * Get game statistics for monitoring
   */
  async getGameStats(tableId) {
    try {
      const config = await this.getTableConfig(tableId);
      const isPrivate = await this.isPrivateTable(tableId);
      
      return {
        tableId,
        isPrivate,
        config,
        timestamp: new Date()
      };
      
    } catch (error) {
      console.error(`❌ [ORCHESTRATOR] Error getting game stats:`, error.message);
      return null;
    }
  }
}

module.exports = PrivateTableGameOrchestrator;