// src/services/game-action-handler.service.js

const PokerEngine = require('../engine/poker-engine');
const tableConfigurationService = require('./table-configuration.service');
const { emitSuccess, emitError } = require('../websocket/socket-emitter');

class GameActionHandlerService {
  
  /**
   * Handle player action with full configuration support
   */
  async handlePlayerAction(io, tableId, playerId, action, amount = 0, gameState) {
    try {
      console.log(`🎯 [ACTION HANDLER] ${playerId} attempting ${action} ${amount} at table ${tableId}`);
      
      // Get table configuration
      const tableConfig = await tableConfigurationService.getTableConfiguration(tableId);
      if (!tableConfig) {
        throw new Error('Table configuration not found');
      }
      
      console.log(`⚙️ [CONFIG] Table ${tableId} using ${tableConfig.configSource} with ${tableConfig.stakes.type} stakes`);
      
      // Get player
      const player = gameState.players.find(p => p.id === playerId.toString());
      if (!player) {
        throw new Error('Player not found in game');
      }
      
      // Validate action availability
      const validation = await PokerEngine.validateAction(player, gameState, tableId);
      const availableActions = validation.options || Object.keys(validation.actions || {}).filter(key => validation.actions[key]);
      
      if (!availableActions.includes(action)) {
        const error = `Invalid action '${action}'. Available: ${availableActions.join(', ')} (${tableConfig.stakes.type})`;
        console.error(`❌ [VALIDATION] ${error}`);
        throw new Error(error);
      }
      
      // Validate bet amount for betting actions
      if ((action === 'raise' || action === 'bet') && amount > 0) {
        const betValidation = await PokerEngine.validateBetAmount(player, gameState, amount, action, tableId);
        if (!betValidation.valid) {
          const error = `${betValidation.error}. Suggested: ${betValidation.suggestedAmount}`;
          console.error(`❌ [BET VALIDATION] ${error}`);
          throw new Error(error);
        }
      }
      
      // Apply action based on stakes type
      const actionResult = await this.applyActionWithStakesRules(
        gameState, 
        player, 
        action, 
        amount, 
        validation, 
        tableConfig
      );
      
      // Emit action events
      await this.emitActionEvents(io, tableId, playerId, action, amount, actionResult, tableConfig);
      
      console.log(`✅ [ACTION APPLIED] ${action} by ${playerId} on ${tableConfig.stakes.type} table`);
      
      return {
        success: true,
        actionResult,
        tableConfig,
        validation
      };
      
    } catch (error) {
      console.error(`❌ [ACTION ERROR] ${error.message}`);
      emitError(io.to(tableId), 'actionError', error.message);
      throw error;
    }
  }
  
