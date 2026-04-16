const mongoHelper = require('../models/customdb');
const trustedHostService = require('./trusted-host.service');

class SettlementService {
  floorToCents(amount) {
    return Math.floor((Number(amount) + Number.EPSILON) * 100) / 100;
  }

  async executeSettlement(gameId, gameData) {
    const existingSettlement = await mongoHelper.findOne(
      mongoHelper.COLLECTIONS.GAME_FINANCIALS,
      'gameId',
      gameId
    );

    if (existingSettlement.success && existingSettlement.data && existingSettlement.data.status === 'SETTLED') {
      return {
        alreadySettled: true,
        gameFinancials: existingSettlement.data,
        settlement: {
          totalBuyIns: existingSettlement.data.totalBuyIns,
          totalRake: existingSettlement.data.totalRake,
          prizePool: existingSettlement.data.prizePool,
          remainingPrize: existingSettlement.data.remainingPrize,
          hostReward: existingSettlement.data.hostReward,
          hostUpliftCollected: existingSettlement.data.calculationSnapshot?.hostUpliftCollected || 0,
          hostTotalPayout: existingSettlement.data.calculationSnapshot?.hostTotalPayout || existingSettlement.data.hostReward,
          affiliatePayout: existingSettlement.data.affiliatePayout,
          companyShareBeforeAff: existingSettlement.data.companyShareBeforeAff,
          companyNet: existingSettlement.data.companyNet,
          platformRevenue: existingSettlement.data.platformRevenue,
          payoutSummary: {
            prizes: existingSettlement.data.remainingPrize,
            hostFromPrizePool: existingSettlement.data.hostReward,
            hostFromUplift: existingSettlement.data.calculationSnapshot?.hostUpliftCollected || 0,
            affiliate: existingSettlement.data.affiliatePayout,
            companyRetained: existingSettlement.data.companyNet
          }
        }
      };
    }

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
      setupFeeAmount = 0,
      affiliateId = null,
      totalWagered = null
    } = gameData;

    const settlementSteps = [];
    const totalBuyInsRaw = Number.isFinite(Number(totalWagered))
      ? Number(totalWagered)
      : actualParticipants * buyIn;
    const companyShareBeforeAffRaw = (tierRake / 100) * totalBuyInsRaw;
    const hostUpliftCollectedRaw = (hostUplift / 100) * totalBuyInsRaw;
    const totalRakeRaw = companyShareBeforeAffRaw + hostUpliftCollectedRaw;
    const prizePoolRaw = totalBuyInsRaw - totalRakeRaw;

    const totalBuyIns = this.floorToCents(totalBuyInsRaw);
    const companyShareBeforeAff = this.floorToCents(companyShareBeforeAffRaw);
    const hostUpliftCollected = this.floorToCents(hostUpliftCollectedRaw);
    const totalRake = this.floorToCents(totalRakeRaw);
    const prizePool = this.floorToCents(prizePoolRaw);
    const effectiveRake = tierRake + hostUplift;

    settlementSteps.push(
      Number.isFinite(Number(totalWagered))
        ? `Step 1: TotalBuyIns = totalWagered ${this.floorToCents(totalWagered)}`
        : `Step 1: TotalBuyIns = ${actualParticipants} x ${buyIn} = ${totalBuyIns}`
    );
    settlementSteps.push(`Step 2: CompanyBaseRake = ${tierRake}% x ${totalBuyIns} = ${companyShareBeforeAff}`);
    settlementSteps.push(`Step 3: HostUpliftCollected = ${hostUplift}% x ${totalBuyIns} = ${hostUpliftCollected}`);
    settlementSteps.push(`Step 4: TotalRake = ${companyShareBeforeAff} + ${hostUpliftCollected} = ${totalRake}`);
    settlementSteps.push(`Step 5: PrizePool = ${totalBuyIns} - ${totalRake} = ${prizePool}`);

    const hostType = await this.getHostType(hostId);
    const hostCaps = await this.getHostCaps();
    const hostCapPercent = hostId ? hostCaps[hostType] : 0;
    const hostRewardCap = this.floorToCents((hostCapPercent / 100) * prizePool);
    const requestedHostReward = this.floorToCents((hostRewardPercent / 100) * prizePool);
    const actualHostReward = Math.min(requestedHostReward, hostRewardCap);
    const remainingPrize = this.floorToCents(prizePool - actualHostReward);

    settlementSteps.push(`Step 6: HostCap = ${hostCapPercent}% x ${prizePool} = ${hostRewardCap}`);
    settlementSteps.push(`Step 7: RemainingPrize = ${prizePool} - ${actualHostReward} = ${remainingPrize}`);

    const affiliateConfig = await this.getAffiliateConfig();
    const affiliateRate = affiliateConfig.affiliateRate;
    const affiliatePayout = affiliateId
      ? this.floorToCents((affiliateRate / 100) * companyShareBeforeAff)
      : 0;
    const companyNet = this.floorToCents(companyShareBeforeAff - affiliatePayout);
    const platformRevenue = this.floorToCents(setupFeeAmount + companyNet);
    const hostTotalPayout = this.floorToCents(actualHostReward + hostUpliftCollected);

