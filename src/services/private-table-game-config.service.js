// src/services/private-table-game-config.service.js

const mongoHelper = require('../models/customdb');

class PrivateTableGameConfigService {
  
  /**
   * Get game configuration for a private table
   */
  async getPrivateTableGameConfig(tableId) {
    try {
      // Get table with private table reference
      const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
      if (!tableResult.success || !tableResult.data) {
        return null;
      }
      
      const table = tableResult.data;
      
      // Check if this is a private table
      if (!table.isPrivate || !table.privateTableId) {
        return null;
      }
      
      // Get private table configuration
      const privateTableResult = await mongoHelper.findById(
        mongoHelper.COLLECTIONS.PRIVATE_TABLES, 
        table.privateTableId
      );
      
      if (!privateTableResult.success || !privateTableResult.data) {
        return null;
      }
      
      const privateTable = privateTableResult.data;
      const privateConfig = privateTable.privateConfig;
      
      if (!privateConfig) {
        return null;
      }
      
      return {
        tableId,
        privateTableId: table.privateTableId,
        gameType: privateTable.gameType,
        config: privateConfig,
        // Derived configurations for game engine
        gameConfig: this.buildGameConfig(privateConfig, privateTable)
      };
      
    } catch (error) {
      console.error('Error getting private table game config:', error);
      return null;
    }
  }
  
  /**
   * Build game configuration from private table config
   */
  buildGameConfig(privateConfig, privateTable) {
    const gameConfig = {
      // Blinds configuration
      blinds: {
        small: privateConfig.stakes?.blinds?.small || 5,
        big: privateConfig.stakes?.blinds?.big || 10,
        type: privateConfig.stakes?.type || 'NO_LIMIT'
      },
      
      // Timer configuration
      timer: {
        turnTimer: privateConfig.turnTimer || 30,
        timeBank: this.calculateTimeBank(privateConfig.turnTimer),
        warningTime: Math.max(5, Math.floor(privateConfig.turnTimer * 0.25))
      },
      
      // Player limits
      players: {
        min: privateConfig.playerCapacity?.min || 2,
        max: privateConfig.playerCapacity?.max || 9
      },
      
      // Buy-in rules
      buyIn: {
        min: privateConfig.buyInSettings?.min || 100,
        max: privateConfig.buyInSettings?.max || 1000,
        allowRebuy: privateConfig.rebuy || false,
        reentryRules: privateConfig.buyInReentryRules || 'ALLOWED_ON_REBUY_ONLY'
      },
      
      // Game features
      features: {
        antesEnabled: privateConfig.antesStraddles || false,
        straddlesEnabled: privateConfig.antesStraddles || false,
        autoMuck: true, // Default for private tables
        showdown: true
      },
      
      // Table duration
      duration: {
        type: privateConfig.tableDuration || 'INFINITY',
        estimatedHours: privateTable.estimatedHours || null,
        timeLimit: privateConfig.timeLimit || null
      },
      
      // Stakes configuration
      stakes: this.buildStakesConfig(privateConfig.stakes)
    };
    
    return gameConfig;
  }
  
  /**
   * Build stakes configuration
   */
  buildStakesConfig(stakesConfig) {
    if (!stakesConfig) {
      return { type: 'NO_LIMIT', betting: 'unlimited' };
    }
    
    const config = {
      type: stakesConfig.type,
      smallBlind: stakesConfig.blinds?.small || 5,
      bigBlind: stakesConfig.blinds?.big || 10
    };
    
    switch (stakesConfig.type) {
      case 'FIXED_LIMIT':
        config.betting = 'fixed';
        config.betSize = config.bigBlind;
        config.maxRaises = 4; // Standard fixed limit
        break;
        
      case 'POT_LIMIT':
        config.betting = 'pot_limit';
        config.maxBet = 'pot_size';
        break;
        
      case 'NO_LIMIT':
        config.betting = 'unlimited';
        break;
        
      case 'CUSTOM':
        config.betting = 'custom';
        config.customRules = {
          minBet: config.bigBlind,
          maxBet: config.bigBlind * 10, // Example custom limit
          maxRaises: 6
        };
        break;
        
      default:
        config.betting = 'unlimited';
    }
    
    return config;
  }
  
  /**
   * Calculate time bank based on turn timer
   */
  calculateTimeBank(turnTimer) {
    // Give players extra time bank based on turn timer
    if (turnTimer <= 15) return 60; // 1 minute
    if (turnTimer <= 30) return 120; // 2 minutes
    if (turnTimer <= 60) return 180; // 3 minutes
    return 300; // 5 minutes for longer timers
  }
  
  /**
   * Apply antes if enabled
   */
  calculateAntes(gameConfig, players) {
    if (!gameConfig.features.antesEnabled) {
      return { antes: {}, totalAntes: 0 };
    }
    
    const anteAmount = Math.max(1, Math.floor(gameConfig.blinds.big * 0.1)); // 10% of big blind
    const antes = {};
    let totalAntes = 0;
    
    players.forEach(player => {
      if (player.status === 'ACTIVE' && player.chips > 0) {
        const ante = Math.min(anteAmount, player.chips);
        antes[player.id] = ante;
        totalAntes += ante;
      }
    });
    
    return { antes, totalAntes, anteAmount };
  }
  
