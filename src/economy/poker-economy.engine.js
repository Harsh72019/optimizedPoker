const EconomyConfig = {
  // Base constants
  AFFILIATE_RATE: 0.30, // 30% [cite: 53]
  AVG_POT_MULTIPLIER: 3, // m_pot [cite: 274]
  SETUP_BASE_FEE: 0.05, // [cite: 57, 208]
  
  // Setup Fee Multipliers [cite: 59, 210]
  FEE_SCALERS: {
    A: 0.005, // Scales with buy-in
    B: 0.03,  // Scales with capacity
    C: 0.10,  // Scales with hours
    D: 0.10   // Scales with speed bonus
  },

  // Speed Bonus Mapping (Value 'd') [cite: 60, 211]
  SPEED_BONUS: {
    30: 0,
    20: 1,
    15: 2,
    10: 3,
    5: 4
  },

  // Timer Multiplier for Estimates (M_timer) [cite: 250-254]
  M_TIMER: {
    30: 1.00,
    20: 1.30,
    15: 1.60,
    10: 2.25,
    5: 4.00
  },

  // Baseline Hands Per Hour (30s timer) [cite: 241]
  HPH_BASE: {
    3: 90, 4: 85, 5: 82, 6: 80, 7: 75, 8: 72, 9: 70
  }
};

class PokerEconomyEngine {
  
  /**
   * Core Rounding Policy: Floors to 2 decimals and extracts the remainder.
   * "Fractional remainders are transferred to the company fees pool"[cite: 195].
   * @param {number} value - The precise float value
   * @returns {Object} { flooredAmount, remainder }
   */
  static applyRounding(value) {
    const flooredAmount = Math.floor(value * 100) / 100; // Floor to cents [cite: 134]
    const remainder = value - flooredAmount;
    return { flooredAmount, remainder };
  }

  /**
   * Calculates the upfront non-refundable Setup Fee.
   * Formula: 0.05 + (a * TotalPotentialBuyIns) + (b * Players) + (c * Hours) - (d * SpeedBonus) [cite: 57, 208]
   */
  static calculateSetupFee(buyIn, capacity, hours, timerSeconds) {
    // For SNGs, BuyIn rule is often 20xBB if not provided explicitly [cite: 394]
    const totalPotentialBuyIns = buyIn * capacity;
    const speedBonusValue = EconomyConfig.SPEED_BONUS[timerSeconds] || 0;

    const a = EconomyConfig.FEE_SCALERS.A * totalPotentialBuyIns; // [cite: 59]
    const b = EconomyConfig.FEE_SCALERS.B * capacity;
    const c = EconomyConfig.FEE_SCALERS.C * hours;
    const d = EconomyConfig.FEE_SCALERS.D * speedBonusValue;

    const preciseFee = EconomyConfig.SETUP_BASE_FEE + a + b + c - d;
    
    // Rounding & charging [cite: 213-214]
    return this.applyRounding(preciseFee); 
  }

  /**
   * Helper to determine table splits for >9 players.
   * "divide all the players equally between the tables" [cite: 242]
   */
  static getTableSplits(totalPlayers) {
    if (totalPlayers <= 9) return [totalPlayers]; //[cite: 245]
    
    const numTables = Math.ceil(totalPlayers / 9);
    const basePlayersPerTable = Math.floor(totalPlayers / numTables);
    let remainder = totalPlayers % numTables;

    const tables = [];
    for (let i = 0; i < numTables; i++) {
      tables.push(basePlayersPerTable + (remainder > 0 ? 1 : 0));
      remainder--;
    }
    return tables; // e.g., 20 players -> [7, 7, 6] [cite: 453]
  }

