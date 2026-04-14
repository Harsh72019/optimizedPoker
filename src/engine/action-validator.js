// src/engine/action-validator.js

class ActionValidator {
  static normalizeAmount(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) {
      return 0;
    }

    const normalized = Math.round((amount + Number.EPSILON) * 100) / 100;
    return Math.abs(normalized) < 0.000001 ? 0 : normalized;
  }

  static getAvailableActions(player, gameState) {

    const {
      currentBet,
      bigBlind,
      lastRaiseAmount,
      streetBets
    } = gameState;

    const playerBet = this.normalizeAmount(streetBets[player.id] || 0);

    const callAmount = this.normalizeAmount(Math.max(0, currentBet - playerBet));

    const options = new Set();
    options.add('fold');

    // ALL_IN players are already committed and should not be offered any action.
    const normalizedChips = this.normalizeAmount(player.chips);

    if (player.status === 'ALL_IN' || normalizedChips <= 0) {
      return {
        options: [],
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

      if (normalizedChips >= this.normalizeAmount(bigBlind)) {
        options.add('raise');
      }
    }
    else {
      if (normalizedChips <= callAmount) {
        options.add('all-in');
      }
      else {
        options.add('call');

        // Minimum raise = lastRaiseAmount
        const minRaiseAmount = lastRaiseAmount || bigBlind;

        if (normalizedChips >= this.normalizeAmount(callAmount + minRaiseAmount)) {
          options.add('raise');
        }
      }
    }

    const minRaiseAmount =
      currentBet === 0
        ? bigBlind
        : currentBet + (lastRaiseAmount || bigBlind);
    const maxRaiseAmount = this.normalizeAmount(playerBet + normalizedChips);
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
