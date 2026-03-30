// src/services/table-configuration.service.js

const mongoHelper = require('../models/customdb');
const privateTableGameConfig = require('./private-table-game-config.service');

class TableConfigurationService {
  
  /**
   * Get complete table configuration for any table (normal or private)
   */
  async getTableConfiguration(tableId) {
    try {
      // Get table data
      const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
      if (!tableResult.success || !tableResult.data) {
        return null;
      }
      
      const table = tableResult.data;
      
      // Check if this is a private table
      if (table.isPrivate && table.privateTableId) {
        return await this.getPrivateTableConfiguration(table, tableId);
      }
      
      // Return standard table configuration
      return await this.getStandardTableConfiguration(table, tableId);
      
    } catch (error) {
      console.error('Error getting table configuration:', error);
      return null;
    }
  }
  
  /**
   * Get private table configuration
   */
  async getPrivateTableConfiguration(table, tableId) {
    const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
    
    if (!privateConfig) {
      console.warn(`⚠️ Private table ${tableId} has no private config, using defaults`);
      return this.getStandardTableConfiguration(table, tableId);
    }
    
    return {
      tableId,
      isPrivate: true,
      privateTableId: table.privateTableId,
      gameType: privateConfig.gameType,
      
      // Stakes configuration
      stakes: {
        type: privateConfig.config.stakes?.type || 'NO_LIMIT',
        blinds: {
          small: privateConfig.config.stakes?.blinds?.small || 5,
          big: privateConfig.config.stakes?.blinds?.big || 10
        },
        betting: privateConfig.gameConfig.stakes.betting,
        ...privateConfig.gameConfig.stakes
      },
      
      // Timer configuration
      timer: {
        turnTimer: privateConfig.config.turnTimer || 30,
        timeBank: privateConfig.gameConfig.timer.timeBank,
        warningTime: privateConfig.gameConfig.timer.warningTime
      },
      
      // Game features
      features: {
        rebuyAllowed: privateConfig.gameConfig.buyIn.allowRebuy,
        antesEnabled: privateConfig.gameConfig.features.antesEnabled,
        straddlesEnabled: privateConfig.gameConfig.features.straddlesEnabled,
        reentryRules: privateConfig.gameConfig.buyIn.reentryRules
      },
      
      // Duration settings
      duration: {
        type: privateConfig.gameConfig.duration.type,
        estimatedHours: privateConfig.gameConfig.duration.estimatedHours,
        maxDuration: privateConfig.gameConfig.duration.maxDuration
      },
      
      // Access control
      access: privateConfig.gameConfig.access,
      
      // Complete game config for engine
      gameConfig: privateConfig.gameConfig,
      
      // Metadata
      configSource: 'PRIVATE_TABLE',
      lastUpdated: new Date()
    };
  }
  
  /**
   * Get standard table configuration
   */
  async getStandardTableConfiguration(table, tableId) {
    // Get SubTier for standard configuration
    let subTier = null;
    if (table.subTierId) {
      const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, table.subTierId);
      if (subTierResult.success) {
        subTier = subTierResult.data;
      }
    }
    
    const bb = subTier?.tableConfig?.bb || 10;
    const sb = subTier?.tableConfig?.sb || 5;
    