  /**
   * Calculates the Estimated Commission Preview for SNGs before creation.
   * (Estimated_Total_Rake_per_hour) = (HandsPerHour_base) * (M(timer)) * (Game Time) * (AvgPot) * (CompanyRake + HostRake) [cite: 286]
   */
  static estimateSNGRake(capacity, bbAmount, gameHours, timerSeconds, tierRakePct, hostUpliftPct) {
    const tableSplits = this.getTableSplits(capacity);
    const mTimer = EconomyConfig.M_TIMER[timerSeconds] || 1.0; //[cite: 247]
    const avgPot = EconomyConfig.AVG_POT_MULTIPLIER * bbAmount; // m_pot * BB [cite: 269]
    
    let totalEstimatedRake = 0;
    let totalHostUplift = 0;
    let totalCompanyBaseRake = 0;

    // Calculate per table and sum them up [cite: 362-367]
    tableSplits.forEach(playersAtTable => {
      // If table size < 3, use 3's baseline for estimation math
      const hphBase = EconomyConfig.HPH_BASE[playersAtTable] || EconomyConfig.HPH_BASE[3];
      const actualHPH = hphBase * mTimer;

      totalEstimatedRake += actualHPH * avgPot * (tierRakePct + hostUpliftPct) * gameHours;
      totalHostUplift += actualHPH * avgPot * hostUpliftPct * gameHours;
      totalCompanyBaseRake += actualHPH * avgPot * tierRakePct * gameHours;
    });

    const affiliatePayoutPrecise = totalCompanyBaseRake * EconomyConfig.AFFILIATE_RATE;// [cite: 178]
    const companyNetPrecise = totalCompanyBaseRake - affiliatePayoutPrecise;// [cite: 179]

    // Floor everything for display [cite: 497-502]
    return {
      estimatedTotalRake: this.applyRounding(totalEstimatedRake).flooredAmount,
      estimatedHostUplift: this.applyRounding(totalHostUplift).flooredAmount,
      estimatedCompanyBaseRake: this.applyRounding(totalCompanyBaseRake).flooredAmount,
      estimatedAffiliatePayout: this.applyRounding(affiliatePayoutPrecise).flooredAmount,
      estimatedCompanyNet: this.applyRounding(companyNetPrecise).flooredAmount
    };
  }

  /**
   * Post-game settlement for Private Sit & Go Tables.
   * Takes the actual money wagered during the game and calculates final payouts.
   */
  static settleSNG(totalWagered, tierRakePct, hostUpliftPct) {
    // "TotalWagered: Sum of all player buy-ins plus any rebuys" 
    const companyBaseRakePrecise = totalWagered * tierRakePct; //[cite: 176]
    const hostUpliftCollectedPrecise = totalWagered * hostUpliftPct; //[cite: 177]
    const affiliatePayoutPrecise = companyBaseRakePrecise * EconomyConfig.AFFILIATE_RATE;// [cite: 178]
    const companyNetPrecise = companyBaseRakePrecise - affiliatePayoutPrecise; //[cite: 179]

    // Apply strict rounding policy to all payouts [cite: 197-199]
    const companyBaseRake = this.applyRounding(companyBaseRakePrecise);
    const hostUplift = this.applyRounding(hostUpliftCollectedPrecise);
    const affiliatePayout = this.applyRounding(affiliatePayoutPrecise);
    const companyNet = this.applyRounding(companyNetPrecise);

    // Accumulate total rounding remainders for the platform's ledger
    const totalRoundingLedger = companyBaseRake.remainder + hostUplift.remainder + affiliatePayout.remainder + companyNet.remainder;

    return {
      hostPayout: hostUplift.flooredAmount,
      affiliatePayout: affiliatePayout.flooredAmount,
      companyNet: companyNet.flooredAmount,
      roundingPoolAddition: totalRoundingLedger
    };
  }

  /**
   * Post-game settlement for Scheduled or Private Tournaments.
   */
  static settleTournament(actualParticipants, buyIn, tierRakePct, hostRewardPct) {
    const totalBuyIns = actualParticipants * buyIn;// [cite: 65]
    const totalRakePrecise = totalBuyIns * tierRakePct;// [cite: 66]
    const prizePoolPrecise = totalBuyIns - totalRakePrecise;// [cite: 67]

    // Host Reward capped at % of prize pool [cite: 68]
    const maxHostReward = prizePoolPrecise * hostRewardPct;
    const hostReward = this.applyRounding(maxHostReward);

    const remainingPrize = this.applyRounding(prizePoolPrecise - hostReward.flooredAmount);// [cite: 69]

    const affiliatePayoutPrecise = totalRakePrecise * EconomyConfig.AFFILIATE_RATE; //[cite: 71]
    const companyNetPrecise = totalRakePrecise - affiliatePayoutPrecise;// [cite: 72]

    const affiliatePayout = this.applyRounding(affiliatePayoutPrecise);
    const companyNet = this.applyRounding(companyNetPrecise);

    return {
      prizePool: remainingPrize.flooredAmount,
      hostPayout: hostReward.flooredAmount,
      affiliatePayout: affiliatePayout.flooredAmount,
      companyNet: companyNet.flooredAmount,
      roundingPoolAddition: hostReward.remainder + remainingPrize.remainder + affiliatePayout.remainder + companyNet.remainder
    };
  }
}

module.exports = { PokerEconomyEngine, EconomyConfig };