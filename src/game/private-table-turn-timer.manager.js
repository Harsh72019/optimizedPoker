// src/game/private-table-turn-timer.manager.js

const gameStateManager = require('../state/game-state');
const tableManager = require('../table/table-manager.service');
const { emitSuccess } = require('../websocket/socket-emitter.js');
const awayManagerService = require('./away-manager.service.js');
const BotManager = require('./bot/bot.manager.js');
const privateTableGameConfig = require('../services/private-table-game-config.service');

class PrivateTableTurnTimerManager {
  constructor(io, orchestrator) {
    this.io = io;
    this.orchestrator = orchestrator;
    this.timers = new Map();
    this.actionService = null;
    this.botManager = new BotManager(io, this, orchestrator);
    this.awayManager = awayManagerService;
  }

  setActionService(actionService) {
    this.actionService = actionService;
  }

  async startTimer(tableId, playerId, defaultSeconds = 20) {
    this.clearTimer(tableId);

    try {
      const gameState = await gameStateManager.getGame(tableId);
      if (!gameState) return;

      if (gameState.phase === 'SHOWDOWN' || gameState.phase === 'COMPLETED') {
        console.log(`Skipping private timer for ${tableId} because hand is in ${gameState.phase}`);
        return;
      }

      const player = gameState.players.find(p => p.id === playerId);
      if (!player) return;

      if (player.status !== 'ACTIVE') {
        console.log(`Skipping private timer for ${playerId} because status is ${player.status}`);
        return;
      }

      // Get private table configuration for timer settings
      const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
      
      // Use private table timer or default
      let timerSeconds = defaultSeconds;
      let timeBank = 60; // Default time bank
      let warningTime = 5; // Default warning time
      
      if (privateConfig) {
        timerSeconds = privateConfig.gameConfig.timer.turnTimer;
        timeBank = privateConfig.gameConfig.timer.timeBank;
        warningTime = privateConfig.gameConfig.timer.warningTime;
        
        console.log(`⏱️ [PRIVATE TIMER] Using private table timer: ${timerSeconds}s (bank: ${timeBank}s)`);
      }

      if (player.disconnected) {
        console.log(`🔄 Player ${playerId} is disconnected - auto folding`);
        await this.actionService.handle(tableId, playerId, 'fold');
        return;
      }

      // Get available actions based on private table rules
      let validation;
      if (privateConfig) {
        validation = privateTableGameConfig.getAvailableActions(
          privateConfig.gameConfig, 
          player, 
          gameState
        );
        console.log(`🎯 [PRIVATE ACTIONS] Player ${playerId} | Stakes: ${validation.stakes} | Actions: ${validation.actions.join(', ')}`);
      } else {
        // Fall back to regular poker engine
        const PokerEngine = require('../engine/poker-engine');
        validation = PokerEngine.validateAction(player, gameState);
        console.log(`🎯 Player ${playerId} turn | Actions: ${validation.options.join(', ')}`);
      }

      const tableState = await tableManager.getTable(tableId);
      const tablePlayer = tableState.players.find(p => p.userId === playerId);

      // Format player turn data with private table context
      const PlayerActionService = require('./player-action.service');
      const actionService = new PlayerActionService(this.io, this, this.orchestrator);
      const playerTurnData = this.formatPrivateTablePlayerTurnData(
        gameState, 
        playerId, 
        tableState, 
        validation,
        privateConfig
      );

      // Emit current player turn
      emitSuccess(this.io.to(tableId), 'currentPlayerTurn', { playerId }, 'Current turn');
      
      if (tablePlayer?.socketId) {
        console.log(`🎯 Private table player turn data:`, JSON.stringify(playerTurnData, null, 2));
        emitSuccess(
          this.io.to(tablePlayer.socketId), 
          'playerTurn', 
          playerTurnData, 
          `${playerTurnData.username}, it's your turn to act.`
        );
      }

      /* ------------------------------------ */
      /* 🤖 BOT LOGIC                         */
      /* ------------------------------------ */

      if (tablePlayer?.isBot) {
        console.log(`🤖 Bot turn: ${playerId}`);
        await new Promise(r => setTimeout(r, 5000));
        await this.botManager.handleBotTurn(tableId, player, gameState);
        return; // NO TIMER
      }

      /* ------------------------------------ */
      /* 💤 AWAY LOGIC                        */
      /* ------------------------------------ */

      if (player.isAway) {
        console.log(`💤 Away auto-action: ${playerId}`);
        await new Promise(r => setTimeout(r, 5000));
        const autoAction = await this.awayManager.handleAwayTurn(tableId, player, gameState);

        if (autoAction) {
          await this.actionService.handle(tableId, playerId, autoAction.type, autoAction.amount);
        }

        return; // NO TIMER
      }

      /* ------------------------------------ */
      /* ⏳ PRIVATE TABLE TIMER               */
      /* ------------------------------------ */

      // Start warning timer
      const warningTimeoutId = setTimeout(() => {
        emitSuccess(
          this.io.to(tableId),
          'turnTimerWarning',
          { 
            playerId, 
            remainingTime: warningTime,
            timeBank: timeBank 
          },
          'Turn timer warning'
        );
      }, (timerSeconds - warningTime) * 1000);

      // Start main timer
      const timeoutId = setTimeout(async () => {
        console.log(`⏰ Private table timer expired for ${playerId}`);
        clearTimeout(warningTimeoutId);

        try {
          await this.handlePrivateTableTimeout(tableId, playerId, privateConfig);
        } catch (err) {
          console.error('Private table timer auto-action error:', err.message);
        }
      }, timerSeconds * 1000);

      this.timers.set(tableId, { 
        timeoutId, 
        warningTimeoutId, 
        startTime: Date.now(),
        duration: timerSeconds * 1000,
        timeBank: timeBank * 1000
      });

      // Notify clients with private table timer info
      emitSuccess(
        this.io.to(tableId),
        'privateTableTurnTimerStarted',
        { 
          playerId, 
          seconds: timerSeconds,
          timeBank: timeBank,
          warningTime: warningTime,
          stakes: privateConfig?.gameConfig?.stakes?.type || 'NO_LIMIT'
        },
        'Private table turn timer started'
      );

    } catch (err) {
      console.error(`❌ Private table startTimer error for ${playerId}:`, err.message);
    }
  }

