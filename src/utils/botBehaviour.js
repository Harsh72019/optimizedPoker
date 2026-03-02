var Hand = require('pokersolver').Hand;
const { roundChips, minChips, maxChips } = require('./numberHelpers');

class BotBehavior {
  constructor(botId, difficulty = 'hard') {
    this.botId = botId;
    this.difficulty = difficulty;
    this.personality = this.generatePersonality();
    this.lastActions = [];
    this.opponentModels = {};
    this.handHistory = [];
    this.mcIterations = this.chooseIterationsByDifficulty(difficulty);
  }

  chooseIterationsByDifficulty(difficulty) {
    if (difficulty === 'easy') return 50;
    if (difficulty === 'hard') return 200;
    return 100;
  }

  generatePersonality() {
    const personalities = {
      aggressive: { bluffFrequency: 0.22, riskTolerance: 0.75, valueThreshold: 0.52 },
      conservative: { bluffFrequency: 0.08, riskTolerance: 0.40, valueThreshold: 0.62 },
      balanced: { bluffFrequency: 0.15, riskTolerance: 0.58, valueThreshold: 0.55 },
      tactical: { bluffFrequency: 0.18, riskTolerance: 0.65, valueThreshold: 0.50 },
    };
    const types = Object.keys(personalities);
    const chosen = types[Math.floor(Math.random() * types.length)];
    return { type: chosen, ...personalities[chosen] };
  }

  makeDecision(gameData, playerData) {
    const heroCards = (playerData.cards || []).map(c => this.normalizeCard(c)).filter(Boolean);
    const board = (playerData.communityCards || []).map(c => this.normalizeCard(c)).filter(Boolean);

    if (!heroCards || heroCards.length < 2) {
      return { action: 'fold', amount: 0 };
    }

    const phase = gameData.phase || 'preflop';
    const playersInHand = Math.max(1, (gameData.playersInHand || gameData.totalPlayers || 2) - 1);
    const shouldAvoidFolding = board.length < 5; // Avoid folding until river (5th card)
    
    const equity = this.estimateEquityMC(heroCards, board, playersInHand, this.mcIterations);
    
    const betToCall = gameData.betToCall || 0;
    const pot = gameData.pot || playerData.pot || 100;
    const chips = playerData.chips || 1000;
    const currentBet = playerData.currentBet || 0;
    
    const position = gameData.position || 0;
    const totalPlayers = gameData.totalPlayers || 2;
    const positionStrength = this.analyzePosition(position, totalPlayers, playersInHand);
    
    const SPR = chips / Math.max(pot, 1);
    
    if (phase === 'preflop' || board.length === 0) {
      return this.makePreflopDecision(heroCards, betToCall, pot, chips, positionStrength, SPR, 0.5, shouldAvoidFolding);
    }
    
    const handStrength = this.evaluateHandStrength(heroCards, board);
    const potential = this.calculatePotential(heroCards, board);
    const potOdds = betToCall === 0 ? 0 : betToCall / (pot + betToCall);
    const impliedOdds = this.calculateImpliedOdds(betToCall, pot, chips, equity, phase);
    const aggression = this.estimateOpponentAggression(gameData);
    
    return this.makePostflopDecision({
      heroCards, board, equity, handStrength, potential,
      betToCall, pot, chips, currentBet, effectiveStack: chips,
      potOdds, impliedOdds, SPR, positionStrength,
      phase, playersInHand, aggression, shouldAvoidFolding
    });
  }

