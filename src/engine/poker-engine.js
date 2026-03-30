// src/engine/poker-engine.js

const HandEvaluator = require('./hand-evaluator');
const ActionValidator = require('./action-validator');
const PotCalculator = require('./pot-calculator');
const GameStateMachine = require('./game-state-machine');

class PokerEngine {
  static async validateAction(player, gameState, tableId = null) {
    return await ActionValidator.getAvailableActions(player, gameState, tableId);
  }
  
  static async validateBetAmount(player, gameState, betAmount, action, tableId = null) {
    return await ActionValidator.validateBetAmount(player, gameState, betAmount, action, tableId);
  }

  static evaluateShowdown(gameState) {
    const activePlayers = gameState.players.filter(
        p => p.status !== 'FOLDED'
    );

    const winnerObjects = HandEvaluator.determineWinners(
        activePlayers,
        gameState.boardCards
    );

    const pots = PotCalculator.calculateSidePots(
        activePlayers,
        gameState.totalContributions
    );

    console.log('[DEBUG] Pots calculated:', JSON.stringify(pots));
    console.log('[DEBUG] Winners:', JSON.stringify(winnerObjects));

    return PotCalculator.distribute(pots, winnerObjects);
  }

  static nextPhase(gameState) {
    return GameStateMachine.nextPhase(gameState);
  }
}

module.exports = PokerEngine;