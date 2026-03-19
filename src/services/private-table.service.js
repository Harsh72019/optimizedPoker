const mongoHelper = require('../models/customdb');
const financialService = require('./financial.service');
const setupFeeService = require('./setup-fee.service');
const rakeTierService = require('./rake-tier.service');
const commissionPreviewService = require('./commission-preview.service');

class PrivateTableService {
  
  /**
   * Create a new private table with financial setup
   */
  async createPrivateTable(hostId, tableConfig) {
    const {
      name,
      description,
      gameType,
      buyIn,
      declaredCapacity,
      participationThreshold,
      tier,
      hostUplift = 0,
      hostRewardPercent = 0,
      estimatedHours,
      timerSeconds,
      scheduledStartTime,
      password,
      allowSpectators = false,
      blindStructure,
      payoutStructure,
      affiliateId
    } = tableConfig;
    
    // Validate host permissions and uplift
    await this.validateHostConfiguration(hostId, gameType, hostUplift, hostRewardPercent);
    
    // Get tier rake
    const tierRake = gameType === 'PRIVATE_SNG' 
      ? await rakeTierService.getSNGRake(tier)
      : await rakeTierService.getTournamentRake(tier);
    
    const effectiveRake = tierRake + (hostUplift || 0);
    
    // Calculate and charge setup fee first (with temporary ID)
    const tempId = `private_${Date.now()}`;
    const setupFeeResult = await setupFeeService.chargeSetupFee(
      tempId,
      hostId,
      { buyIn, declaredCapacity, hours: estimatedHours, timerSeconds }
    );
    
    // Create private table record using mongoHelper (let it generate Doc_ ID)
    const privateTableData = {
      name,
      description,
      hostId,
      gameType,
      buyIn,
      declaredCapacity,
      participationThreshold,
      estimatedHours,
      timerSeconds,
      tier,
      hostUplift,
      hostRewardPercent,
      tierRake,
      effectiveRake,
      setupFeeAmount: setupFeeResult.chargedAmount,
      setupFeePaid: true,
      setupFeeTransactionId: setupFeeResult.ledgerEntry._id,
      status: 'WAITING_FOR_PLAYERS',
      scheduledStartTime: scheduledStartTime ? new Date(scheduledStartTime) : null,
      password,
      allowSpectators,
      blindStructure,
      payoutStructure: payoutStructure || this.getDefaultPayoutStructure(declaredCapacity),
      affiliateId,
      createdBy: 'HOST',
      registeredPlayers: [],
      waitlist: [],
      tables: [],
      winners: [],
      settlementCompleted: false,
      isPrivate: true,
      stats: {
        totalHandsPlayed: 0,
        averagePotSize: 0,
        longestGame: 0,
        peakPlayers: 0
      }
    };
    
    const result = await mongoHelper.create(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      privateTableData
    );
    
    if (!result.success) {
      throw new Error('Failed to create private table: ' + result.error);
    }
    
    const privateTable = result.data;
    
    return {
      privateTable,
      setupFee: setupFeeResult,
      financialPreview: await this.generateFinancialPreview(privateTable)
    };
  }
  
  /**
   * Register player for private table
   */
  async registerPlayer(tableId, userId) {
    const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.PRIVATE_TABLES, tableId);
    
    if (!tableResult.success || !tableResult.data) {
      throw new Error('Private table not found');
    }
    
    const privateTable = tableResult.data;
    
    // Check if already registered
    const alreadyRegistered = privateTable.registeredPlayers?.some(
      p => p.userId?.toString() === userId.toString()
    );
    
    if (alreadyRegistered) {
      throw new Error('Player already registered');
    }
    
    // Check capacity
    const currentCount = privateTable.registeredPlayers?.length || 0;
    const isFull = currentCount >= privateTable.declaredCapacity;
    
    if (isFull) {
      // Add to waitlist
      const waitlist = privateTable.waitlist || [];
      waitlist.push({
        userId,
        waitlistedAt: new Date(),
        position: waitlist.length + 1
      });
      
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.PRIVATE_TABLES,
        tableId,
        { waitlist }
      );
      
