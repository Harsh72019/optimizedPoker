const financialService = require('./financial.service');
const settlementService = require('./settlement.service');
const walletIntegrationService = require('./wallet-integration.service');
const mongoHelper = require('../models/customdb');

class FinancialIntegrationService {
  floorToCents(amount) {
    return Math.floor((Number(amount) + Number.EPSILON) * 100) / 100;
  }

  async onTableCreated(tableData) {
    const { tableId, hostId, gameType, config } = tableData;

    if (!['PRIVATE_SNG', 'PRIVATE_TOURNAMENT'].includes(gameType)) {
      return null;
    }

    const financialSetup = await financialService.createPrivateTable(hostId, {
      gameType,
      buyIn: config.buyIn,
      declaredCapacity: config.maxPlayers,
      participationThreshold: config.participationThreshold || 75,
      tier: config.tier || 1,
      hostUplift: config.hostUplift || 0,
      hostRewardPercent: config.hostRewardPercent || 0,
      hours: config.estimatedHours || 2,
      timerSeconds: config.timerSeconds || 30
    });

    return financialSetup;
  }

  async onGameCompleted(gameData) {
    const {
      gameId,
      tableId,
      gameType,
      hostId,
      buyIn,
      declaredCapacity,
      actualParticipants,
      participationThreshold,
      tierRake,
      hostUplift,
      hostRewardPercent,
      setupFeeAmount,
      affiliateId,
      winners
    } = gameData;

    const settlement = await financialService.settleGame(gameId, {
      gameType,
      hostId,
      buyIn,
      declaredCapacity,
      actualParticipants,
      participationThreshold,
      tierRake,
      hostUplift,
      hostRewardPercent,
      setupFeeAmount,
      affiliateId
    });

    if (settlement.alreadySettled) {
      const payoutPlan = winners && winners.length > 0 && settlement.settlement
        ? await this.processWinnerPayouts(gameId, winners, settlement.settlement.remainingPrize)
        : [];

      const walletResults = await this.executeSettlementPayouts({
        gameId,
        sourceTableId: tableId,
        hostId,
        affiliateId,
        settlement: settlement.settlement,
        winnerPayouts: payoutPlan
      });

      return {
        ...settlement,
        payoutPlan,
        walletResults
      };
    }

    const payoutPlan = winners && winners.length > 0 && settlement.settlement
      ? await this.processWinnerPayouts(gameId, winners, settlement.settlement.remainingPrize)
      : [];

    const walletResults = await this.executeSettlementPayouts({
      gameId,
      sourceTableId: tableId,
      hostId,
      affiliateId,
      settlement: settlement.settlement,
      winnerPayouts: payoutPlan
    });

    return {
      ...settlement,
      payoutPlan,
      walletResults
    };
  }

  async processWinnerPayouts(gameId, winners, totalPrizePool) {
    let distributedAmount = 0;
    const payouts = [];

    for (const winner of winners) {
      const { playerId, percentage } = winner;
      const exactAmount = (percentage / 100) * totalPrizePool;
      const payoutAmount = this.floorToCents(exactAmount);

      payouts.push({
        userId: playerId,
        position: winner.position,
        amount: payoutAmount,
        exactAmount,
        roundingLoss: exactAmount - payoutAmount
      });

      distributedAmount += payoutAmount;
    }

    const totalRoundingLoss = totalPrizePool - distributedAmount;
    if (totalRoundingLoss > 0.001) {
      await settlementService.addPrizeSplitRounding(gameId, totalPrizePool, distributedAmount);
    }

    return payouts;
  }

  async executeSettlementPayouts({ gameId, sourceTableId, hostId, affiliateId, settlement, winnerPayouts }) {
    if (!settlement) {
      return { winners: [], host: null, hostUplift: null, affiliate: null };
    }

    const results = {
      winners: [],
      host: null,
      hostUplift: null,
      affiliate: null
    };

    if (winnerPayouts && winnerPayouts.length > 0) {
      results.winners = await walletIntegrationService.distributePrizePool(winnerPayouts, gameId, { sourceTableId });
    }

    if (hostId && settlement.hostReward > 0) {
      try {
        results.host = await walletIntegrationService.payHostReward(hostId, settlement.hostReward, gameId, { sourceTableId });
      } catch (error) {
        results.host = { success: false, error: error.message };
      }
    }

    if (hostId && settlement.hostUpliftCollected > 0) {
      try {
        results.hostUplift = await walletIntegrationService.payHostReward(
          hostId,
          settlement.hostUpliftCollected,
          `${gameId}_uplift`,
          { sourceTableId }
        );
      } catch (error) {
        results.hostUplift = { success: false, error: error.message };
      }
    }

    if (affiliateId && settlement.affiliatePayout > 0) {
      try {
        results.affiliate = await walletIntegrationService.payAffiliateCommission(
          affiliateId,
          settlement.affiliatePayout,
          gameId,
          hostId,
          { sourceTableId }
        );
      } catch (error) {
        results.affiliate = { success: false, error: error.message };
      }
    }

    return results;
  }

  async onCashGameHandCompleted(handData) {
    const { tableId, potSize, rakeAmount, playersInvolved, handNumber } = handData;
    return {
      tableId,
      handNumber,
      potSize,
      rakeCollected: rakeAmount,
      players: playersInvolved.length
    };
  }

  async getTableFinancialPreview(tableConfig) {
    return financialService.generateFinancialPreview(tableConfig);
  }

  async validateTableFinancials(hostId, tableConfig) {
    const { gameType, hostUplift, hostRewardPercent } = tableConfig;
    const validations = [];

    try {
      if (gameType === 'PRIVATE_SNG' && hostUplift > 0) {
        const rakeTierService = require('./rake-tier.service');
        await rakeTierService.validateHostUplift(hostId, hostUplift);
        validations.push({ type: 'hostUplift', valid: true });
      }

      if (hostRewardPercent > 0) {
        await financialService.validateHostReward(hostId, hostRewardPercent);
        validations.push({ type: 'hostReward', valid: true });
      }

      return { valid: true, validations };
    } catch (error) {
      return { valid: false, error: error.message, validations };
    }
  }

  async getHostFinancialSummary(hostId, dateRange = {}) {
    const matchStage = { hostId, status: 'SETTLED' };

    if (dateRange.startDate || dateRange.endDate) {
      matchStage.createdAt = {};
      if (dateRange.startDate) matchStage.createdAt.$gte = new Date(dateRange.startDate);
      if (dateRange.endDate) matchStage.createdAt.$lte = new Date(dateRange.endDate);
    }

    const summaryResult = await mongoHelper.aggregate(mongoHelper.COLLECTIONS.GAME_FINANCIALS, [
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalGamesHosted: { $sum: 1 },
          totalSetupFeesPaid: { $sum: '$setupFee' },
          totalHostRewards: { $sum: '$hostReward' },
          totalPrizePoolsGenerated: { $sum: '$prizePool' },
          avgParticipation: { $avg: { $divide: ['$actualParticipants', '$declaredCapacity'] } },
          gamesByType: {
            $push: {
              gameType: '$gameType',
              participants: '$actualParticipants',
              hostReward: '$hostReward'
            }
          }
        }
      }
    ]);

    return summaryResult.success && summaryResult.data && summaryResult.data[0]
      ? summaryResult.data[0]
      : {
          totalGamesHosted: 0,
          totalSetupFeesPaid: 0,
          totalHostRewards: 0,
          totalPrizePoolsGenerated: 0,
          avgParticipation: 0
        };
  }
}

module.exports = new FinancialIntegrationService();
