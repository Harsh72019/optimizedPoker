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
      gameType, // 'SNG' or 'TOURNAMENT'
      stakes, // { type: 'FIXED_LIMIT' | 'POT_LIMIT' | 'NO_LIMIT' | 'CUSTOM', blinds: { small: number, big: number } }
      turnTimer, // in seconds
      playerCapacity, // { min: number, max: number }
      tableDuration, // 'TIMED' or 'INFINITY'
      buyInSettings, // { min: number, max: number }
      invitationControl, // { type: 'PASSWORD' | 'INVITE', password?: string }
      rebuy = false,
      antesStraddles = false,
      buyInReentryRules = 'ALLOWED_ON_REBUY_ONLY',
      scheduledStartTime,
      allowSpectators = false,
      affiliateId,
      // Legacy fields for compatibility
      buyIn,
      declaredCapacity,
      participationThreshold = 50,
      tier = 3,
      hostUplift = 0,
      hostRewardPercent = 0,
      estimatedHours = 2,
      timerSeconds
    } = tableConfig;
    
    // Map new config to legacy format for existing system compatibility
    const mappedConfig = {
      name,
      description,
      gameType: gameType === 'SNG' ? 'PRIVATE_SNG' : 'PRIVATE_TOURNAMENT',
      buyIn: buyIn || buyInSettings.min,
      declaredCapacity: declaredCapacity || playerCapacity.max,
      participationThreshold: participationThreshold || Math.ceil((playerCapacity.min / playerCapacity.max) * 100),
      tier,
      hostUplift,
      hostRewardPercent,
      estimatedHours: tableDuration === 'INFINITY' ? 12 : estimatedHours,
      timerSeconds: timerSeconds || turnTimer,
      scheduledStartTime,
      password: invitationControl.type === 'PASSWORD' ? invitationControl.password : null,
      allowSpectators,
      affiliateId,
      // New private table specific fields
      privateConfig: {
        stakes,
        turnTimer,
        playerCapacity,
        tableDuration,
        buyInSettings,
        invitationControl,
        rebuy,
        antesStraddles,
        buyInReentryRules
      }
    };
    
    // Validate host permissions and uplift
    await this.validateHostConfiguration(hostId, mappedConfig.gameType, hostUplift, hostRewardPercent);
    
    // Get tier rake
    const tierRake = mappedConfig.gameType === 'PRIVATE_SNG' 
      ? await rakeTierService.getSNGRake(tier)
      : await rakeTierService.getTournamentRake(tier);
    
    const effectiveRake = tierRake + (hostUplift || 0);
    
    // Calculate and charge setup fee first (with temporary ID)
    const tempId = `private_${Date.now()}`;
    const setupFeeResult = await setupFeeService.chargeSetupFee(
      tempId,
      hostId,
      { buyIn: mappedConfig.buyIn, declaredCapacity: mappedConfig.declaredCapacity, hours: mappedConfig.estimatedHours, timerSeconds: mappedConfig.timerSeconds }
    );
    
    // Create private table record using mongoHelper (let it generate Doc_ ID)
    // 🎮 HOST AUTO-REGISTRATION: Host is automatically registered as the first player
    const privateTableData = {
      name: mappedConfig.name,
      description: mappedConfig.description,
      hostId,
      gameType: mappedConfig.gameType,
      buyIn: mappedConfig.buyIn,
      declaredCapacity: mappedConfig.declaredCapacity,
      participationThreshold: mappedConfig.participationThreshold,
      estimatedHours: mappedConfig.estimatedHours,
      timerSeconds: mappedConfig.timerSeconds,
      tier,
      hostUplift,
      hostRewardPercent,
      tierRake,
      effectiveRake,
      setupFeeAmount: setupFeeResult.chargedAmount,
      setupFeePaid: true,
      setupFeeTransactionId: setupFeeResult.ledgerEntry._id,
      status: 'WAITING_FOR_PLAYERS',
      scheduledStartTime: mappedConfig.scheduledStartTime ? new Date(mappedConfig.scheduledStartTime) : null,
      password: mappedConfig.password,
      allowSpectators: mappedConfig.allowSpectators,
      affiliateId: mappedConfig.affiliateId,
      createdBy: 'HOST',
      // 🎮 HOST IS AUTOMATICALLY REGISTERED AS FIRST PLAYER
      registeredPlayers: [{
        userId: hostId,
        registeredAt: new Date(),
        buyInPaid: false,
        status: 'REGISTERED',
        isHost: true
      }],
      waitlist: [],
      tables: [],
      winners: [],
      settlementCompleted: false,
      isPrivate: true,
      // Store new private table configuration
      privateConfig: mappedConfig.privateConfig,
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
    
    // Check if threshold is already met with just the host
    const thresholdPercentage = (1 / privateTable.declaredCapacity) * 100;
    const thresholdMet = thresholdPercentage >= privateTable.participationThreshold;
    
    if (thresholdMet) {
      // Update status to READY_TO_START if threshold is met with just the host
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.PRIVATE_TABLES,
        privateTable._id,
        { status: 'READY_TO_START' }
      );
      privateTable.status = 'READY_TO_START';
      console.log(`🎮 [HOST AUTO-REG] Table ${privateTable._id} ready to start with host only (${thresholdPercentage.toFixed(2)}% >= ${privateTable.participationThreshold}%)`);
    }
    
    console.log(`🎮 [HOST AUTO-REG] Host ${hostId} automatically registered as player in table ${privateTable._id}`);
    
    return {
      privateTable,
      setupFee: setupFeeResult,
      financialPreview: await this.generateFinancialPreview(privateTable),
      hostAutoRegistered: true
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
    
    // Check if table is in a state that allows registration
    if (!['CREATED', 'WAITING_FOR_PLAYERS', 'READY_TO_START'].includes(privateTable.status)) {
      throw new Error(`Cannot join table in current status: ${privateTable.status}`);
    }
    
    // Check if already registered
    const alreadyRegistered = privateTable.registeredPlayers?.some(
      p => p.userId?.toString() === userId.toString()
    );
    
    if (alreadyRegistered) {
      // If it's the host, return current status instead of error
      if (privateTable.hostId.toString() === userId.toString()) {
        const currentCount = privateTable.registeredPlayers?.length || 0;
        return {
          registered: true,
          waitlisted: false,
          position: 1, // Host is always first
          tableStatus: privateTable.status,
          playersRegistered: currentCount,
          spotsRemaining: privateTable.declaredCapacity - currentCount,
          isHost: true
        };
      }
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
    const requiredPlayers = Math.ceil(privateTable.declaredCapacity * privateTable.participationThreshold / 100);
    const thresholdMet = newCount >= requiredPlayers;
    // Determine new status based on current status and threshold
    let newStatus = privateTable.status;
    if (privateTable.status === 'CREATED' && newCount > 0) {
      newStatus = 'WAITING_FOR_PLAYERS';
    }
    if (thresholdMet && ['CREATED', 'WAITING_FOR_PLAYERS'].includes(privateTable.status)) {
      newStatus = 'READY_TO_START';
    }
    
    console.log(`📊 Threshold Check: ${newCount}/${privateTable.declaredCapacity}, Required: ${requiredPlayers}, Threshold met: ${thresholdMet} → Status: ${privateTable.status} → ${newStatus}`);
    
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
    
    const currentPlayerCount = privateTable.registeredPlayers?.length || 0;
    const currentPercentage = (currentPlayerCount / privateTable.declaredCapacity) * 100;
    const requiredPlayers = Math.ceil(privateTable.declaredCapacity * privateTable.participationThreshold / 100);
    
    console.log(`📊 Detailed Check: ${currentPlayerCount}/${privateTable.declaredCapacity} = ${currentPercentage.toFixed(1)}% >= ${privateTable.participationThreshold}%`);
    console.log(`📊 Required players: ${requiredPlayers}, Current players: ${currentPlayerCount}`);
    
    // Check if we have enough players (use >= for threshold check)
    if (currentPlayerCount < requiredPlayers) {
      throw new Error(`Table is not ready to start. Need ${privateTable.participationThreshold}% (${requiredPlayers} players), currently at ${currentPercentage.toFixed(0)}% (${currentPlayerCount} players)`);
    }
    
    // Also check status, but allow starting if we have enough players regardless of status
    if (privateTable.status !== 'READY_TO_START' && privateTable.status !== 'WAITING_FOR_PLAYERS') {
      throw new Error(`Cannot start table in current status: ${privateTable.status}`);
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
    const blockchainService = require('./blockchain.service');
    const tableManager = require('../table/table-manager.service');
    
    // Use private config if available, otherwise fall back to legacy fields
    const config = privateTable.privateConfig || {};
    const buyIn = config.buyInSettings?.min || privateTable.buyIn;
    
    // Create blockchain table first for private SNG
    console.log(`🔗 Creating blockchain table for private SNG: ${privateTable._id}`);
    const createResult = await blockchainService.createTableOnBlockchain(
      privateTable.hostId, // Use hostId as userAddress for now
      privateTable.effectiveRake,
      buyIn
    );
    
    if (!createResult.success) {
      throw new Error(`Failed to create blockchain table: ${createResult.error}`);
    }
    
    console.log(`✅ Blockchain table created: ID=${createResult.tableId}, Address=${createResult.tableAddress}`);
    
    // Update private table with blockchain info
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      privateTable._id,
      {
        tableBlockchainId: createResult.tableId,
        blockchainAddress: createResult.tableAddress
      }
    );
    
    // Find a suitable SubTier for the buy-in amount
    const subTier = await this.findSubTierForBuyIn(buyIn);
    
    if (!subTier) {
      throw new Error('No suitable table configuration found for this buy-in');
    }
    
    // Create underlying table using existing system with private config
    const tableData = {
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
      privateTableId: privateTable._id,
      // Add blockchain integration
      tableBlockchainId: createResult.tableId,
      blockchainAddress: createResult.tableAddress,
      // Store private table configuration for game engine
      privateConfig: config
    };
    
    const tableResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TABLES,
      tableData,
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
    
    // ✅ CRITICAL: Automatically seat all registered players in the underlying table
    console.log(`🎮 [AUTO-SEAT] Seating ${privateTable.registeredPlayers.length} registered players`);
    
    for (const registeredPlayer of privateTable.registeredPlayers) {
      const playerId = registeredPlayer.userId?.toString() || registeredPlayer.userId;
      
      try {
        // Get user info
        const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
        if (!userResult.success || !userResult.data) {
          console.error(`❌ [AUTO-SEAT] User not found: ${playerId}`);
          continue;
        }
        
        const user = userResult.data;
        
        // Seat player in underlying table using table manager
        const { tableState } = await tableManager.seatPlayer(
          underlyingTable._id,
          {
            userId: playerId,
            username: user.username,
            chips: buyIn,
            socketId: `private_${playerId}` // Temporary socket ID for private table players
          }
        );
        
        // Sync to MongoDB
        const mongoHelper = require('../models/customdb');
        const findResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, underlyingTable._id);
        
        if (findResult.success && findResult.data) {
          const table = findResult.data;
          let updatedPlayers = table.currentPlayers || [];
          
          const exists = updatedPlayers.some(p => p.user?.toString() === playerId);
          if (!exists) {
            updatedPlayers.push({ user: playerId });
            
            await mongoHelper.updateById(
              mongoHelper.COLLECTIONS.TABLES,
              underlyingTable._id,
              { 
                currentPlayers: updatedPlayers,
                lastActivityAt: new Date()
              }
            );
          }
        }
        
        console.log(`✅ [AUTO-SEAT] Seated ${user.username} (${playerId}) in underlying table`);
        
      } catch (error) {
        console.error(`❌ [AUTO-SEAT] Failed to seat player ${playerId}:`, error.message);
      }
    }
    
    return {
      underlyingTable,
      playersToAdd: privateTable.registeredPlayers.length,
      subTier,
      privateConfig: config,
      blockchainInfo: {
        tableId: createResult.tableId,
        tableAddress: createResult.tableAddress
      }
    };
  }
  
  /**
   * Start Private Tournament
   */
  async startPrivateTournament(privateTable) {
    const blockchainService = require('./blockchain.service');
    
    // Use private config if available, otherwise fall back to legacy fields
    const config = privateTable.privateConfig || {};
    const buyIn = config.buyInSettings?.min || privateTable.buyIn;
    
    // Create blockchain table first for private tournament
    console.log(`🔗 Creating blockchain table for private tournament: ${privateTable._id}`);
    const createResult = await blockchainService.createTableOnBlockchain(
      privateTable.hostId, // Use hostId as userAddress for now
      privateTable.effectiveRake,
      buyIn
    );
    
    if (!createResult.success) {
      throw new Error(`Failed to create blockchain table: ${createResult.error}`);
    }
    
    console.log(`✅ Blockchain table created: ID=${createResult.tableId}, Address=${createResult.tableAddress}`);
    
    // Update private table with blockchain info
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      privateTable._id,
      {
        tableBlockchainId: createResult.tableId,
        blockchainAddress: createResult.tableAddress
      }
    );
    
    // Create tournament record using mongoHelper
    const tournamentData = {
      name: privateTable.name,
      description: privateTable.description,
      buyIn,
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
      timerSeconds: config.turnTimer || privateTable.timerSeconds,
      startingChips: 10000,
      levelDuration: 15,
      timeZone: 'UTC',
      tierRake: privateTable.tierRake,
      effectiveRake: privateTable.effectiveRake,
      setupFeeAmount: privateTable.setupFeeAmount,
      affiliateId: privateTable.affiliateId,
      registeredPlayers: privateTable.registeredPlayers.map(p => p.userId),
      // Add blockchain integration
      tableBlockchainId: createResult.tableId,
      blockchainAddress: createResult.tableAddress,
      // Private tournament specific configurations
      privateConfig: config
    };
    
    // Apply private table specific configurations
    if (config.stakes) {
      tournamentData.stakes = config.stakes;
    }
    if (config.rebuy !== undefined) {
      tournamentData.rebuyAllowed = config.rebuy;
    }
    if (config.antesStraddles !== undefined) {
      tournamentData.antesStraddles = config.antesStraddles;
    }
    if (config.buyInReentryRules) {
      tournamentData.buyInReentryRules = config.buyInReentryRules;
    }
    
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
      playersRegistered: privateTable.registeredPlayers.length,
      blockchainInfo: {
        tableId: createResult.tableId,
        tableAddress: createResult.tableAddress
      }
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
        { path: 'hostId', collection: mongoHelper.COLLECTIONS.USERS, select: 'username email profilePic name' },
        { path: 'registeredPlayers.userId', collection: mongoHelper.COLLECTIONS.USERS, select: 'username email profilePic name' }
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
    
    // Process refunds for registered players (except setup fee)
    const walletIntegrationService = require('./wallet-integration.service');
    const registeredPlayerIds = privateTable.registeredPlayers?.map(p => p.userId) || [];
    
    let refundResults = [];
    let totalRefundAmount = 0;
    
    if (registeredPlayerIds.length > 0) {
      console.log(`💰 [CANCEL] Processing refunds for ${registeredPlayerIds.length} players`);
      console.log(`💰 [CANCEL] Buy-in amount: ${privateTable.buyIn} per player`);
      
      try {
        // Process buy-in refunds through blockchain
        refundResults = await walletIntegrationService.refundBuyIns(
          registeredPlayerIds,
          privateTable.buyIn,
          tableId
        );
        
        // Calculate total refund amount
        totalRefundAmount = refundResults.filter(r => r.success).length * privateTable.buyIn;
        
        console.log(`✅ [CANCEL] Refunded ${totalRefundAmount} USDT to ${refundResults.filter(r => r.success).length} players`);
        
        // Log any failed refunds
        const failedRefunds = refundResults.filter(r => !r.success);
        if (failedRefunds.length > 0) {
          console.error(`❌ [CANCEL] Failed to refund ${failedRefunds.length} players:`, failedRefunds);
        }
        
      } catch (error) {
        console.error(`❌ [CANCEL] Refund processing failed:`, error);
        // Continue with cancellation even if refunds fail - they can be processed manually
      }
    }
    
    // Update status to cancelled
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.PRIVATE_TABLES,
      tableId,
      {
        status: 'CANCELLED',
        cancelReason: reason,
        completedAt: new Date(),
        refundResults: refundResults,
        totalRefundAmount: totalRefundAmount
      }
    );
    
    console.log(`❌ [CANCEL] Private table ${tableId} cancelled by host ${hostId}`);
    console.log(`💰 [CANCEL] Setup fee (${privateTable.setupFeeAmount}) is kept by platform`);
    
    return {
      cancelled: true,
      refundAmount: totalRefundAmount,
      setupFeeKept: privateTable.setupFeeAmount,
      refundResults: refundResults,
      reason,
      playersRefunded: refundResults.filter(r => r.success).length,
      playersFailed: refundResults.filter(r => !r.success).length
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
    if (privateTable.gameType === 'PRIVATE_SNG') {
      // Use SNG-specific commission preview
      const sngCommissionPreview = require('./sng-commission-preview.service');
      const config = privateTable.privateConfig || {};
      
      return await sngCommissionPreview.generateSNGCommissionPreview({
        declaredCapacity: privateTable.declaredCapacity,
        buyIn: privateTable.buyIn,
        duration: privateTable.estimatedHours || 2,
        timerSeconds: privateTable.timerSeconds || 30,
        tier: privateTable.tier || 3,
        hostUplift: privateTable.hostUplift || 0,
        bigBlind: config.stakes?.blinds?.big || privateTable.buyIn / 25 // Estimate BB
      });
    } else {
      // Use tournament preview for tournaments
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