  makePreflopDecision(heroCards, betToCall, pot, chips, positionStrength, SPR, aggression, shouldAvoidFolding = false) {
    const handRank = this.getPreflopHandRank(heroCards);
    
    // ✅ FIX: Ensure raise sizing meets minimum requirements with precision rounding
    const minRaise = roundChips(Math.max(betToCall * 2, pot * 0.3)); // At least 2x the bet to call or 30% of pot
    const baseRaise = roundChips(Math.max(pot * 0.4, minRaise));
    const raiseSize = roundChips(Math.min(maxChips(baseRaise, pot * 0.5), chips));
    
    // Premium hands - play strong but not overly aggressive
    if (handRank <= 0.10) {
      if (betToCall === 0) {
        return { action: 'raise', amount: roundChips(Math.min(raiseSize, chips)) };
      }
      // Call/raise with premium based on bet size
      if (betToCall < chips * 0.3) {
        const reraiseSize = roundChips(Math.max(betToCall * 2.5, pot * 0.4));
        return { action: 'raise', amount: roundChips(Math.min(reraiseSize, chips)) };
      }
      return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
    }
    
    // Strong hands - balanced approach
    if (handRank <= 0.30) {
      if (betToCall === 0) {
        if (Math.random() < 0.7) {
          return { action: 'raise', amount: roundChips(Math.min(raiseSize * 0.9, chips)) };
        }
        return { action: 'check', amount: 0 };
      }
      // Call reasonable bets
      if (betToCall <= pot * 0.8) {
        return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
      }
      // Fold to large bets without great position
      if (betToCall <= chips * 0.25 && positionStrength > 0.6) {
        return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
      }
      if (shouldAvoidFolding) {
        return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
      }
      return { action: 'fold', amount: 0 };
    }
    
    // Medium hands - selective play
    if (handRank <= 0.50) {
      if (betToCall === 0) {
        // Raise sometimes, check often
        if (Math.random() < 0.4 && positionStrength > 0.5) {
          return { action: 'raise', amount: roundChips(Math.min(raiseSize * 0.7, chips)) };
        }
        return { action: 'check', amount: 0 };
      }
      // Call small bets only
      if (betToCall <= pot * 0.5) {
        return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
      }
      // Fold to larger bets
      if (shouldAvoidFolding) {
        return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
      }
      return { action: 'fold', amount: 0 };
    }
    
    // Marginal hands - tight play
    if (handRank <= 0.70) {
      if (betToCall === 0) {
        // Mostly check, rarely raise
        if (positionStrength > 0.7 && Math.random() < 0.25) {
          return { action: 'raise', amount: roundChips(Math.min(raiseSize * 0.5, chips)) };
        }
        return { action: 'check', amount: 0 };
      }
      // Call only very small bets
      if (betToCall <= pot * 0.3 || betToCall <= chips * 0.03) {
        return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
      }
      if (shouldAvoidFolding) {
        return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
      }
      return { action: 'fold', amount: 0 };
    }
    
    // Weak hands - fold most of the time
    if (handRank <= 0.85 && positionStrength > 0.7) {
      if (betToCall === 0) {
        // Rarely bluff
        if (Math.random() < 0.15) {
          return { action: 'raise', amount: roundChips(Math.min(raiseSize * 0.4, chips)) };
        }
        return { action: 'check', amount: 0 };
      }
      // Call only tiny bets
      if (betToCall <= pot * 0.2 || betToCall <= chips * 0.02) {
        return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
      }
    }
    
    // Trash hands - fold
    if (betToCall === 0) {
      return { action: 'check', amount: 0 };
    }
    
    // Only call extremely small bets with trash
    if (betToCall <= chips * 0.02 || betToCall <= pot * 0.15) {
      return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
    }
    
    if (shouldAvoidFolding && betToCall > 0) {
      return { action: 'call', amount: roundChips(Math.min(betToCall, chips)) };
    }
    return { action: 'fold', amount: 0 };
  }

  makePostflopDecision(ctx) {
    const { heroCards, board, equity, handStrength, potential,
            betToCall, pot, chips, effectiveStack,
            potOdds, impliedOdds, SPR, positionStrength,
            phase, playersInHand, aggression, shouldAvoidFolding = false } = ctx;
    
    const adjustedEquity = equity * 0.7 + handStrength * 0.2 + potential * 0.1;
    const isDrawingHand = potential > 0.25 && handStrength < 0.5;
    const isRiver = phase === 'river';
    
    // Check scenario
    if (betToCall === 0) {
      return this.makeCheckDecision(adjustedEquity, handStrength, pot, chips, 
                                     positionStrength, isDrawingHand, phase);
    }
    
    // Facing a bet - be more aggressive
    return this.makeBetFacingDecision(adjustedEquity, handStrength, potential,
                                       betToCall, pot, chips, potOdds, 
                                       impliedOdds, SPR, positionStrength,
                                       isDrawingHand, aggression, phase, isRiver, shouldAvoidFolding);
  }

