const financialIntegrationService = require('./financial-integration.service');
const cashGameRakeService = require('./cash-game-rake.service');
const multiTableTournamentService = require('./multi-table-tournament.service');
const walletIntegrationService = require('./wallet-integration.service');
const trustedHostService = require('./trusted-host.service');

class GameEngineIntegrationService {
  
  /**
   * Hook: Called when a cash game hand is completed
   */
  async onCashGameHandCompleted(handData) {
    const {
      tableId,
      handNumber,
      potSize,
      playersInvolved,
      rakePercentage,
      hostUplift = 0
    } = handData;
    
    try {
      // Only collect rake if pot meets minimum threshold
      const rakeConfig = await cashGameRakeService.getCashGameRakeConfig();
      
      if (potSize < rakeConfig.minPotForRake) {
        console.log(`💰 No rake collected - pot ${potSize} below minimum ${rakeConfig.minPotForRake}`);
        return { rakeCollected: 0 };
      }
      
      // Collect rake
      const rakeResult = await cashGameRakeService.collectRake({
        tableId,
        handNumber,
        potSize,
        playersInvolved,
        rakePercentage,
        hostUplift
      });
      
      // Update player hand counts for tier progression
      await this.updatePlayerHandCounts(playersInvolved, tableId);
      
      console.log(`💰 Cash game rake collected: ${rakeResult.rakeCollected} from pot ${potSize}`);
      
      return rakeResult;
      
    } catch (error) {
      console.error(`❌ Cash game rake collection failed:`, error);
      throw error;
    }
  }
  
  /**
   * Hook: Called when a private table is created
   */
  async onPrivateTableCreated(tableData) {
    const {
      tableId,
      hostId,
      gameType,
      buyIn,
      maxPlayers,
      participationThreshold,
      tier,
      hostUplift,
      hostRewardPercent,
      estimatedHours,
      timerSeconds
    } = tableData;
    
    try {
      // Validate host privileges
      await trustedHostService.validateHostAction(hostId, 'HOST_UPLIFT', hostUplift || 0);
      await trustedHostService.validateHostAction(hostId, 'HOST_REWARD', hostRewardPercent || 0);
      
      // Create financial setup
      const financialSetup = await financialIntegrationService.onTableCreated({
        tableId,
        hostId,
        gameType,
        config: {
          buyIn,
          maxPlayers,
          participationThreshold,
          tier,
          hostUplift,
          hostRewardPercent,
          estimatedHours,
          timerSeconds
        }
      });
      
      // Calculate and charge setup fee
      const setupFeeResult = await require('./setup-fee.service').chargeSetupFee(
        tableId,
        hostId,
        { buyIn, declaredCapacity: maxPlayers, hours: estimatedHours, timerSeconds }
      );
      
      // Charge setup fee from host wallet
      const walletResult = await walletIntegrationService.chargeSetupFee(
        hostId,
        setupFeeResult.chargedAmount,
        tableId
      );
      
      console.log(`🎯 Private table created with financial setup: ${tableId}`);
      
      return {
        ...financialSetup,
        setupFee: {
          ...setupFeeResult,
          transactionId: walletResult.transactionId
        }
      };
      
    } catch (error) {
      console.error(`❌ Private table creation failed:`, error);
      throw error;
    }
  }
  
  /**
   * Hook: Called when a tournament/SNG is completed
   */
  async onTournamentCompleted(tournamentData) {
    const {
      gameId,
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
    } = tournamentData;
    
    try {
      // Execute financial settlement
      const settlement = await financialIntegrationService.onGameCompleted({
        gameId,
        tableId: gameId,
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
      });
      
      // Process wallet transactions
      const walletTransactions = [];
      
      // Pay host reward if applicable
      if (settlement.settlement.hostReward > 0 && hostId) {
        walletTransactions.push({
          type: 'PAY_HOST_REWARD',
          userId: hostId,
          amount: settlement.settlement.hostReward,
          gameId
        });
      }
      
      // Pay affiliate commission if applicable
      if (settlement.settlement.affiliatePayout > 0 && affiliateId) {
        walletTransactions.push({
          type: 'PAY_AFFILIATE',
          userId: affiliateId,
          amount: settlement.settlement.affiliatePayout,
          gameId,
          referredUserId: hostId
        });
      }
      
      // Process wallet transactions
      if (walletTransactions.length > 0) {
        await walletIntegrationService.batchProcessTransactions(walletTransactions);
      }
      
      // Distribute prize pool to winners
      if (winners && winners.length > 0) {
        await walletIntegrationService.distributePrizePool(winners, gameId);
      }
      
      console.log(`🏆 Tournament completed with settlement: ${gameId}`);
      console.log(`💰 Platform revenue: ${settlement.settlement.platformRevenue}`);
      
      return settlement;
      
    } catch (error) {
      console.error(`❌ Tournament completion failed:`, error);
      throw error;
    }
  }
  
