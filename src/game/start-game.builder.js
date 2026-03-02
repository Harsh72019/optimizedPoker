// src/game/start-game.builder.js

class StartGameBuilder {
  static buildInitialState({
    tableId,
    seatedPlayers,
    smallBlind,
    bigBlind,
    dealerPosition
  }) {
    if (seatedPlayers.length < 2) {
      throw new Error('Need at least 2 players');
    }

    const sortedSeats = seatedPlayers
      .map(p => p.seatPosition)
      .sort((a, b) => a - b);

    let dealerIndex = sortedSeats.indexOf(dealerPosition);

    // If dealer seat no longer exists, move to first active seat
    if (dealerIndex === -1) {
      dealerIndex = 0;
      dealerPosition = sortedSeats[0];
    }
    const smallBlindSeat =
      sortedSeats[(dealerIndex + 1) % sortedSeats.length];

    const bigBlindSeat =
      sortedSeats[(dealerIndex + 2) % sortedSeats.length];

    const players = seatedPlayers.map(p => ({
      id: p.userId,
      username: p.username,
      seatPosition: p.seatPosition,
      chips: Number(p.chips) || 0,
      // chipsInPot: 0,
      status: 'ACTIVE',
      hasActed: false,
      cards: [],
    }));

    return {
      tableId,
      phase: 'PREFLOP',
      dealerPosition,
      smallBlindPosition: smallBlindSeat,
      bigBlindPosition: bigBlindSeat,
      currentBet: 0,
      pot: 0,
      boardCards: [],
      deck: [],
      streetBets: {},
      totalContributions: {},
      lastRaiseAmount: 0,
      currentPlayerId: null,
      handId: Date.now().toString(),
      players,
      smallBlind,
      bigBlind
    };
  }
}

module.exports = StartGameBuilder;