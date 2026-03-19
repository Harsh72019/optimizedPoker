const mongoHelper = require('../models/customdb');

class CashGameRakeService {
  
  /**
   * Calculate and collect rake from a cash game pot
   */
  async collectRake(handData) {
    const {
      tableId,
      handNumber,
      potSize,
      playersInvolved,
      gameType = 'CASH_GAME',
      rakePercentage,
      hostUplift = 0
    } = handData;
    
    // Calculate effective rake
    const effectiveRake = rakePercentage + hostUplift;
    const rakeAmount = (effectiveRake / 100) * potSize;
    
    // Apply rounding policy
    const displayedRake = Math.floor(rakeAmount * 100) / 100;
    const roundingResidue = rakeAmount - displayedRake;
    
    // Calculate distributions
    const companyRake = (rakePercentage / 100) * potSize;
    const hostShare = (hostUplift / 100) * potSize;
    
    // Apply rounding to distributions
    const companyRakeFloored = Math.floor(companyRake * 100) / 100;
    const hostShareFloored = Math.floor(hostShare * 100) / 100;
    
    // Affiliate payout (30% of company rake)
    const affiliateRate = await this.getAffiliateRate();
    const affiliateShare = companyRakeFloored * (affiliateRate / 100);
    const affiliateShareFloored = Math.floor(affiliateShare * 100) / 100;
    
    const companyNet = companyRakeFloored - affiliateShareFloored;
    
    // Create rake ledger entry
    const rakeLedgerData = {
      gameId: `${tableId}_hand_${handNumber}`,
      gameType,
      totalWagered: potSize,
      rakePercentage: effectiveRake,
      rakeAmount: displayedRake,
      companyShare: companyNet,
      affiliateShare: affiliateShareFloored,
      hostShare: hostShareFloored,
      handsPlayed: 1,
      avgPotSize: potSize
    };
    
    const rakeLedgerResult = await mongoHelper.create(mongoHelper.COLLECTIONS.RAKE_LEDGER, rakeLedgerData);
    
    if (!rakeLedgerResult.success) {
      console.error(`❌ Failed to create rake ledger: ${rakeLedgerResult.error}`);
    }
    
    // Add rounding residue to pool if significant
    if (roundingResidue > 0.001) {
      await this.addToRoundingPool(
        `${tableId}_hand_${handNumber}`,
        'RAKE_CALCULATION',
        rakeAmount,
        displayedRake
      );
    }
    
    console.log(`💰 Cash game rake collected: ${displayedRake} from pot ${potSize}`);
    
    return {
      rakeCollected: displayedRake,
      companyNet,
      affiliateShare: affiliateShareFloored,
      hostShare: hostShareFloored,
      roundingResidue,
      ledgerEntry: rakeLedgerResult.data
    };
  }
  
  /**
   * Get rake percentage for cash game table
   */
  async getCashGameRake(tableConfig) {
    const { tier, hostUplift = 0 } = tableConfig;
    
    // Cash games use different rake structure
    const rakeConfig = await this.getCashGameRakeConfig();
    const baseRake = rakeConfig.tiers[`tier${tier}`] || 5.0;
    
    return {
      baseRake,
      hostUplift,
      effectiveRake: baseRake + hostUplift
    };
  }
  
  /**
   * Calculate rake cap for cash games
   */
  calculateRakeCap(potSize, maxRake = 5.0) {
    // Most cash games have a rake cap (e.g., max $5 rake)
    const calculatedRake = potSize * 0.05; // 5% example
    return Math.min(calculatedRake, maxRake);
  }
  
  /**
   * Get cash game rake configuration
   */
  async getCashGameRakeConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'CASH_GAME_RAKE');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config;
    }
    
    const defaultConfig = {
      configType: 'CASH_GAME_RAKE',
      config: {
        tiers: {
          tier1: 5.0,
          tier2: 4.5,
          tier3: 4.0,
          tier4: 3.5,
          tier5: 3.0
        },
        rakeCap: 5.0, // Maximum rake per hand
        minPotForRake: 1.0 // Minimum pot size to collect rake
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config;
    } else {
      throw new Error(`Failed to create cash game rake config: ${createResult.error}`);
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
      config: { affiliateRate: 30 }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config.affiliateRate;
    } else {
      throw new Error(`Failed to create affiliate rate config: ${createResult.error}`);
    }
  }
  
  /**
   * Add rounding residue to pool
   */
  async addToRoundingPool(gameId, source, originalAmount, displayedAmount) {
    const roundingData = {
      gameId,
      source,
      originalAmount,
      displayedAmount,
      roundingAmount: originalAmount - displayedAmount,
      description: `Cash game rake rounding residue`
    };
    
    const roundingResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ROUNDING_POOL_LEDGER, roundingData);
    
    if (roundingResult.success) {
      console.log(`💰 Rounding pool entry created: ${roundingData.roundingAmount}`);
      return roundingResult.data;
    } else {
      console.error(`❌ Failed to create rounding pool entry: ${roundingResult.error}`);
      return null;
    }
  }
  
  /**
   * Get cash game rake summary for table
   */
  async getTableRakeSummary(tableId, dateRange = {}) {
    const { startDate, endDate } = dateRange;
    
    // Build aggregation pipeline
    const pipeline = [
      {
        $match: {
          gameId: { $regex: `^${tableId}_hand_` },
          gameType: 'CASH_GAME'
        }
      }
    ];
    
    // Add date range filter if provided
    if (startDate || endDate) {
      const dateMatch = {};
      if (startDate) dateMatch.$gte = new Date(startDate);
      if (endDate) dateMatch.$lte = new Date(endDate);
      
      pipeline[0].$match.created_at = dateMatch;
    }
    
    // Add grouping stage
    pipeline.push({
      $group: {
        _id: null,
        totalHands: { $sum: 1 },
        totalWagered: { $sum: '$totalWagered' },
        totalRakeCollected: { $sum: '$rakeAmount' },
        totalCompanyShare: { $sum: '$companyShare' },
        totalAffiliateShare: { $sum: '$affiliateShare' },
        totalHostShare: { $sum: '$hostShare' },
        avgPotSize: { $avg: '$avgPotSize' },
        avgRakePerHand: { $avg: '$rakeAmount' }
      }
    });
    
    const summaryResult = await mongoHelper.aggregate(mongoHelper.COLLECTIONS.RAKE_LEDGER, pipeline);
    
    if (summaryResult.success && summaryResult.data && summaryResult.data.length > 0) {
      return summaryResult.data[0];
    }
    
    return {
      totalHands: 0,
      totalWagered: 0,
      totalRakeCollected: 0,
      totalCompanyShare: 0,
      totalAffiliateShare: 0,
      totalHostShare: 0,
      avgPotSize: 0,
      avgRakePerHand: 0
    };
  }
}

module.exports = new CashGameRakeService();