  makeCheckDecision(equity, handStrength, pot, chips, positionStrength, isDrawing, phase) {
    
    // Very strong hand - bet most of the time
    if (equity > 0.75) {
      if (Math.random() < 0.85) {
        const betSize = roundChips(Math.min(pot * 0.5, chips));
        return { action: 'raise', amount: betSize };
      }
      return { action: 'check', amount: 0 };
    }
    
    // Strong hand - bet sometimes
    if (equity > 0.60) {
      if (Math.random() < 0.6) {
        const betSize = roundChips(Math.min(pot * 0.4, chips));
        return { action: 'raise', amount: betSize };
      }
      return { action: 'check', amount: 0 };
    }
    
    // Medium strength - check mostly
    if (equity > 0.45) {
      if (Math.random() < 0.3 && positionStrength > 0.6) {
        const betSize = roundChips(Math.min(pot * 0.35, chips));
        return { action: 'raise', amount: betSize };
      }
      return { action: 'check', amount: 0 };
    }
    
    // Drawing hand - check mostly, semi-bluff rarely
    if (isDrawing && phase !== 'river') {
      if (Math.random() < 0.2 && positionStrength > 0.7) {
        const betSize = roundChips(Math.min(pot * 0.3, chips));
        return { action: 'raise', amount: betSize };
      }
    }
    
    // Weak hand - almost always check
    return { action: 'check', amount: 0 };
  }

  makeBetFacingDecision(equity, handStrength, potential, betToCall, pot, chips,
                        potOdds, impliedOdds, SPR, positionStrength, 
                        isDrawing, aggression, phase, isRiver, shouldAvoidFolding = false) {
    
    const callAmount = roundChips(Math.min(betToCall, chips));
    
    // Very strong hand - raise sometimes, call often
    if (equity > 0.75) {
      if (betToCall < chips * 0.4 && Math.random() < 0.5) {
        const raiseSize = roundChips(Math.max(betToCall * 2.2, pot * 0.4));
        return { action: 'raise', amount: roundChips(Math.min(raiseSize, chips)) };
      }
      if (betToCall <= chips * 0.6) {
        return { action: 'call', amount: callAmount };
      }
      if (shouldAvoidFolding) {
        return { action: 'call', amount: callAmount };
      }
      return { action: 'fold', amount: 0 };
    }
    
    // Strong hand - mostly call
    if (equity > 0.60) {
      if (betToCall < chips * 0.3 && Math.random() < 0.3) {
        const raiseSize = roundChips(Math.max(betToCall * 2, pot * 0.3));
        return { action: 'raise', amount: roundChips(Math.min(raiseSize, chips)) };
      }
      if (betToCall <= chips * 0.4) {
        return { action: 'call', amount: callAmount };
      }
      if (shouldAvoidFolding) {
        return { action: 'call', amount: callAmount };
      }
      return { action: 'fold', amount: 0 };
    }
    
    // Good hand - call if good price
    if (equity > 0.50) {
      if (equity > potOdds * 1.1) {
        return { action: 'call', amount: callAmount };
      }
      if (betToCall <= pot * 0.5) {
        return { action: 'call', amount: callAmount };
      }
      if (shouldAvoidFolding) {
        return { action: 'call', amount: callAmount };
      }
      return { action: 'fold', amount: 0 };
    }
    
    // Drawing hand - call if good odds
    if (isDrawing && !isRiver) {
      if (equity > impliedOdds * 0.8 || betToCall <= pot * 0.3) {
        return { action: 'call', amount: callAmount };
      }
      if (shouldAvoidFolding) {
        return { action: 'call', amount: callAmount };
      }
      return { action: 'fold', amount: 0 };
    }
    
    // Marginal hand - fold mostly
    if (equity > 0.40) {
      if (betToCall <= pot * 0.25) {
        return { action: 'call', amount: callAmount };
      }
      if (equity > potOdds * 1.2 && betToCall < pot * 0.4) {
        return { action: 'call', amount: callAmount };
      }
    }
    
    // Weak hand - fold
    // Only call very small bets
    if (betToCall <= pot * 0.15 && betToCall <= chips * 0.05) {
      return { action: 'call', amount: callAmount };
    }
    
    // All-in with decent equity
    if (betToCall >= chips * 0.9 && equity > 0.35) {
      return { action: 'call', amount: roundChips(chips) };
    }
    
    // Avoid folding until river
    if (shouldAvoidFolding) {
      return { action: 'call', amount: callAmount };
    }
    
    return { action: 'fold', amount: 0 };
  }