  /**
   * Hook: Called when a player is eliminated from tournament
   */
  async onPlayerEliminated(tournamentId, eliminatedPlayerId) {
    try {
      const result = await multiTableTournamentService.onPlayerEliminated(
        tournamentId,
        eliminatedPlayerId
      );
      
      console.log(`❌ Player eliminated from tournament ${tournamentId}`);
      
      // Check if final table was formed
      if (result.rebalancing.finalTableFormed) {
        console.log(`🏆 Final table formed for tournament ${tournamentId}`);
        
        // Notify all remaining players about final table
        // This would integrate with your WebSocket system
        // this.notifyFinalTableFormed(tournamentId, result.rebalancing.finalTable);
      }
      
      return result;
      
    } catch (error) {
      console.error(`❌ Player elimination handling failed:`, error);
      throw error;
    }
  }
  
  /**
   * Hook: Called when a player joins a table
   */
  async onPlayerJoinedTable(tableId, playerId, buyInAmount) {
    try {
      // For cash games, charge buy-in
      if (buyInAmount > 0) {
        await walletIntegrationService.chargeBuyIn(playerId, buyInAmount, tableId);
        console.log(`💰 Buy-in charged: ${buyInAmount} from player ${playerId}`);
      }
      
      // Update player statistics
      await this.updatePlayerStats(playerId, 'TABLE_JOINED');
      
      return { success: true };
      
    } catch (error) {
      console.error(`❌ Player join handling failed:`, error);
      throw error;
    }
  }
  
  /**
   * Hook: Called when a player leaves a table
   */
  async onPlayerLeftTable(tableId, playerId, finalChips) {
    try {
      // For cash games, process cashout
      if (finalChips > 0) {
        // This would typically be handled by your existing blockchain service
        // but we can log it for financial tracking
        console.log(`💰 Player cashout: ${finalChips} chips for player ${playerId}`);
      }
      
      // Update player statistics
      await this.updatePlayerStats(playerId, 'TABLE_LEFT');
      
      return { success: true };
      
    } catch (error) {
      console.error(`❌ Player leave handling failed:`, error);
      throw error;
    }
  }
  
  /**
   * Update player hand counts for tier progression
   */
  async updatePlayerHandCounts(playerIds, tableId) {
    try {
      // This would integrate with your player statistics system
      for (const playerId of playerIds) {
        // Increment hand count for each player
        // This could be used for tier progression, rewards, etc.
        console.log(`📊 Hand count updated for player ${playerId} at table ${tableId}`);
      }
    } catch (error) {
      console.error(`❌ Player hand count update failed:`, error);
    }
  }
  
  /**
   * Update player statistics
   */
  async updatePlayerStats(playerId, action) {
    try {
      // This would integrate with your player statistics system
      console.log(`📊 Player stats updated: ${playerId} - ${action}`);
    } catch (error) {
      console.error(`❌ Player stats update failed:`, error);
    }
  }
  
  /**
   * Get financial preview for table creation UI
   */
  async getTableCreationPreview(tableConfig) {
    try {
      const preview = await financialIntegrationService.getTableFinancialPreview(tableConfig);
      return preview;
    } catch (error) {
      console.error(`❌ Financial preview generation failed:`, error);
      throw error;
    }
  }
  
  /**
   * Validate table configuration before creation
   */
  async validateTableConfiguration(hostId, tableConfig) {
    try {
      const validation = await financialIntegrationService.validateTableFinancials(
        hostId,
        tableConfig
      );
      
      if (!validation.valid) {
        throw new Error(validation.error);
      }
      
      return validation;
    } catch (error) {
      console.error(`❌ Table configuration validation failed:`, error);
      throw error;
    }
  }
  
  /**
   * Handle insufficient participation (below threshold)
   */
  async onInsufficientParticipation(gameId, gameData) {
    try {
      // Refund all players except setup fee
      const playerIds = gameData.playerIds || [];
      const refundResults = await walletIntegrationService.refundBuyIns(
        playerIds,
        gameData.buyIn,
        gameId
      );
      
      console.log(`💰 Refunded ${refundResults.length} players due to insufficient participation`);
      console.log(`💰 Setup fee kept: ${gameData.setupFeeAmount}`);
      
      return {
        refunded: true,
        refundResults,
        setupFeeKept: gameData.setupFeeAmount
      };
      
    } catch (error) {
      console.error(`❌ Insufficient participation handling failed:`, error);
      throw error;
    }
  }
  
  /**
   * Get real-time financial metrics for admin dashboard
   */
  async getRealtimeFinancialMetrics() {
    try {
      // This would aggregate real-time financial data
      const metrics = {
        activeTables: 0, // Count of active cash game tables
        activeTournaments: 0, // Count of active tournaments
        totalRakeCollectedToday: 0,
        totalSetupFeesCollectedToday: 0,
        totalPlatformRevenueToday: 0,
        playersOnline: 0
      };
      
      // TODO: Implement actual metric collection
      
      return metrics;
    } catch (error) {
      console.error(`❌ Realtime metrics collection failed:`, error);
      throw error;
    }
  }
}

module.exports = new GameEngineIntegrationService();