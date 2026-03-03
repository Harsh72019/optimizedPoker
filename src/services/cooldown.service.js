const mongoHelper = require('../models/customdb');

class CooldownService {
  async updateCooldownsOnSeat(tableId, tierId, participants) {
    const tierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, tierId);
    const tier = tierResult.data;

    if (!tier || !tier.mutualCooldownEnforced) return;
    
    const windowSize = tier.cooldownWindowGames || 3;
    
    // Filter out bots from participants
    const humanParticipants = [];
    for (const userId of participants) {
      const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
      if (userResult.success && userResult.data && !userResult.data.isBot) {
        humanParticipants.push(userId);
      }
    }
    
    for (const playerId of humanParticipants) {
      const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
      const player = playerResult.data;
      
      if (!player) continue;

      if (!player.cooldown) {
        player.cooldown = { recentGames: [], opponentCounts: {} };
      }
      if (!player.cooldown.recentGames) {
        player.cooldown.recentGames = [];
      }
      if (!player.cooldown.opponentCounts) {
        player.cooldown.opponentCounts = {};
      }

      const others = humanParticipants.filter(id => id !== playerId);

      // Decrement ALL existing opponent counts by 1 (one game has passed)
      for (const oppId in player.cooldown.opponentCounts) {
        player.cooldown.opponentCounts[oppId]--;
        if (player.cooldown.opponentCounts[oppId] <= 0) {
          delete player.cooldown.opponentCounts[oppId];
        }
      }

      // Set counts for current opponents to windowSize (they're now in cooldown)
      for (const opponentId of others) {
        const key = opponentId.toString();
        player.cooldown.opponentCounts[key] = windowSize;
      }

      // Add new game
      player.cooldown.recentGames.push({
        tableId: tableId,
        seatedAt: new Date(),
        opponents: others,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      });

      // Keep only last windowSize games for reference
      if (player.cooldown.recentGames.length > windowSize) {
        player.cooldown.recentGames.shift();
      }

      await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, playerId, {
        cooldown: player.cooldown
      });
    }
  }

  async hasCooldownConflict(playerId, opponentIds) {
    console.log("inside the cooldown conflicts check")
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const player = playerResult.data;
    
    if (!player || !player.cooldown) return false;

    // Clean up expired games first
    await this.cleanupExpiredCooldowns(playerId);

    // Refresh player data after cleanup
    const refreshedResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const refreshedPlayer = refreshedResult.data;
    console.log(refreshedPlayer , "refreshed player")
    if (!refreshedPlayer || !refreshedPlayer.cooldown) return false;

    const countsMap = refreshedPlayer.cooldown.opponentCounts || {};
    console.log(countsMap , "counts map")
    for (const oppId of opponentIds) {
      const count = countsMap.get ? countsMap.get(oppId.toString()) : countsMap[oppId.toString()];
      console.log(count  , "count inside the for loop")
      if (count && count > 0) {
        console.log(`🚫 Cooldown conflict: Player ${playerId} has count ${count} with opponent ${oppId}`);
        return true;
      }
    }

    return false;
  }

  async getCooldownSnapshot(playerId) {
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const player = playerResult.data;
    
    if (!player || !player.cooldown) {
      return { opponentIds: [], windowGames: 0, updatedAt: new Date() };
    }

    return {
      opponentIds: Object.keys(player.cooldown.opponentCounts || {}),
      windowGames: player.cooldown.recentGames?.length || 0,
      updatedAt: player.updatedAt
    };
  }

  async cleanupExpiredCooldowns(playerId) {
    const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
    const player = playerResult.data;
    
    if (!player || !player.cooldown || !player.cooldown.recentGames) return;

    const now = new Date();
    const validGames = [];
    const opponentDecrements = {};

    // Count how many times each opponent appears in expired games
    for (const game of player.cooldown.recentGames) {
      if (new Date(game.expiresAt) > now) {
        validGames.push(game);
      } else {
        for (const oppId of game.opponents) {
          const key = oppId.toString();
          opponentDecrements[key] = (opponentDecrements[key] || 0) + 1;
        }
      }
    }

    // Decrement counts by the number of expired games
    const countsMap = player.cooldown.opponentCounts || {};
    for (const oppId in opponentDecrements) {
      const currentCount = countsMap[oppId] || 0;
      const newCount = Math.max(0, currentCount - opponentDecrements[oppId]);
      if (newCount === 0) {
        delete countsMap[oppId];
      } else {
        countsMap[oppId] = newCount;
      }
    }

    await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, playerId, {
      cooldown: {
        recentGames: validGames,
        opponentCounts: countsMap
      }
    });

    console.log(`🧹 Cleaned up ${player.cooldown.recentGames.length - validGames.length} expired games for player ${playerId}`);
  }

  async recordGameEnd(tableId, participants, tierId) {
    const tierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, tierId);
    const tier = tierResult.data;
    const windowSize = tier?.cooldownWindowGames || 3;
    
    for (const playerId of participants) {
      const playerResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, playerId);
      const player = playerResult.data;
      
      if (!player) continue;

      if (!player.cooldown) {
        player.cooldown = { recentGames: [], opponentCounts: {} };
      }

      const others = participants.filter(id => id !== playerId);

      // Decrement all existing opponent counts
      for (const oppId in player.cooldown.opponentCounts) {
        player.cooldown.opponentCounts[oppId]--;
        if (player.cooldown.opponentCounts[oppId] <= 0) {
          delete player.cooldown.opponentCounts[oppId];
        }
      }

      // Set counts for current opponents
      for (const opponentId of others) {
        player.cooldown.opponentCounts[opponentId.toString()] = windowSize;
      }

      // Add new game
      player.cooldown.recentGames.push({
        tableId: tableId,
        seatedAt: new Date(),
        opponents: others,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      });

      // Keep only last windowSize games
      if (player.cooldown.recentGames.length > windowSize) {
        player.cooldown.recentGames.shift();
      }

      await mongoHelper.updateById(mongoHelper.COLLECTIONS.USERS, playerId, {
        cooldown: player.cooldown
      });
    }
  }
}

module.exports = new CooldownService();
