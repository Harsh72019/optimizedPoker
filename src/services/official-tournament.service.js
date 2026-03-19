const { Tournament, TournamentPlayer } = require('../models/tournament.model');
const { GameFinancials, AdminConfig } = require('../models');
const settlementService = require('./settlement.service');
const walletIntegrationService = require('./wallet-integration.service');

class OfficialTournamentService {
  
  /**
   * Create scheduled/official tournament
   */
  async createOfficialTournament(tournamentConfig, adminId) {
    const {
      name,
      description,
      startTime,
      registrationDeadline,
      buyIn,
      maxPlayers,
      rakePercentage, // Must be between 5-8%
      templateId,
      timeZone = 'UTC'
    } = tournamentConfig;
    
    // Validate rake percentage
    await this.validateOfficialTournamentRake(rakePercentage);
    
    // Create tournament
    const tournament = new Tournament({
      name,
      description,
      startTime: new Date(startTime),
      registrationDeadline: new Date(registrationDeadline),
      buyIn,
      maxPlayers,
      templateId,
      timeZone,
      // Official tournament specific fields
      gameType: 'SCHEDULED_TOURNAMENT',
      isOfficial: true,
      createdBy: adminId,
      rakePercentage,
      status: 'registering'
    });
    
    await tournament.save();
    
    console.log(`🏆 Official tournament created: ${name} (${rakePercentage}% rake)`);
    
    return {
      tournament,
      rakePercentage,
      estimatedPrizePool: this.calculateEstimatedPrizePool(buyIn, maxPlayers, rakePercentage)
    };
  }
  
  /**
   * Validate official tournament rake percentage
   */
  async validateOfficialTournamentRake(rakePercentage) {
    const rakeConfig = await this.getOfficialTournamentRakeConfig();
    
    if (rakePercentage < rakeConfig.minRake || rakePercentage > rakeConfig.maxRake) {
      throw new Error(
        `Official tournament rake must be between ${rakeConfig.minRake}% and ${rakeConfig.maxRake}%. Provided: ${rakePercentage}%`
      );
    }
    
    return true;
  }
  
  /**
   * Get official tournament rake configuration
   */
  async getOfficialTournamentRakeConfig() {
    let config = await AdminConfig.findOne({ configType: 'OFFICIAL_TOURNAMENT_RAKE' });
    
    if (!config) {
      config = new AdminConfig({
        configType: 'OFFICIAL_TOURNAMENT_RAKE',
        config: {
          minRake: 5,
          maxRake: 8,
          defaultRake: 6,
          allowCustomRake: true
        }
      });
      await config.save();
    }
    
    return config.config;
  }
  
  /**
   * Calculate estimated prize pool
   */
  calculateEstimatedPrizePool(buyIn, maxPlayers, rakePercentage) {
    const totalBuyIns = buyIn * maxPlayers;
    const totalRake = (rakePercentage / 100) * totalBuyIns;
    const prizePool = totalBuyIns - totalRake;
    
    return {
      totalBuyIns,
      totalRake,
      prizePool,
      rakePercentage
    };
  }
  
  /**
   * Register player for official tournament
   */
  async registerPlayerForOfficial(tournamentId, userId) {
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      throw new Error('Tournament not found');
    }
    
    if (!tournament.isOfficial) {
      throw new Error('This is not an official tournament');
    }
    
    if (tournament.status !== 'registering') {
      throw new Error('Registration is not open for this tournament');
    }
    
    if (new Date() > tournament.registrationDeadline) {
      throw new Error('Registration deadline has passed');
    }
    
    // Check if already registered
    const existingPlayer = await TournamentPlayer.findOne({
      tournament: tournamentId,
      user: userId
    });
    
    if (existingPlayer) {
      throw new Error('Player already registered for this tournament');
    }
    
    // Charge buy-in
    const walletResult = await walletIntegrationService.chargeBuyIn(
      userId,
      tournament.buyIn,
      tournamentId
    );
    
    // Register player
    const tournamentPlayer = await tournament.registerPlayer(userId, walletResult.transactionId);
    
    console.log(`✅ Player ${userId} registered for official tournament ${tournamentId}`);
    