  /**
   * Check if rebuy is allowed
   */
  canPlayerRebuy(gameConfig, player, gamePhase = 'preflop') {
    if (!gameConfig.buyIn.allowRebuy) {
      return { allowed: false, reason: 'Rebuy not enabled for this table' };
    }
    
    // Check re-entry rules
    switch (gameConfig.buyIn.reentryRules) {
      case 'NEVER_ALLOWED':
        return { allowed: false, reason: 'Re-entry not allowed' };
        
      case 'ALLOWED_ON_REBUY_ONLY':
        if (player.chips > 0) {
          return { allowed: false, reason: 'Can only rebuy when eliminated' };
        }
        break;
        
      case 'ALWAYS_ALLOWED':
        // Always allowed
        break;
        
      default:
        return { allowed: false, reason: 'Invalid re-entry rule' };
    }
    
    // Check buy-in limits
    const currentChips = player.chips || 0;
    const maxAllowed = gameConfig.buyIn.max - currentChips;
    
    if (maxAllowed <= 0) {
      return { allowed: false, reason: 'Already at maximum buy-in' };
    }
    
    return { 
      allowed: true, 
      minAmount: gameConfig.buyIn.min,
      maxAmount: maxAllowed,
      currentChips
    };
  }
  
  /**
   * Validate bet amount based on stakes type
   */
  validateBetAmount(gameConfig, player, betAmount, currentBet, pot) {
    const stakes = gameConfig.stakes;
    const playerChips = player.chips;
    
    switch (stakes.type) {
      case 'FIXED_LIMIT':
        return this.validateFixedLimitBet(stakes, betAmount, currentBet);
        
      case 'POT_LIMIT':
        return this.validatePotLimitBet(stakes, betAmount, currentBet, pot, playerChips);
        
      case 'NO_LIMIT':
        return this.validateNoLimitBet(stakes, betAmount, currentBet, playerChips);
        
      case 'CUSTOM':
        return this.validateCustomBet(stakes, betAmount, currentBet, playerChips);
        
      default:
        return { valid: false, error: 'Invalid stakes type' };
    }
  }
  
  validateFixedLimitBet(stakes, betAmount, currentBet) {
    const validBet = stakes.betSize;
    
    if (betAmount !== validBet && betAmount !== currentBet + validBet) {
      return { 
        valid: false, 
        error: `Fixed limit: bet must be ${validBet}`,
        suggestedAmount: validBet
      };
    }
    
    return { valid: true };
  }
  
  validatePotLimitBet(stakes, betAmount, currentBet, pot, playerChips) {
    const maxBet = pot + currentBet;
    const minBet = stakes.bigBlind;
    
    if (betAmount < minBet) {
      return { 
        valid: false, 
        error: `Minimum bet is ${minBet}`,
        suggestedAmount: minBet
      };
    }
    
    if (betAmount > maxBet && betAmount < playerChips) {
      return { 
        valid: false, 
        error: `Maximum bet is ${maxBet} (pot limit)`,
        suggestedAmount: maxBet
      };
    }
    
    return { valid: true };
  }
  
  validateNoLimitBet(stakes, betAmount, currentBet, playerChips) {
    const minBet = stakes.bigBlind;
    
    if (betAmount < minBet && betAmount < playerChips) {
      return { 
        valid: false, 
        error: `Minimum bet is ${minBet}`,
        suggestedAmount: minBet
      };
    }
    
    return { valid: true };
  }
  
  validateCustomBet(stakes, betAmount, currentBet, playerChips) {
    const { minBet, maxBet } = stakes.customRules;
    
    if (betAmount < minBet) {
      return { 
        valid: false, 
        error: `Minimum bet is ${minBet}`,
        suggestedAmount: minBet
      };
    }
    
    if (betAmount > maxBet && betAmount < playerChips) {
      return { 
        valid: false, 
        error: `Maximum bet is ${maxBet}`,
        suggestedAmount: maxBet
      };
    }
    
    return { valid: true };
  }
  
  /**
   * Get available actions for player based on private table rules
   */
  getAvailableActions(gameConfig, player, gameState) {
    const baseActions = ['fold'];
    const currentBet = gameState.currentBet || 0;
    const playerBet = gameState.streetBets[player.id] || 0;
    const callAmount = currentBet - playerBet;
    
    // Check if player can check
    if (callAmount === 0) {
      baseActions.push('check');
    } else if (player.chips >= callAmount) {
      baseActions.push('call');
    }
    
    // Check if player can bet/raise based on stakes
    const canBetRaise = this.canPlayerBetRaise(gameConfig, player, gameState);
    if (canBetRaise.allowed) {
      baseActions.push('raise');
    }
    
    // All-in is always available if player has chips
    if (player.chips > 0) {
      baseActions.push('all-in');
    }
    
    return {
      actions: baseActions,
      callAmount,
      minBet: canBetRaise.minAmount,
      maxBet: canBetRaise.maxAmount,
      stakes: gameConfig.stakes.type
    };
  }
  
  canPlayerBetRaise(gameConfig, player, gameState) {
    const stakes = gameConfig.stakes;
    const currentBet = gameState.currentBet || 0;
    const pot = gameState.pot || 0;
    
    switch (stakes.type) {
      case 'FIXED_LIMIT':
        return {
          allowed: true,
          minAmount: stakes.betSize,
          maxAmount: stakes.betSize
        };
        
      case 'POT_LIMIT':
        const potLimitMax = pot + currentBet;
        return {
          allowed: player.chips >= stakes.bigBlind,
          minAmount: stakes.bigBlind,
          maxAmount: Math.min(potLimitMax, player.chips)
        };
        
      case 'NO_LIMIT':
        return {
          allowed: player.chips >= stakes.bigBlind,
          minAmount: stakes.bigBlind,
          maxAmount: player.chips
        };
        
      case 'CUSTOM':
        return {
          allowed: player.chips >= stakes.customRules.minBet,
          minAmount: stakes.customRules.minBet,
          maxAmount: Math.min(stakes.customRules.maxBet, player.chips)
        };
        
      default:
        return { allowed: false };
    }
  }
}

module.exports = new PrivateTableGameConfigService();
