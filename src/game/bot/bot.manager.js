const PlayerActionService = require('../player-action.service.js');
const BasicBotStrategy = require('./bot-strategy.basic.js');

class BotManager {
  constructor(io, timerManager, orchestrator) {
    this.io = io;
    this.timerManager = timerManager;
    this.orchestrator = orchestrator;
    this.strategy = new BasicBotStrategy();
    this.actionService = new PlayerActionService(io, timerManager, orchestrator);
  }

  async handleBotTurn(tableId, botPlayer, gameState) {
    try {
      const decision = this.strategy.decide(botPlayer, gameState);

      await this.actionService.handle(
        tableId,
        botPlayer.id,
        decision.type,
        decision.amount
      );
    } catch (err) {
      console.error(`❌ Bot action error for ${botPlayer.id}:`, err.message);
    }
  }
}

module.exports = BotManager;