    return {
      tableId,
      isPrivate: false,
      gameType: 'STANDARD_SNG',
      
      // Standard stakes (always no-limit)
      stakes: {
        type: 'NO_LIMIT',
        blinds: { small: sb, big: bb },
        betting: 'unlimited'
      },
      
      // Standard timer
      timer: {
        turnTimer: 30,
        timeBank: 120,
        warningTime: 7
      },
      
      // Standard features
      features: {
        rebuyAllowed: false,
        antesEnabled: false,
        straddlesEnabled: false,
        reentryRules: 'NEVER_ALLOWED'
      },
      
      // Standard duration
      duration: {
        type: 'INFINITY',
        estimatedHours: 2,
        maxDuration: null
      },
      
      // Standard access
      access: {
        type: 'OPEN',
        password: null,
        allowSpectators: true
      },
      
      // Game config for engine
      gameConfig: {
        blinds: { small: sb, big: bb },
        stakes: { type: 'NO_LIMIT', betting: 'unlimited' },
        timer: { turnTimer: 30, timeBank: 120, warningTime: 7 },
        features: { antesEnabled: false, straddlesEnabled: false },
        buyIn: { allowRebuy: false, reentryRules: 'NEVER_ALLOWED' },
        duration: { type: 'INFINITY' },
        access: { type: 'OPEN' }
      },
      
      // Metadata
      configSource: 'STANDARD_TABLE',
      subTier: subTier,
      lastUpdated: new Date()
    };
  }
  
  /**
   * Validate table configuration
   */
  validateTableConfiguration(config) {
    const errors = [];
    
    if (!config) {
      errors.push('Configuration is required');
      return { valid: false, errors };
    }
    
    // Validate stakes
    if (!config.stakes || !config.stakes.type) {
      errors.push('Stakes configuration is required');
    } else {
      const validStakesTypes = ['FIXED_LIMIT', 'POT_LIMIT', 'NO_LIMIT', 'CUSTOM'];
      if (!validStakesTypes.includes(config.stakes.type)) {
        errors.push(`Invalid stakes type: ${config.stakes.type}`);
      }
      
      if (!config.stakes.blinds || !config.stakes.blinds.small || !config.stakes.blinds.big) {
        errors.push('Blinds configuration is required');
      }
    }
    
    // Validate timer
    if (!config.timer || !config.timer.turnTimer) {
      errors.push('Timer configuration is required');
    } else if (config.timer.turnTimer < 5 || config.timer.turnTimer > 300) {
      errors.push('Turn timer must be between 5 and 300 seconds');
    }
    
    // Validate features for private tables
    if (config.isPrivate) {
      if (config.features.antesEnabled && config.gameType === 'PRIVATE_SNG') {
        errors.push('Antes are not allowed in SNGs, only tournaments');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Get betting rules explanation for UI
   */
  getBettingRulesExplanation(stakesType) {
    switch (stakesType) {
      case 'FIXED_LIMIT':
        return {
          title: 'Fixed Limit',
          description: 'All bets and raises are a fixed amount. Limited number of raises per round.',
          rules: [
            'All bets must be exactly the fixed amount',
            'Maximum 4 raises per betting round',
            'No all-in unless you have less than the bet amount'
          ]
        };
        
      case 'POT_LIMIT':
        return {
          title: 'Pot Limit',
          description: 'You cannot bet or raise more than the current pot size.',
          rules: [
            'Maximum bet/raise is the size of the pot',
            'Minimum bet is the big blind',
            'All-in allowed if less than pot limit'
          ]
        };
        
      case 'NO_LIMIT':
        return {
          title: 'No Limit',
          description: 'You can bet or raise any amount up to your entire chip stack.',
          rules: [
            'Minimum bet is the big blind',
            'Maximum bet is your entire chip stack',
            'All-in allowed at any time'
          ]
        };
        
      case 'CUSTOM':
        return {
          title: 'Custom Rules',
          description: 'Special betting limits set by the table host.',
          rules: [
            'Custom minimum and maximum bet amounts',
            'Custom raise limits per round',
            'Rules defined by table configuration'
          ]
        };
        
      default:
        return {
          title: 'Standard Rules',
          description: 'Standard poker betting rules apply.',
          rules: ['Follow standard poker betting conventions']
        };
    }
  }
  
  /**
   * Get available actions explanation for UI
   */
  getActionsExplanation(availableActions, stakesType) {
    const explanations = {
      fold: 'Give up your hand and forfeit any chips already bet',
      check: 'Pass the action without betting (only when no bet to call)',
      call: 'Match the current bet amount',
      bet: `Place the first bet in this round (min: big blind${stakesType === 'FIXED_LIMIT' ? ', exact amount only' : ''})`,
      raise: `Increase the current bet${stakesType === 'FIXED_LIMIT' ? ' by exactly the fixed amount' : stakesType === 'POT_LIMIT' ? ' up to pot size' : ' by any amount'}`,
      allIn: 'Bet all your remaining chips'
    };
    
    return availableActions.reduce((acc, action) => {
      acc[action] = explanations[action] || `Perform ${action}`;
      return acc;
    }, {});
  }
  
  /**
   * Cache configuration for performance
   */
  async cacheTableConfiguration(tableId, config) {
    // TODO: Implement Redis caching for table configurations
    console.log(`📦 [CACHE] Caching config for table ${tableId}`);
  }
  
  /**
   * Clear configuration cache
   */
  async clearTableConfigurationCache(tableId) {
    // TODO: Implement Redis cache clearing
    console.log(`🗑️ [CACHE] Clearing config cache for table ${tableId}`);
  }
}

module.exports = new TableConfigurationService();