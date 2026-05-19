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

  isLiveSocket(socketId) {
    return !!socketId && !!this.io.sockets.sockets.get(socketId);
  }

  async markHumanDisconnectedAndFold(tableId, playerId, gameState, reason) {
    await tableManager.markDisconnected(tableId, playerId);

    const player = gameState.players.find(p => p.id === playerId);
    if (player) {
      player.disconnected = true;
      await gameStateManager.updateGame(tableId, gameState);
    }

    await this.actionService.handle(tableId, playerId, 'fold');
  }

  async startTimer(tableId, playerId, seconds = 20) {
    this.clearTimer(tableId);

    try {
      const gameState = await gameStateManager.getGame(tableId);

      if (!gameState) {
        console.error(`❌ [TIMER DEBUG] No gameState found for table ${tableId}`);
        return;
      }
      if (gameState.phase === 'SHOWDOWN' || gameState.phase === 'COMPLETED') {
        return;
      }
      

      const player = gameState.players.find(p => p.id === playerId);

      if (!player) {
        console.error(`❌ [TIMER DEBUG] Player ${playerId} not found in gameState`);
        return;
      }

      if (player.status !== 'ACTIVE') {
        return;
      }

      if (player.disconnected) {
        await this.actionService.handle(tableId, playerId, 'fold');
        return;
      }

      const tableState = await tableManager.getTable(tableId);
      const tablePlayer = tableState.players.find(p => p.userId === playerId);

      if (!tablePlayer?.isBot && !this.isLiveSocket(tablePlayer?.socketId)) {
        await this.markHumanDisconnectedAndFold(tableId, playerId, gameState, 'missing_socket');
        return;
      }

      const PlayerActionService = require('./player-action.service');
      const actionService = new PlayerActionService(this.io, this, this.orchestrator);
      const playerTurnData = await actionService.formatPlayerTurnData(gameState, playerId, tableState);
      
      // Emit playerTurn to specific player
      emitSuccess(this.io.to(tableId), 'currentPlayerTurn', { playerId }, 'Current turn');
      
      if (tablePlayer?.socketId) {
        emitSuccess(this.io.to(tablePlayer.socketId), 'playerTurn', playerTurnData, `${playerTurnData.username}, it's your turn to act.`);
      } else {
        console.error(`❌ [TIMER DEBUG] No socketId found for player ${playerId}`);
      }

      /* ------------------------------------ */
      /* 🤖 BOT LOGIC                         */
      /* ------------------------------------ */

      if (tablePlayer?.isBot) {
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

      const timerToken = `${tableId}:${playerId}:${Date.now()}:${Math.random()}`;
      const timeoutId = setTimeout(async () => {
        const activeTimer = this.timers.get(tableId);
        if (!activeTimer || activeTimer.token !== timerToken) {
          return;
        }

        try {
          await this.handleTimeout(tableId, playerId);
        } catch (err) {
          console.error('Timer auto-action error:', err);
        }
      }, seconds * 1000);

      this.timers.set(tableId, { timeoutId, token: timerToken, playerId, seconds });

      // Notify clients
      emitSuccess(
        this.io.to(tableId),
        'turnTimerStarted',
        {
          playerId,
          seconds,
          stakes: playerTurnData.stakes || 'NO_LIMIT'
        },
        'Turn timer started'
      );
    } catch (err) {
      console.error(`❌ startTimer error for ${playerId}:`, err.message);
    }
  }

  clearTimer(tableId) {
    const existing = this.timers.get(tableId);
    if (existing) {
      clearTimeout(existing.timeoutId);
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
      return;
    }

    if (gameState.phase === 'SHOWDOWN' || gameState.phase === 'COMPLETED') {
      return;
    }

    if (gameState.currentPlayerId !== playerId) {
      return;
    }

    const player = gameState.players.find(p => p.id === playerId);

    if (!player) {
      return;
    }

    if (player.status !== 'ACTIVE') {
      return;
    }

    const tableState = await tableManager.getTable(tableId);
    const tablePlayer = tableState.players.find(p => p.userId === playerId);

    if (player.disconnected || (!tablePlayer?.isBot && !this.isLiveSocket(tablePlayer?.socketId))) {
      emitSuccess(this.io.to(tableId), 'playerTimeout', { playerId }, 'Player disconnected');
      emitSuccess(this.io.to(tableId), 'playerAutoFolded', { playerId }, 'Disconnected player auto folded');
      await this.markHumanDisconnectedAndFold(tableId, playerId, gameState, 'timeout_missing_socket');
      return;
    }

    const PlayerActionService = require('./player-action.service');
    const actionService = new PlayerActionService(this.io, this, this.orchestrator);
    const policy = await actionService.getActionPolicy(tableId, playerId, gameState, tableState);

    let autoAction = 'fold';

    if (policy.availableOptions.includes('check')) {
      autoAction = 'check';
    }


    emitSuccess(this.io.to(tableId), 'playerTimeout', { playerId }, 'Player timeout');
    emitSuccess(this.io.to(tableId), 'playerAutoFolded', { playerId }, 'Auto folded');

    await this.actionService.handle(tableId, playerId, autoAction);
  }
}

module.exports = TurnTimerManager;
