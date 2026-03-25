const financialService = require('./financial.service');
const setupFeeService = require('./setup-fee.service');
const settlementService = require('./settlement.service');
const { GameFinancials } = require('../models');

class FinancialIntegrationService {

  /**
   * Hook into table creation process
   */
  async onTableCreated(tableData) {
    const { tableId, hostId, gameType, config } = tableData;

    // Only process private tables that require setup fees
    if (!['PRIVATE_SNG', 'PRIVATE_TOURNAMENT'].includes(gameType)) {
      return null;
    }

    try {
      // Create financial setup
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

      // Store financial setup reference in table
      console.log(`💰 Financial setup completed for table ${tableId}:`, {
        tierRake: financialSetup.tierRake,
        effectiveRake: financialSetup.effectiveRake
      });

      return financialSetup;

    } catch (error) {
      console.error(`❌ Financial setup failed for table ${tableId}:`, error);
      throw error;
    }
  }

  /**
   * Hook into game completion process
   */
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

    try {
      // Execute settlement
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

      console.log(`💰 Settlement completed for game ${gameId}:`, {
        platformRevenue: settlement.settlement.platformRevenue,
        prizePool: settlement.settlement.remainingPrize,
        hostReward: settlement.settlement.hostReward
      });

      // Process winner payouts with rounding
      if (winners && winners.length > 0) {
        await this.processWinnerPayouts(gameId, winners, settlement.settlement.remainingPrize);
      }

      return settlement;

    } catch (error) {
      console.error(`❌ Settlement failed for game ${gameId}:`, error);
      throw error;
    }
  }

  /**
   * Process winner payouts with proper rounding
   */
  async processWinnerPayouts(gameId, winners, totalPrizePool) {
    let distributedAmount = 0;
    const payouts = [];

    for (const winner of winners) {
      const { playerId, percentage } = winner;
      const exactAmount = (percentage / 100) * totalPrizePool;
      const payoutAmount = Math.floor(exactAmount * 100) / 100;

      payouts.push({
        playerId,
        exactAmount,
        payoutAmount,
        roundingLoss: exactAmount - payoutAmount
      });

      distributedAmount += payoutAmount;
    }

    // Add rounding residue to rounding pool
    const totalRoundingLoss = totalPrizePool - distributedAmount;
    if (totalRoundingLoss > 0.001) {
      await settlementService.addPrizeSplitRounding(gameId, totalPrizePool, distributedAmount);
    }

    console.log(`💰 Winner payouts processed for game ${gameId}:`, {
      totalPrize: totalPrizePool,
      distributed: distributedAmount,
      roundingPool: totalRoundingLoss
    });

    return payouts;
  }

  /**
   * Hook into cash game rake collection
   */
  async onCashGameHandCompleted(handData) {
    const {
      tableId,
      potSize,
      rakeAmount,
      playersInvolved,
      handNumber
    } = handData;

    // This would integrate with cash game rake tracking
    // For now, just log the rake collection
    console.log(`💰 Cash game rake collected:`, {
      tableId,
      handNumber,
      potSize,
      rakeAmount,
      players: playersInvolved.length
    });

    // TODO: Implement cash game rake ledger updates
    // This would track rake per hand for cash games

    return { rakeCollected: rakeAmount };
  }

  /**
   * Get financial preview for UI display
   */
  async getTableFinancialPreview(tableConfig) {
    try {
      const preview = await financialService.generateFinancialPreview(tableConfig);
      return preview;
    } catch (error) {
      console.error('❌ Failed to generate financial preview:', error);
      throw error;
    }
  }

  /**
   * Validate table financial configuration
   */
  async validateTableFinancials(hostId, tableConfig) {
    const { gameType, hostUplift, hostRewardPercent } = tableConfig;

    const validations = [];

    try {
      // Validate host uplift for SNG
      if (gameType === 'PRIVATE_SNG' && hostUplift > 0) {
        const rakeTierService = require('./rake-tier.service');
        await rakeTierService.validateHostUplift(hostId, hostUplift);
        validations.push({ type: 'hostUplift', valid: true });
      }

      // Validate host reward percentage
      if (hostRewardPercent > 0) {
        await financialService.validateHostReward(hostId, hostRewardPercent);
        validations.push({ type: 'hostReward', valid: true });
      }

      return { valid: true, validations };

    } catch (error) {
      return {
        valid: false,
        error: error.message,
        validations
      };
    }
  }

  /**
   * Get host financial summary
   */
  async getHostFinancialSummary(hostId, dateRange = {}) {
    const { startDate, endDate } = dateRange;

    const matchStage = {
      hostId,
      status: 'SETTLED'
    };

    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }

    const summary = await GameFinancials.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalGamesHosted: { $sum: 1 },
          totalSetupFeesPaid: { $sum: '$setupFee' },
          totalHostRewards: { $sum: '$hostReward' },
          totalPrizePoolsGenerated: { $sum: '$prizePool' },
          avgParticipation: {
            $avg: {
              $divide: ['$actualParticipants', '$declaredCapacity']
            }
          },
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

    return summary[0] || {
      totalGamesHosted: 0,
      totalSetupFeesPaid: 0,
      totalHostRewards: 0,
      totalPrizePoolsGenerated: 0,
      avgParticipation: 0
    };
  }
}

module.exports = new FinancialIntegrationService();