      return {
        registered: false,
        waitlisted: true,
        position: waitlist.length,
        tableStatus: privateTable.status,
        playersRegistered: currentCount,
        spotsRemaining: 0
      };
    }
    
    // Register player
    const registeredPlayers = privateTable.registeredPlayers || [];
    registeredPlayers.push({
      userId,
      registeredAt: new Date(),
      buyInPaid: false,
      status: 'REGISTERED'
    });
    
    // Check if threshold met
    const newCount = registeredPlayers.length;
    const thresholdPercentage = (newCount / privateTable.declaredCapacity) * 100;
    const thresholdMet = thresholdPercentage >= privateTable.participationThreshold;
    const newStatus = thresholdMet ? 'READY_TO_START' : 'WAITING_FOR_PLAYERS';
    
    console.log(`📊 Threshold Check: ${newCount}/${privateTable.declaredCapacity} = ${thresholdPercentage.toFixed(2)}% >= ${privateTable.participationThreshold}% ? ${thresholdMet} → Status: ${newStatus}`);
    
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      tableId,
      { 
        registeredPlayers,
        status: newStatus
      }
    );
    
    if (!updateResult.success) {
      console.error(`❌ Failed to update table:`, updateResult.error);
      throw new Error('Failed to register player: ' + updateResult.error);
    }
    
    console.log(`✅ Player registered. Updated status to: ${newStatus}`);
    console.log(`📝 Update result:`, JSON.stringify(updateResult.data, null, 2));
    
    return {
      registered: true,
      waitlisted: false,
      position: newCount,
      tableStatus: newStatus,
      playersRegistered: newCount,
      spotsRemaining: privateTable.declaredCapacity - newCount
    };
  }
  
  /**
   * Start private table game
   */
  async startPrivateTable(tableId, hostId) {
    // Add small delay to ensure DB is updated
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.PRIVATE_TABLES, tableId);
    
    if (!tableResult.success || !tableResult.data) {
      throw new Error('Private table not found');
    }
    
    const privateTable = tableResult.data;
    
    console.log(`🎮 Start attempt - Status: ${privateTable.status}, Players: ${privateTable.registeredPlayers?.length || 0}/${privateTable.declaredCapacity}, Threshold: ${privateTable.participationThreshold}%`);
    console.log(`📋 Registered players:`, privateTable.registeredPlayers);
    
    if (privateTable.hostId.toString() !== hostId.toString()) {
      throw new Error('Only the host can start the table');
    }
    
    if (privateTable.status !== 'READY_TO_START') {
      const currentPercentage = ((privateTable.registeredPlayers?.length || 0) / privateTable.declaredCapacity) * 100;
      throw new Error(`Table is not ready to start. Need ${privateTable.participationThreshold}% (${Math.ceil(privateTable.declaredCapacity * privateTable.participationThreshold / 100)} players), currently at ${currentPercentage.toFixed(0)}% (${privateTable.registeredPlayers?.length || 0} players)`);
    }
    
    // Start the game based on type
    let gameResult;
    
    if (privateTable.gameType === 'PRIVATE_SNG') {
      gameResult = await this.startPrivateSNG(privateTable);
    } else {
      gameResult = await this.startPrivateTournament(privateTable);
    }
    
    // Update private table status
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      tableId,
      {
        status: 'ACTIVE',
        actualStartTime: new Date()
      }
    );
    
    return {
      privateTable,
      gameResult,
      message: `${privateTable.gameType} started successfully!`
    };
  }
  
  /**
   * Start Private SNG (creates underlying table using existing system)
   */
  async startPrivateSNG(privateTable) {
    // Find a suitable SubTier for the buy-in amount
    const subTier = await this.findSubTierForBuyIn(privateTable.buyIn);
    
    if (!subTier) {
      throw new Error('No suitable table configuration found for this buy-in');
    }
    
    // Create underlying table using existing system
    const tableResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TABLES,
      {
        maxPlayers: privateTable.registeredPlayers.length,
        subTierId: subTier._id,
        currentPlayers: [],
        gameRoundsCompleted: 0,
        dealerPosition: null,
        currentTurnPosition: null,
        smallBlindPosition: null,
        bigBlindPosition: null,
        status: 'in-use',
        isPrivate: true,
        privateTableId: privateTable._id
      },
      mongoHelper.MODELS.TABLE
    );
    
    if (!tableResult.success) {
      throw new Error('Failed to create underlying table: ' + tableResult.error);
    }
    
    const underlyingTable = tableResult.data;
    
    // Update private table with underlying table reference
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      privateTable._id,
      { underlyingTableId: underlyingTable._id }
    );
    
    return {
      underlyingTable,
      playersToAdd: privateTable.registeredPlayers.length,
      subTier
    };
  }
  
  /**
   * Start Private Tournament
   */
  async startPrivateTournament(privateTable) {
    // Create tournament record using mongoHelper
    const tournamentData = {
      name: privateTable.name,
      description: privateTable.description,
      buyIn: privateTable.buyIn,
      maxPlayers: privateTable.declaredCapacity,
      startTime: new Date(),
      registrationDeadline: new Date(),
      status: 'active',
      isPrivate: true,
      hostId: privateTable.hostId,
      tier: privateTable.tier,
      hostRewardPercent: privateTable.hostRewardPercent,
      participationThreshold: privateTable.participationThreshold,
      estimatedHours: privateTable.estimatedHours,
      timerSeconds: privateTable.timerSeconds,
      startingChips: privateTable.blindStructure?.startingChips || 10000,
      levelDuration: privateTable.blindStructure?.levelDuration || 15,
      payoutStructure: privateTable.payoutStructure,
      timeZone: 'UTC',
      tierRake: privateTable.tierRake,
      effectiveRake: privateTable.effectiveRake,
      setupFeeAmount: privateTable.setupFeeAmount,
      affiliateId: privateTable.affiliateId,
      registeredPlayers: privateTable.registeredPlayers.map(p => p.userId)
    };
    
    const tournamentResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TOURNAMENTS,
      tournamentData,
      mongoHelper.MODELS.TOURNAMENT
    );
    
    if (!tournamentResult.success) {
      throw new Error('Failed to create tournament: ' + tournamentResult.error);
    }
    
    const tournament = tournamentResult.data;
    
    // Update private table with tournament reference
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      privateTable._id,
      { tournamentId: tournament._id }
    );
    
    return {
      tournament,
      playersRegistered: privateTable.registeredPlayers.length
    };
  }
  
  /**
   * Get private table with details
   */
  async getPrivateTable(tableId) {
    const result = await mongoHelper.findById(mongoHelper.COLLECTIONS.PRIVATE_TABLES, tableId);
    return result.success ? result.data : null;
  }
  
  /**
   * Get private table with populated details
   */
  async getPrivateTableWithDetails(tableId) {
    const result = await mongoHelper.findByIdWithPopulate(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      tableId,
      [
        { path: 'hostId', collection: mongoHelper.COLLECTIONS.USERS, select: 'username email' },
        { path: 'registeredPlayers.userId', collection: mongoHelper.COLLECTIONS.USERS, select: 'username' }
      ]
    );
    return result.success ? result.data : null;
  }
  
  /**
   * Cancel private table
   */
  async cancelPrivateTable(tableId, hostId, reason) {
    const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.PRIVATE_TABLES, tableId);
    
    if (!tableResult.success || !tableResult.data) {
      throw new Error('Private table not found');
    }
    
    const privateTable = tableResult.data;
    
    if (privateTable.hostId.toString() !== hostId.toString()) {
      throw new Error('Only the host can cancel the table');
    }
    
    if (['COMPLETED', 'CANCELLED'].includes(privateTable.status)) {
      throw new Error('Table cannot be cancelled in current status');
    }
    
    // Update status to cancelled
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      tableId,
      {
        status: 'CANCELLED',
        cancelReason: reason,
        completedAt: new Date()
      }
    );
    
    // TODO: Process refunds for registered players
    const refundAmount = (privateTable.registeredPlayers?.length || 0) * privateTable.buyIn;
    
    return {
      cancelled: true,
      refundAmount,
      reason
    };
  }
  
  /**
   * Get private tables for host
   */
  async getHostTables(hostId, status = null) {
    const query = { hostId };
    if (status) query.status = status;
    
    const result = await mongoHelper.findWithPopulate(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      query,
      [
        { path: 'hostId', collection: mongoHelper.COLLECTIONS.USERS, select: 'username' }
      ]
    );
    
    return result.success ? result.data : [];
  }
  
  /**
   * Find suitable SubTier for buy-in amount
   */
  async findSubTierForBuyIn(buyIn) {
    // Find SubTier where buyIn falls within the range (bb * 20 to bb * 100)
    const subTiersResult = await mongoHelper.getAll(mongoHelper.COLLECTIONS.SUB_TIERS, {});
    
    if (!subTiersResult.success) {
      throw new Error('Failed to fetch SubTiers');
    }
    
    for (const subTier of subTiersResult.data) {
      const bb = subTier.tableConfig.bb;
      const minBuyIn = bb * 20;
      const maxBuyIn = bb * 100;
      
      if (buyIn >= minBuyIn && buyIn <= maxBuyIn) {
        return subTier;
      }
    }
    
    return null;
  }
  
  /**
   * Generate financial preview for private table
   */
  async generateFinancialPreview(privateTable) {
    return await commissionPreviewService.generateTournamentPreview({
      buyIn: privateTable.buyIn,
      declaredCapacity: privateTable.declaredCapacity,
      participationThreshold: privateTable.participationThreshold,
      tierRake: privateTable.tierRake,
      hostUplift: privateTable.hostUplift,
      hostRewardPercent: privateTable.hostRewardPercent,
      hours: privateTable.estimatedHours,
      timerSeconds: privateTable.timerSeconds,
      hasAffiliate: !!privateTable.affiliateId
    });
  }
  
  /**
   * Update setup fee ledger with game ID
   */
  async updateSetupFeeLedger(ledgerId, gameId) {
    // TODO: Implement setup fee ledger update
    console.log(`📝 Updated setup fee ledger ${ledgerId} with game ID ${gameId}`);
  }
  
  /**
   * Validate host configuration
   */
  async validateHostConfiguration(hostId, gameType, hostUplift, hostRewardPercent) {
    // Validate host uplift for SNG
    if (gameType === 'PRIVATE_SNG' && hostUplift > 0) {
      await rakeTierService.validateHostUplift(hostId, hostUplift);
    }
    
    // Validate host reward percentage
    if (hostRewardPercent > 0) {
      await financialService.validateHostReward(hostId, hostRewardPercent);
    }
    
    return true;
  }
  
  /**
   * Get host type (regular or trusted)
   */
  async getHostType(hostId) {
    // TODO: Implement logic to determine if host is trusted
    return 'REGULAR';
  }
  
  /**
   * Get default payout structure based on capacity
   */
  getDefaultPayoutStructure(capacity) {
    if (capacity <= 6) {
      return [
        { position: 1, percentage: 65 },
        { position: 2, percentage: 35 }
      ];
    } else if (capacity <= 18) {
      return [
        { position: 1, percentage: 50 },
        { position: 2, percentage: 30 },
        { position: 3, percentage: 20 }
      ];
    } else {
      return [
        { position: 1, percentage: 40 },
        { position: 2, percentage: 25 },
        { position: 3, percentage: 15 },
        { position: 4, percentage: 10 },
        { position: 5, percentage: 10 }
      ];
    }
  }
}

module.exports = new PrivateTableService();