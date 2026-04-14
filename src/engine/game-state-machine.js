// src/engine/state-machine.js

class GameStateMachine {
  static normalizeAmount(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) {
      return 0;
    }

    const normalized = Math.round((amount + Number.EPSILON) * 100) / 100;
    return Math.abs(normalized) < 0.000001 ? 0 : normalized;
  }

  static nextPhase(currentPhase) {
    switch (currentPhase) {
      case 'PREFLOP': return 'FLOP';
      case 'FLOP': return 'TURN';
      case 'TURN': return 'RIVER';
      case 'RIVER': return 'SHOWDOWN';
      default: return 'SHOWDOWN';
    }
  }

  static isBettingRoundComplete(gameState) {
    const nonFoldedPlayers = gameState.players.filter(
      p => p.status !== 'FOLDED'
    );

    // Everyone else folded, so the hand can be awarded immediately.
    if (nonFoldedPlayers.length <= 1) return true;

    const actionablePlayers = nonFoldedPlayers.filter(
      p => p.status === 'ACTIVE' && this.normalizeAmount(p.chips) > 0
    );

    // Nobody can act anymore, so betting is over and the board can run out.
    if (actionablePlayers.length === 0) return true;

    // Remaining active players must have acted and matched the current bet.
    return actionablePlayers.every(p => {
      const playerBet = this.normalizeAmount(gameState.streetBets[p.id] || 0);
      const currentBet = this.normalizeAmount(gameState.currentBet || 0);
      return p.hasActed && playerBet === currentBet;
    });
  }

  static shouldGoToShowdown(gameState) {
    const nonFolded = gameState.players.filter(
      p => p.status !== 'FOLDED'
    );

    if (nonFolded.length <= 1) return false;

    const activeNonAllIn = nonFolded.filter(
      p => p.status === 'ACTIVE' && this.normalizeAmount(p.chips) > 0
    );

    // If nobody left can bet, we should proceed to showdown.
    return activeNonAllIn.length === 0;
  }
}

module.exports = GameStateMachine;
