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
      console.log(
        `🎯 [ACTION HANDLER] ${playerId} attempting ${action} ${amount} at table ${tableId}`
      );

      // Get table configuration
      const tableConfig =
        await tableConfigurationService.getTableConfiguration(tableId);
      if (!tableConfig) {
        throw new Error('Table configuration not found');
      }

      console.log(
        `⚙️ [CONFIG] Table ${tableId} using ${tableConfig.configSource} with ${tableConfig.stakes.type} stakes`
      );

      // Get player
      const player = gameState.players.find(
        (p) => p.id === playerId.toString()
      );
      if (!player) {
        throw new Error('Player not found in game');
      }

      // Validate action availability
      const validation = await PokerEngine.validateAction(
        player,
        gameState,
        tableId
      );
      const availableActions =
        validation.options ||
        Object.keys(validation.actions || {}).filter(
          (key) => validation.actions[key]
        );

      if (!availableActions.includes(action)) {
        const error = `Invalid action '${action}'. Available: ${availableActions.join(
          ', '
        )} (${tableConfig.stakes.type})`;
        console.error(`❌ [VALIDATION] ${error}`);
        throw new Error(error);
      }

      // Validate bet amount
      if ((action === 'raise' || action === 'bet') && amount > 0) {
        const betValidation = await PokerEngine.validateBetAmount(
          player,
          gameState,
          amount,
          action,
          tableId
        );

        if (!betValidation.valid) {
          const error = `${betValidation.error}. Suggested: ${betValidation.suggestedAmount}`;
          console.error(`❌ [BET VALIDATION] ${error}`);
          throw new Error(error);
        }
      }

      // Apply action
      const actionResult = await this.applyActionWithStakesRules(
        gameState,
        player,
        action,
        amount,
        validation,
        tableConfig
      );

      // Emit events
      await this.emitActionEvents(
        io,
        tableId,
        playerId,
        action,
        amount,
        actionResult,
        tableConfig
      );

      console.log(
        `✅ [ACTION APPLIED] ${action} by ${playerId} on ${tableConfig.stakes.type} table`
      );

      return {
        success: true,
        actionResult,
        tableConfig,
        validation,
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
  async applyActionWithStakesRules(
    gameState,
    player,
    action,
    amount,
    validation,
    tableConfig
  ) {
    const stakesType = tableConfig.stakes.type;
    const callAmount =
      validation.callAmount || validation.actions?.call || 0;

    console.log(
      `🎲 [APPLY ACTION] ${action} with ${stakesType} rules`
    );

    switch (action) {
      case 'fold':
        player.status = 'FOLDED';
        return { action: 'fold', amount: 0 };

      case 'check':
        return { action: 'check', amount: 0 };

      case 'call': {
        const actualCallAmount = Math.min(callAmount, player.chips);
        this.applyBet(gameState, player, actualCallAmount);
        return { action: 'call', amount: actualCallAmount };
      }

      case 'bet':
      case 'raise':
        return await this.applyBetOrRaise(
          gameState,
          player,
          action,
          amount,
          validation,
          stakesType
        );

      case 'all-in': {
        const allInAmount = player.chips;
        this.applyBet(gameState, player, allInAmount);
        player.status = 'ALL_IN';
        return { action: 'all-in', amount: allInAmount };
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Apply bet or raise with stakes-specific validation
   */
  async applyBetOrRaise(
    gameState,
    player,
    action,
    amount,
    validation,
    stakesType
  ) {
    let finalAmount = amount;

    switch (stakesType) {
      case 'FIXED_LIMIT':
        finalAmount =
          validation.actions?.raise?.exact ||
          validation.actions?.bet?.exact ||
          amount;
        console.log(
          `🔒 [FIXED LIMIT] Using exact amount: ${finalAmount}`
        );
        break;

      case 'POT_LIMIT': {
        const maxPotBet =
          validation.actions?.raise?.max ||
          validation.actions?.bet?.max ||
          amount;
        finalAmount = Math.min(amount, maxPotBet);
        console.log(
          `🍯 [POT LIMIT] Capped at: ${finalAmount}`
        );
        break;
      }

      case 'CUSTOM': {
        const maxCustomBet =
          validation.actions?.raise?.max ||
          validation.actions?.bet?.max ||
          amount;
        finalAmount = Math.min(amount, maxCustomBet);
        console.log(
          `⚙️ [CUSTOM] Using custom limits: ${finalAmount}`
        );
        break;
      }

      case 'NO_LIMIT':
      default:
        console.log(
          `🚀 [NO LIMIT] Using requested amount: ${finalAmount}`
        );
        break;
    }

    // Apply bet
    this.applyBet(gameState, player, finalAmount);

    // Handle raise logic
    if (
      action === 'raise' ||
      gameState.streetBets[player.id] > gameState.currentBet
    ) {
      const raiseSize =
        gameState.streetBets[player.id] -
        gameState.currentBet;

      gameState.lastRaiseAmount = raiseSize;
      gameState.currentBet =
        gameState.streetBets[player.id];

      gameState.players.forEach((p) => {
        if (p.id !== player.id && p.status === 'ACTIVE') {
          p.hasActed = false;
        }
      });
    }

    return { action, amount: finalAmount, stakesType };
  }

  /**
   * Apply bet
   */
  applyBet(gameState, player, amount) {
    const actual = Math.min(amount, player.chips);

    player.chips -= actual;
    gameState.streetBets[player.id] =
      (gameState.streetBets[player.id] || 0) + actual;
    gameState.totalContributions[player.id] =
      (gameState.totalContributions[player.id] || 0) + actual;

    console.log(
      `💰 [BET APPLIED] Player ${player.id}: -${actual} chips`
    );
  }

  /**
   * Emit events
   */
  async emitActionEvents(
    io,
    tableId,
    playerId,
    action,
    amount,
    actionResult,
    tableConfig
  ) {
    const stakesInfo = {
      stakesType: tableConfig.stakes.type,
      explanation: tableConfig.stakes.betting,
    };

    emitSuccess(
      io.to(tableId),
      'actionTaken',
      {
        playerId,
        action,
        amount: actionResult.amount,
        stakesType: tableConfig.stakes.type,
        timestamp: new Date().toISOString(),
      },
      this.getActionMessage(
        action,
        actionResult.amount,
        tableConfig.stakes.type
      )
    );

    if (tableConfig.stakes.type !== 'NO_LIMIT') {
      emitSuccess(
        io.to(tableId),
        'stakesInfo',
        stakesInfo,
        `${tableConfig.stakes.type} rules applied`
      );
    }

    switch (action) {
      case 'fold':
        emitSuccess(
          io.to(tableId),
          'playerFolded',
          { playerId },
          'Player folded'
        );
        break;

      case 'all-in':
        emitSuccess(
          io.to(tableId),
          'playerAllIn',
          { playerId, amount: actionResult.amount },
          'Player all-in'
        );
        break;

      case 'raise':
        if (tableConfig.stakes.type === 'FIXED_LIMIT') {
          emitSuccess(
            io.to(tableId),
            'fixedLimitRaise',
            { playerId, amount: actionResult.amount },
            'Fixed limit raise'
          );
        }
        break;
    }
  }

  /**
   * Message formatter
   */
  getActionMessage(action, amount, stakesType) {
    const formatAmount = (amt) => {
      if (amt === 0) return '0';
      if (amt < 1) return parseFloat(amt.toFixed(2)).toString();
      return amt % 1 === 0
        ? amt.toString()
        : parseFloat(amt.toFixed(2)).toString();
    };

    const stakesContext =
      stakesType !== 'NO_LIMIT' ? ` (${stakesType})` : '';

    switch (action) {
      case 'check':
        return `Player checked${stakesContext}.`;
      case 'fold':
        return `Player folded${stakesContext}.`;
      case 'call':
        return amount === 0
          ? `Player checked${stakesContext}.`
          : `Player called ${formatAmount(amount)} chips${stakesContext}.`;
      case 'raise':
        return `Player raised to ${formatAmount(amount)} chips${stakesContext}.`;
      case 'bet':
        return `Player bet ${formatAmount(amount)} chips${stakesContext}.`;
      case 'all-in':
        return `Player went all-in with ${formatAmount(amount)} chips${stakesContext}.`;
      default:
        return `Player performed ${action}${stakesContext}.`;
    }
  }

  /**
   * UI helper
   */
  async getAvailableActionsForUI(tableId, playerId, gameState) {
    try {
      const tableConfig =
        await tableConfigurationService.getTableConfiguration(tableId);
      if (!tableConfig) {
        throw new Error('Table configuration not found');
      }

      const player = gameState.players.find(
        (p) => p.id === playerId.toString()
      );
      if (!player) {
        throw new Error('Player not found');
      }

      const validation = await PokerEngine.validateAction(
        player,
        gameState,
        tableId
      );

      const availableActions =
        validation.options ||
        Object.keys(validation.actions || {}).filter(
          (key) => validation.actions[key]
        );

      return {
        availableActions,
        stakesType: tableConfig.stakes.type,
        bettingRules:
          tableConfigurationService.getBettingRulesExplanation(
            tableConfig.stakes.type
          ),
        actionsExplanation:
          tableConfigurationService.getActionsExplanation(
            availableActions,
            tableConfig.stakes.type
          ),
        limits: validation.limits || null,
        validation,
      };
    } catch (error) {
      console.error(
        'Error getting available actions for UI:',
        error
      );
      return null;
    }
  }
}

module.exports = new GameActionHandlerService();