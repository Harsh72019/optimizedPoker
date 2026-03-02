const mongoHelper = require('../models/customdb');

class ReputationService {
  determineInitialTierByDeposit(depositAmount) {
    if (depositAmount >= 100) return 'Dog';
    if (depositAmount >= 34) return 'Cat';
    if (depositAmount >= 14) return 'Rat';
    return 'Human';
  }

  async setInitialTierByDeposit(userId, depositAmount) {
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
    const player = playerResult.data;
    
    if (!player) {
      throw new Error('User not found');
    }

    // Check if this is first deposit (accountType is still default 'Human' and handsFromNextTier is 0)
    if (player.accountType === 'Human' && (!player.handsFromNextTier || player.handsFromNextTier === 0)) {
      const initialTier = this.determineInitialTierByDeposit(depositAmount);
      const handsRequired = this.getHandsRequiredForNextTier(initialTier);
      
      await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, userId, {
        accountType: initialTier,
        handsFromNextTier: handsRequired,
        'reputation.score': 80,
        'reputation.earnBackHandsRemaining': 0
      });
      
      console.log(`🎯 [Initial Tier] User ${player.username} deposit ${depositAmount} -> ${initialTier} tier`);
      return { tier: initialTier, isFirstDeposit: true };
    }
    
    return { tier: player.accountType, isFirstDeposit: false };
  }

  async initializePlayerForTier(player) {
    // Initialize reputation if missing
    if (!player.reputation) {
      player.reputation = { score: 80, earnBackHandsRemaining: 0 };
    }
    
    // Initialize handsFromNextTier if missing or 0
    if (!player.handsFromNextTier || player.handsFromNextTier === 0) {
      player.handsFromNextTier = this.getHandsRequiredForNextTier(player.accountType);
    }
    
    await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, player._id, {
      handsFromNextTier: player.handsFromNextTier,
      'reputation.score': player.reputation.score,
      'reputation.earnBackHandsRemaining': player.reputation.earnBackHandsRemaining
    });
    
    console.log(`✅ [Reputation] Initialized player ${player.username}: accountType=${player.accountType}, handsFromNextTier=${player.handsFromNextTier}`);
    return player;
  }

  async updateReputation(playerId, deltas) {
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const player = playerResult.data;
    
    if (!player) return;

    const tierResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TIERS, { 
      minAccountType: player.accountType 
    });
    const tier = tierResult.data?.[0];
    
    if (!tier || !tier.reputationConfig) return;

    const cfg = tier.reputationConfig;
    
    // Initialize reputation if missing
    if (!player.reputation) {
      player.reputation = { score: 50, earnBackHandsRemaining: 0 };
    }
    
    const currentScore = player.reputation.score ?? 50;

    let reputationChange = 0;
    reputationChange += (deltas.hands_completed || 0) * cfg.wHands;
    reputationChange += (deltas.early_leaves || 0) * cfg.wEarly;
    reputationChange += (deltas.queue_churn || 0) * cfg.wChurn;
    reputationChange += (deltas.disconnects?.client || 0) * cfg.wDCClient;
    reputationChange += Math.min(deltas.disconnects?.server || 0, cfg.dcServerCap) * cfg.wDCServer;

    const newScore = currentScore * (1 - cfg.emaAlpha) + 
                    cfg.emaAlpha * (100 + reputationChange);
    
    player.reputation.score = Math.max(0, Math.min(100, newScore));
    
    await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, playerId, {
      'reputation.score': player.reputation.score,
      'reputation.earnBackHandsRemaining': player.reputation.earnBackHandsRemaining ?? 0
    });
    
    console.log(`✅ Reputation updated for ${playerId}: ${currentScore} -> ${player.reputation.score}`);
    return player.reputation.score;
  }

  getReputationTier(score) {
    if (score >= 80) return 'HIGH';
    if (score >= 60) return 'MEDIUM';
    if (score >= 40) return 'LOW';
    return 'VERY_LOW';
  }

  getHandsRequiredForNextTier(accountType) {
    const requirements = {
      'Human': 100, 'Cat': 100, 'Rat': 100, 'Dog': 0
    };
    return requirements[accountType] || 100;
  }

  async onPlayerLeave(playerId, tableId, handsPlayed, reason = "NORMAL") {
    console.log(`🎯 [onPlayerLeave] ENTRY - playerId: ${playerId}, handsPlayed: ${handsPlayed}, reason: ${reason}`);
    
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const player = playerResult.data;
    
    if (!player) {
      console.error(`❌ [onPlayerLeave] Player ${playerId} not found`);
      return;
    }

    console.log(`👤 [onPlayerLeave] Player: ${player.username}, Current tier: ${player.accountType}, handsFromNextTier: ${player.handsFromNextTier}`);

    // Initialize reputation if missing
    if (!player.reputation) {
      player.reputation = { score: 50, earnBackHandsRemaining: 0 };
    }

    if (handsPlayed > 0) {
      console.log(`👊 [onPlayerLeave] Decrementing handsFromNextTier by ${handsPlayed}`);
      player.handsFromNextTier -= handsPlayed;
      console.log(`📊 [onPlayerLeave] New handsFromNextTier: ${player.handsFromNextTier}`);
      
      if (player.handsFromNextTier <= 0) {
        console.log(`🎉 [onPlayerLeave] Tier upgrade triggered! handsFromNextTier: ${player.handsFromNextTier}`);
        const overflow = Math.abs(player.handsFromNextTier);
        await this.upgradeAccountType(player, overflow);
      } else {
        console.log(`📊 [onPlayerLeave] No upgrade yet, ${player.handsFromNextTier} hands remaining`);
      }
    }

    const threshold = player.discipline?.earlyLeaveMinHands || 10;
    const tierResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TIERS, { 
      minAccountType: player.accountType 
    });
    const tier = tierResult.data?.[0];
    const cfg = tier?.reputationConfig || {};

    const deltas = {
      hands_completed: 0,
      early_leaves: 0,
      disconnects: { client: 0, server: 0 }
    };

    if (handsPlayed < threshold) {
      deltas.early_leaves = 1;
      player.reputation.earnBackHandsRemaining = cfg.earnBackHandsRequired || 30;
    } else {
      if (player.reputation.earnBackHandsRemaining > 0) {
        const debt = player.reputation.earnBackHandsRemaining;
        const reduce = Math.min(handsPlayed, debt);
        player.reputation.earnBackHandsRemaining -= reduce;
        deltas.hands_completed = Math.max(0, handsPlayed - reduce);
      } else {
        deltas.hands_completed = handsPlayed;
      }
    }

    if (reason === "DISCONNECT_CLIENT") {
      deltas.disconnects.client = 1;
    } else if (reason === "DISCONNECT_SERVER") {
      deltas.disconnects.server = 1;
    }

    await this.updateReputation(playerId, deltas);
    await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, playerId, {
      handsFromNextTier: player.handsFromNextTier,
      'reputation.earnBackHandsRemaining': player.reputation.earnBackHandsRemaining
    });
  }

  async upgradeAccountType(player, overflowHands) {
    console.log(`🚀 [upgradeAccountType] ENTRY - Player: ${player.username}, Current: ${player.accountType}, Overflow: ${overflowHands}`);
    
    const accountHierarchy = ['Human', 'Rat', 'Cat', 'Dog'];
    const currentIndex = accountHierarchy.indexOf(player.accountType);
    
    console.log(`📊 [upgradeAccountType] Current index: ${currentIndex}, Max index: ${accountHierarchy.length - 1}`);
    
    if (currentIndex < accountHierarchy.length - 1) {
      const oldType = player.accountType;
      player.accountType = accountHierarchy[currentIndex + 1];
      
      const handsRequired = this.getHandsRequiredForNextTier(player.accountType);
      player.handsFromNextTier = Math.max(0, handsRequired - overflowHands);
      
      console.log(`🎉 [upgradeAccountType] Upgrading ${player.username} from ${oldType} to ${player.accountType}`);
      console.log(`📊 [upgradeAccountType] New handsFromNextTier: ${player.handsFromNextTier}`);
      
      await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, player._id, {
        accountType: player.accountType,
        handsFromNextTier: player.handsFromNextTier
      });
      
      console.log(`✅ [upgradeAccountType] Player ${player._id} upgraded from ${oldType} to ${player.accountType}`);
    } else {
      console.log(`🏆 [upgradeAccountType] Player ${player.username} already at max tier: ${player.accountType}`);
    }
  }
}

module.exports = new ReputationService();
