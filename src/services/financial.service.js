const setupFeeService = require('./setup-fee.service');
const settlementService = require('./settlement.service');
const rakeTierService = require('./rake-tier.service');
const commissionPreviewService = require('./commission-preview.service');
const mongoHelper = require('../models/customdb');

class FinancialService {
  
  /**
   * Create a new private table with financial setup
   */
  async createPrivateTable(hostId, tableConfig) {
    const {
      gameType, // 'PRIVATE_SNG' or 'PRIVATE_TOURNAMENT'
      buyIn,
      declaredCapacity,
      participationThreshold,
      tier,
      hostUplift = 0,
      hostRewardPercent = 0,
      hours,
      timerSeconds
    } = tableConfig;
    
    // Validate host uplift for SNG
    if (gameType === 'PRIVATE_SNG' && hostUplift > 0) {
      await rakeTierService.validateHostUplift(hostId, hostUplift);
    }
    
    // Validate host reward percentage
    await this.validateHostReward(hostId, hostRewardPercent);
    
    // Get tier rake
    const tierRake = gameType === 'PRIVATE_SNG' 
      ? await rakeTierService.getSNGRake(tier)
      : await rakeTierService.getTournamentRake(tier);
    
    return {
      tierRake,
      effectiveRake: tierRake + hostUplift,
      gameConfig: {
        ...tableConfig,
        tierRake,
      }
    };
  }
  
  /**
   * Generate financial preview before table creation
   */
  async generateFinancialPreview(tableConfig) {
    const { gameType } = tableConfig;
    
    if (gameType === 'CASH_GAME') {
      return await commissionPreviewService.generateCashGamePreview(tableConfig);
    } else {
      return await commissionPreviewService.generateTournamentPreview(tableConfig);
    }
  }
  
  /**
   * Execute settlement when game ends
   */
  async settleGame(gameId, gameData) {
    const { participationThreshold, actualParticipants, declaredCapacity } = gameData;
    
    // Check if participation threshold was met
    const thresholdMet = (actualParticipants / declaredCapacity) >= (participationThreshold / 100);
    
    if (!thresholdMet) {
      // Refund players but keep setup fee
      return await this.handleInsufficientParticipation(gameId, gameData);
    }
    
    // Check if proportional scaling needed
    if (actualParticipants < declaredCapacity) {
      return await settlementService.executeProportionalSettlement(gameId, gameData);
    }
    
    // Full settlement
    return await settlementService.executeSettlement(gameId, gameData);
  }
  
  /**
   * Handle insufficient participation (below threshold)
   */
  async handleInsufficientParticipation(gameId, gameData) {
    // Create financial record showing refund
    const gameFinancialsData = {
      gameId,
      gameType: gameData.gameType,
      hostId: gameData.hostId,
      buyIn: gameData.buyIn,
      declaredCapacity: gameData.declaredCapacity,
      actualParticipants: gameData.actualParticipants,
      participationThreshold: gameData.participationThreshold,
      tierRake: gameData.tierRake,
      hostUplift: gameData.hostUplift || 0,
      effectiveRake: gameData.tierRake + (gameData.hostUplift || 0),
      totalBuyIns: 0,
      totalRake: 0,
      prizePool: 0,
      hostReward: 0,
      hostRewardCap: 0,
      remainingPrize: 0,
      companyShareBeforeAff: 0,
      affiliatePayout: 0,
      companyNet: 0,
      setupFee: gameData.setupFeeAmount,
      platformRevenue: gameData.setupFeeAmount, // Only setup fee is kept
      status: 'REFUNDED'
    };
    
    const gameFinancialsResult = await mongoHelper.create(mongoHelper.COLLECTIONS.GAME_FINANCIALS, gameFinancialsData);
    
    if (!gameFinancialsResult.success) {
      throw new Error(`Failed to create refund financial record: ${gameFinancialsResult.error}`);
    }
    
    console.log(`💰 Insufficient participation handled for game ${gameId} - setup fee kept: ${gameData.setupFeeAmount}`);
    
    return {
      gameFinancials: gameFinancialsResult.data,
      refundAmount: gameData.actualParticipants * gameData.buyIn,
      setupFeeKept: gameData.setupFeeAmount
    };
  }
  
  /**
   * Validate host reward percentage
   */
  async validateHostReward(hostId, hostRewardPercent) {
    if (hostRewardPercent <= 0) return true;
    
    const hostType = await rakeTierService.getHostType(hostId);
    const hostCaps = await this.getHostCaps();
    const maxAllowed = hostCaps[hostType];
    
    if (hostRewardPercent > maxAllowed) {
      throw new Error(`Host reward ${hostRewardPercent}% exceeds maximum allowed ${maxAllowed}% for ${hostType} host`);
    }
    
    return true;
  }
  
