const mongoHelper = require('../models/customdb');
const setupFeeService = require('./setup-fee.service');

class SNGCommissionPreviewService {
  
  /**
   * Generate commission preview for Private SNG
   */
  async generateSNGCommissionPreview(sngConfig) {
    const {
      declaredCapacity,
      buyIn,
      duration, // in hours
      timerSeconds,
      tier,
      hostUplift = 0,
      bigBlind
    } = sngConfig;
    
    // Get configuration
    const handsPerHourConfig = await this.getHandsPerHourConfig();
    const timerMultipliers = await this.getTimerMultipliers();
    const avgPotMultiplier = await this.getAvgPotMultiplier();
    const tierRakes = await this.getSNGTierRakes();
    
    // Calculate hands per hour based on table configuration
    const tableConfigs = this.calculateTableConfiguration(declaredCapacity);
    let totalEstimatedRakePerHour = 0;
    let totalEstimatedHostUpliftPerHour = 0;
    let totalEstimatedCompanyRakePerHour = 0;
    
    const tableBreakdown = [];
    
    for (const tableConfig of tableConfigs) {
      const { players, tableNumber } = tableConfig;
      
      // Get base hands per hour for this table size
      const baseHandsPerHour = handsPerHourConfig[players] || 70;
      const timerMultiplier = timerMultipliers[timerSeconds] || 1.0;
      const handsPerHour = baseHandsPerHour * timerMultiplier;
      
      // Calculate average pot
      const avgPot = avgPotMultiplier * bigBlind;
      
      // Get rake rates
      const baseTierRake = tierRakes[`tier${tier}`] / 100; // Convert to decimal
      const hostUpliftRate = hostUplift / 100;
      const totalRakeRate = baseTierRake + hostUpliftRate;
      
      // Calculate per-hour estimates for this table
      const totalRakePerHour = handsPerHour * avgPot * totalRakeRate;
      const hostUpliftPerHour = handsPerHour * avgPot * hostUpliftRate;
      const companyBaseRakePerHour = handsPerHour * avgPot * baseTierRake;
      
      // Add to totals
      totalEstimatedRakePerHour += totalRakePerHour;
      totalEstimatedHostUpliftPerHour += hostUpliftPerHour;
      totalEstimatedCompanyRakePerHour += companyBaseRakePerHour;
      
      tableBreakdown.push({
        tableNumber,
        players,
        handsPerHour: Math.round(handsPerHour * 10) / 10,
        avgPot: this.roundToCents(avgPot),
        totalRakePerHour: this.roundToCents(totalRakePerHour),
        hostUpliftPerHour: this.roundToCents(hostUpliftPerHour),
        companyBaseRakePerHour: this.roundToCents(companyBaseRakePerHour)
      });
    }
    
    // Calculate affiliate and company net
    const affiliateRate = await this.getAffiliateRate();
    const affiliatePerHour = (affiliateRate / 100) * totalEstimatedCompanyRakePerHour;
    const companyNetPerHour = totalEstimatedCompanyRakePerHour - affiliatePerHour;
    
    // Calculate totals for full duration
    const totalEstimates = {
      totalRake: this.roundToCents(totalEstimatedRakePerHour * duration),
      hostUplift: this.roundToCents(totalEstimatedHostUpliftPerHour * duration),
      companyBaseRake: this.roundToCents(totalEstimatedCompanyRakePerHour * duration),
      affiliate: this.roundToCents(affiliatePerHour * duration),
      companyNet: this.roundToCents(companyNetPerHour * duration)
    };
    
    // Calculate setup fee
    const setupFee = await this.calculateSetupFee({
      buyIn,
      declaredCapacity,
      duration,
      timerSeconds
    });
    
    const platformRevenue = setupFee.chargedAmount + totalEstimates.companyNet;
    
    return {
      sngConfig: {
        declaredCapacity,
        buyIn,
        duration,
        timerSeconds,
        tier,
        hostUplift,
        bigBlind
      },
      tableConfiguration: {
        totalTables: tableConfigs.length,
        breakdown: tableBreakdown
      },
      hourlyEstimates: {
        totalRakePerHour: this.roundToCents(totalEstimatedRakePerHour),
        hostUpliftPerHour: this.roundToCents(totalEstimatedHostUpliftPerHour),
        companyBaseRakePerHour: this.roundToCents(totalEstimatedCompanyRakePerHour),
        affiliatePerHour: this.roundToCents(affiliatePerHour),
        companyNetPerHour: this.roundToCents(companyNetPerHour)
      },
      totalEstimates,
      setupFee: {
        amount: setupFee.chargedAmount,
        calculation: setupFee.calculationDetails
      },
      platformRevenue: this.roundToCents(platformRevenue),
      disclaimer: "This is an upper-bound estimate assuming all players play for the full duration with the given parameters. Actual commission may be lower if players are eliminated early or tables merge. Setup Fee is charged at creation and is non-refundable."
    };
  }
  
