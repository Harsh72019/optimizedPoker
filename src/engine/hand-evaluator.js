// src/engine/hand-evaluator.js

const { Hand } = require('pokersolver');

class HandEvaluator {
  static evaluate(cards) {
    return Hand.solve(cards);
  }

  static compare(hand1, hand2) {
    return hand1.compare(hand2);
  }

  static determineWinners(players, boardCards) {
    const evaluated = players
      .filter(p => p.status !== 'FOLDED')
      .map(player => {
        const combined = [...player.cards, ...boardCards];
        return {
          playerId: player.id,
          hand: this.evaluate(combined),
        };
      });

    if (evaluated.length === 0) return [];

    evaluated.sort((a, b) => b.hand.compare(a.hand));

    const bestHand = evaluated[0].hand;

    return evaluated
      .filter(p => p.hand.compare(bestHand) === 0)
      .map(p => ({ playerId: p.playerId }));
  }
}

module.exports = HandEvaluator;