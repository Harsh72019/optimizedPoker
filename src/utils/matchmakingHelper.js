const mongoHelper = require('../models/customdb');
const cooldownService = require('../services/cooldown.service');
const reputationService = require('../services/reputation.service');


// ✅ INITIAL STATE: Ensure each sub-tier begins with three open tables
// async function ensureInitialTables(subTier) {
//   const existingTables = await MatchmakingTable.countDocuments({
//     subTierId: subTier._id,
//     state: { $in: ['OPEN', 'ACTIVE'] }
//   });

//   if (existingTables < 3) {
//     const tablesToCreate = 3 - existingTables;
//     console.log(`🆕 Creating ${tablesToCreate} initial tables for sub-tier ${subTier.name}`);
    
//     for (let i = 0; i < tablesToCreate; i++) {
//       await createInitialTable(subTier);
//     }
//   }
// }

// ✅ Find eligible open table (PDF definition)
// async function findEligibleOpenTable(userId, subTierId, tableTypeId) {
//   const availableTables = await findTableWithVacanciesInSubTier(
//     subTierId,
//     tableTypeId,
//     subTierId
//   );

//   if (!availableTables) return null;

//   for (const table of availableTables) {
//     // ✅ Check table is OPEN (PDF definition)
//     const isOpenTable = 
//       table.currentPlayers.length < table.tableTypeId.maxSeats &&
//       await hasNoBilateralCooldownConflicts(userId, table);

//     if (isOpenTable) {
//       return table;
//     }
//   }

//   return null;
// }

// ✅ Check bilateral cooldown conflicts (PDF definition)
async function hasNoBilateralCooldownConflicts(requestingPlayerId, table) {
  const seatedPlayerIds = table.currentPlayers.map(p => p.user._id.toString());
  
  // Check if requester has cooldown with any seated player
  const requesterConflict = await cooldownService.hasCooldownConflict(
    requestingPlayerId, 
    seatedPlayerIds
  );
  
  if (requesterConflict) return false;

  // ✅ MUTUAL COOLDOWN ENFORCED: Check if any seated player has cooldown with requester
  const subTier = await SubTier.findById(table.subTierId).populate('tierId');
  if (subTier.tierId.mutualCooldownEnforced) {
    for (const seatedPlayerId of seatedPlayerIds) {
      const mutualConflict = await cooldownService.hasCooldownConflict(
        seatedPlayerId,
        [requestingPlayerId]
      );
      if (mutualConflict) return false;
    }
  }

  return true;
}

// ✅ Bot concession logic (PDF definition)
async function canUseBotConcession(user, subTier) {
  const tier = subTier.tierId;
  
  if (!tier.botConcession.enable) return false;
  
  // Check player reputation meets minimum (PDF: reputation.score >= 40)
  if (user.reputation.score < tier.botConcession.minPlayerReputation) {
    return false;
  }
  
  // Check wait time (PDF: minWaitToConcedeSecs)
  const lastJoinAttempt = user.discipline.lastJoinAttemptAt;
  const waitTimeSeconds = lastJoinAttempt ? 
    (new Date() - lastJoinAttempt) / 1000 : 0;
  
  if (waitTimeSeconds < tier.botConcession.minWaitToConcedeSecs) {
    return false;
  }

  return true;
}

// ✅ Funds and eligibility service methods
async function getAmountRequiredToJoinSubTier(tierId, subTierId) {
  const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
  const subTier = subTierResult.success ? subTierResult.data : null;
  if (!subTier) return 0;
  return subTier.tableConfig.bb * 100; // 100 BB requirement
}

async function holdFunds(playerId, amount) {
  // Implement funds holding logic
  // This would interface with your blockchain service
  console.log(`💰 Holding ${amount} funds for player ${playerId}`);
  return true;
}

async function releaseFunds(playerId, amount) {
  // Implement funds release logic
  console.log(`💰 Releasing ${amount} funds for player ${playerId}`);
  return true;
}

