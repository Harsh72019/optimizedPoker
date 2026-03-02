const httpStatus = require('http-status');
const mongoHelper = require('../models/customdb');
const ApiError = require('../utils/ApiError');

const getPlayerInfoByTypeId = async (type, id) => {
  try {
    const playerResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.PLAYERS, type, id);

    if (!playerResult.success || !playerResult.data) {
      return null;
    }

    const player = playerResult.data;

    // Populate user data
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, player.user);

    if (userResult.success && userResult.data) {
      return {
        ...player,
        user: userResult.data,
      };
    }

    return player;
  } catch (error) {
    throw new Error(error.message);
  }
};

const updateUserHandStats = async (userId, handResult) => {
  try {
    if (
      !userId ||
      (typeof userId === 'string' && userId.startsWith('bot_')) ||
      (typeof userId === 'object' && userId._id && userId._id.startsWith('bot_'))
    ) {
      return null;
    }
    
    let stats = await mongoHelper.find(mongoHelper.COLLECTIONS.USER_STATS, { userId });
    
    if (!stats.success || stats.data.length === 0) {
      const createResult = await mongoHelper.create(
        mongoHelper.COLLECTIONS.USER_STATS,
        { userId },
        mongoHelper.MODELS.USER_STAT
      );
      stats = { success: true, data: [createResult.data] };
    }

    const currentStats = Array.isArray(stats.data) ? stats.data[0] : stats.data;
    const statId = currentStats._id;

    const updates = {
      totalHandsPlayed: (currentStats.totalHandsPlayed || 0) + 1
    };

    if (handResult.isDeposit) {
      updates.totalDeposits = (currentStats.totalDeposits || 0) + handResult.amount;
    } else if (handResult.isWithdrawal) {
      updates.totalWithdrawals = (currentStats.totalWithdrawals || 0) + handResult.amount;
    } else if (handResult.isWin) {
      updates.totalHandsWon = (currentStats.totalHandsWon || 0) + 1;
      updates.totalAmountWon = (currentStats.totalAmountWon || 0) + handResult.amount;
      updates.biggestWin = Math.max(currentStats.biggestWin || 0, handResult.amount);
      
      if (handResult.handDetails) {
        const newHandValue = handResult.handDetails.handValue || 0;
        const currentBestHandValue = currentStats.bestHand?.handValue || 0;
        
        if (newHandValue > currentBestHandValue) {
          updates.bestHand = {
            cards: handResult.handDetails.cards.map(card => ({
              cardFace: card.cardFace,
              suit: card.suit,
              value: card.value
            })),
            handRank: handResult.handDetails.handRank,
            handValue: newHandValue
          };
        }
      }
    } else {
      updates.totalHandsLost = (currentStats.totalHandsLost || 0) + 1;
      updates.totalAmountLost = (currentStats.totalAmountLost || 0) + handResult.amount;
    }

    if (updates.totalHandsPlayed > 0) {
      updates.winRate = ((updates.totalHandsWon || currentStats.totalHandsWon || 0) / updates.totalHandsPlayed) * 100;
    }

    const totalLost = updates.totalAmountLost || currentStats.totalAmountLost || 0;
    const totalWon = updates.totalAmountWon || currentStats.totalAmountWon || 0;
    if (totalLost > 0) {
      updates.profitRatio = totalWon / totalLost;
    } else if (totalWon > 0) {
      updates.profitRatio = 99.99;
    }

    updates.lastUpdated = new Date();

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USER_STATS,
      statId,
      updates,
      mongoHelper.MODELS.USER_STAT
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error);
    }

    console.log(`✅ Stats updated for user ${userId}`);
    return updateResult.data;
  } catch (error) {
    console.error('Error updating user stats:', error);
    return null;
  }
};


async function createInitialUserStats(userId) {
  try {
    const existingResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.USER_STATS, 'userId', userId);

    if (existingResult.success && existingResult.data) {
      return existingResult.data;
    }

    const createResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.USER_STATS,
      { userId },
      mongoHelper.MODELS.USER_STAT
    );

    if (!createResult.success) {
      throw new Error(createResult.error);
    }

    return createResult.data;
  } catch (error) {
    console.error('Error creating initial user stats:', error);
    throw error;
  }
}

module.exports = {
  getPlayerInfoByTypeId,
  updateUserHandStats,
  createInitialUserStats
};