  getPreflopHandRank(cards) {
    if (!cards || cards.length < 2) return 1.0;
    
    const c1 = cards[0], c2 = cards[1];
    const rank1Str = c1[0] === '1' ? c1.slice(0, 2) : c1[0];
    const rank2Str = c2[0] === '1' ? c2.slice(0, 2) : c2[0];
    const rank1 = this.getRankValue(rank1Str);
    const rank2 = this.getRankValue(rank2Str);
    const suited = c1.slice(-1) === c2.slice(-1);
    const gap = Math.abs(rank1 - rank2);
    const maxRank = Math.max(rank1, rank2);
    const minRank = Math.min(rank1, rank2);
    const isPair = rank1 === rank2;
    
    // Premium pairs
    if (isPair && maxRank >= 13) return 0.02; // AA, KK
    if (isPair && maxRank >= 11) return 0.07; // QQ
    
    // Premium non-pairs
    if (maxRank === 14 && minRank >= 12) return suited ? 0.04 : 0.06; // AK, AQ
    
    // High pairs
    if (isPair && maxRank >= 9) return 0.15; // JJ, TT, 99
    if (isPair && maxRank >= 7) return 0.25; // 88, 77
    if (isPair && maxRank >= 5) return 0.35; // 66, 55
    if (isPair) return 0.45; // 44, 33, 22
    
    // Strong broadways
    if (maxRank >= 13 && minRank >= 11) return suited ? 0.18 : 0.28; // AJ, KQ
    if (maxRank >= 13 && minRank >= 10) return suited ? 0.30 : 0.42; // AT, KJ, QJ
    if (maxRank >= 12 && minRank >= 9) return suited ? 0.38 : 0.52; // KT, QT, JT
    
    // Ace-high
    if (maxRank === 14) {
      if (suited) return 0.35 + (14 - minRank) * 0.02;
      return 0.50 + (14 - minRank) * 0.02;
    }
    
    // King-high
    if (maxRank === 13) {
      if (suited) return 0.48 + (13 - minRank) * 0.02;
      return 0.62 + (13 - minRank) * 0.02;
    }
    
    // Suited connectors and gappers
    if (suited && gap <= 1 && maxRank >= 7) return 0.42; // 87s+
    if (suited && gap <= 2 && maxRank >= 8) return 0.52; // 86s+
    if (suited && gap <= 1) return 0.60; // All suited connectors
    
    // Any suited cards
    if (suited && maxRank >= 8) return 0.68;
    
    // Connected cards
    if (gap <= 1 && maxRank >= 8) return 0.72;
    
    // Two broadways
    if (minRank >= 10) return 0.75;
    
    return 0.88; // True trash hands
  }

  getRankValue(rank) {
    const map = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, 
                  '9': 9, '10': 10, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
    return map[rank] || 2;
  }

  evaluateHandStrength(heroCards, board) {
    if (!heroCards || heroCards.length < 2) return 0;
    if (!board || board.length === 0) return 0.5;
    
    try {
      const hand = Hand.solve([...heroCards, ...board]);
      const rankMap = {
        'Royal Flush': 1.0, 'Straight Flush': 0.98, 'Four of a Kind': 0.92,
        'Full House': 0.85, 'Flush': 0.75, 'Straight': 0.68,
        'Three of a Kind': 0.58, 'Two Pair': 0.48, 'Pair': 0.35,
        'High Card': 0.20
      };
      return rankMap[hand.name] || 0.3;
    } catch (e) {
      return 0.3;
    }
  }

  calculatePotential(heroCards, board) {
    if (!board || board.length >= 5) return 0;
    if (!heroCards || heroCards.length < 2) return 0;
    
    const deck = this.buildFullDeck().filter(c => 
      ![...heroCards, ...board].includes(c)
    );
    
    let improved = 0;
    const samples = Math.min(50, deck.length);
    
    for (let i = 0; i < samples; i++) {
      const nextCard = deck[Math.floor(Math.random() * deck.length)];
      const newBoard = [...board, nextCard];
      const newStrength = this.evaluateHandStrength(heroCards, newBoard);
      const oldStrength = this.evaluateHandStrength(heroCards, board);
      if (newStrength > oldStrength + 0.1) improved++;
    }
    
    return improved / samples;
  }