  clearTimer(tableId) {
    const existing = this.timers.get(tableId);
    if (existing) {
      clearTimeout(existing.timeoutId);
      if (existing.warningTimeoutId) {
        clearTimeout(existing.warningTimeoutId);
      }
      this.timers.delete(tableId);
    }
  }

  async handlePrivateTableTimeout(tableId, playerId, privateConfig) {
    if (!this.actionService) {
      console.error(`❌ No actionService available for private table timeout`);
      return;
    }

    const gameState = await gameStateManager.getGame(tableId);
    if (!gameState) {
      console.log(`⚠️ No game state found for ${tableId}`);
      return;
    }

    if (gameState.phase === 'SHOWDOWN' || gameState.phase === 'COMPLETED') {
      console.log(`Skipping private timeout for ${tableId} because hand is in ${gameState.phase}`);
      return;
    }

    if (gameState.currentPlayerId !== playerId) {
      console.log(`⚠️ Not current player's turn. Current: ${gameState.currentPlayerId}, Timeout: ${playerId}`);
      return;
    }

    const player = gameState.players.find(p => p.id === playerId);
    if (!player) {
      console.log(`⚠️ Player ${playerId} not found in game`);
      return;
    }

    if (player.status !== 'ACTIVE') {
      console.log(`Skipping private timeout for ${playerId} because status is ${player.status}`);
      return;
    }

    // Get available actions based on private table rules
    let autoAction = 'fold';
    
    if (privateConfig) {
      const validation = privateTableGameConfig.getAvailableActions(
        privateConfig.gameConfig, 
        player, 
        gameState
      );
      
      if (validation.actions.includes('check')) {
        autoAction = 'check';
      }
      
      console.log(`⏰ Private table auto-action for ${playerId}: ${autoAction} (stakes: ${privateConfig.gameConfig.stakes.type})`);
    } else {
      // Fall back to regular logic
      const PokerEngine = require('../engine/poker-engine');
      const validation = PokerEngine.validateAction(player, gameState);
      
      if (validation.options.includes('check')) {
        autoAction = 'check';
      }
      
      console.log(`⏰ Auto-action for ${playerId}: ${autoAction}`);
    }

    emitSuccess(this.io.to(tableId), 'playerTimeout', { playerId }, 'Player timeout');
    emitSuccess(this.io.to(tableId), 'playerAutoAction', { 
      playerId, 
      action: autoAction,
      reason: 'timeout'
    }, `Auto ${autoAction}`);

    await this.actionService.handle(tableId, playerId, autoAction);
  }

