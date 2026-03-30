// src/services/private-table-action-validator.service.js

class PrivateTableActionValidator {
  
  /**
   * Get available actions for player based on private table stakes configuration
   */
  getAvailableActions(gameConfig, player, gameState) {
    const currentBet = gameState.currentBet || 0;
    const playerBet = gameState.streetBets?.[player.id] || 0;
    const callAmount = currentBet - playerBet;
    const pot = gameState.pot || 0;
    const playerChips = player.chips || 0;
    
    const actions = {
      fold: true, // Always available
      check: callAmount === 0,
      call: callAmount > 0 && playerChips >= callAmount ? callAmount : null,
      bet: null,
      raise: null,
      allIn: playerChips > 0 ? playerChips : null
    };
    
    // Get betting limits based on stakes type
    const bettingLimits = this.getBettingLimits(gameConfig, gameState, player);
    
    if (currentBet === 0) {
      // No current bet - player can bet
      actions.bet = bettingLimits.bet;
    } else {
      // Current bet exists - player can raise
      actions.raise = bettingLimits.raise;
    }
    
    return {
      actions,
      stakesType: gameConfig.stakes.type,
      limits: bettingLimits,
      explanation: this.getStakesExplanation(gameConfig.stakes.type)
    };
  }
  
  /**
   * Get betting limits based on stakes type
   */
  getBettingLimits(gameConfig, gameState, player) {
    const stakes = gameConfig.stakes;
    const currentBet = gameState.currentBet || 0;
    const pot = gameState.pot || 0;
    const playerChips = player.chips || 0;
    const bigBlind = gameConfig.blinds.big;
    
    switch (stakes.type) {
      case 'FIXED_LIMIT':
        return this.getFixedLimitLimits(stakes, currentBet, gameState);
        
      case 'POT_LIMIT':
        return this.getPotLimitLimits(bigBlind, currentBet, pot, playerChips);
        
      case 'NO_LIMIT':
        return this.getNoLimitLimits(bigBlind, currentBet, playerChips);
        
      case 'CUSTOM':
        return this.getCustomLimits(stakes, currentBet, playerChips);
        
      default:
        return this.getNoLimitLimits(bigBlind, currentBet, playerChips);
    }
  }
  
  /**
   * Fixed Limit betting rules
   */
  getFixedLimitLimits(stakes, currentBet, gameState) {
    const betSize = stakes.betSize;
    const maxRaises = stakes.maxRaises || 4;
    const currentRaises = gameState.raisesThisRound || 0;
    
    // In fixed limit, you can only bet/raise by exactly the bet size
    const canRaise = currentRaises < maxRaises;
    
    return {
      bet: currentBet === 0 ? { min: betSize, max: betSize, exact: betSize } : null,
      raise: currentBet > 0 && canRaise ? { 
        min: currentBet + betSize, 
        max: currentBet + betSize, 
        exact: currentBet + betSize 
      } : null,
      explanation: `Fixed limit: All bets/raises must be exactly ${betSize}. ${maxRaises - currentRaises} raises remaining.`
    };
  }
  
  /**
   * Pot Limit betting rules
   */
  getPotLimitLimits(bigBlind, currentBet, pot, playerChips) {
    const minBet = bigBlind;
    const maxBet = pot; // Can't bet more than pot
    const maxRaise = pot + currentBet; // Can raise up to pot + current bet
    
    return {
      bet: currentBet === 0 ? { 
        min: minBet, 
        max: Math.min(maxBet, playerChips) 
      } : null,
      raise: currentBet > 0 ? { 
        min: currentBet + minBet, 
        max: Math.min(maxRaise, playerChips) 
      } : null,
      explanation: `Pot limit: Maximum bet/raise is limited to pot size (${pot})`
    };
  }
  
  /**
   * No Limit betting rules
   */
  getNoLimitLimits(bigBlind, currentBet, playerChips) {
    const minBet = bigBlind;
    
    return {
      bet: currentBet === 0 ? { 
        min: minBet, 
        max: playerChips 
      } : null,
      raise: currentBet > 0 ? { 
        min: currentBet + minBet, 
        max: playerChips 
      } : null,
      explanation: `No limit: You can bet/raise any amount up to your chip stack (${playerChips})`
    };
  }
  
  /**
   * Custom betting rules
   */
  getCustomLimits(stakes, currentBet, playerChips) {
    const customRules = stakes.customRules;
    const minBet = customRules.minBet;
    const maxBet = customRules.maxBet;
    const maxRaises = customRules.maxRaises || 6;
    
    return {
      bet: currentBet === 0 ? { 
        min: minBet, 
        max: Math.min(maxBet, playerChips) 
      } : null,
      raise: currentBet > 0 ? { 
        min: currentBet + minBet, 
        max: Math.min(maxBet, playerChips) 
      } : null,
      explanation: `Custom rules: Min bet ${minBet}, Max bet ${maxBet}, Max ${maxRaises} raises`
    };
  }
  
  /**
   * Validate if a specific bet amount is allowed
   */
  validateBetAmount(gameConfig, player, betAmount, gameState) {
    const limits = this.getBettingLimits(gameConfig, gameState, player);
    const currentBet = gameState.currentBet || 0;
    const isRaise = currentBet > 0;
    const relevantLimit = isRaise ? limits.raise : limits.bet;
    
    if (!relevantLimit) {
      return { valid: false, error: 'Betting not allowed in current situation' };
    }
    
    // Check if it's an exact amount requirement (Fixed Limit)
    if (relevantLimit.exact !== undefined) {
      if (betAmount !== relevantLimit.exact) {
        return { 
          valid: false, 
          error: `${gameConfig.stakes.type} requires exactly ${relevantLimit.exact}`,
          suggestedAmount: relevantLimit.exact
        };
      }
    } else {
      // Check min/max range
      if (betAmount < relevantLimit.min) {
        return { 
          valid: false, 
          error: `Minimum ${isRaise ? 'raise' : 'bet'} is ${relevantLimit.min}`,
          suggestedAmount: relevantLimit.min
        };
      }
      
      if (betAmount > relevantLimit.max) {
        return { 
          valid: false, 
          error: `Maximum ${isRaise ? 'raise' : 'bet'} is ${relevantLimit.max}`,
          suggestedAmount: relevantLimit.max
        };
      }
    }
    
    return { valid: true };
  }
  
  /**
   * Get explanation of stakes type for UI
   */
  getStakesExplanation(stakesType) {
    switch (stakesType) {
      case 'FIXED_LIMIT':
        return 'Fixed Limit: All bets and raises are a fixed amount. Limited number of raises per round.';
      case 'POT_LIMIT':
        return 'Pot Limit: You cannot bet or raise more than the current pot size.';
      case 'NO_LIMIT':
        return 'No Limit: You can bet or raise any amount up to your entire chip stack.';
      case 'CUSTOM':
        return 'Custom Rules: Special betting limits set by the table host.';
      default:
        return 'Standard poker betting rules apply.';
    }
  }
}

module.exports = new PrivateTableActionValidator();