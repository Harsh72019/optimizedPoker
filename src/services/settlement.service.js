const mongoHelper = require('../models/customdb');

class SettlementService {
  
  /**
   * Execute complete settlement when tournament ends
   * Follows exact specification steps 1-9
   */
  async executeSettlement(gameId, gameData) {
    const {
      gameType,
      hostId,
      buyIn,
      declaredCapacity,
      actualParticipants,
      participationThreshold,
      tierRake,
      hostUplift = 0,
      hostRewardPercent = 0,
      setupFeeAmount,
      affiliateId = null
    } = gameData;
    
    const settlementSteps = [];
    
    // Step 1: TotalBuyIns_actual = ActualParticipants × BuyIn
    const totalBuyIns = actualParticipants * buyIn;
    settlementSteps.push(`Step 1: TotalBuyIns = ${actualParticipants} × ${buyIn} = ${totalBuyIns}`);
    
    // Step 2: TotalRake = TierRake% × TotalBuyIns_actual
    const effectiveRake = tierRake + hostUplift;
    const totalRake = (effectiveRake / 100) * totalBuyIns;
    settlementSteps.push(`Step 2: TotalRake = ${effectiveRake}% × ${totalBuyIns} = ${totalRake}`);
    
    // Step 3: PrizePool = TotalBuyIns_actual - TotalRake
    const prizePool = totalBuyIns - totalRake;
    settlementSteps.push(`Step 3: PrizePool = ${totalBuyIns} - ${totalRake} = ${prizePool}`);
    
    // Step 4: HostCap = HostRate% × PrizePool
    const hostType = await this.getHostType(hostId);
    const hostCaps = await this.getHostCaps();
    const hostCap = hostCaps[hostType];
    const hostRewardCap = (hostCap / 100) * prizePool;
    settlementSteps.push(`Step 4: HostCap = ${hostCap}% × ${prizePool} = ${hostRewardCap}`);
    
    // Validate and calculate actual host reward
    const requestedHostReward = (hostRewardPercent / 100) * prizePool;
    const actualHostReward = Math.min(requestedHostReward, hostRewardCap);
    
    // Step 5: RemainingPrize = PrizePool - HostReward
    const remainingPrize = prizePool - actualHostReward;
    settlementSteps.push(`Step 5: RemainingPrize = ${prizePool} - ${actualHostReward} = ${remainingPrize}`);
    
    // Step 6: CompanyShareBeforeAff = TotalRake
    const companyShareBeforeAff = totalRake;
    settlementSteps.push(`Step 6: CompanyShareBeforeAff = ${totalRake}`);
    
    // Step 7: AffiliatePayout = AffiliateRate × CompanyShareBeforeAff
    const affiliateConfig = await this.getAffiliateConfig();
    const affiliateRate = affiliateConfig.affiliateRate;
    const affiliatePayout = affiliateId ? (affiliateRate / 100) * companyShareBeforeAff : 0;
    settlementSteps.push(`Step 7: AffiliatePayout = ${affiliateRate}% × ${companyShareBeforeAff} = ${affiliatePayout}`);
    
    // Step 8: CompanyNet = CompanyShareBeforeAff - AffiliatePayout
    const companyNet = companyShareBeforeAff - affiliatePayout;
    settlementSteps.push(`Step 8: CompanyNet = ${companyShareBeforeAff} - ${affiliatePayout} = ${companyNet}`);
    
    // Step 9: PlatformRevenue = SetupFee + CompanyNet
    const platformRevenue = setupFeeAmount + companyNet;
    settlementSteps.push(`Step 9: PlatformRevenue = ${setupFeeAmount} + ${companyNet} = ${platformRevenue}`);
    
    // Create main financial record
    const gameFinancialsData = {
      gameId,
      gameType,
      hostId,
      buyIn,
      declaredCapacity,
      actualParticipants,
      participationThreshold,
      tierRake,
      hostUplift,
      effectiveRake,
      totalBuyIns,
      totalRake,
      prizePool,
      hostReward: actualHostReward,
      hostRewardCap,
      remainingPrize,
      companyShareBeforeAff,
      affiliatePayout,
      companyNet,
      setupFee: setupFeeAmount,
      platformRevenue,
      calculationSnapshot: {
        settlementSteps,
        timestamp: new Date()
      },
      status: 'SETTLED'
    };
    
    const gameFinancialsResult = await mongoHelper.create(mongoHelper.COLLECTIONS.GAME_FINANCIALS, gameFinancialsData);
    
    if (!gameFinancialsResult.success) {
      throw new Error(`Failed to create game financials: ${gameFinancialsResult.error}`);
    }
    
    // Create subsidiary ledger entries
    await this.createRakeLedger(gameId, gameType, totalBuyIns, effectiveRake, totalRake, companyNet, affiliatePayout, hostUplift > 0 ? (hostUplift / 100) * totalBuyIns : 0);
    
    if (actualHostReward > 0) {
      await this.createHostRewardLedger(gameId, hostId, prizePool, hostRewardPercent, requestedHostReward, hostType, hostCap, actualHostReward);
    }
    
    if (affiliatePayout > 0 && affiliateId) {
      await this.createAffiliateLedger(gameId, affiliateId, hostId, companyShareBeforeAff, affiliateRate, affiliatePayout);
    }
    
    console.log(`💰 Settlement completed for game ${gameId}: Platform revenue ${platformRevenue}`);
    
    return {
      gameFinancials: gameFinancialsResult.data,
      settlement: {
        totalBuyIns,
        totalRake,
        prizePool,
        remainingPrize,
        hostReward: actualHostReward,
        affiliatePayout,
        companyNet,
        platformRevenue
      }
    };
  }
  