  formatPrivateTablePlayerTurnData(gameState, playerId, tableState, validation, privateConfig) {
    const player = gameState.players.find(p => p.id === playerId);
    const tablePlayer = tableState.players.find(p => p.userId === playerId);
    
    const baseData = {
      playerId,
      username: tablePlayer?.username || 'Unknown',
      chips: player?.chips || 0,
      seatPosition: player?.seatPosition,
      currentBet: gameState.currentBet || 0,
      pot: gameState.pot || 0,
      phase: gameState.phase || 'preflop',
      boardCards: gameState.boardCards || []
    };

    if (privateConfig) {
      // Use private table validation
      return {
        ...baseData,
        availableActions: validation.actions,
        callAmount: validation.callAmount,
        minBet: validation.minBet,
        maxBet: validation.maxBet,
        stakes: validation.stakes,
        privateTableInfo: {
          gameType: privateConfig.gameType,
          stakesType: privateConfig.gameConfig.stakes.type,
          features: privateConfig.gameConfig.features,
          rebuyAllowed: privateConfig.gameConfig.buyIn.allowRebuy
        }
      };
    } else {
      // Fall back to regular format
      return {
        ...baseData,
        availableActions: validation.options || [],
        callAmount: validation.callAmount,
        minRaiseAmount: validation.minRaiseAmount,
        maxRaiseAmount: validation.maxRaiseAmount
      };
    }
  }

  // Time bank functionality for private tables
  async useTimeBank(tableId, playerId) {
    const timerInfo = this.timers.get(tableId);
    if (!timerInfo) return false;

    const privateConfig = await privateTableGameConfig.getPrivateTableGameConfig(tableId);
    if (!privateConfig) return false;

    const timeBank = privateConfig.gameConfig.timer.timeBank * 1000;
    const elapsed = Date.now() - timerInfo.startTime;
    
    if (elapsed >= timerInfo.duration && timeBank > 0) {
      console.log(`⏰ [TIME BANK] Player ${playerId} using time bank: ${timeBank/1000}s`);
      
      // Clear existing timer
      clearTimeout(timerInfo.timeoutId);
      
      // Start time bank timer
      const timeBankTimeout = setTimeout(async () => {
        await this.handlePrivateTableTimeout(tableId, playerId, privateConfig);
      }, timeBank);
      
      this.timers.set(tableId, {
        ...timerInfo,
        timeoutId: timeBankTimeout,
        usingTimeBank: true
      });

      emitSuccess(
        this.io.to(tableId),
        'timeBankActivated',
        { 
          playerId, 
          timeBankSeconds: timeBank / 1000 
        },
        'Time bank activated'
      );

      return true;
    }

    return false;
  }
}

module.exports = PrivateTableTurnTimerManager;