const mongoHelper = require('../models/customdb');
const blockchainService = require('./blockchain.service');
const ApiError = require('../utils/ApiError');
const { MATCHMAKING_TIERS } = require('../constants/constants');
const {findTableWithVacanciesInSubTier} = require('./table.service');
const reputationService = require('./reputation.service');
const cooldownService = require('./cooldown.service');
// const queueMatcher = require('./queueMatcher.service');
const { updateJoinAttempt, getAmountRequiredToJoinSubTier, findAvailableTableWithCooldown, updateFlowRate } = require('../utils/matchmakingHelper');

class MatchmakingLayerService {

  // Initialize matchmaking system
  async initializeMatchmaking() {
    try {
      const countResult = await mongoHelper.count(mongoHelper.COLLECTIONS.TIERS);
      const existingTiers = countResult.success ? countResult.data : 0;
      
      if (existingTiers > 0) {
        console.log('✅ Matchmaking tiers already initialized');
        return { success: true, message: 'Tiers already exist' };
      }

      const tiers = MATCHMAKING_TIERS

      for (const tierData of tiers) {
        const tierResult = await mongoHelper.create(mongoHelper.COLLECTIONS.TIERS, {
          name: tierData.name,
          minAccountType: tierData.minAccountType,
          bankAllocatedReserve: tierData.bankAllocatedReserve,
          mutualCooldownEnforced: true,
          cooldownWindowGames: 3,
          botConcession: { enable: true, minWaitToConcedeSecs: 10, minPlayerReputation: 10 },
          reputationConfig: {
            wHands: 0.5,
            wEarly: -5,
            wChurn: -2,
            wDCClient: -3,
            wDCServer: -1,
            dcServerCap: 3,
            emaAlpha: 0.1,
            earnBackHandsRequired: 30
          },
          maxWaitSoftensSecs: 30,
          subTierIds: []
        });
        
        if (!tierResult.success) throw new Error(tierResult.error);
        const tier = tierResult.data;

        for (const subTierData of tierData.subTiers) {
          const subTierResult = await mongoHelper.create(mongoHelper.COLLECTIONS.SUB_TIERS, {
            name: subTierData.name,
            tierId: tier._id,
            tableConfig: {
              maxSeats: 9,
              bb: subTierData.bb,
              turnTimeSeconds: 25,
              closureGraceSecs: 30,
              mode: 'CASH'
            },
            playersInQueue: [],
            tableIds: []
          });
          
          if (!subTierResult.success) throw new Error(subTierResult.error);
          const subTier = subTierResult.data;

          const existingTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, tier._id);
          if (existingTierResult.success) {
            const existingTier = existingTierResult.data;
            const updatedSubTierIds = [...(existingTier.subTierIds || []), subTier._id];
            await mongoHelper.updateById(mongoHelper.COLLECTIONS.TIERS, tier._id, {
              subTierIds: updatedSubTierIds
            });
          }
        }
      }

      console.log('✅ Matchmaking system initialized successfully');
      return { success: true, message: 'Matchmaking initialized' };
    } catch (error) {
      console.error('❌ Error initializing matchmaking:', error);
      throw error;
    }
  }

  // Main matchmaking function - integrates with your existing checkTableExistence flow
  async processMatchmaking(userId, userAddress, subTierId, chipsInPlay = null) {
    try {
      console.log(`🎯 Matchmaking request: User ${userId}, SubTier ${subTierId}`);

      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
      const subTierResult = await mongoHelper.findByIdWithPopulate(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId, [
        { path: 'tierId', collection: mongoHelper.COLLECTIONS.TIERS }
      ]);
      
      const user = userResult.success ? userResult.data : null;
      const subTier = subTierResult.success ? subTierResult.data : null;
      console.log(user, subTier, "🚀 ~ processMatchmaking ~ user, subTier");
      if (!user || !subTier) {
        throw new ApiError('User or sub-tier not found', 404);
      }

      // ✅ 1. INITIAL STATE: Ensure sub-tier has initial tables
      // await this.ensureInitialTables(subTier);

      // ✅ 2. Initialize player for tier progression
      await reputationService.initializePlayerForTier(user);

      // Refresh user data after initialization
      const refreshedUserResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
      const refreshedUser = refreshedUserResult.success ? refreshedUserResult.data : user;

      // Set default account type if not set
      if (!refreshedUser.accountType) {
        await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, userId, { accountType: 'Human' });
        refreshedUser.accountType = 'Human';
      }

      // Validate account type
      if (!this.validateAccountType(refreshedUser, subTier.tierId)) {
        throw new ApiError(`Account type insufficient. Required: ${subTier.tierId.minAccountType}, Have: ${refreshedUser.accountType}`, 403);
      }

      // ✅ 3. Update join attempt timestamp for spam detection
      await updateJoinAttempt(userId);

      // ✅ 4. Check reputation for eligibility (allow new players)
      const reputationScore = refreshedUser.reputation?.score ?? 50;
      if (reputationScore < 0) {
        throw new ApiError(`Your reputation is too low to join matchmaking (${reputationScore})`, 403);
      }

      // Get table type based on sub-tier BB
      const tableType = await this.getTableTypeByBB(subTier.tableConfig.bb);
      if (!tableType) {
        throw new ApiError(`No table type found for BB: ${subTier.tableConfig.bb}`, 404);
      }

      // ✅ FIX: Default to maxBuyIn if chipsInPlay not provided
      if (!chipsInPlay || chipsInPlay < tableType.minBuyIn) {
        chipsInPlay = tableType.maxBuyIn;
        console.log(`💰 Using maxBuyIn: ${chipsInPlay}`);
      }

      // ✅ 5. Check funds with required amount calculation
      const requiredAmount = await getAmountRequiredToJoinSubTier(subTier.tierId._id, subTierId);
      

      // Check user balance (using your existing logic)
      let userBalance = await blockchainService.getBalance(userAddress);
      userBalance = Math.floor(userBalance);

      if (userBalance < tableType.minBuyIn) {
        throw new ApiError(`Cannot join table: Your balance must be at least ${tableType.minBuyIn}.`, 400);
      }

      if (userBalance < requiredAmount) {
        throw new ApiError(`Insufficient funds. Required: ${requiredAmount}, Have: ${userBalance}`, 402);
      }

      // Calculate final chips (using your existing logic)
      const finalChipsInPlay = this.calculateFinalChips(chipsInPlay, tableType);

      if (userBalance < finalChipsInPlay) {
        throw new ApiError(`Insufficient balance. You need ${finalChipsInPlay} but have ${userBalance}.`, 402);
      }

      // console.log('tableType:', tableType);
      // // Find or create table through blockchain (using your existing service)
      // const result = await blockchainService.findTableOrCreateThroughBlockchainNew(
      //   subTier?.tableConfig?.maxSeats || 6, // playerCount from sub-tier config
      //   tableType._id,
      //   finalChipsInPlay,
      //   userAddress,
      //   subTierId,
      //   userId
      // );

      // // Create matchmaking record
      // // await this.createMatchmakingRecord(userId, subTierId, result.tableData._id);
      // // return await this.seatPlayerInExistingTable(userId, userAddress, subTier, result.tableData, finalChipsInPlay);
      // // ✅ RETURN data for socket emission instead of seating directly
      // return {
      //   success: true,
      //   message: result.message,
      //   data: {
      //     blockChainTableId: result.tableData.tableBlockchainId,
      //     tableId: result.tableData._id,
      //     chipsInPlay: finalChipsInPlay,
      //     tableCreated: result.wasCreated,
      //     autoRenew: false,
      //     maxBuy: false,
      //     viaMatchmaking: true,
      //     // Add additional data needed for joinTable
      //     subTierId: subTierId,
      //     userData: {
      //       userId: userId,
      //       walletAddress: userAddress
      //     }
      //   }
      // };

      const matchResult = await queueMatcher.processJoinRequest(
        userId,
        subTier.tierId._id,
        subTierId,
        finalChipsInPlay
      );

      // If queued, return queue status
      if (matchResult.status === 'queued') {
        return {
          success: false,
          message: matchResult.message,
          data: {
            status: 'queued',
            position: matchResult.position,
            subTierId: subTierId
          }
        };
      }

      // If seated, continue with existing flow
      const result = {
        tableData: {
          _id: matchResult.tableId,
          tableBlockchainId: matchResult.blockChainTableId
        },
        wasCreated: matchResult.data.tableCreated,
        currentPlayers: [] // Will be populated below
      };

      // // ✅ 8. Create matchmaking record with enhanced data (ENHANCED)
      // const matchmakingRecord = await this.createMatchmakingRecord(
      //   userId, 
      //   subTierId, 
      //   result.tableData._id,
      //   tableCreationMethod
      // );

      // ✅ 9. Cooldowns already updated in queueMatcher.seatPlayer()
      // No need to update again here

      // // ✅ 10. Record funding if bot concession used (NEW)
      // if (tableCreationMethod === 'BOT_CONCESSION') {
      //   await this.recordBotFunding(subTier.tierId._id, result.tableData._id, finalChipsInPlay);
      // }

      // ✅ 11. Reputation already updated in queueMatcher
      // No need to update again here

      // ✅ 14. UPDATE FLOW RATE
      await updateFlowRate(subTierId);

      return {
        success: true,
        message: matchResult.withBot ? 'Matched with bot concession' : 'Matched to table',
        data: {
          blockChainTableId: matchResult.blockChainTableId,
          tableId: matchResult.tableId,
          chipsInPlay: finalChipsInPlay,
          tableCreated: matchResult.data?.tableCreated || false,
          autoRenew: true,
          maxBuy: true,
          viaMatchmaking: true,
          withBot: matchResult.withBot || false,
          subTierId: subTierId,
          userData: {
            userId: userId,
            walletAddress: userAddress
          }
        }
      };


    } catch (error) {
      console.error('❌ Matchmaking error:', error.message);
      throw error;
    }
  }

  // Get table type by big blind amount
  async getTableTypeByBB(bb) {
    const findResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLE_TYPES, { bigBlind: bb });
    let tableType = findResult.success && findResult.data.length > 0 ? findResult.data[0] : null;
    
    if (!tableType) {
      // Create table type if it doesn't exist
      const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.TABLE_TYPES, {
        tableName: `${bb} BB Table`,
        minBuyIn: bb * 20,
        maxBuyIn: bb * 100,
        smallBlind: bb / 2,
        bigBlind: bb,
        maxSeats: 6
      });
      tableType = createResult.success ? createResult.data : null;
    }
    console.log(`🚀 ~ getTableTypeByBB ~ tableType:`, tableType);

    return tableType;
  }

  // Calculate final chips (mirroring your existing logic)
  calculateFinalChips(chipsInPlay, tableType) {
    return chipsInPlay < tableType.minBuyIn
      ? tableType.minBuyIn
      : chipsInPlay > tableType.maxBuyIn
        ? tableType.maxBuyIn
        : chipsInPlay;
  }

  // Create matchmaking record for tracking
  async createMatchmakingRecord(userId, subTierId, tableId) {
    // Find existing matchmaking table for this poker table
    // const findResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES, { blockchainTableId: tableId });
    // let matchmakingTable = findResult.success && findResult.data.length > 0 ? findResult.data[0] : null;

    // if (!matchmakingTable) {
    const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
    const subTier = subTierResult.success ? subTierResult.data : null;
    
    // const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.TABLES, {
    //   subTierId,
    //   tierId: subTier.tierId,
    //   tableConfig: subTier.tableConfig,
    //   blockchainTableId: tableId,
    //   state: 'ACTIVE',
    //   currentPlayerIds: [userId],
    //   handsByPlayer: {}
    // });
    // matchmakingTable = createResult.success ? createResult.data : null;

    // Update sub-tier with new table
    const existingSubTier = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
    if (existingSubTier.success) {
      const updatedTableIds = [...(existingSubTier.data.tableIds || []), matchmakingTable._id];
      await mongoHelper.updateById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId, {
        tableIds: updatedTableIds
      });
    }
    // } else {
    // Update existing matchmaking table
    // const existingTable = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, matchmakingTable._id);
    // if (existingTable.success) {
    //   const updatedPlayerIds = [...(existingTable.data.currentPlayerIds || []), userId];
    //   await mongoHelper.updateById(mongoHelper.COLLECTIONS.TABLES, matchmakingTable._id, {
    //     currentPlayerIds: updatedPlayerIds,
    //     lastActivityAt: new Date()
    //   });
    // }
    // }

    return matchmakingTable;
  }

  // Utility methods
  validateAccountType(user, tier) {
    const accountHierarchy = ['Human', 'Rat', 'Cat', 'Dog'];
    const userLevel = accountHierarchy.indexOf(user.accountType || 'Human');
    const requiredLevel = accountHierarchy.indexOf(tier.minAccountType);
    return userLevel >= requiredLevel;
  }

  // Get all available sub-tiers for frontend
  async getAvailableSubTiers() {
    const result = await mongoHelper.findWithPopulate(mongoHelper.COLLECTIONS.SUB_TIERS, { _id : { $exists: true }}, [
      { path: 'tierId', collection: mongoHelper.COLLECTIONS.TIERS }
    ]);
    console.log(result , "🚀 ~ getAvailableSubTiers ~ result");
    return result.success ? result.data : [];
  }

  // Get matchmaking status
  async getMatchmakingStatus() {
    const subTiersResult = await mongoHelper.findWithPopulate(mongoHelper.COLLECTIONS.SUB_TIERS, {}, [
      { path: 'tierId', collection: mongoHelper.COLLECTIONS.TIERS },
      { path: 'tableIds', collection: mongoHelper.COLLECTIONS.TABLES }
    ]);
    
    const subTiers = subTiersResult.success ? subTiersResult.data : [];
    const status = {};

    for (const subTier of subTiers) {
      status[subTier.name] = {
        bb: subTier.tableConfig.bb,
        tables: (subTier.tableIds || []).length,
        activePlayers: 0,
        queuedPlayers: (subTier.playersInQueue || []).length
      };

      for (const tableId of (subTier.tableIds || [])) {
        const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
        if (tableResult.success && tableResult.data) {
          status[subTier.name].activePlayers += (tableResult.data.currentPlayerIds || []).length;
        }
      }
    }

    return status;
  }

  // Cleanup for testing
  async cleanupTestData() {
    const findMatchmakingTables = await mongoHelper.find(mongoHelper.COLLECTIONS.TABLES);
    if (findMatchmakingTables.success && findMatchmakingTables.data) {
      for (const table of findMatchmakingTables.data) {
        await mongoHelper.deleteById(mongoHelper.COLLECTIONS.TABLES, table._id);
      }
    }
    
    const findSubTiers = await mongoHelper.find(mongoHelper.COLLECTIONS.SUB_TIERS);
    if (findSubTiers.success && findSubTiers.data) {
      for (const subTier of findSubTiers.data) {
        await mongoHelper.deleteById(mongoHelper.COLLECTIONS.SUB_TIERS, subTier._id);
      }
    }
    
    const findTiers = await mongoHelper.find(mongoHelper.COLLECTIONS.TIERS);
    if (findTiers.success && findTiers.data) {
      for (const tier of findTiers.data) {
        await mongoHelper.deleteById(mongoHelper.COLLECTIONS.TIERS, tier._id);
      }
    }
    
    return { success: true, message: 'Test data cleaned up' };
  }

  // Find available table with cooldown checks using your table service
  async findAvailableTableInSubTier(userId, subTierId, tableTypeId) {
    try {
      // Use your existing table service to find tables
      const availableTable = await findTableWithVacanciesInSubTier(
        subTierId, // playerCount from sub-tier config
        tableTypeId,
        subTierId
      );

      if (!availableTable) {
        console.log(`❌ No available tables found in sub-tier ${subTierId}`);
        return null;
      }

      // Check cooldown conflicts
      // const hasConflict = await this.hasCooldownConflict(userId, availableTable.currentPlayers.map(p => p.user._id));

      // if (hasConflict) {
      //   console.log(`🚫 Cooldown conflict for user ${userId} in table ${availableTable._id}`);
      //   return null;
      // }

      // console.log(`✅ Table ${availableTable._id} available for user ${userId}`);
      return availableTable;

    } catch (error) {
      console.error('❌ Error finding available table:', error);
      return null;
    }
  }

  // Seat player in existing table using your table service
  async seatPlayerInExistingTable(userId, userAddress, subTier, table, chipsInPlay) {
    try {
      console.log(`🪑 Seating player ${userId} in existing table ${table._id}`);

      // Use your existing addUserToTable function
      const result = await addUserToTable(
        table._id,
        userId,
        null, // socketId will be set by socket layer
        chipsInPlay,
        true, // autoRenew
        false, // maxBuy
        null,  // io instance
        false  // isBot
      );

      if (result.error) {
        throw new Error(result.message);
      }

      // Update matchmaking table record
      await this.updateMatchmakingTable(subTier._id, table._id, userId);

      // Update cooldowns
      // await this.updateCooldowns(table._id, subTier.tierId._id, [
      //   userId,
      //   ...table.currentPlayers.map(p => p.user._id)
      // ]);

      return {
        success: true,
        message: 'Successfully seated at existing table',
        data: {
          blockChainTableId: table.tableBlockchainId,
          tableId: table._id,
          chipsInPlay: chipsInPlay,
          tableCreated: false,
          viaMatchmaking: true
        }
      };

    } catch (error) {
      console.error('❌ Error seating player in existing table:', error);
      throw error;
    }
  }

  async updateMatchmakingTable(subTierId, tableId, playerId) {
    const findResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);

    console.log(findResult , "🚀 ~ updateMatchmakingTable ~ findResult:" , subTierId , "subTierId" , tableId , "blockChaintableId")
    
    const matchmakingTable = findResult.success && findResult.data ? findResult.data : null;

    if (matchmakingTable) {
      const existingTable = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, matchmakingTable._id);
      if (existingTable.success) {
        const updatedPlayerIds = [...(existingTable.data.currentPlayerIds || []), playerId];
        const updateResult = await mongoHelper.updateById(mongoHelper.COLLECTIONS.TABLES, matchmakingTable._id, {
          currentPlayerIds: updatedPlayerIds,
          lastActivityAt: new Date()
        });
        return updateResult.success ? updateResult.data : null;
      }
    }
    
    return null;
  }

  async getTiersWithSubTiers(userId) {
    console.log(userId , "🚀 ~ getTiersWithSubTiers ~ userId")
    const tiersResult = await mongoHelper.getAll(mongoHelper.COLLECTIONS.TIERS);
    if (!tiersResult.success) return [];
    
    let userAccountType = 'Human';
    if (userId) {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
      if (userResult.success && userResult.data) {
        userAccountType = userResult.data.accountType || 'Human';
        console.log(`🔍 [getTiersWithSubTiers] User ${userId} accountType: ${userAccountType}`);
      }
    }
    
    const accountHierarchy = ['Human', 'Rat', 'Cat', 'Dog'];
    const userLevel = accountHierarchy.indexOf(userAccountType);
    
    const result = [];

    for (const tier of tiersResult.data) {
      const requiredLevel = accountHierarchy.indexOf(tier.minAccountType);
      const isLocked = userLevel < requiredLevel;
      
      const subTiersResult = await mongoHelper.find(mongoHelper.COLLECTIONS.SUB_TIERS, { tierId: tier._id });
      const subTiers = subTiersResult.success ? subTiersResult.data : [];
      
      let tierMinBuy = Infinity;
      let tierMaxBuy = -Infinity;
      let tierMinBB = Infinity;
      let tierMaxBB = -Infinity;
      let tierMinSB = Infinity;
      let tierMaxSB = -Infinity;
      
      const subTiersWithRanges = subTiers.map(subTier => {
        const bb = subTier.tableConfig.bb;
        const sb = bb / 2;
        const minBuy = parseFloat((bb * 20).toFixed(2));
        const maxBuy = parseFloat((bb * 100).toFixed(2));
        
        tierMinBuy = Math.min(tierMinBuy, minBuy);
        tierMaxBuy = Math.max(tierMaxBuy, maxBuy);
        tierMinBB = Math.min(tierMinBB, bb);
        tierMaxBB = Math.max(tierMaxBB, bb);
        tierMinSB = Math.min(tierMinSB, sb);
        tierMaxSB = Math.max(tierMaxSB, sb);
        
        return {
          _id: subTier._id,
          name: subTier.name,
          bb: bb,
          bigBlind: bb,
          smallBlind: sb,
          minBuy,
          maxBuy,
          maxSeats: subTier.tableConfig.maxSeats,
          mode: subTier.tableConfig.mode
        };
      });
      
      result.push({
        _id: tier._id,
        name: tier.name,
        minAccountType: tier.minAccountType,
        isLocked,
        minBuy: tierMinBuy === Infinity ? 0 : parseFloat(tierMinBuy.toFixed(2)),
        maxBuy: tierMaxBuy === -Infinity ? 0 : parseFloat(tierMaxBuy.toFixed(2)),
        smallBlind: tierMinSB === Infinity ? 0 : tierMinSB,
        bigBlind: tierMaxBB === -Infinity ? 0 : tierMaxBB,
        subTiers: subTiersWithRanges
      });
    }
    
    return result;
  }

}



module.exports = new MatchmakingLayerService();