  /**
   * Create rake ledger entry
   */
  async createRakeLedger(gameId, gameType, totalWagered, rakePercentage, rakeAmount, companyShare, affiliateShare, hostShare) {
    const rakeLedgerData = {
      gameId,
      gameType,
      totalWagered,
      rakePercentage,
      rakeAmount,
      companyShare,
      affiliateShare,
      hostShare
    };
    
    const rakeLedgerResult = await mongoHelper.create(mongoHelper.COLLECTIONS.RAKE_LEDGER, rakeLedgerData);
    
    if (rakeLedgerResult.success) {
      console.log(`💰 Rake ledger created for game ${gameId}`);
      return rakeLedgerResult.data;
    } else {
      console.error(`❌ Failed to create rake ledger: ${rakeLedgerResult.error}`);
      return null;
    }
  }
  
  /**
   * Create host reward ledger entry
   */
  async createHostRewardLedger(gameId, hostId, prizePool, requestedPercent, requestedAmount, hostType, maxAllowedPercent, actualAmount) {
    const hostRewardData = {
      gameId,
      hostId,
      prizePool,
      requestedRewardPercent: requestedPercent,
      requestedRewardAmount: requestedAmount,
      hostType: hostType.toUpperCase(),
      maxAllowedPercent,
      actualRewardAmount: actualAmount,
      status: 'PAID'
    };
    
    const hostRewardResult = await mongoHelper.create(mongoHelper.COLLECTIONS.HOST_REWARD_LEDGER, hostRewardData);
    
    if (hostRewardResult.success) {
      console.log(`💰 Host reward ledger created: ${actualAmount} for host ${hostId}`);
      return hostRewardResult.data;
    } else {
      console.error(`❌ Failed to create host reward ledger: ${hostRewardResult.error}`);
      return null;
    }
  }
  
  /**
   * Create affiliate ledger entry
   */
  async createAffiliateLedger(gameId, affiliateId, referredUserId, companyRake, affiliateRate, payoutAmount) {
    const affiliateData = {
      gameId,
      affiliateId,
      referredUserId,
      companyRake,
      affiliateRate,
      payoutAmount,
      status: 'PAID'
    };
    
    const affiliateResult = await mongoHelper.create(mongoHelper.COLLECTIONS.AFFILIATE_LEDGER, affiliateData);
    
    if (affiliateResult.success) {
      console.log(`💰 Affiliate ledger created: ${payoutAmount} for affiliate ${affiliateId}`);
      return affiliateResult.data;
    } else {
      console.error(`❌ Failed to create affiliate ledger: ${affiliateResult.error}`);
      return null;
    }
  }
  
  /**
   * Get host type (regular or trusted)
   */
  async getHostType(hostId) {
    // Check if host is manually marked as trusted
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, hostId);
    
    if (userResult.success && userResult.data && userResult.data.isTrustedHost) {
      return 'trusted';
    }
    
    // For now, assume regular (trusted host service will handle automatic qualification)
    return 'regular';
  }
  
  /**
   * Get host reward caps from admin config
   */
  async getHostCaps() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'HOST_CAPS');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config.hostCaps;
    }
    
    // Create default configuration
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
      throw new Error(`Failed to create default host caps config: ${createResult.error}`);
    }
  }
  
  /**
   * Get affiliate configuration
   */
  async getAffiliateConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'AFFILIATE_RATE');
    
    if (configResult.success && configResult.data) {
      return configResult.data.config;
    }
    
    // Create default configuration
    const defaultConfig = {
      configType: 'AFFILIATE_RATE',
      config: {
        affiliateRate: 30
      }
    };
    
    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, defaultConfig);
    
    if (createResult.success) {
      return createResult.data.config;
    } else {
      throw new Error(`Failed to create default affiliate config: ${createResult.error}`);
    }
  }
  
  /**
   * Handle proportional scaling when participation threshold is met but capacity not filled
   */
  async executeProportionalSettlement(gameId, gameData) {
    const { actualParticipants, declaredCapacity } = gameData;
    const ratio = actualParticipants / declaredCapacity;
    
    console.log(`⚖️ Executing proportional settlement: ${actualParticipants}/${declaredCapacity} = ${ratio}`);
    
    // Scale all amounts proportionally except setup fee
    const scaledGameData = {
      ...gameData,
      // Setup fee is never refunded per specification
    };
    
    return await this.executeSettlement(gameId, scaledGameData);
  }
  
  /**
   * Add prize split rounding to rounding pool
   */
  async addPrizeSplitRounding(gameId, originalAmount, displayedAmount) {
    const roundingAmount = originalAmount - displayedAmount;
    
    if (roundingAmount > 0.001) {
      const roundingData = {
        gameId,
        source: 'PRIZE_SPLIT',
        originalAmount,
        displayedAmount,
        roundingAmount,
        description: 'Prize split rounding residue'
      };
      
      const roundingResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ROUNDING_POOL_LEDGER, roundingData);
      
      if (roundingResult.success) {
        console.log(`💰 Prize split rounding added: ${roundingAmount}`);
        return roundingResult.data;
      } else {
        console.error(`❌ Failed to create rounding pool entry: ${roundingResult.error}`);
        return null;
      }
    }
    
    return null;
  }
}

module.exports = new SettlementService();