// src/game/bot/bot-strategy.basic.js

const PokerEngine = require('../../engine/poker-engine');

class BasicBotStrategy {
  decide(bot, gameState) {
    const validation =
      PokerEngine.validateAction(bot, gameState);

    const pot = gameState.pot;
    const callAmount = validation.callAmount || 0;

    // If check possible → check 60% of time
    if (validation.options.includes('check')) {
      return { type: 'check' };
    }

    // Small calls allowed
    if (
      validation.options.includes('call') &&
      callAmount < bot.chips * 0.2
    ) {
      return { type: 'call' };
    }

    // Occasional raise (30% chance)
    if (validation.options.includes('raise')) {
      const raiseAmount =
        Math.min(
          validation.minRaiseAmount,
          bot.chips * 0.3
        );

      if (Math.random() < 0.3) {
        return {
          type: 'raise',
          amount: raiseAmount
        };
      }
    }

    return { type: 'fold' };
  }
}

module.exports = BasicBotStrategy;