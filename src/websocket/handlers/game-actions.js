// src/websocket/handlers/game-actions.handler.js

const verifyEventToken = require('../verify-event-token');
const { emitError, emitSuccess } = require('../socket-emitter');

class GameActionHandler {
  constructor(io, socket, timerManager, actionService) {
    this.io = io;
    this.socket = socket;
    this.timerManager = timerManager;
    this.actionService = actionService;
    this.registerEvents();
  }


   registerEvents() {
    this.socket.on('playerAction', async (data) => {
      try {
        const { action, amount, token } = data;
        
        const user = await verifyEventToken(token, this.socket);
        
        await this.actionService.handle(
          this.socket.tableId,
          user._id.toString(),
          action,
          amount
        );
      } catch (err) {
        emitError(this.socket, 'error', err.message);
      }
    });

    this.socket.on('updateWinningProbability', async (data) => {
      try {
        const { token } = data;
        await verifyEventToken(token, this.socket);
        
        const tableId = this.socket.tableId;
        if (!tableId) return;

        const gameState = await require('../state/game-state').getGame(tableId);
        if (!gameState) return;

        const ProbabilityCalculator = require('../game/probability-calculator');
        const probabilities = ProbabilityCalculator.calculateWinningProbabilities(gameState);
        
        emitSuccess(this.socket, 'winningProbability', { probabilities }, 'Probabilities calculated');
      } catch (err) {
        emitError(this.socket, 'errorFetchingProbability', err.message);
      }
    });
  }
}

module.exports = GameActionHandler;