const mongoHelper = require('../models/customdb');
const cooldownService = require('./cooldown.service');
const reputationService = require('./reputation.service');
const queueService = require('./queue.service');
const fundingService = require('./funding.service');
const blockchainService = require('./blockchain.service');
const ApiError = require('../utils/ApiError');

class QueueMatcherService {
  constructor() {
    this.processingLocks = new Map(); // subTierId -> boolean
  }
  /**
   * PDF: JOIN REQUEST FLOW (CANONICAL)
   * Main entry point for matchmaking
   */
  async processJoinRequest(playerId, tierId, subTierId, chipsInPlay) {
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const tierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, tierId);
    const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
    
    const player = playerResult.data;
    const tier = tierResult.data;
    const subTier = subTierResult.data;
    
    if (!player || !tier || !subTier) {
      throw new ApiError(404, 'Player, tier, or sub-tier not found');
    }
    
    // Populate tierId for subTier
    if (subTier.tierId && typeof subTier.tierId === 'string') {
      const tierPopResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, subTier.tierId);
      subTier.tierId = tierPopResult.data;
    }

    // 1. Validate account type
    if (!this.validateAccountType(player, tier)) {
      throw new ApiError(403, 'account_type_insufficient');
    }

    // 2. Check funds
    const required = subTier.tableConfig.bb * 100; // 100 BB requirement
    if (player.chips < required) {
      throw new ApiError(402, 'insufficient_funds');
    }

    // 3. Enqueue player (only if not already in queue)
    let position = await queueService.getQueuePosition(playerId, subTierId);
    if (position === -1) {
      const enqueuedAt = new Date();
      await queueService.addToQueue(playerId, subTierId);
    }

    // 4. Immediate seating attempt (atomic)
    const eligibleTable = await this.findEligibleTable(playerId, subTier);
    
    if (eligibleTable) {
      await queueService.removeFromQueue(playerId, subTierId);
      const result = await this.seatPlayer(eligibleTable, playerId, subTier, chipsInPlay);
      return { 
        status: 'seated', 
        tableId: result.tableId,
        blockChainTableId: result.blockChainTableId,
        data: result.data
      };
    }

    // 5. Queued under threshold
    const queueEntry = subTier.playersInQueue?.find(e => e.playerId.toString() === playerId.toString());
    const enqueuedAt = queueEntry?.enqueuedAt || new Date();
    const waitTime = (Date.now() - new Date(enqueuedAt)) / 1000;
    if (waitTime < (tier.maxWaitSoftensSecs || 30)) {
      const position = await queueService.getQueuePosition(playerId, subTierId);
      return { 
        status: 'queued', 
        position,
        message: 'No available tables, you are in queue'
      };
    }

    // 6. Bot concession
    const playerRepScore = player?.reputation?.score ?? 50;
    if (tier.botConcession.enable && 
        playerRepScore >= tier.botConcession.minPlayerReputation &&
        waitTime >= tier.botConcession.minWaitToConcedeSecs) {
      
      if (await fundingService.bankReserveAllows(tierId, required)) {
        await queueService.removeFromQueue(playerId, subTierId);
        const result = await this.createTableWithBot(playerId, subTier, chipsInPlay, tier);
        return { 
          status: 'seated', 
          tableId: result.tableId,
          blockChainTableId: result.blockChainTableId,
          withBot: true,
          data: result.data
        };
      } else {
        console.log(`[QUEUE] Reserve exhausted for player ${playerId}, keeping in queue`);
        position = await queueService.getQueuePosition(playerId, subTierId);
        return { 
          status: 'queued', 
          position,
          message: 'Waiting for available table (reserve exhausted)'
        };
      }
    }

    // Still queued
     position = await queueService.getQueuePosition(playerId, subTierId);
    return { 
      status: 'queued', 
      position,
      message: 'Waiting for available table or bot concession'
    };
  }

  /**
   * PDF: Find eligible open table
   * Eligible = (seats available) AND (no bilateral cooldown conflicts)
   */
  async findEligibleTable(playerId, subTier) {
    console.log(`🔍 Finding eligible table for player ${playerId} in subTier ${subTier._id}`);
    
    const tablesResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, {
      subTierId: subTier._id
    });
    
    const tables = tablesResult.data || [];
    console.log(`📊 Found ${tables.length} tables with subTierId ${subTier._id}`);

    for (const table of tables) {
      console.log(`🔍 Checking table ${table._id}: ${table.currentPlayers?.length || 0}/${subTier.tableConfig.maxSeats} players`);
      
      // Check capacity
      if (table.currentPlayers.length >= subTier.tableConfig.maxSeats) {
        console.log(`❌ Table ${table._id} is full`);
        continue;
      }
      console.log(playerId , "player id");
      console.log(table.currentPlayers, "current players");
      
      // Get seated user IDs from player records (exclude bots)
      const seatedUserIds = [];
      for (const player of table.currentPlayers) {
        const playerId_str = player._id?.toString() || player.toString();
        const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.PLAYERS, playerId_str);
        if (playerResult.success && playerResult.data) {
          const userId = playerResult.data.user?._id?.toString() || playerResult.data.user?.toString();
          const isBot = playerResult.data.isBot;
          if (userId && userId !== playerId && !isBot) {
            seatedUserIds.push(userId);
          }
        }
      }

      console.log(`👥 Seated user IDs (excluding requester): ${seatedUserIds.length}`, seatedUserIds);

      // Check cooldown conflicts
      const hasConflict = await cooldownService.hasCooldownConflict(playerId, seatedUserIds);
      if (hasConflict) {
        console.log(`❌ Table ${table._id} has cooldown conflict`);
        continue;
      }

      // Mutual cooldown check if enforced
      if (subTier.tierId.mutualCooldownEnforced) {
        let mutualConflict = false;
        for (const seatedUserId of seatedUserIds) {
          const conflict = await cooldownService.hasCooldownConflict(seatedUserId, [playerId]);
          if (conflict) {
            mutualConflict = true;
            break;
          }
        }
        if (mutualConflict) {
          console.log(`❌ Table ${table._id} has mutual cooldown conflict`);
          continue;
        }
      }

      console.log(`✅ Found eligible table ${table._id}`);
      return table; // Found eligible table
    }

    console.log(`❌ No eligible tables found`);
    return null; // No eligible tables
  }

  /**
   * Seat player in existing table
   */
  async seatPlayer(table, playerId, subTier, chipsInPlay) {
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const player = playerResult.data;
    
    // Calculate final chips
    const tableType = table.tableTypeId;
    const finalChips = Math.max(
      tableType.minBuyIn,
      Math.min(chipsInPlay, tableType.maxBuyIn)
    );

    // Update reputation for successful match
    await reputationService.updateReputation(playerId, {
      queue_churn: 0,
      hands_completed: 0
    });

    return {
      tableId: table._id,
      blockChainTableId: table.tableBlockchainId,
      data: {
        tableId: table._id,
        blockChainTableId: table.tableBlockchainId,
        chipsInPlay: finalChips,
        tableCreated: false,
        viaMatchmaking: true,
        subTierId: subTier._id,
        tierId: subTier.tierId._id || subTier.tierId,
        userData: {
          userId: playerId,
          walletAddress: player.walletAddress
        }
      }
    };
  }

  /**
   * Create new table with bot concession
   */
  async createTableWithBot(playerId, subTier, chipsInPlay, tier) {
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const player = playerResult.data;
    const tableType = await this.getTableTypeByBB(subTier.tableConfig.bb);
    
    const finalChips = Math.max(
      tableType.minBuyIn,
      Math.min(chipsInPlay, tableType.maxBuyIn)
    );

    // Create table through blockchain
    const result = await blockchainService.findTableOrCreateThroughBlockchainNew(
      subTier.tableConfig.maxSeats,
      tableType._id,
      finalChips,
      player.walletAddress,
      subTier._id,
      playerId
    );

    // Record bot funding
    await fundingService.recordFunding(
      tier._id,
      'bot_pool', // Bot ID placeholder
      result.tableData._id,
      finalChips
    );

    // Update reputation
    await reputationService.updateReputation(playerId, {
      queue_churn: 0,
      hands_completed: 0
    });

    return {
      tableId: result.tableData._id,
      blockChainTableId: result.tableData.tableBlockchainId,
      data: {
        tableId: result.tableData._id,
        blockChainTableId: result.tableData.tableBlockchainId,
        chipsInPlay: finalChips,
        tableCreated: true,
        withBot: true,
        viaMatchmaking: true,
        subTierId: subTier._id,
        userData: {
          userId: playerId,
          walletAddress: player.walletAddress
        }
      }
    };
  }

  /**
   * Validate account type hierarchy
   */
  validateAccountType(player, tier) {
    const hierarchy = ['Human', 'Rat', 'Cat', 'Dog'];
    const playerLevel = hierarchy.indexOf(player.accountType || 'Human');
    const requiredLevel = hierarchy.indexOf(tier.minAccountType);
    return playerLevel >= requiredLevel;
  }

  /**
   * Get or create table type by BB
   */
  async getTableTypeByBB(bb) {
    const tableTypeResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLE_TYPES, { bigBlind: bb });
    let tableType = tableTypeResult.data?.[0];
    
    if (!tableType) {
      const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.TABLE_TYPES, {
        tableName: `${bb} BB Table`,
        minBuyIn: bb * 20,
        maxBuyIn: bb * 100,
        smallBlind: bb / 2,
        bigBlind: bb,
        maxSeats: 6
      });
      tableType = createResult.data;
    }
    
    return tableType;
  }

  /**
   * Process queued players (called by cron)
   */
  async processQueuedPlayers(subTierId, io) {
    if (this.processingLocks.get(subTierId)) return;
    this.processingLocks.set(subTierId, true);

    try {
      const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
      const subTier = subTierResult.data;
      
      if (!subTier || subTier.playersInQueue.length === 0) return;
      
      if (subTier.tierId && typeof subTier.tierId === 'string') {
        const tierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, subTier.tierId);
        subTier.tierId = tierResult.data;
      }

      const entry = subTier.playersInQueue[0];
      if (!entry) return;

      try {
        const result = await this.processJoinRequest(
          entry.playerId,
          subTier.tierId._id || subTier.tierId,
          subTierId,
          1000
        );

        if (result.status === 'seated' && io) {
          io.to(entry.playerId.toString()).emit('callJoinTable', {
            message: 'Table ready, please join',
            status: true,
            data: {
              blockChainTableId: result.blockChainTableId,
              tableId: result.tableId,
              chipsInPlay: result.data.chipsInPlay,
              autoRenew: false,
              maxBuy: true,
              viaMatchmaking: true,
              subTierId: subTierId,
              userData: result.data.userData
            }
          });
          console.log(`✅ Notified player ${entry.playerId} to join table ${result.tableId}`);
        }
      } catch (error) {
        console.error(`❌ Error processing queued player ${entry.playerId}:`, error.message);
        if (error.message.includes('insufficient_funds') || error.message.includes('account_type')) {
          await queueService.removeFromQueue(entry.playerId, subTierId);
        }
      }
    } finally {
      this.processingLocks.delete(subTierId);
    }
  }
}

module.exports = new QueueMatcherService();
