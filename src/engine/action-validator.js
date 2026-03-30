// src/engine/action-validator.js

const privateTableActionValidator = require('../services/private-table-action-validator.service');
const privateTableGameConfig = require('../services/private-table-game-config.service');

class ActionValidator {
  static async getAvailableActions(player, gameState, tableId = null) {
    // Check if this is a private table with custom configuration
    if (tableId) {
      const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
      if (privateConfig) {
        console.log(`🎯 [PRIVATE TABLE] Using custom stakes: ${privateConfig.gameConfig.stakes.type}`);
        return privateTableActionValidator.getAvailableActions(
          privateConfig.gameConfig,
          player,
          gameState
        );
      }
    }
    
    // Fallback to standard poker rules for normal tables
    return this.getStandardAvailableActions(player, gameState);
  }
  
  static getStandardAvailableActions(player, gameState) {
    const {
      currentBet,
      bigBlind,
      lastRaiseAmount,
      streetBets
    } = gameState;

    const playerBet = streetBets[player.id] || 0;
    const callAmount = Math.max(0, currentBet - playerBet);

    const options = new Set();
    options.add('fold');

    // Cannot act if ALL_IN
    if (player.status === 'ALL_IN' || player.chips <= 0) {
      return {
        options: ['fold'],
        callAmount: 0,
        minRaise: 0,
        maxRaise: 0,
        stakesType: 'NO_LIMIT',
        explanation: 'Standard no-limit poker rules'
      };
    }

    // If no bet to match
    if (callAmount === 0) {
      options.add('check');

      if (player.chips >= bigBlind) {
        options.add('raise');
      }
    }
    else {
      if (player.chips <= callAmount) {
        options.add('all-in');
      }
      else {
        options.add('call');

        // Minimum raise = lastRaiseAmount
        const minRaiseAmount = lastRaiseAmount || bigBlind;

        if (player.chips >= callAmount + minRaiseAmount) {
          options.add('raise');
        }
      }
    }

    const minRaiseTotal = callAmount + (lastRaiseAmount || bigBlind);
    
    console.log('🎯 Standard table | Actions: ', Array.from(options));
    
    return {
      actions: {
        fold: true,
        check: options.has('check'),
        call: options.has('call') ? callAmount : null,
        bet: options.has('raise') && callAmount === 0 ? { min: bigBlind, max: player.chips } : null,
        raise: options.has('raise') && callAmount > 0 ? { min: minRaiseTotal, max: player.chips } : null,
        allIn: options.has('all-in') ? player.chips : null
      },
      options: Array.from(options),
      callAmount,
      minRaise: minRaiseTotal,
      maxRaise: player.chips,
      stakesType: 'NO_LIMIT',
      explanation: 'Standard no-limit poker rules'
    };
  }
  
  /**
   * Validate if a specific bet amount is allowed
   */
  static async validateBetAmount(player, gameState, betAmount, action, tableId = null) {
    // Check if this is a private table with custom configuration
    if (tableId) {
      const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
      if (privateConfig) {
        return privateTableActionValidator.validateBetAmount(
          privateConfig.gameConfig,
          player,
          betAmount,
          gameState
        );
      }
    }
    
    // Standard validation for normal tables
    return this.validateStandardBetAmount(player, gameState, betAmount, action);
  }
  
  static validateStandardBetAmount(player, gameState, betAmount, action) {
    const { currentBet, bigBlind, lastRaiseAmount, streetBets } = gameState;
    const playerBet = streetBets[player.id] || 0;
    const callAmount = Math.max(0, currentBet - playerBet);
    
    if (action === 'raise' || action === 'bet') {
      const minRaise = callAmount + (lastRaiseAmount || bigBlind);
      
      if (betAmount < minRaise) {
        return {
          valid: false,
          error: `Minimum ${action} is ${minRaise}`,
          suggestedAmount: minRaise
        };
      }
      
      if (betAmount > player.chips) {
        return {
          valid: false,
          error: `Cannot ${action} more than your chips (${player.chips})`,
          suggestedAmount: player.chips
        };
      }
    }
    
    return { valid: true };
  }
}

module.exports = ActionValidator;