    return {
      success: true,
      tournamentPlayer,
      buyInCharged: tournament.buyIn,
      transactionId: walletResult.transactionId,
      currentRegistrations: tournament.players.length
    };
  }
  
  /**
   * Start official tournament
   */
  async startOfficialTournament(tournamentId, adminId) {
    const tournament = await Tournament.findById(tournamentId)
      .populate('players');
    
    if (!tournament) {
      throw new Error('Tournament not found');
    }
    
    if (!tournament.isOfficial) {
      throw new Error('This is not an official tournament');
    }
    
    if (tournament.status !== 'registering') {
      throw new Error('Tournament cannot be started in current status');
    }
    
    // Check minimum players
    const minPlayers = tournament.minPlayersPerTable || 2;
    if (tournament.players.length < minPlayers) {
      throw new Error(`Insufficient players. Minimum required: ${minPlayers}, Current: ${tournament.players.length}`);
    }
    
    // Initialize tournament from template
    await tournament.initializeFromTemplate();
    
    // Create tables and distribute players
    const multiTableService = require('./multi-table-tournament.service');
    const activePlayers = await TournamentPlayer.find({
      tournament: tournamentId,
      status: { $in: ['registered', 'waiting'] }
    });
    
    const tables = await multiTableService.createTournamentTables(tournamentId, activePlayers);
    
    // Update tournament status
    tournament.status = 'active';
    tournament.startedAt = new Date();
    tournament.startedBy = adminId;
    tournament.activeTables = tables;
    
    await tournament.save();
    
    console.log(`🚀 Official tournament started: ${tournament.name} with ${activePlayers.length} players across ${tables.length} tables`);
    
    return {
      success: true,
      tournament,
      playersCount: activePlayers.length,
      tablesCount: tables.length,
      prizePool: tournament.prizePool
    };
  }
  
  /**
   * Complete official tournament and execute settlement
   */
  async completeOfficialTournament(tournamentId, winners) {
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      throw new Error('Tournament not found');
    }
    
    if (!tournament.isOfficial) {
      throw new Error('This is not an official tournament');
    }
    
    // Execute financial settlement
    const settlementData = {
      gameType: 'SCHEDULED_TOURNAMENT',
      hostId: null, // No host for official tournaments
      buyIn: tournament.buyIn,
      declaredCapacity: tournament.maxPlayers,
      actualParticipants: tournament.players.length,
      participationThreshold: 100, // Official tournaments don't have thresholds
      tierRake: tournament.rakePercentage,
      hostUplift: 0,
      hostRewardPercent: 0,
      setupFeeAmount: 0, // No setup fee for official tournaments
      affiliateId: null // No affiliate for official tournaments
    };
    
    const settlement = await settlementService.executeSettlement(tournamentId, settlementData);
    
    // Process winner payouts
    const winnerPayouts = await walletIntegrationService.distributePrizePool(
      winners.map(winner => ({
        userId: winner.userId,
        amount: winner.prize,
        position: winner.position
      })),
      tournamentId
    );
    
    // Update tournament with winners
    tournament.winners = winners;
    tournament.status = 'completed';
    tournament.completedAt = new Date();
    
    await tournament.save();
    
    console.log(`🏆 Official tournament completed: ${tournament.name}`);
    console.log(`💰 Platform revenue: ${settlement.settlement.platformRevenue}`);
    
    return {
      success: true,
      tournament,
      settlement: settlement.settlement,
      winnerPayouts,
      platformRevenue: settlement.settlement.platformRevenue
    };
  }
  
  /**
   * Cancel official tournament
   */
  async cancelOfficialTournament(tournamentId, adminId, reason) {
    const tournament = await Tournament.findById(tournamentId)
      .populate('players');
    
    if (!tournament) {
      throw new Error('Tournament not found');
    }
    
    if (!tournament.isOfficial) {
      throw new Error('This is not an official tournament');
    }
    
    if (tournament.status === 'completed') {
      throw new Error('Cannot cancel completed tournament');
    }
    
    // Refund all players
    const playerIds = tournament.players.map(p => p.user);
    const refundResults = await walletIntegrationService.refundBuyIns(
      playerIds,
      tournament.buyIn,
      tournamentId
    );
    
    // Update tournament status
    tournament.status = 'cancelled';
    tournament.cancelledAt = new Date();
    tournament.cancelledBy = adminId;
    tournament.cancelReason = reason;
    
    await tournament.save();
    
    console.log(`❌ Official tournament cancelled: ${tournament.name} - ${reason}`);
    
    return {
      success: true,
      tournament,
      refundResults,
      totalRefunded: refundResults.length * tournament.buyIn
    };
  }
  
  /**
   * Get official tournament statistics
   */
  async getOfficialTournamentStats(dateRange = {}) {
    const { startDate, endDate } = dateRange;
    
    const matchStage = {
      isOfficial: true
    };
    
    if (startDate || endDate) {
      matchStage.createdAt = {};
      if (startDate) matchStage.createdAt.$gte = new Date(startDate);
      if (endDate) matchStage.createdAt.$lte = new Date(endDate);
    }
    
    const stats = await Tournament.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalTournaments: { $sum: 1 },
          completedTournaments: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          cancelledTournaments: {
            $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] }
          },
          totalPlayers: { $sum: { $size: '$players' } },
          totalPrizePool: { $sum: '$prizePool' },
          avgPlayersPerTournament: { $avg: { $size: '$players' } },
          avgBuyIn: { $avg: '$buyIn' }
        }
      }
    ]);
    
    return stats[0] || {
      totalTournaments: 0,
      completedTournaments: 0,
      cancelledTournaments: 0,
      totalPlayers: 0,
      totalPrizePool: 0,
      avgPlayersPerTournament: 0,
      avgBuyIn: 0
    };
  }
  
  /**
   * Update official tournament rake configuration
   */
  async updateOfficialTournamentRakeConfig(newConfig, adminId) {
    let config = await AdminConfig.findOne({ configType: 'OFFICIAL_TOURNAMENT_RAKE' });
    
    if (!config) {
      config = new AdminConfig({ configType: 'OFFICIAL_TOURNAMENT_RAKE', config: {} });
    }
    
    config.config = { ...config.config, ...newConfig };
    config.lastUpdatedBy = adminId;
    config.version += 1;
    
    await config.save();
    
    console.log(`⚙️ Official tournament rake config updated by admin ${adminId}`);
    
    return config;
  }
  
  /**
   * Get all official tournaments
   */
  async getAllOfficialTournaments(filters = {}) {
    const { status, startDate, endDate, limit = 50, skip = 0 } = filters;
    
    const query = { isOfficial: true };
    
    if (status) {
      query.status = status;
    }
    
    if (startDate || endDate) {
      query.startTime = {};
      if (startDate) query.startTime.$gte = new Date(startDate);
      if (endDate) query.startTime.$lte = new Date(endDate);
    }
    
    const tournaments = await Tournament.find(query)
      .populate('players', 'user')
      .sort({ startTime: -1 })
      .limit(limit)
      .skip(skip);
    
    return tournaments;
  }
}

module.exports = new OfficialTournamentService();