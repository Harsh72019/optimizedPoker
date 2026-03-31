// src/game/bot/bot-strategy.basic.js

const PokerEngine = require('../../engine/poker-engine');
const BotBehaviour = require('../../utils/botBehaviour');

class BasicBotStrategy {
  constructor() {
    this.botBehaviours = new Map();
  }

  getBotBehaviour(botId) {
    if (!this.botBehaviours.has(botId)) {
      this.botBehaviours.set(botId, new BotBehaviour(botId, 'hard'));
    }
    return this.botBehaviours.get(botId);
  }

  decide(bot, gameState) {
    const validation = PokerEngine.validateAction(bot, gameState);
    const behaviour = this.getBotBehaviour(bot.id);

    // Check if validation is valid
    if (!validation || !validation.options) {
      console.error(`❌ Invalid validation for bot ${bot.id}:`, validation);
      return { type: 'fold' };
    }

    const gameData = {
      phase: gameState.phase?.toLowerCase() || 'preflop',
      pot: gameState.pot + Object.values(gameState.streetBets || {}).reduce((a, b) => a + b, 0),
      betToCall: validation.callAmount || 0,
      playersInHand: gameState.players.filter(p => p.status !== 'FOLDED').length,
      totalPlayers: gameState.players.length,
      position: bot.seatPosition || 0,
      minBet: gameState.bigBlind || 0.04
    };

    const playerData = {
      cards: bot.cards || [],
      communityCards: gameState.boardCards || [],
      chips: bot.chips || 0,
      currentBet: gameState.streetBets?.[bot.id] || 0,
      pot: gameData.pot
    };

    const decision = behaviour.makeDecision(gameData, playerData);

    if (!validation.options.includes(decision.action)) {
      if (validation.options.includes('check')) return { type: 'check' };
      if (validation.options.includes('fold')) return { type: 'fold' };
      return { type: validation.options[0] };
    }

    if (decision.action === 'raise') {
      const minRaise = validation.minRaise || validation.minRaiseAmount || gameState.bigBlind || 0.04;
      const amount = Math.max(decision.amount, minRaise);
      return { type: 'raise', amount: Math.min(amount, bot.chips) };
    }

    return { type: decision.action, amount: decision.amount };
  }
}

module.exports = BasicBotStrategy;