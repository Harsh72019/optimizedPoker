// src/engine/state-machine.js

class GameStateMachine {

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
    const activePlayers = gameState.players.filter(
      p => p.status === 'ACTIVE'
    );

    // Only one active → hand ends
    if (activePlayers.length <= 1) return true;

    // All active players must:
    // 1) Have acted
    // 2) Match current bet OR be ALL_IN
    return activePlayers.every(p => {
      const playerBet = gameState.streetBets[p.id] || 0;

      return (
        p.hasActed &&
        (
          playerBet === gameState.currentBet ||
          p.status === 'ALL_IN'
        )
      );
    });
  }

  static shouldGoToShowdown(gameState) {
    const nonFolded = gameState.players.filter(
      p => p.status !== 'FOLDED'
    );

    const activeNonAllIn = nonFolded.filter(
      p => p.status === 'ACTIVE'
    );

    // If nobody left who can bet → showdown
    return activeNonAllIn.length <= 1;
  }
}

module.exports = GameStateMachine;