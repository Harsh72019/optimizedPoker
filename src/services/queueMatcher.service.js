const mongoHelper = require('../models/customdb');
const cooldownService = require('./cooldown.service');
const reputationService = require('./reputation.service');
const queueService = require('./queue.service');
const fundingService = require('./funding.service');
const blockchainService = require('./blockchain.service');
const ApiError = require('../utils/ApiError');
const userService = require('./user.service');
const tableManager = require('../table/table-manager.service');

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
    // if (player.chips < required) {
    //   throw new ApiError(402, 'insufficient_funds');
    // }

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
  extractRedisPlayerUserId(player) {
    return player?.userId?.toString?.()
      || player?.id?.toString?.()
      || player?.user?._id?.toString?.()
      || player?.user?.toString?.()
      || null;
  }

  async resolveMongoPlayerEntry(entry) {
    if (!entry) {
      return null;
    }

    if (entry.user || entry.userId) {
      const userId = entry.user?._id?.toString?.()
        || entry.user?.toString?.()
        || entry.userId?.toString?.()
        || null;

      return {
        userId,
        isBot: !!entry.isBot || (typeof userId === 'string' && userId.startsWith('bot_'))
      };
    }

    const playerDocId = entry._id?.toString?.() || entry.toString?.();
    if (!playerDocId || playerDocId === '[object Object]') {
      return null;
    }

    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.PLAYERS, playerDocId);
    if (!playerResult.success || !playerResult.data) {
      return null;
    }

    const player = playerResult.data;
    const userId = player.user?._id?.toString?.()
      || player.user?.toString?.()
      || null;

    return {
      userId,
      isBot: !!player.isBot || (typeof userId === 'string' && userId.startsWith('bot_'))
    };
  }

  async getLiveSeatSnapshot(table) {
    const liveTable = await tableManager.getLiveTable(table._id);

    if (liveTable) {
      const livePlayers = Array.isArray(liveTable.players) ? liveTable.players : [];
      return {
        source: 'redis',
        seatedCount: livePlayers.length,
        humanUserIds: livePlayers
          .filter(player => !player?.isBot)
          .map(player => this.extractRedisPlayerUserId(player))
          .filter(Boolean)
      };
    }

    const currentPlayers = Array.isArray(table.currentPlayers) ? table.currentPlayers : [];
    const humanUserIds = [];

    for (const entry of currentPlayers) {
      const resolved = await this.resolveMongoPlayerEntry(entry);
      if (resolved?.userId && !resolved.isBot) {
        humanUserIds.push(resolved.userId);
      }
    }

    return {
      source: 'mongo',
      seatedCount: currentPlayers.length,
      humanUserIds
    };
  }

  async findEligibleTable(playerId, subTier) {
    
    const tablesResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, {
      subTierId: subTier._id
    });
    
    const tables = tablesResult.data || [];

    for (const table of tables) {
      const seatSnapshot = await this.getLiveSeatSnapshot(table);
      
      // Check capacity
      if (seatSnapshot.seatedCount >= subTier.tableConfig.maxSeats) {
        continue;
      }
      if (seatSnapshot.humanUserIds.includes(playerId.toString())) {
        continue;
      }
      
      // Get seated user IDs from player records (exclude bots)
      const seatedUserIds = seatSnapshot.humanUserIds.filter(userId => userId !== playerId.toString());


      const hasBlockedConflict = await userService.hasBlockedUserConflict(playerId, seatedUserIds);
      if (hasBlockedConflict) {
        continue;
      }

      // Check cooldown conflicts
      const hasConflict = await cooldownService.hasCooldownConflict(playerId, seatedUserIds);
      if (hasConflict) {
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
          continue;
        }
      }

      return table; // Found eligible table
    }

    return null; // No eligible tables
  }

  /**
   * Seat player in existing table
   */
  async seatPlayer(table, playerId, subTier, chipsInPlay) {
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const player = playerResult.data;
    
    // Calculate final chips
    let tableType = table.tableTypeId;
    if (!tableType?.minBuyIn || !tableType?.maxBuyIn) {
      if (table?.tableTypeId) {
        const tableTypeId = table.tableTypeId?._id || table.tableTypeId;
        const tableTypeResult = await mongoHelper.findById(
          mongoHelper.COLLECTIONS.TABLE_TYPES,
          tableTypeId
        );
        if (tableTypeResult.success && tableTypeResult.data) {
          tableType = tableTypeResult.data;
        }
      }

      if ((!tableType?.minBuyIn || !tableType?.maxBuyIn) && subTier?.tableConfig?.bb) {
        tableType = await this.getTableTypeByBB(subTier.tableConfig.bb);
      }
    }

    if (!tableType?.minBuyIn || !tableType?.maxBuyIn) {
      throw new Error(`Unable to resolve table type for table ${table?._id}`);
    }

    const requestedChips = Number(chipsInPlay);
    const normalizedChips = Number.isFinite(requestedChips) && requestedChips > 0
      ? requestedChips
      : tableType.maxBuyIn;
    const finalChips = Math.max(
      tableType.minBuyIn,
      Math.min(normalizedChips, tableType.maxBuyIn)
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
          io.to(`user_${entry.playerId.toString()}`).emit('callJoinTable', {
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
