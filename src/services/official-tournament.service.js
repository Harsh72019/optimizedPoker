const mongoHelper = require('../models/customdb');
const settlementService = require('./settlement.service');
const walletIntegrationService = require('./wallet-integration.service');

class OfficialTournamentService {
  floorToCents(amount) {
    return Math.floor((Number(amount) + Number.EPSILON) * 100) / 100;
  }

  async createOfficialTournament(tournamentConfig, adminId) {
    const {
      name,
      description,
      startTime,
      registrationDeadline,
      buyIn,
      maxPlayers,
      rakePercentage,
      templateId,
      timeZone = 'UTC'
    } = tournamentConfig;

    await this.validateOfficialTournamentRake(rakePercentage);

    const createResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      {
        name,
        description,
        startTime: new Date(startTime),
        registrationDeadline: new Date(registrationDeadline),
        buyIn,
        maxPlayers,
        templateId,
        timeZone,
        gameType: 'SCHEDULED_TOURNAMENT',
        isOfficial: true,
        createdBy: adminId,
        rakePercentage,
        status: 'registering',
        players: [],
        winners: []
      },
      mongoHelper.MODELS.TOURNAMENT
    );

    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    return {
      tournament: createResult.data,
      rakePercentage,
      estimatedPrizePool: this.calculateEstimatedPrizePool(buyIn, maxPlayers, rakePercentage)
    };
  }

  async validateOfficialTournamentRake(rakePercentage) {
    const rakeConfig = await this.getOfficialTournamentRakeConfig();
    if (rakePercentage < rakeConfig.minRake || rakePercentage > rakeConfig.maxRake) {
      throw new Error(`Official tournament rake must be between ${rakeConfig.minRake}% and ${rakeConfig.maxRake}%. Provided: ${rakePercentage}%`);
    }
    return true;
  }

  async getOfficialTournamentRakeConfig() {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'OFFICIAL_TOURNAMENT_RAKE');
    if (configResult.success && configResult.data) {
      return configResult.data.config;
    }

    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, {
      configType: 'OFFICIAL_TOURNAMENT_RAKE',
      config: {
        minRake: 5,
        maxRake: 8,
        defaultRake: 6,
        allowCustomRake: true
      }
    });

    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    return createResult.data.config;
  }

  calculateEstimatedPrizePool(buyIn, maxPlayers, rakePercentage) {
    const totalBuyIns = buyIn * maxPlayers;
    const totalRake = this.floorToCents((rakePercentage / 100) * totalBuyIns);
    const prizePool = this.floorToCents(totalBuyIns - totalRake);
    return { totalBuyIns, totalRake, prizePool, rakePercentage };
  }

  async registerPlayerForOfficial(tournamentId, userId) {
    const tournamentResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TOURNAMENTS, tournamentId);
    if (!tournamentResult.success || !tournamentResult.data) {
      throw new Error('Tournament not found');
    }

    const tournament = tournamentResult.data;
    if (!tournament.isOfficial) throw new Error('This is not an official tournament');
    if (tournament.status !== 'registering') throw new Error('Registration is not open for this tournament');
    if (new Date() > new Date(tournament.registrationDeadline)) throw new Error('Registration deadline has passed');

    const existingPlayerResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, {
      tournament: tournamentId,
      user: userId
    });
    if (existingPlayerResult.success && existingPlayerResult.data && existingPlayerResult.data.length > 0) {
      throw new Error('Player already registered for this tournament');
    }

    const walletResult = await walletIntegrationService.chargeBuyIn(userId, tournament.buyIn, tournamentId);
    const playerCreateResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS,
      {
        tournament: tournamentId,
        user: userId,
        status: 'registered',
        transactionId: walletResult.transactionId,
        registeredAt: new Date()
      },
      mongoHelper.MODELS.TOURNAMENT_PLAYER
    );

    if (!playerCreateResult.success) {
      throw new Error(playerCreateResult.error);
    }

    const updatedPlayers = [...(tournament.players || []), playerCreateResult.data._id];
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      { players: updatedPlayers },
      mongoHelper.MODELS.TOURNAMENT
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error);
    }

    return {
      success: true,
      tournamentPlayer: playerCreateResult.data,
      buyInCharged: tournament.buyIn,
      transactionId: walletResult.transactionId,
      currentRegistrations: updatedPlayers.length
    };
  }

  async startOfficialTournament(tournamentId, adminId) {
    const tournamentResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TOURNAMENTS, tournamentId);
    if (!tournamentResult.success || !tournamentResult.data) throw new Error('Tournament not found');

    const tournament = tournamentResult.data;
    if (!tournament.isOfficial) throw new Error('This is not an official tournament');
    if (tournament.status !== 'registering') throw new Error('Tournament cannot be started in current status');

    const playerCount = (tournament.players || []).length;
    const minPlayers = tournament.minPlayersPerTable || 2;
    if (playerCount < minPlayers) {
      throw new Error(`Insufficient players. Minimum required: ${minPlayers}, Current: ${playerCount}`);
    }

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      {
        status: 'active',
        startedAt: new Date(),
        startedBy: adminId
      },
      mongoHelper.MODELS.TOURNAMENT
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error);
    }

    return {
      success: true,
      tournament: updateResult.data,
      playersCount: playerCount,
      tablesCount: 0,
      prizePool: this.calculateEstimatedPrizePool(tournament.buyIn, playerCount, tournament.rakePercentage).prizePool
    };
  }

  async completeOfficialTournament(tournamentId, winners) {
    const tournamentResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TOURNAMENTS, tournamentId);
    if (!tournamentResult.success || !tournamentResult.data) throw new Error('Tournament not found');

    const tournament = tournamentResult.data;
    if (!tournament.isOfficial) throw new Error('This is not an official tournament');

    const settlement = await settlementService.executeSettlement(tournamentId, {
      gameType: 'SCHEDULED_TOURNAMENT',
      hostId: null,
      buyIn: tournament.buyIn,
      declaredCapacity: tournament.maxPlayers,
      actualParticipants: (tournament.players || []).length,
      participationThreshold: 100,
      tierRake: tournament.rakePercentage,
      hostUplift: 0,
      hostRewardPercent: 0,
      setupFeeAmount: 0,
      affiliateId: null
    });

    const winnerPayouts = await walletIntegrationService.distributePrizePool(
      winners.map((winner) => ({
        userId: winner.userId,
        amount: winner.prize,
        position: winner.position
      })),
      tournamentId
    );

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      {
        winners,
        status: 'completed',
        completedAt: new Date()
      },
      mongoHelper.MODELS.TOURNAMENT
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error);
    }

    return {
      success: true,
      tournament: updateResult.data,
      settlement: settlement.settlement,
      winnerPayouts,
      platformRevenue: settlement.settlement.platformRevenue
    };
  }

  async cancelOfficialTournament(tournamentId, adminId, reason) {
    const tournamentResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TOURNAMENTS, tournamentId);
    if (!tournamentResult.success || !tournamentResult.data) throw new Error('Tournament not found');

    const tournament = tournamentResult.data;
    if (!tournament.isOfficial) throw new Error('This is not an official tournament');
    if (tournament.status === 'completed') throw new Error('Cannot cancel completed tournament');

    const playersResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENT_PLAYERS, { tournament: tournamentId });
    const playerIds = playersResult.success && playersResult.data ? playersResult.data.map((player) => player.user) : [];
    const refundResults = await walletIntegrationService.refundBuyIns(playerIds, tournament.buyIn, tournamentId);

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentId,
      {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: adminId,
        cancelReason: reason
      },
      mongoHelper.MODELS.TOURNAMENT
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error);
    }

    return {
      success: true,
      tournament: updateResult.data,
      refundResults,
      totalRefunded: refundResults.filter((result) => result.success).length * tournament.buyIn
    };
  }

  async getOfficialTournamentStats(dateRange = {}) {
    const matchStage = { isOfficial: true };
    if (dateRange.startDate || dateRange.endDate) {
      matchStage.createdAt = {};
      if (dateRange.startDate) matchStage.createdAt.$gte = new Date(dateRange.startDate);
      if (dateRange.endDate) matchStage.createdAt.$lte = new Date(dateRange.endDate);
    }

    const statsResult = await mongoHelper.aggregate(mongoHelper.COLLECTIONS.TOURNAMENTS, [
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalTournaments: { $sum: 1 },
          completedTournaments: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          cancelledTournaments: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          totalPlayers: { $sum: { $size: '$players' } },
          avgPlayersPerTournament: { $avg: { $size: '$players' } },
          avgBuyIn: { $avg: '$buyIn' }
        }
      }
    ]);

    return statsResult.success && statsResult.data && statsResult.data[0]
      ? statsResult.data[0]
      : {
          totalTournaments: 0,
          completedTournaments: 0,
          cancelledTournaments: 0,
          totalPlayers: 0,
          avgPlayersPerTournament: 0,
          avgBuyIn: 0
        };
  }

  async updateOfficialTournamentRakeConfig(newConfig, adminId) {
    const configResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.ADMIN_CONFIG, 'configType', 'OFFICIAL_TOURNAMENT_RAKE');

    if (configResult.success && configResult.data) {
      const updateResult = await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.ADMIN_CONFIG,
        configResult.data._id,
        {
          config: { ...configResult.data.config, ...newConfig },
          lastUpdatedBy: adminId,
          version: Number(configResult.data.version || 0) + 1
        }
      );

      if (!updateResult.success) {
        throw new Error(updateResult.error);
      }

      return updateResult.data;
    }

    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.ADMIN_CONFIG, {
      configType: 'OFFICIAL_TOURNAMENT_RAKE',
      config: newConfig,
      lastUpdatedBy: adminId,
      version: 1
    });

    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    return createResult.data;
  }

  async getAllOfficialTournaments(filters = {}) {
    const query = { isOfficial: true };
    if (filters.status) query.status = filters.status;
    if (filters.startDate || filters.endDate) {
      query.startTime = {};
      if (filters.startDate) query.startTime.$gte = new Date(filters.startDate);
      if (filters.endDate) query.startTime.$lte = new Date(filters.endDate);
    }

    const tournamentsResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TOURNAMENTS, query);
    if (!tournamentsResult.success || !tournamentsResult.data) {
      return [];
    }

    const skip = Number(filters.skip || 0);
    const limit = Number(filters.limit || 50);

    return tournamentsResult.data
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
      .slice(skip, skip + limit);
  }
}

module.exports = new OfficialTournamentService();