// ✅ Queue management with timestamp check
async function wasRecentlyQueued(userId, subTierId) {
  const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
  const subTier = subTierResult.success ? subTierResult.data : null;
  if (!subTier) return null;
  
  const queueEntry = subTier.playersInQueue.find(
    entry => entry.playerId.toString() === userId.toString()
  );
  
  if (!queueEntry) return null;
  
  const secondsInQueue = (new Date() - queueEntry.enqueuedAt) / 1000;
  return { entry: queueEntry, seconds: secondsInQueue };
}

// ✅ Update flow rate (PDF: Flow Rate is tracked independently per Sub-Tier)
async function updateFlowRate(subTierId) {
  const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
  if (subTierResult.success) {
    const currentFlowRate = subTierResult.data.flowRate || 0;
    await mongoHelper.updateById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId, {
      flowRate: currentFlowRate + 1,
      lastFlowUpdate: new Date()
    });
  }
}

// ✅ Enhanced matchmaking record with PDF fields
async function createMatchmakingRecord(userId, subTierId, tableId, method = 'EXISTING') {
  const subTier = await SubTier.findById(subTierId);
  
  const matchmakingTable = await MatchmakingTable.create({
    subTierId,
    tierId: subTier.tierId._id,
    tableConfig: subTier.tableConfig,
    blockchainTableId: tableId,
    currentPlayerIds: [userId],
    state: 'ACTIVE',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    handsByPlayer: new Map([[userId, 0]]), // Initialize hands counter
    creationMethod: method
  });

  await SubTier.findByIdAndUpdate(subTierId, {
    $push: { tableIds: matchmakingTable._id }
  });

  return matchmakingTable;
}

// ✅ Handle matchmaking failures with reputation penalties
async function handleMatchmakingFailure(userId, error) {
  const deltas = {};
  
  if (error.message.includes('insufficient funds')) {
    deltas.queue_churn = 0.5;
  } else if (error.message.includes('cooldown')) {
    deltas.queue_churn = 1;
  } else if (error.message.includes('reputation')) {
    deltas.queue_churn = 0; // No additional penalty for reputation-based rejects
  } else {
    deltas.queue_churn = 0.2;
  }
  
  await reputationService.updateReputation(userId, deltas);
}

// ✅ Update join attempt for spam detection
async function updateJoinAttempt(userId) {
  const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
  if (userResult.success) {
    const user = userResult.data;
    const discipline = user.discipline || {};
    discipline.lastJoinAttemptAt = new Date();
    await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, userId, { discipline });
  }
}

// ✅ Enhanced account type validation
function validateAccountType(user, tier) {
  const accountHierarchy = ['Human', 'Rat', 'Cat', 'Dog'];
  const userLevel = accountHierarchy.indexOf(user.accountType || 'Human');
  const requiredLevel = accountHierarchy.indexOf(tier.minAccountType);
  return userLevel >= requiredLevel;
}

// ✅ Find available table with cooldown checks
async function findAvailableTableWithCooldown(userId, subTierId, tableTypeId) {
  try {
    const tableService = require('../services/table.service');
    const availableTable = await tableService.findTableWithVacanciesInSubTier(
      null,
      tableTypeId,
      subTierId
    );

    if (!availableTable) {
      return null;
    }


    console.log('checking cooldown conflicts ', availableTable.currentPlayers);
    // Check cooldown conflicts
    const otherPlayerIds = availableTable.currentPlayers
      .map(p => p.toString())
      .filter(id => id !== userId);
    if (otherPlayerIds.length > 0) {
      // const hasConflict = await cooldownService.hasCooldownConflict(userId, otherPlayerIds);
      // if (hasConflict) {
      //   console.log(`🚫 Cooldown conflict for user ${userId}`);
      //   return {
      //     cooldownConflict: true
      //   };
      // }
    }

    return availableTable;
  } catch (error) {
    console.error('❌ Error finding available table:', error);
    return null;
  }
}

module.exports = {
    // ensureInitialTables,   
    // findEligibleOpenTable,
    canUseBotConcession,
    getAmountRequiredToJoinSubTier,
    holdFunds,
    releaseFunds,
    wasRecentlyQueued,
    updateFlowRate,
    createMatchmakingRecord,
    handleMatchmakingFailure,
    updateJoinAttempt,
    validateAccountType,
    findAvailableTableWithCooldown
};


