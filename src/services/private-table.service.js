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
      timeLimit, // Time limit in MINUTES (for TIMED tables)
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
      estimatedHours = 2, // Fallback for legacy
      timerSeconds
    } = tableConfig;
    
    // Validate all configurations
    this.validatePrivateTableConfig(tableConfig);
    
    // Determine the mapped game type first
    const mappedGameType = gameType === 'SNG' ? 'PRIVATE_SNG' : 'PRIVATE_TOURNAMENT';
    
    // Calculate estimated hours from timeLimit (in minutes)
    const calculatedEstimatedHours = tableDuration === 'TIMED' && timeLimit 
      ? timeLimit / 60 
      : (tableDuration === 'INFINITY' ? 12 : estimatedHours);
    
    // Map new config to legacy format for existing system compatibility
    const mappedConfig = {
      name,
      description,
      gameType: mappedGameType,
      buyIn: buyIn || buyInSettings.min,
      declaredCapacity: declaredCapacity || playerCapacity.max,
      participationThreshold: participationThreshold || Math.ceil((playerCapacity.min / playerCapacity.max) * 100),
      tier,
      hostUplift,
      hostRewardPercent,
      estimatedHours: calculatedEstimatedHours,
      timerSeconds: timerSeconds || turnTimer,
      scheduledStartTime,
      password: this.extractPassword(invitationControl),
      allowSpectators,
      affiliateId,
      // New private table specific fields with full configuration
      privateConfig: {
        stakes: this.normalizeStakesConfig(stakes),
        turnTimer,
        playerCapacity,
        tableDuration,
        timeLimit: timeLimit || null, // Store actual time limit in minutes
        buyInSettings,
        invitationControl: this.normalizeInvitationControl(invitationControl),
        rebuy,
        antesStraddles,
        buyInReentryRules,
        // Additional derived configurations - use mappedGameType instead of mappedConfig.gameType
        gameFeatures: this.buildGameFeatures(rebuy, antesStraddles, buyInReentryRules, mappedGameType),
        timingConfig: this.buildTimingConfig(tableDuration, timeLimit, turnTimer)
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
      // Store complete private table configuration
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
    console.log(`⚙️ [CONFIG] Table created with full configuration:`, {
      stakes: mappedConfig.privateConfig.stakes,
      duration: mappedConfig.privateConfig.tableDuration,
      timeLimit: mappedConfig.privateConfig.timeLimit,
      features: mappedConfig.privateConfig.gameFeatures,
      timing: mappedConfig.privateConfig.timingConfig
    });
    
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
      // Player is already registered, just return current status (no error)
      const currentCount = privateTable.registeredPlayers?.length || 0;
      const isHost = privateTable.hostId.toString() === userId.toString();
      
      return {
        registered: true,
        waitlisted: false,
        position: privateTable.registeredPlayers.findIndex(p => p.userId?.toString() === userId.toString()) + 1,
        tableStatus: privateTable.status,
        playersRegistered: currentCount,
        spotsRemaining: privateTable.declaredCapacity - currentCount,
        isHost,
        alreadyRegistered: true // Flag to indicate they were already registered
      };
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
  async startPrivateTable(tableId, hostId, orchestrator = null) {
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
      gameResult = await this.startPrivateSNG(privateTable , orchestrator);
    } else {
      gameResult = await this.startPrivateTournament(privateTable , orchestrator);
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
  async startPrivateSNG(privateTable, orchestrator) {
    const tableManager = require('../table/table-manager.service');
    
    // Use private config if available, otherwise fall back to legacy fields
    const config = privateTable.privateConfig || {};
    const buyIn = config.buyInSettings?.min || privateTable.buyIn;
    
    // Find a suitable SubTier for the buy-in amount
    let subTier;
    try {
      subTier = await this.findSubTierForBuyIn(buyIn);
    } catch (error) {
      console.error(`❌ Error finding SubTier for buyIn ${buyIn}:`, error.message);
      // Create a default subTier if none found
      subTier = {
        _id: 'default_subtier',
        tableConfig: {
          bb: config.stakes?.blinds?.big || Math.max(buyIn / 50, 1),
          sb: config.stakes?.blinds?.small || Math.max(buyIn / 100, 0.5)
        }
      };
    }
    
    if (!subTier) {
      throw new Error('No suitable table configuration found for this buy-in');
    }
    
    // Build complete game configuration from private table settings
    const gameConfig = this.buildCompleteGameConfig(config, privateTable);
    
    // Create underlying table using existing system with complete private config
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
      // Store complete private table configuration for game engine
      privateConfig: config,
      // Store derived game configuration
      gameConfig: gameConfig,
      // Stakes configuration
      stakesType: config.stakes?.type || 'NO_LIMIT',
      blinds: {
        small: config.stakes?.blinds?.small || subTier.tableConfig.sb,
        big: config.stakes?.blinds?.big || subTier.tableConfig.bb
      },
      // Timer configuration
      turnTimer: config.turnTimer || privateTable.timerSeconds || 30,
      timeBank: gameConfig.timer.timeBank,
      // Game features
      rebuyAllowed: config.gameFeatures?.rebuyAllowed || false,
      antesEnabled: config.gameFeatures?.antesEnabled || false,
      straddlesEnabled: config.gameFeatures?.straddlesEnabled || false,
      // Duration settings
      tableDuration: config.tableDuration || 'INFINITY',
      timeLimit: config.timeLimit || null, // Time limit in minutes
      estimatedHours: config.timingConfig?.estimatedHours || privateTable.estimatedHours,
      // Track game start time for timer
      gameStartedAt: new Date()
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
    
    // 🕐 START TABLE TIMER if it's a timed table
    if (config.tableDuration === 'TIMED' && config.timeLimit) {
      const tableTimerService = require('../services/table-timer.service');
      
      // Ensure timer service has IO access
      if (orchestrator && orchestrator.io) {
        tableTimerService.setIO(orchestrator.io);
      }
      
      await tableTimerService.startTableTimer(underlyingTable._id, config.timeLimit);
      console.log(`⏰ [TIMER] Started ${config.timeLimit} minute timer for table ${underlyingTable._id}`);
    }
    
    // ✅ NO AUTO-SEATING: Let real players join via redirect flow
    console.log(`🎮 [REDIRECT FLOW] Created underlying table ${underlyingTable._id} with complete config:`);
    console.log(`⚙️ [CONFIG] Stakes: ${gameConfig.stakes.type}, Blinds: ${gameConfig.blinds.small}/${gameConfig.blinds.big}`);
    console.log(`⚙️ [CONFIG] Duration: ${gameConfig.duration.type}, Timer: ${gameConfig.timer.turnTimer}s`);
    console.log(`⚙️ [CONFIG] Time Limit: ${config.timeLimit || 'None'} minutes`);
    console.log(`⚙️ [CONFIG] Features: Rebuy=${gameConfig.buyIn.allowRebuy}, Antes=${gameConfig.features.antesEnabled}`);
    console.log(`🎮 [REDIRECT FLOW] ${privateTable.registeredPlayers.length} registered players will be redirected to join`);
    
    // The game will start when real players join via the redirect flow
    // No need to start the game here - let the orchestrator handle it when players are seated
    
    return {
      underlyingTable,
      playersToAdd: privateTable.registeredPlayers.length,
      subTier,
      privateConfig: config,
      gameConfig: gameConfig
    };
  }
  
  /**
   * Start Private Tournament
   */
  async startPrivateTournament(privateTable) {
    // Use private config if available, otherwise fall back to legacy fields
    const config = privateTable.privateConfig || {};
    const buyIn = config.buyInSettings?.min || privateTable.buyIn;
    
    // Build complete game configuration
    const gameConfig = this.buildCompleteGameConfig(config, privateTable);
    
    // Create tournament record using mongoHelper with complete configuration
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
      estimatedHours: gameConfig.duration.estimatedHours,
      timerSeconds: gameConfig.timer.turnTimer,
      startingChips: this.calculateStartingChips(buyIn),
      levelDuration: this.calculateLevelDuration(gameConfig.duration.type, gameConfig.duration.estimatedHours),
      timeZone: 'UTC',
      tierRake: privateTable.tierRake,
      effectiveRake: privateTable.effectiveRake,
      setupFeeAmount: privateTable.setupFeeAmount,
      affiliateId: privateTable.affiliateId,
      registeredPlayers: privateTable.registeredPlayers.map(p => p.userId),
      
      // Complete private tournament configuration
      privateConfig: config,
      gameConfig: gameConfig,
      
      // Stakes configuration
      stakesType: gameConfig.stakes.type,
      blindStructure: this.buildBlindStructure(gameConfig),
      
      // Game features
      rebuyAllowed: gameConfig.buyIn.allowRebuy,
      rebuyPeriod: gameConfig.buyIn.rebuyPeriod,
      maxRebuys: gameConfig.buyIn.maxRebuys,
      antesEnabled: gameConfig.features.antesEnabled,
      straddlesEnabled: gameConfig.features.straddlesEnabled,
      buyInReentryRules: gameConfig.buyIn.reentryRules,
      
      // Duration and timing
      tableDuration: gameConfig.duration.type,
      maxDuration: gameConfig.duration.maxDuration,
      warningBeforeEnd: gameConfig.duration.warningBeforeEnd,
      
      // Access control
      invitationControl: gameConfig.access,
      allowSpectators: gameConfig.access.allowSpectators
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
    
    console.log(`🏆 [TOURNAMENT] Created private tournament ${tournament._id} with complete config:`);
    console.log(`⚙️ [CONFIG] Stakes: ${gameConfig.stakes.type}, Starting chips: ${tournamentData.startingChips}`);
    console.log(`⚙️ [CONFIG] Duration: ${gameConfig.duration.type}, Level duration: ${tournamentData.levelDuration}min`);
    console.log(`⚙️ [CONFIG] Features: Rebuy=${gameConfig.buyIn.allowRebuy}, Antes=${gameConfig.features.antesEnabled}`);
    
    return {
      tournament,
      playersRegistered: privateTable.registeredPlayers.length,
      gameConfig: gameConfig
    };
  }
  
  /**
   * Get private table with details
   */
  async getPrivateTable(tableId) {
    console.log('🔍 [SERVICE] getPrivateTable called with:', tableId);
    
    // Try findById first since we have a specific ID
    const resultById = await mongoHelper.findById(mongoHelper.COLLECTIONS.PRIVATE_TABLES, tableId);
    console.log('🔍 [SERVICE] findById result:', resultById);
    
    if (resultById.success && resultById.data) {
      console.log('🔍 [SERVICE] findById found table, registeredPlayers:', resultById.data.registeredPlayers);
      return resultById.data;
    }
    
    // Fallback to find method
    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.PRIVATE_TABLES, { _id: tableId });
    console.log('🔍 [SERVICE] find result:', result);
    
    const privateTable = result.success ? result.data[0] : null;
    console.log('🔍 [SERVICE] find returning privateTable:', privateTable);
    console.log('🔍 [SERVICE] find privateTable registeredPlayers:', privateTable?.registeredPlayers);
    
    return privateTable;
  }
  
  /**
   * Get private table with populated details
   */
  async getPrivateTableWithDetails(tableId) {
    // First get the private table
    const result = await mongoHelper.findById(mongoHelper.COLLECTIONS.PRIVATE_TABLES, tableId);
    
    if (!result.success || !result.data) {
      return null;
    }
    
    const privateTable = result.data;
    
    // Collect all user IDs that need to be fetched
    const userIds = new Set();
    
    // Add host ID
    if (privateTable.hostId) {
      userIds.add(privateTable.hostId.toString());
    }
    
    // Add all registered player user IDs
    if (privateTable.registeredPlayers) {
      privateTable.registeredPlayers.forEach(player => {
        if (player.userId) {
          userIds.add(player.userId.toString());
        }
      });
    }
    
    // Fetch all users in one query using $in operator
    const usersResult = await mongoHelper.find(
      mongoHelper.COLLECTIONS.USERS,
      { _id: { $in: Array.from(userIds) } }
    );
    
    // Create a map for quick user lookup
    const usersMap = new Map();
    if (usersResult.success && usersResult.data) {
      usersResult.data.forEach(user => {
        usersMap.set(user._id.toString(), {
          _id: user._id,
          username: user.username,
          email: user.email,
          profilePic: user.profilePic,
          name: user.name
        });
      });
    }
    
    // Populate host details
    if (privateTable.hostId) {
      const hostUser = usersMap.get(privateTable.hostId.toString());
      if (hostUser) {
        privateTable.hostId = hostUser;
      }
    }
    
    // Populate registered players
    if (privateTable.registeredPlayers) {
      privateTable.registeredPlayers = privateTable.registeredPlayers.map(player => {
        const user = usersMap.get(player.userId?.toString());
        return {
          ...player,
          user: user || null
        };
      });
    }
    
    return privateTable;
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
    try {
      // Find SubTier where buyIn falls within the range (bb * 20 to bb * 100)
      const subTiersResult = await mongoHelper.getAll(mongoHelper.COLLECTIONS.SUB_TIERS, {});
      
      if (!subTiersResult.success || !subTiersResult.data || subTiersResult.data.length === 0) {
        console.warn(`⚠️ No SubTiers found in database, creating default for buyIn: ${buyIn}`);
        return null;
      }
      
      for (const subTier of subTiersResult.data) {
        if (!subTier.tableConfig || !subTier.tableConfig.bb) {
          continue; // Skip invalid subTiers
        }
        
        const bb = subTier.tableConfig.bb;
        const minBuyIn = bb * 20;
        const maxBuyIn = bb * 100;
        
        if (buyIn >= minBuyIn && buyIn <= maxBuyIn) {
          console.log(`✅ Found matching SubTier: ${subTier._id} (BB: ${bb}, Range: ${minBuyIn}-${maxBuyIn})`);
          return subTier;
        }
      }
      
      console.warn(`⚠️ No matching SubTier found for buyIn: ${buyIn}`);
      return null;
    } catch (error) {
      console.error(`❌ Error in findSubTierForBuyIn:`, error.message);
      return null;
    }
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
  
  /**
   * Validate complete private table configuration
   */
  validatePrivateTableConfig(tableConfig) {
    const PrivateTableValidator = require('../utils/private-table-validator');
    const validation = PrivateTableValidator.validate(tableConfig);
    
    if (!validation.valid) {
      throw new Error('Invalid table configuration: ' + validation.errors.join(', '));
    }
    
    // Additional business logic validations
    if (tableConfig.stakes?.type === 'CUSTOM' && !tableConfig.stakes?.blinds) {
      throw new Error('Custom stakes require blinds configuration');
    }
    
    if (tableConfig.tableDuration === 'TIMED' && !tableConfig.timeLimit) {
      throw new Error('Timed tables require timeLimit in minutes');
    }
    
    if (tableConfig.timeLimit && tableConfig.timeLimit < 5) {
      throw new Error('Time limit must be at least 5 minutes');
    }
    
    if (tableConfig.invitationControl?.type === 'PASSWORD' && !tableConfig.invitationControl?.password) {
      throw new Error('Password-protected tables require a password');
    }
    
    // Antes validation: Only allowed in tournaments
    if (tableConfig.antesStraddles && tableConfig.gameType === 'SNG') {
      console.warn('⚠️ Antes are not typically used in SNGs, only straddles will be enabled');
    }
    
    return true;
  }
  
  /**
   * Calculate estimated hours based on table duration
   */
  calculateEstimatedHours(tableDuration, estimatedHours) {
    if (tableDuration === 'INFINITY') {
      return 12; // Default max for infinity tables
    }
    return estimatedHours || 2; // Default for timed tables
  }
  
  /**
   * Extract password from invitation control
   */
  extractPassword(invitationControl) {
    if (!invitationControl) return null;
    return invitationControl.type === 'PASSWORD' ? invitationControl.password : null;
  }
  
  /**
   * Normalize stakes configuration
   */
  normalizeStakesConfig(stakes) {
    if (!stakes) {
      return {
        type: 'NO_LIMIT',
        blinds: { small: 5, big: 10 }
      };
    }
    
    const normalized = {
      type: stakes.type || 'NO_LIMIT',
      blinds: stakes.blinds || { small: 5, big: 10 }
    };
    
    // Add type-specific configurations
    switch (normalized.type) {
      case 'FIXED_LIMIT':
        normalized.betSize = normalized.blinds.big;
        normalized.maxRaises = 4;
        break;
      case 'POT_LIMIT':
        normalized.maxBet = 'pot_size';
        break;
      case 'CUSTOM':
        normalized.customRules = {
          minBet: normalized.blinds.big,
          maxBet: normalized.blinds.big * 10,
          maxRaises: 6
        };
        break;
    }
    
    return normalized;
  }
  
  /**
   * Normalize invitation control
   */
  normalizeInvitationControl(invitationControl) {
    if (!invitationControl) {
      return { type: 'PASSWORD', password: null };
    }
    
    return {
      type: invitationControl.type || 'PASSWORD',
      password: invitationControl.password || null,
      inviteList: invitationControl.type === 'INVITE' ? (invitationControl.inviteList || []) : []
    };
  }
  
  /**
   * Build game features configuration
   */
  buildGameFeatures(rebuy, antesStraddles, buyInReentryRules, gameType) {
    // Antes are typically only used in tournaments, not SNGs
    const antesAllowed = gameType === 'TOURNAMENT' || gameType === 'PRIVATE_TOURNAMENT';
    
    return {
      rebuyAllowed: rebuy || false,
      antesEnabled: antesAllowed && (antesStraddles || false), // Only enable antes for tournaments
      straddlesEnabled: antesStraddles || false, // Straddles can be in both SNGs and tournaments
      reentryRules: buyInReentryRules || 'ALLOWED_ON_REBUY_ONLY',
      autoMuck: true,
      showdown: true,
      // Calculate ante amount if enabled (only for tournaments)
      anteAmount: (antesAllowed && antesStraddles) ? 'auto' : 0, // Will be calculated as 10% of big blind
      // Rebuy specific settings
      rebuyPeriod: rebuy ? 60 : 0, // 60 minutes rebuy period if enabled
      maxRebuys: rebuy ? 3 : 0 // Max 3 rebuys if enabled
    };
  }
  
  /**
   * Build timing configuration
   */
  buildTimingConfig(tableDuration, timeLimit, turnTimer) {
    const config = {
      duration: tableDuration || 'INFINITY',
      timeLimit: timeLimit || null, // Time limit in minutes
      estimatedHours: timeLimit ? timeLimit / 60 : 12, // Convert minutes to hours
      turnTimer: turnTimer || 30,
      timeBank: this.calculateTimeBank(turnTimer || 30),
      warningTime: Math.max(5, Math.floor((turnTimer || 30) * 0.25))
    };
    
    // Add duration-specific settings
    if (tableDuration === 'TIMED' && timeLimit) {
      config.maxDuration = timeLimit; // Store in minutes
      config.warningBeforeEnd = 5; // 5 minutes warning before time limit
      config.finalRoundWarning = 2; // 2 minutes warning for final round
    }
    
    return config;
  }
  
  /**
   * Calculate time bank based on turn timer
   */
  calculateTimeBank(turnTimer) {
    if (turnTimer <= 15) return 60; // 1 minute
    if (turnTimer <= 30) return 120; // 2 minutes
    if (turnTimer <= 60) return 180; // 3 minutes
    return 300; // 5 minutes for longer timers
  }
  
  /**
   * Build complete game configuration from private table settings
   */
  buildCompleteGameConfig(privateConfig, privateTable) {
    const config = privateConfig || {};
    
    return {
      // Blinds and stakes configuration
      blinds: {
        small: config.stakes?.blinds?.small || 5,
        big: config.stakes?.blinds?.big || 10
      },
      
      stakes: {
        type: config.stakes?.type || 'NO_LIMIT',
        betting: this.getBettingType(config.stakes?.type),
        ...this.getStakesSpecificConfig(config.stakes)
      },
      
      // Timer configuration
      timer: {
        turnTimer: config.turnTimer || privateTable.timerSeconds || 30,
        timeBank: this.calculateTimeBank(config.turnTimer || privateTable.timerSeconds || 30),
        warningTime: Math.max(5, Math.floor((config.turnTimer || 30) * 0.25))
      },
      
      // Player limits
      players: {
        min: config.playerCapacity?.min || 2,
        max: config.playerCapacity?.max || privateTable.declaredCapacity || 9
      },
      
      // Buy-in rules
      buyIn: {
        min: config.buyInSettings?.min || privateTable.buyIn || 100,
        max: config.buyInSettings?.max || privateTable.buyIn || 1000,
        allowRebuy: config.gameFeatures?.rebuyAllowed || false,
        reentryRules: config.buyInReentryRules || 'ALLOWED_ON_REBUY_ONLY',
        rebuyPeriod: config.gameFeatures?.rebuyPeriod || 60,
        maxRebuys: config.gameFeatures?.maxRebuys || 3
      },
      
      // Game features
      features: {
        antesEnabled: config.gameFeatures?.antesEnabled || false,
        straddlesEnabled: config.gameFeatures?.straddlesEnabled || false,
        autoMuck: true,
        showdown: true,
        anteAmount: config.gameFeatures?.antesEnabled ? 'auto' : 0
      },
      
      // Table duration
      duration: {
        type: config.tableDuration || 'INFINITY',
        estimatedHours: config.timingConfig?.estimatedHours || privateTable.estimatedHours || 2,
        maxDuration: config.tableDuration === 'TIMED' ? (config.timingConfig?.estimatedHours || 2) * 60 : null,
        warningBeforeEnd: config.tableDuration === 'TIMED' ? 15 : null
      },
      
      // Invitation and access control
      access: {
        type: config.invitationControl?.type || 'PASSWORD',
        password: config.invitationControl?.password || null,
        inviteList: config.invitationControl?.inviteList || [],
        allowSpectators: privateTable.allowSpectators || false
      }
    };
  }
  
  /**
   * Get betting type based on stakes type
   */
  getBettingType(stakesType) {
    switch (stakesType) {
      case 'FIXED_LIMIT': return 'fixed';
      case 'POT_LIMIT': return 'pot_limit';
      case 'NO_LIMIT': return 'unlimited';
      case 'CUSTOM': return 'custom';
      default: return 'unlimited';
    }
  }
  
  /**
   * Get stakes-specific configuration
   */
  getStakesSpecificConfig(stakes) {
    if (!stakes) return {};
    
    switch (stakes.type) {
      case 'FIXED_LIMIT':
        return {
          betSize: stakes.blinds?.big || 10,
          maxRaises: stakes.maxRaises || 4
        };
        
      case 'POT_LIMIT':
        return {
          maxBet: 'pot_size'
        };
        
      case 'CUSTOM':
        return {
          customRules: stakes.customRules || {
            minBet: stakes.blinds?.big || 10,
            maxBet: (stakes.blinds?.big || 10) * 10,
            maxRaises: 6
          }
        };
        
      default:
        return {};
    }
  }
  
  /**
   * Calculate starting chips for tournament based on buy-in
   */
  calculateStartingChips(buyIn) {
    // Standard tournament starting chips: 100-200x big blind equivalent
    // Assume big blind is roughly buyIn/50
    const estimatedBB = Math.max(buyIn / 50, 1);
    return Math.max(estimatedBB * 150, 1000); // 150x BB or minimum 1000
  }
  
  /**
   * Calculate level duration based on tournament type and estimated hours
   */
  calculateLevelDuration(durationType, estimatedHours) {
    if (durationType === 'INFINITY') {
      return 20; // 20 minutes for infinity tournaments
    }
    
    // For timed tournaments, calculate based on estimated hours
    // Assume 8-12 levels per hour
    const targetLevels = Math.max(estimatedHours * 10, 8);
    const levelDuration = Math.max((estimatedHours * 60) / targetLevels, 10);
    
    return Math.round(levelDuration);
  }
  
  /**
   * Build blind structure for tournament
   */
  buildBlindStructure(gameConfig) {
    const startingSB = gameConfig.blinds.small;
    const startingBB = gameConfig.blinds.big;
    const levels = [];
    
    // Build progressive blind structure
    let currentSB = startingSB;
    let currentBB = startingBB;
    
    for (let level = 1; level <= 20; level++) {
      levels.push({
        level,
        smallBlind: Math.round(currentSB),
        bigBlind: Math.round(currentBB),
        // Antes only in tournaments, and only if enabled
        ante: gameConfig.features.antesEnabled ? Math.max(1, Math.round(currentBB * 0.1)) : 0,
        duration: this.calculateLevelDuration(gameConfig.duration.type, gameConfig.duration.estimatedHours)
      });
      
      // Increase blinds by 50% each level for first 10 levels, then 25%
      const multiplier = level <= 10 ? 1.5 : 1.25;
      currentSB *= multiplier;
      currentBB *= multiplier;
    }
    
    return levels;
  }
}

module.exports = new PrivateTableService();