  /**
   * Calculate table configuration based on player count
   */
  calculateTableConfiguration(totalPlayers) {
    const tables = [];
    
    if (totalPlayers <= 9) {
      // Single table
      tables.push({ players: totalPlayers, tableNumber: 1 });
    } else {
      // Multiple tables - distribute evenly
      const numTables = Math.ceil(totalPlayers / 9);
      const playersPerTable = Math.floor(totalPlayers / numTables);
      const remainder = totalPlayers % numTables;
      
      for (let i = 0; i < numTables; i++) {
        const players = playersPerTable + (i < remainder ? 1 : 0);
        tables.push({ players, tableNumber: i + 1 });
      }
    }
    
    return tables;
  }
  
  /**
   * Calculate setup fee for SNG
   */
  async calculateSetupFee(config) {
    const calculation = await setupFeeService.calculateSetupFee({
      buyIn,
      declaredCapacity,
      hours: duration,
      timerSeconds
    });

    const { terms } = calculation.calculationDetails;

    return {
      chargedAmount: calculation.displayedAmount,
      remainder: calculation.roundingResidue,
      calculationDetails: {
        ...terms,
        preciseFee: calculation.fullPrecisionResult,
        speedBonus: calculation.calculationDetails.speedBonus
      }
    };
  }
  
  /**
   * Get hands per hour configuration for SNG
   */
  async getHandsPerHourConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'SNG_HANDS_PER_HOUR');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.handsPerHour;
    }
    
    const defaultConfig = {
      configType: 'SNG_HANDS_PER_HOUR',
      config: {
        handsPerHour: {
          3: 90,
          4: 85,
          5: 82,
          6: 80,
          7: 75,
          8: 72,
          9: 70,
          10: 65,
          11: 62,
          12: 60,
          13: 58,
          14: 56,
          15: 54,
          16: 52,
          17: 50,
          18: 48
        }
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.handsPerHour;
    } else {
      throw new Error(`Failed to create SNG hands per hour config: ${createResult.error}`);
    }
  }
  
  /**
   * Get timer multipliers
   */
  async getTimerMultipliers() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'SNG_TIMER_MULTIPLIERS');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.timerMultipliers;
    }
    
    const defaultConfig = {
      configType: 'SNG_TIMER_MULTIPLIERS',
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
      throw new Error(`Failed to create SNG timer multipliers config: ${createResult.error}`);
    }
  }
  
  /**
   * Get average pot multiplier
   */
  async getAvgPotMultiplier() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'SNG_AVG_POT_MULTIPLIER');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.avgPotMultiplier;
    }
    
    const defaultConfig = {
      configType: 'SNG_AVG_POT_MULTIPLIER',
      config: {
        avgPotMultiplier: 3
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.avgPotMultiplier;
    } else {
      throw new Error(`Failed to create SNG avg pot multiplier config: ${createResult.error}`);
    }
  }
  
  /**
   * Get SNG tier rakes
   */
  async getSNGTierRakes() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'SNG_RAKE_TIERS');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.sngTiers;
    }
    
    const defaultConfig = {
      configType: 'SNG_RAKE_TIERS',
      config: {
        sngTiers: {
          tier1: 5.0,
          tier2: 4.5,
          tier3: 3.5,
          tier4: 2.5,
          tier5: 2.0
        }
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.sngTiers;
    } else {
      throw new Error(`Failed to create SNG rake tiers config: ${createResult.error}`);
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
    
    return 30; // Default 30%
  }
  
  /**
   * Get setup fee configuration
   */
  async getSetupFeeConfig() {
    const config = await setupFeeService.getSetupFeeConfig();
    return {
      constants: config.setupFeeConstants,
      speedBonusTable: config.speedBonus
    };
  }
  
  /**
   * Round amount to cents
   */
  roundToCents(amount) {
    return Math.floor(amount * 100) / 100;
  }
}

module.exports = new SNGCommissionPreviewService();
