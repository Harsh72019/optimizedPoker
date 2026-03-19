const mongoHelper = require('../models/customdb');

class CommissionPreviewService {
  
  /**
   * Generate commission preview for cash games
   */
  async generateCashGamePreview(gameConfig) {
    const {
      playerCount,
      timerSeconds,
      bigBlind,
      companyRake,
      hostUplift = 0,
      hours = 1
    } = gameConfig;
    
    // Get configuration
    const handsPerHourConfig = await this.getHandsPerHourConfig();
    const timerMultipliers = await this.getTimerMultipliers();
    const avgPotMultiplier = await this.getAvgPotMultiplier();
    
    // Calculate hands per hour
    const baseHandsPerHour = handsPerHourConfig[playerCount] || 70;
    const timerMultiplier = timerMultipliers[timerSeconds] || 1.0;
    const estimatedHandsPerHour = Math.round(baseHandsPerHour * timerMultiplier);
    
    // Calculate average pot
    const avgPot = avgPotMultiplier * bigBlind;
    
    // Calculate total rake per hour
    const totalRakePercent = companyRake + hostUplift;
    const estimatedTotalRakePerHour = estimatedHandsPerHour * avgPot * (totalRakePercent / 100);
    
    // Calculate distributions
    const companyRakePerHour = estimatedHandsPerHour * avgPot * (companyRake / 100);
    const hostEarningsPerHour = estimatedHandsPerHour * avgPot * (hostUplift / 100);
    
    // Affiliate calculations (30% of company rake)
    const affiliateRate = await this.getAffiliateRate();
    const affiliatePayoutPerHour = companyRakePerHour * (affiliateRate / 100);
    const companyNetPerHour = companyRakePerHour - affiliatePayoutPerHour;
    
    // Scale by hours if specified
    const preview = {
      gameConfig: {
        playerCount,
        timerSeconds,
        bigBlind,
        companyRake,
        hostUplift,
        hours
      },
      calculations: {
        baseHandsPerHour,
        timerMultiplier,
        estimatedHandsPerHour,
        avgPot,
        totalRakePercent
      },
      hourlyEstimates: {
        handsPerHour: estimatedHandsPerHour,
        totalRakePerHour: this.roundToCents(estimatedTotalRakePerHour),
        hostEarningsPerHour: this.roundToCents(hostEarningsPerHour),
        companyRakePerHour: this.roundToCents(companyRakePerHour),
        affiliatePayoutPerHour: this.roundToCents(affiliatePayoutPerHour),
        companyNetPerHour: this.roundToCents(companyNetPerHour)
      },
      totalEstimates: {
        totalHands: estimatedHandsPerHour * hours,
        totalRake: this.roundToCents(estimatedTotalRakePerHour * hours),
        hostEarnings: this.roundToCents(hostEarningsPerHour * hours),
        affiliatePayout: this.roundToCents(affiliatePayoutPerHour * hours),
        companyNet: this.roundToCents(companyNetPerHour * hours)
      },
      disclaimer: "Actual commission may be lower if players leave early or if actual pot sizes differ from estimates."
    };
    
    return preview;
  }
  
  /**
   * Generate tournament financial preview
   */
  async generateTournamentPreview(gameConfig) {
    const {
      buyIn,
      declaredCapacity,
      participationThreshold,
      tierRake,
      hostUplift = 0,
      hostRewardPercent = 0,
      hours,
      timerSeconds,
      hasAffiliate = false
    } = gameConfig;
    
    // Calculate setup fee
    const setupFeeService = require('./setup-fee.service');
    const setupFeeCalc = await setupFeeService.calculateSetupFee({
      buyIn,
      declaredCapacity,
      hours,
      timerSeconds
    });
    
    // Calculate for different participation scenarios
    const scenarios = [];
    
    // Full capacity scenario
    scenarios.push(await this.calculateTournamentScenario({
      ...gameConfig,
      actualParticipants: declaredCapacity,
      scenarioName: 'Full Capacity'
    }, setupFeeCalc.displayedAmount));
    
    // Minimum threshold scenario
    const minParticipants = Math.ceil(declaredCapacity * (participationThreshold / 100));
    if (minParticipants < declaredCapacity) {
      scenarios.push(await this.calculateTournamentScenario({
        ...gameConfig,
        actualParticipants: minParticipants,
        scenarioName: `Minimum Threshold (${participationThreshold}%)`
      }, setupFeeCalc.displayedAmount));
    }
    
    return {
      gameConfig,
      setupFee: {
        amount: setupFeeCalc.displayedAmount,
        calculation: setupFeeCalc.calculationDetails
      },
      scenarios,
      disclaimer: "Setup fee is charged immediately and never refunded. Actual earnings depend on final participation."
    };
  }
  