    settlementSteps.push(`Step 8: AffiliatePayout = ${affiliateRate}% x ${companyShareBeforeAff} = ${affiliatePayout}`);
    settlementSteps.push(`Step 9: CompanyNet = ${companyShareBeforeAff} - ${affiliatePayout} = ${companyNet}`);
    settlementSteps.push(`Step 10: PlatformRevenue = ${setupFeeAmount} + ${companyNet} = ${platformRevenue}`);

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
        hostType,
        affiliateRate,
        hostUpliftCollected,
        hostTotalPayout,
        timestamp: new Date()
      },
      status: 'SETTLED'
    };

    const gameFinancialsResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.GAME_FINANCIALS,
      gameFinancialsData
    );

    if (!gameFinancialsResult.success) {
      throw new Error(`Failed to create game financials: ${gameFinancialsResult.error}`);
    }

    await this.createRakeLedger(
      gameId,
      gameType,
      totalBuyIns,
      effectiveRake,
      totalRake,
      companyShareBeforeAff,
      affiliatePayout,
      hostUpliftCollected
    );

    if (actualHostReward > 0) {
      await this.createHostRewardLedger(
        gameId,
        hostId,
        prizePool,
        hostRewardPercent,
        requestedHostReward,
        hostType,
        hostCapPercent,
        actualHostReward
      );
    }

    if (affiliatePayout > 0 && affiliateId) {
      await this.createAffiliateLedger(
        gameId,
        affiliateId,
        hostId,
        companyShareBeforeAff,
        affiliateRate,
        affiliatePayout
      );
    }

    return {
      gameFinancials: gameFinancialsResult.data,
      settlement: {
        totalBuyIns,
        totalRake,
        prizePool,
        remainingPrize,
        hostReward: actualHostReward,
        hostUpliftCollected,
        hostTotalPayout,
        affiliatePayout,
        companyShareBeforeAff,
        companyNet,
        platformRevenue,
        payoutSummary: {
          prizes: remainingPrize,
          hostFromPrizePool: actualHostReward,
          hostFromUplift: hostUpliftCollected,
          affiliate: affiliatePayout,
          companyRetained: companyNet
        }
      }
    };
  }

  async createRakeLedger(gameId, gameType, totalWagered, rakePercentage, rakeAmount, companyShare, affiliateShare, hostShare) {
    const rakeLedgerResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.RAKE_LEDGER,
      {
        gameId,
        gameType,
        totalWagered,
        rakePercentage,
        rakeAmount,
        companyShare,
        affiliateShare,
        hostShare
      },
      mongoHelper.MODELS.RAKE_LEDGER
    );

    return rakeLedgerResult.success ? rakeLedgerResult.data : null;
  }

  async createHostRewardLedger(gameId, hostId, prizePool, requestedPercent, requestedAmount, hostType, maxAllowedPercent, actualAmount) {
    const hostRewardResult = await mongoHelper.create(mongoHelper.COLLECTIONS.HOST_REWARD_LEDGER, {
      gameId,
      hostId,
      prizePool,
      requestedRewardPercent: requestedPercent,
      requestedRewardAmount: requestedAmount,
      hostType: hostType.toUpperCase(),
      maxAllowedPercent,
      actualRewardAmount: actualAmount,
      status: 'PENDING'
    });

    return hostRewardResult.success ? hostRewardResult.data : null;
  }

  async createAffiliateLedger(gameId, affiliateId, referredUserId, companyRake, affiliateRate, payoutAmount) {
    const affiliateResult = await mongoHelper.create(mongoHelper.COLLECTIONS.AFFILIATE_LEDGER, {
      gameId,
      affiliateId,
      referredUserId,
      companyRake,
      affiliateRate,
      payoutAmount,
      status: 'PENDING'
    });

    return affiliateResult.success ? affiliateResult.data : null;
  }

  async getHostType(hostId) {
    if (!hostId) {
      return 'regular';
    }

    const privileges = await trustedHostService.getHostPrivileges(hostId);
    return privileges.hostType || 'regular';
  }

  async getHostCaps() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'HOST_CAPS');

    if (configResult.success && configResult.data) {
      return configResult.data.config.hostCaps;
    }

    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, {
      configType: 'HOST_CAPS',
      config: {
        hostCaps: {
          regular: 15,
          trusted: 25
        }
      }
    });

    if (!createResult.success) {
      throw new Error(`Failed to create default host caps config: ${createResult.error}`);
    }

    return createResult.data.config.hostCaps;
  }

  async getAffiliateConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'AFFILIATE_RATE');

    if (configResult.success && configResult.data) {
      return configResult.data.config;
    }

    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, {
      configType: 'AFFILIATE_RATE',
      config: { affiliateRate: 30 }
    });

    if (!createResult.success) {
      throw new Error(`Failed to create default affiliate config: ${createResult.error}`);
    }

    return createResult.data.config;
  }

  async executeProportionalSettlement(gameId, gameData) {
    return this.executeSettlement(gameId, gameData);
  }

  async addPrizeSplitRounding(gameId, originalAmount, displayedAmount) {
    const roundingAmount = originalAmount - displayedAmount;

    if (roundingAmount <= 0.001) {
      return null;
    }

    const roundingResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ROUNDING_POOL_LEDGER, {
      gameId,
      source: 'PRIZE_SPLIT',
      originalAmount,
      displayedAmount,
      roundingAmount,
      description: 'Prize split rounding residue'
    });

    return roundingResult.success ? roundingResult.data : null;
  }
}

module.exports = new SettlementService();
