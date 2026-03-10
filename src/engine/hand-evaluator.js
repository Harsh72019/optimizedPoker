// src/engine/hand-evaluator.js

const { Hand } = require('pokersolver');

class HandEvaluator {
  static evaluate(cards) {
    const normalizedCards = cards.map(card => this.normalizeCard(card)).filter(Boolean);
    return Hand.solve(normalizedCards);
  }

  static compare(hand1, hand2) {
    return hand1.compare(hand2);
  }

  static determineWinners(players, boardCards) {
    console.log('[DEBUG] Raw board cards:', JSON.stringify(boardCards));
    
    const evaluated = players
      .filter(p => p.status !== 'FOLDED')
      .map(player => {
        console.log(`[DEBUG] Player ${player.id} raw cards:`, JSON.stringify(player.cards));
        
        const normalizedPlayerCards = player.cards.map(card => this.normalizeCard(card)).filter(Boolean);
        const normalizedBoardCards = boardCards.map(card => this.normalizeCard(card)).filter(Boolean);
        
        console.log(`[DEBUG] Player ${player.id} normalized cards:`, normalizedPlayerCards);
        console.log(`[DEBUG] Normalized board cards:`, normalizedBoardCards);
        
        const combined = [...normalizedPlayerCards, ...normalizedBoardCards];
        console.log(`[DEBUG] Player ${player.id} combined cards:`, combined);
        
        const hand = this.evaluate(combined);
        console.log(`[DEBUG] Player ${player.id} evaluated hand:`, hand.name, hand.descr);
        
        return {
          playerId: player.id,
          hand: hand,
          handName: hand.name,
          bestHand: hand.cards
        };
      });

    if (evaluated.length === 0) return [];

    evaluated.sort((a, b) => b.hand.compare(a.hand));

    const bestHand = evaluated[0].hand;

    return evaluated
      .filter(p => p.hand.compare(bestHand) === 0)
      .map(p => ({ 
        playerId: p.playerId, 
        handName: p.handName,
        bestHand: p.bestHand
      }));
  }

  static normalizeCard(card) {
    if (!card) return null;
    if (typeof card === 'object') {
      const face = (card.cardFace || card.rank || '').toString();
      const suitRaw = (card.suit || '').toString().toLowerCase();
      const suitChar = this.suitToChar(suitRaw);
      if (!face || !suitChar) return null;
      return `${face}${suitChar}`;
    }
    if (typeof card === 'string') {
      return card; // Already normalized
    }
    return null;
  }

  static suitToChar(s) {
    if (!s) return null;
    s = s.toString().toLowerCase();
    if (['s', 'spade', 'spades', '♠'].includes(s)) return 's';
    if (['h', 'heart', 'hearts', '♥'].includes(s)) return 'h';
    if (['d', 'diamond', 'diamonds', '♦'].includes(s)) return 'd';
    if (['c', 'club', 'clubs', '♣'].includes(s)) return 'c';
    return null;
  }
}

module.exports = HandEvaluator;