  /**
   * Apply action with stakes-specific rules
   */
  async applyActionWithStakesRules(gameState, player, action, amount, validation, tableConfig) {
    const stakesType = tableConfig.stakes.type;
    const callAmount = validation.callAmount || validation.actions?.call || 0;
    
    console.log(`🎲 [APPLY ACTION] ${action} with ${stakesType} rules`);
    
    switch (action) {
      case 'fold':
        player.status = 'FOLDED';
        return { action: 'fold', amount: 0 };
        
      case 'check':
        return { action: 'check', amount: 0 };
        
      case 'call':
        const actualCallAmount = Math.min(callAmount, player.chips);
        this.applyBet(gameState, player, actualCallAmount);
        return { action: 'call', amount: actualCallAmount };
        
      case 'bet':
      case 'raise':
        return await this.applyBetOrRaise(gameState, player, action, amount, validation, stakesType);
        
      case 'all-in':
        const allInAmount = player.chips;
        this.applyBet(gameState, player, allInAmount);
        player.status = 'ALL_IN';
        return { action: 'all-in', amount: allInAmount };
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
  
  /**
   * Apply bet or raise with stakes-specific validation
   */
  async applyBetOrRaise(gameState, player, action, amount, validation, stakesType) {\n    let finalAmount = amount;\n    \n    switch (stakesType) {\n      case 'FIXED_LIMIT':\n        // Fixed limit: use exact amount from validation\n        finalAmount = validation.actions?.raise?.exact || validation.actions?.bet?.exact || amount;\n        console.log(`🔒 [FIXED LIMIT] Using exact amount: ${finalAmount}`);\n        break;\n        \n      case 'POT_LIMIT':\n        // Pot limit: ensure amount doesn't exceed pot limit\n        const maxPotBet = validation.actions?.raise?.max || validation.actions?.bet?.max || amount;\n        finalAmount = Math.min(amount, maxPotBet);\n        console.log(`🍯 [POT LIMIT] Capped at: ${finalAmount}`);\n        break;\n        \n      case 'CUSTOM':\n        // Custom: ensure amount is within custom limits\n        const maxCustomBet = validation.actions?.raise?.max || validation.actions?.bet?.max || amount;\n        finalAmount = Math.min(amount, maxCustomBet);\n        console.log(`⚙️ [CUSTOM] Using custom limits: ${finalAmount}`);\n        break;\n        \n      case 'NO_LIMIT':\n      default:\n        // No limit: use amount as-is (already validated)\n        console.log(`🚀 [NO LIMIT] Using requested amount: ${finalAmount}`);\n        break;\n    }\n    \n    // Apply the bet\n    this.applyBet(gameState, player, finalAmount);\n    \n    // Handle raise logic\n    if (action === 'raise' || gameState.streetBets[player.id] > gameState.currentBet) {\n      const raiseSize = gameState.streetBets[player.id] - gameState.currentBet;\n      gameState.lastRaiseAmount = raiseSize;\n      gameState.currentBet = gameState.streetBets[player.id];\n      \n      // Reset other players' hasActed status\n      gameState.players.forEach(p => {\n        if (p.id !== player.id && p.status === 'ACTIVE') {\n          p.hasActed = false;\n        }\n      });\n    }\n    \n    return { action, amount: finalAmount, stakesType };\n  }\n  \n  /**\n   * Apply bet to game state\n   */\n  applyBet(gameState, player, amount) {\n    const actual = Math.min(amount, player.chips);\n    \n    player.chips -= actual;\n    gameState.streetBets[player.id] = (gameState.streetBets[player.id] || 0) + actual;\n    gameState.totalContributions[player.id] = (gameState.totalContributions[player.id] || 0) + actual;\n    \n    console.log(`💰 [BET APPLIED] Player ${player.id}: -${actual} chips, total bet: ${gameState.streetBets[player.id]}`);\n  }\n  \n  /**\n   * Emit action-related events\n   */\n  async emitActionEvents(io, tableId, playerId, action, amount, actionResult, tableConfig) {\n    const stakesInfo = {\n      stakesType: tableConfig.stakes.type,\n      explanation: tableConfig.stakes.betting\n    };\n    \n    // Emit action taken event\n    emitSuccess(io.to(tableId), 'actionTaken', {\n      playerId,\n      action,\n      amount: actionResult.amount,\n      stakesType: tableConfig.stakes.type,\n      timestamp: new Date().toISOString()\n    }, this.getActionMessage(action, actionResult.amount, tableConfig.stakes.type));\n    \n    // Emit stakes-specific events\n    if (tableConfig.stakes.type !== 'NO_LIMIT') {\n      emitSuccess(io.to(tableId), 'stakesInfo', stakesInfo, `${tableConfig.stakes.type} rules applied`);\n    }\n    \n    // Emit specific action events\n    switch (action) {\n      case 'fold':\n        emitSuccess(io.to(tableId), 'playerFolded', { playerId }, 'Player folded');\n        break;\n      case 'all-in':\n        emitSuccess(io.to(tableId), 'playerAllIn', { playerId, amount: actionResult.amount }, 'Player all-in');\n        break;\n      case 'raise':\n        if (tableConfig.stakes.type === 'FIXED_LIMIT') {\n          emitSuccess(io.to(tableId), 'fixedLimitRaise', { playerId, amount: actionResult.amount }, 'Fixed limit raise');\n        }\n        break;\n    }\n  }\n  \n  /**\n   * Get action message with stakes context\n   */\n  getActionMessage(action, amount, stakesType) {\n    const formatAmount = (amt) => {\n      if (amt === 0) return '0';\n      if (amt < 1) {\n        return parseFloat(amt.toFixed(2)).toString();\n      }\n      return amt % 1 === 0 ? amt.toString() : parseFloat(amt.toFixed(2)).toString();\n    };\n    \n    const stakesContext = stakesType !== 'NO_LIMIT' ? ` (${stakesType})` : '';\n    \n    switch (action) {\n      case 'check':\n        return `Player checked${stakesContext}.`;\n      case 'fold':\n        return `Player folded${stakesContext}.`;\n      case 'call':\n        return amount === 0 ? `Player checked${stakesContext}.` : `Player called ${formatAmount(amount)} chips${stakesContext}.`;\n      case 'raise':\n        return `Player raised to ${formatAmount(amount)} chips${stakesContext}.`;\n      case 'bet':\n        return `Player bet ${formatAmount(amount)} chips${stakesContext}.`;\n      case 'all-in':\n        return `Player went all-in with ${formatAmount(amount)} chips${stakesContext}.`;\n      default:\n        return `Player performed ${action}${stakesContext}.`;\n    }\n  }\n  \n  /**\n   * Get available actions with stakes-specific UI data\n   */\n  async getAvailableActionsForUI(tableId, playerId, gameState) {\n    try {\n      const tableConfig = await tableConfigurationService.getTableConfiguration(tableId);\n      if (!tableConfig) {\n        throw new Error('Table configuration not found');\n      }\n      \n      const player = gameState.players.find(p => p.id === playerId.toString());\n      if (!player) {\n        throw new Error('Player not found');\n      }\n      \n      const validation = await PokerEngine.validateAction(player, gameState, tableId);\n      const availableActions = validation.options || Object.keys(validation.actions || {}).filter(key => validation.actions[key]);\n      \n      return {\n        availableActions,\n        stakesType: tableConfig.stakes.type,\n        bettingRules: tableConfigurationService.getBettingRulesExplanation(tableConfig.stakes.type),\n        actionsExplanation: tableConfigurationService.getActionsExplanation(availableActions, tableConfig.stakes.type),\n        limits: validation.limits || null,\n        validation\n      };\n      \n    } catch (error) {\n      console.error('Error getting available actions for UI:', error);\n      return null;\n    }\n  }\n}\n\nmodule.exports = new GameActionHandlerService();