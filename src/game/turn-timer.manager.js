// src/game/turn-timer.manager.js

const gameStateManager = require('../state/game-state');
const tableManager = require('../table/table-manager.service');
const { emitSuccess } = require('../websocket/socket-emitter.js');
const awayManagerService = require('./away-manager.service.js');
const BotManager = require('./bot/bot.manager.js');
class TurnTimerManager {
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

  async startTimer(tableId, playerId, seconds = 300) {
    this.clearTimer(tableId);

    try {
      const gameState = await gameStateManager.getGame(tableId);

      if (!gameState) return;

      const player = gameState.players.find(p => p.id === playerId);

      if (!player) return;

      if (player.disconnected) {
        console.log(`🔄 Player ${playerId} is disconnected - auto folding`);
        await this.actionService.handle(tableId, playerId, 'fold');
        return;
      }

      const PokerEngine = require('../engine/poker-engine');
      const validation = PokerEngine.validateAction(player, gameState);
      console.log(`🎯 Player ${playerId} turn | Actions: ${validation.options.join(', ')}`);

      const tableState = await tableManager.getTable(tableId);

      const tablePlayer = tableState.players.find(p => p.userId === playerId);

      const PlayerActionService = require('./player-action.service');
      const actionService = new PlayerActionService(this.io, this, this.orchestrator);
      const playerTurnData = actionService.formatPlayerTurnData(gameState, playerId, tableState);
      // Emit playerTurn to specific player

      if (tablePlayer?.socketId) {
        this.io.to(tableId).except(tablePlayer.socketId).emit('currentPlayerTurn', {
          status: true,
          data: { playerId },
          message: 'Current turn'
        });
      }
      if (tablePlayer?.socketId) {
        console.log(`🎯 Player turn data:`, JSON.stringify(playerTurnData, null, 2));
        emitSuccess(this.io.to(tablePlayer.socketId), 'playerTurn', playerTurnData, `${playerTurnData.username}, it's your turn to act.`);
      }
      // Emit currentPlayerTurn to all OTHER players (excluding current player)
      

      /* ------------------------------------ */
      /* 🤖 BOT LOGIC                         */
      /* ------------------------------------ */

      if (tablePlayer?.isBot) {
        console.log(`🤖 Bot turn: ${playerId}`);
        await new Promise(r => setTimeout(r, 5000));
        await this.botManager.handleBotTurn(
          tableId,
          player,
          gameState
        );

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
      /* ⏳ NORMAL PLAYER TIMER               */
      /* ------------------------------------ */

      const timeoutId = setTimeout(async () => {
        console.log(`⏰ Timer expired for ${playerId}`);

        try {
          await this.handleTimeout(tableId, playerId);
        } catch (err) {
          console.error('Timer auto-action error:', err.message);
        }
      }, seconds * 1000);

      this.timers.set(tableId, timeoutId);

      // Notify clients
      emitSuccess(
        this.io.to(tableId),
        'turnTimerStarted',
        { playerId, seconds },
        'Turn timer started'
      );
    } catch (err) {
      console.error(`❌ startTimer error for ${playerId}:`, err.message);
    }
  }

  clearTimer(tableId) {
    const existing = this.timers.get(tableId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(tableId);
    }
  }

  async handleTimeout(tableId, playerId) {
    if (!this.actionService) {
      console.error(`❌ No actionService available for timeout`);
      return;
    }

    const gameState = await require('../state/game-state').getGame(tableId);

    if (!gameState) {
      console.log(`⚠️ No game state found for ${tableId}`);
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

    const PokerEngine = require('../engine/poker-engine');
    const validation = PokerEngine.validateAction(player, gameState);

    let autoAction = 'fold';

    if (validation.options.includes('check')) {
      autoAction = 'check';
    }

    console.log(`⏰ Auto-action for ${playerId}: ${autoAction}`);

    emitSuccess(this.io.to(tableId), 'playerTimeout', { playerId }, 'Player timeout');
    emitSuccess(this.io.to(tableId), 'playerAutoFolded', { playerId }, 'Auto folded');

    await this.actionService.handle(tableId, playerId, autoAction);
  }
}

module.exports = TurnTimerManager;