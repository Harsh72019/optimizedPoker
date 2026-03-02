// src/game/probability-calculator.js

const crypto = require('crypto');

class ProbabilityCalculator {
  static calculateWinningProbabilities(gameState) {
    try {
      if (!gameState || !gameState.players) {
        return [];
      }

      const communityCards = gameState.boardCards || [];
      const activePlayers = gameState.players.filter(
        p => p.status !== 'FOLDED' && p.cards && p.cards.length === 2
      );

      if (activePlayers.length === 0) {
        return [];
      }

      const probabilities = [];
      const stage = this.getStage(communityCards.length);

      for (let player of activePlayers) {
        const playerHand = this.convertCards(player.cards);
        const community = this.convertCards(communityCards);
        
        const probability = this.calculateProbability(
          playerHand,
          community,
          stage,
          activePlayers.length
        );

        probabilities.push({
          playerId: player.id,
          probability: probability.toFixed(1),
        });
      }

      return probabilities;
    } catch (error) {
      console.error('Error calculating winning probabilities:', error.message);
      return [];
    }
  }

  static convertCards(cards) {
    const VALUE_MAP = {
      '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
      'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
    };
    const SUIT_MAP = { 'h': 'Heart', 'd': 'Diamond', 'c': 'Club', 's': 'Spade' };

    return cards.map(card => {
      const value = card.slice(0, -1);
      const suit = card.slice(-1);
      return {
        cardFace: value,
        suit: SUIT_MAP[suit] || suit,
        value: VALUE_MAP[value] || parseInt(value)
      };
    });
  }

  static getStage(communityCardsCount) {
    if (communityCardsCount === 0) return 'preflop';
    if (communityCardsCount === 3) return 'flop';
    if (communityCardsCount === 4) return 'turn';
    return 'river';
  }

  static calculateProbability(playerHand, communityCards, stage, numPlayers) {
    let probability = this.evaluateHoleCards(playerHand);
    probability = this.adjustForPlayerCount(probability, numPlayers);

    if (communityCards.length > 0) {
      probability = this.evaluateWithCommunityCards(playerHand, communityCards, probability);
    }

    probability = this.adjustForStage(probability, stage);
    return Math.min(Math.max(probability, 1), 99);
  }

  static evaluateHoleCards(playerHand) {
    const [card1, card2] = playerHand;
    const isSuited = card1.suit === card2.suit;
    const isPair = card1.value === card2.value;
    const highCard = Math.max(card1.value, card2.value);
    const lowCard = Math.min(card1.value, card2.value);
    const gap = highCard - lowCard;

    let score = 0;

    if (highCard === 14) score += 10;
    else if (highCard === 13) score += 8;
    else if (highCard === 12) score += 7;
    else if (highCard === 11) score += 6;
    else score += highCard / 2;

    if (isPair) score = Math.max(score * 2, 5);
    if (isSuited) score += 2;

    if (!isPair) {
      if (gap === 1) score -= 0;
      else if (gap === 2) score -= 1;
      else if (gap === 3) score -= 2;
      else if (gap <= 5) score -= 3;
      else score -= 4;
    }

    score = Math.max(score, 1);
    return 10 + (score / 20) * 60;
  }

  static adjustForPlayerCount(probability, numPlayers) {
    const adjustment = (numPlayers - 2) * 4;
    return probability - adjustment;
  }

  static evaluateWithCommunityCards(playerHand, communityCards, baseProbability) {
    const allCards = [...playerHand, ...communityCards];
    const handStrength = this.evaluateHandStrength(allCards);
    const drawStrength = this.evaluateDrawingStrength(playerHand, communityCards);
    return baseProbability + handStrength + drawStrength;
  }

  static evaluateHandStrength(allCards) {
    const valueCounts = {};
    const suitCounts = {};

    allCards.forEach(card => {
      valueCounts[card.value] = (valueCounts[card.value] || 0) + 1;
      suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
    });

    const valueFrequencies = Object.values(valueCounts);
    const hasPair = valueFrequencies.includes(2);
    const hasTwoPair = valueFrequencies.filter(count => count === 2).length >= 2;
    const hasTrips = valueFrequencies.includes(3);
    const hasQuads = valueFrequencies.includes(4);
    const hasFlush = Object.values(suitCounts).some(count => count >= 5);

    const uniqueValues = [...new Set(allCards.map(card => card.value))].sort((a, b) => a - b);
    let hasStraight = false;
    for (let i = 0; i <= uniqueValues.length - 5; i++) {
      if (uniqueValues[i + 4] - uniqueValues[i] === 4) {
        hasStraight = true;
        break;
      }
    }

    if (!hasStraight && uniqueValues.includes(14)) {
      if (uniqueValues.includes(2) && uniqueValues.includes(3) && uniqueValues.includes(4) && uniqueValues.includes(5)) {
        hasStraight = true;
      }
    }

    let hasStraightFlush = false;
    if (hasFlush && hasStraight) {
      const flushSuit = Object.keys(suitCounts).find(suit => suitCounts[suit] >= 5);
      const flushCards = allCards
        .filter(card => card.suit === flushSuit)
        .map(card => card.value)
        .sort((a, b) => a - b);

      for (let i = 0; i <= flushCards.length - 5; i++) {
        if (flushCards[i + 4] - flushCards[i] === 4) {
          hasStraightFlush = true;
          break;
        }
      }
    }

    if (hasStraightFlush) return 80;
    if (hasQuads) return 70;
    if (hasTrips && hasPair) return 60;
    if (hasFlush) return 50;
    if (hasStraight) return 40;
    if (hasTrips) return 30;
    if (hasTwoPair) return 20;
    if (hasPair) return 10;

    const highCard = Math.max(...allCards.map(card => card.value));
    return highCard >= 13 ? 5 : 0;
  }

  static evaluateDrawingStrength(playerHand, communityCards) {
    if (communityCards.length === 5) return 0;

    const allCards = [...playerHand, ...communityCards];
    let drawScore = 0;

    const suitCounts = {};
    allCards.forEach(card => {
      suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
    });

    const flushDrawSuit = Object.keys(suitCounts).find(suit => suitCounts[suit] === 4);
    if (flushDrawSuit) drawScore += 15;

    const values = [...new Set(allCards.map(card => card.value))].sort((a, b) => a - b);

    for (let i = 0; i <= values.length - 4; i++) {
      if (values[i + 3] - values[i] === 3) {
        drawScore += 15;
        break;
      }
    }

    for (let i = 0; i <= values.length - 4; i++) {
      if (values[i + 3] - values[i] === 4) {
        drawScore += 8;
        break;
      }
    }

    return drawScore;
  }

  static adjustForStage(probability, stage) {
    switch (stage) {
      case 'preflop':
        return probability;
      case 'flop':
        return Math.min(probability * 1.1, 95);
      case 'turn':
        return Math.min(probability * 1.2, 98);
      case 'river':
        return probability >= 50 ? Math.min(probability * 1.3, 99) : Math.max(probability * 0.8, 1);
      default:
        return probability;
    }
  }
}

module.exports = ProbabilityCalculator;