  /**
   * Calculate tournament scenario
   */
  async calculateTournamentScenario(config, setupFeeAmount) {
    const {
      buyIn,
      actualParticipants,
      tierRake,
      hostUplift = 0,
      hostRewardPercent = 0,
      scenarioName,
      hasAffiliate = false
    } = config;
    
    // Follow settlement calculation steps
    const totalBuyIns = actualParticipants * buyIn;
    const effectiveRake = tierRake + hostUplift;
    const totalRake = (effectiveRake / 100) * totalBuyIns;
    const prizePool = totalBuyIns - totalRake;
    
    // Host reward calculation
    const hostCaps = await this.getHostCaps();
    const hostCap = hostCaps.regular; // Assume regular for preview
    const hostRewardCap = (hostCap / 100) * prizePool;
    const requestedHostReward = (hostRewardPercent / 100) * prizePool;
    const actualHostReward = Math.min(requestedHostReward, hostRewardCap);
    
    const remainingPrize = prizePool - actualHostReward;
    
    // Company and affiliate
    const companyShareBeforeAff = totalRake;
    const affiliateRate = await this.getAffiliateRate();
    const affiliatePayout = hasAffiliate ? (affiliateRate / 100) * companyShareBeforeAff : 0;
    const companyNet = companyShareBeforeAff - affiliatePayout;
    
    const platformRevenue = setupFeeAmount + companyNet;
    
    return {
      scenarioName,
      participants: actualParticipants,
      financials: {
        totalBuyIns: this.roundToCents(totalBuyIns),
        totalRake: this.roundToCents(totalRake),
        prizePool: this.roundToCents(prizePool),
        hostReward: this.roundToCents(actualHostReward),
        remainingPrize: this.roundToCents(remainingPrize),
        affiliatePayout: this.roundToCents(affiliatePayout),
        companyNet: this.roundToCents(companyNet),
        platformRevenue: this.roundToCents(platformRevenue)
      },
      breakdown: {
        effectiveRakePercent: effectiveRake,
        hostRewardPercent: hostRewardPercent,
        hostRewardCap: hostCap,
        affiliateRate: affiliateRate
      }
    };
  }
  
  /**
   * Get hands per hour configuration
   */
  async getHandsPerHourConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'HANDS_PER_HOUR');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.handsPerHour;
    }
    
    const defaultConfig = {
      configType: 'HANDS_PER_HOUR',
      config: {
        handsPerHour: {
          3: 90,
          4: 85,
          5: 82,
          6: 80,
          7: 75,
          8: 72,
          9: 70
        }
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.handsPerHour;
    } else {
      throw new Error(`Failed to create hands per hour config: ${createResult.error}`);
    }
  }
  
  /**
   * Get timer multipliers
   */
  async getTimerMultipliers() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'TIMER_MULTIPLIERS');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.timerMultipliers;
    }
    
    const defaultConfig = {
      configType: 'TIMER_MULTIPLIERS',
      config: {
        timerMultipliers: {
          30: 1.00,
          20: 1.30,
          15: 1.60,
          10: 2.25,
          5: 4.00
        }
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.timerMultipliers;
    } else {
      throw new Error(`Failed to create timer multipliers config: ${createResult.error}`);
    }
  }
  
  /**
   * Get average pot multiplier
   */
  async getAvgPotMultiplier() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'AVG_POT_MULTIPLIER');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.avgPotMultiplier;
    }
    
    const defaultConfig = {
      configType: 'AVG_POT_MULTIPLIER',
      config: {
        avgPotMultiplier: 3
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.avgPotMultiplier;
    } else {
      throw new Error(`Failed to create avg pot multiplier config: ${createResult.error}`);
    }
  }
  
  /**
   * Get affiliate rate
   */
  async getAffiliateRate() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'AFFILIATE_RATE');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.affiliateRate;
    }
    
    const defaultConfig = {
      configType: 'AFFILIATE_RATE',
      config: {
        affiliateRate: 30
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.affiliateRate;
    } else {
      throw new Error(`Failed to create affiliate rate config: ${createResult.error}`);
    }
  }
  
  /**
   * Get host caps
   */
  async getHostCaps() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'HOST_CAPS');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.hostCaps;
    }
    
    const defaultConfig = {
      configType: 'HOST_CAPS',
      config: {
        hostCaps: {
          regular: 15,
          trusted: 25
        }
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.hostCaps;
    } else {
      throw new Error(`Failed to create host caps config: ${createResult.error}`);
    }
  }
  
  /**
   * Round amount to cents
   */
  roundToCents(amount) {
    return Math.floor(amount * 100) / 100;
  }
}

module.exports = new CommissionPreviewService();