  calculateImpliedOdds(betToCall, pot, chips, equity, phase) {
    if (phase === 'river') return pot > 0 ? betToCall / pot : 0;
    
    const potentialFutureWinnings = Math.min(chips, pot * 2.5);
    const totalPot = pot + betToCall + potentialFutureWinnings * equity;
    return totalPot > 0 ? betToCall / totalPot : 0;
  }

  analyzePosition(position, totalPlayers, playersInHand) {
    if (!position || !totalPlayers) return 0.5;
    
    const relativePosition = position / totalPlayers;
    const playersToAct = Math.max(0, playersInHand - 1);
    const positionAdjustment = Math.max(0, (3 - playersToAct) / 3);
    
    return Math.min(1, relativePosition * 0.7 + positionAdjustment * 0.3);
  }

  estimateOpponentAggression(gameData) {
    const pot = gameData.pot || 0;
    const betToCall = gameData.betToCall || 0;
    const minBet = gameData.minBet || 1;
    
    if (betToCall === 0) return 0.3;
    
    const betRatio = betToCall / Math.max(pot, minBet);
    return Math.min(1, betRatio / 2);
  }

  estimateEquityMC(heroCards, boardCards, numOpponents = 1, iterations = 500) {
    const hero = heroCards.map(c => this.normalizeCard(c)).filter(Boolean);
    const board = (boardCards || []).map(c => this.normalizeCard(c)).filter(Boolean);
    if (hero.length < 2) return 0.0;

    const deck = this.buildFullDeck().filter(c => ![...hero, ...board].includes(c));
    let heroWins = 0, ties = 0, total = 0;

    for (let i = 0; i < iterations; i++) {
      const d = deck.slice();
      this.shuffleArray(d);

      const opponents = [];
      for (let p = 0; p < numOpponents; p++) {
        if (d.length < 2) break;
        opponents.push([d.pop(), d.pop()]);
      }

      const needed = Math.max(0, 5 - board.length);
      const community = board.slice();
      for (let k = 0; k < needed; k++) {
        if (d.length === 0) break;
        community.push(d.pop());
      }

      try {
        const heroHand = Hand.solve([...hero, ...community]);
        const oppHands = opponents.map(h => Hand.solve([...h, ...community]));
        const allHands = [heroHand, ...oppHands];
        const winners = Hand.winners(allHands);

        const heroWon = winners.some(w => w === heroHand);
        if (heroWon) {
          winners.length > 1 ? ties++ : heroWins++;
        }
        total++;
      } catch (err) {
        continue;
      }
    }

    return total > 0 ? (heroWins + ties * 0.5) / total : 0;
  }

  normalizeCard(card) {
    if (!card) return null;
    if (typeof card === 'object') {
      const face = (card.cardFace || card.rank || '').toString();
      const suitRaw = (card.suit || '').toString().toLowerCase();
      const suitChar = this.suitToChar(suitRaw);
      if (!face || !suitChar) return null;
      return `${face}${suitChar}`;
    }
    if (typeof card === 'string') {
      const cleaned = card.replace(/[^0-9AJQKTcdsh♠♥♦♣]/gi, '');
      const last = cleaned.slice(-1);
      const rank = cleaned.slice(0, -1);
      const mappedSuit = this.suitToChar(last.toLowerCase());
      if (mappedSuit) return `${rank}${mappedSuit}`;
      return cleaned;
    }
    return null;
  }

  suitToChar(s) {
    if (!s) return null;
    s = s.toString().toLowerCase();
    if (['s', 'spade', 'spades', '♠'].includes(s)) return 's';
    if (['h', 'heart', 'hearts', '♥'].includes(s)) return 'h';
    if (['d', 'diamond', 'diamonds', '♦'].includes(s)) return 'd';
    if (['c', 'club', 'clubs', '♣'].includes(s)) return 'c';
    return null;
  }

  buildFullDeck() {
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = ['s', 'h', 'd', 'c'];
    const deck = [];
    ranks.forEach(r => suits.forEach(s => deck.push(`${r}${s}`)));
    return deck;
  }

  shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}

module.exports = BotBehavior;