  /**
   * Get host caps configuration
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
   * Get financial summary for a game
   */
  async getGameFinancialSummary(gameId) {
    const gameFinancialsResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.GAME_FINANCIALS, 'gameId', gameId);
    
    if (!gameFinancialsResult.success || !gameFinancialsResult.data) {
      throw new Error('Financial record not found for this game');
    }
    
    const gameFinancials = gameFinancialsResult.data;
    
    return {
      gameId: gameFinancials.gameId,
      gameType: gameFinancials.gameType,
      status: gameFinancials.status,
      summary: {
        totalBuyIns: gameFinancials.totalBuyIns,
        totalRake: gameFinancials.totalRake,
        prizePool: gameFinancials.prizePool,
        hostReward: gameFinancials.hostReward,
        remainingPrize: gameFinancials.remainingPrize,
        setupFee: gameFinancials.setupFee,
        platformRevenue: gameFinancials.platformRevenue
      },
      participants: {
        declared: gameFinancials.declaredCapacity,
        actual: gameFinancials.actualParticipants,
        threshold: gameFinancials.participationThreshold
      },
      rake: {
        tier: gameFinancials.tierRake,
        uplift: gameFinancials.hostUplift,
        effective: gameFinancials.effectiveRake
      }
    };
  }
  
  /**
   * Get platform revenue summary
   */
  async getPlatformRevenueSummary(dateRange = {}) {
    const { startDate, endDate } = dateRange;
    
    // Build aggregation pipeline
    const pipeline = [
      {
        $match: {
          status: 'SETTLED'
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
        totalGames: { $sum: 1 },
        totalSetupFees: { $sum: '$setupFee' },
        totalCompanyNet: { $sum: '$companyNet' },
        totalPlatformRevenue: { $sum: '$platformRevenue' },
        totalAffiliatePayout: { $sum: '$affiliatePayout' },
        totalHostRewards: { $sum: '$hostReward' },
        totalPrizePool: { $sum: '$prizePool' },
        gamesByType: {
          $push: {
            gameType: '$gameType',
            revenue: '$platformRevenue'
          }
        }
      }
    });
    
    const summaryResult = await mongoHelper.aggregate(mongoHelper.COLLECTIONS.GAME_FINANCIALS, pipeline);
    
    if (summaryResult.success && summaryResult.data && summaryResult.data.length > 0) {
      return summaryResult.data[0];
    }
    
    return {
      totalGames: 0,
      totalSetupFees: 0,
      totalCompanyNet: 0,
      totalPlatformRevenue: 0,
      totalAffiliatePayout: 0,
      totalHostRewards: 0,
      totalPrizePool: 0
    };
  }
  
  /**
   * Initialize default admin configurations
   */
  async initializeDefaultConfigurations() {
    const configTypes = [
      'RAKE_TIERS',
      'AFFILIATE_RATE', 
      'HOST_CAPS',
      'SETUP_FEE',
      'TIMER_MULTIPLIERS',
      'HANDS_PER_HOUR',
      'AVG_POT_MULTIPLIER'
    ];
    
    for (const configType of configTypes) {
      const existingResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', configType);
      
      if (!existingResult.success || !existingResult.data) {
        // Trigger creation of default config by calling respective service methods
        try {
          switch (configType) {
            case 'RAKE_TIERS':
              await rakeTierService.getTournamentTierConfig();
              break;
            case 'AFFILIATE_RATE':
              await commissionPreviewService.getAffiliateRate();
              break;
            case 'HOST_CAPS':
              await this.getHostCaps();
              break;
            case 'SETUP_FEE':
              await setupFeeService.getSetupFeeConfig();
              break;
            case 'TIMER_MULTIPLIERS':
              await commissionPreviewService.getTimerMultipliers();
              break;
            case 'HANDS_PER_HOUR':
              await commissionPreviewService.getHandsPerHourConfig();
              break;
            case 'AVG_POT_MULTIPLIER':
              await commissionPreviewService.getAvgPotMultiplier();
              break;
          }
          console.log(`✅ Initialized ${configType} configuration`);
        } catch (error) {
          console.error(`❌ Failed to initialize ${configType}: ${error.message}`);
        }
      } else {
        console.log(`⏭️  ${configType} configuration already exists`);
      }
    }
    
    return { initialized: true };
  }
}

module.exports = new FinancialService();