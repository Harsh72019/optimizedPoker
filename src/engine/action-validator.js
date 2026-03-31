// src/engine/action-validator.js

class ActionValidator {
  static getAvailableActions(player, gameState) {

    const {
      currentBet,
      bigBlind,
      lastRaiseAmount,
      streetBets
    } = gameState;

    const playerBet = streetBets[player.id] || 0;

    const callAmount = Math.max(0, currentBet - playerBet);

    const options = new Set();
    options.add('fold');

    // Cannot act if ALL_IN
    if (player.status === 'ALL_IN' || player.chips <= 0) {
      return {
        options: ['fold'],
        callAmount: 0,
        minRaise: null,
        maxRaise: null,
        minRaiseAmount: null,
        maxRaiseAmount: null
      };
    }

    // If no bet to match
    if (callAmount === 0) {
      options.add('check');

      if (player.chips >= bigBlind) {
        options.add('raise');
      }
    }
    else {
      if (player.chips <= callAmount) {
        options.add('all-in');
      }
      else {
        options.add('call');

        // Minimum raise = lastRaiseAmount
        const minRaiseAmount = lastRaiseAmount || bigBlind;

        if (player.chips >= callAmount + minRaiseAmount) {
          options.add('raise');
        }
      }
    }

    const minRaiseAmount =
      currentBet === 0
        ? bigBlind
        : currentBet + (lastRaiseAmount || bigBlind);
    const maxRaiseAmount = playerBet + player.chips;
    console.log('🎯 Player turn | Actions: ', Array.from(options));
    return {
      options: Array.from(options),
      callAmount,
      minRaise: options.has('raise') ? minRaiseAmount : null,
      maxRaise: options.has('raise') ? maxRaiseAmount : null,
      minRaiseAmount: options.has('raise') ? minRaiseAmount : null,
      maxRaiseAmount: options.has('raise') ? maxRaiseAmount : null
    };
  }
}

module.exports = ActionValidator;
