// userLevel.service.js
const {UserStat} = require('../models/userStats.model');
const {User} = require('../models/user.model');
const mongoose = require('mongoose');

// Define level thresholds
const LEVEL_THRESHOLDS = {
  NEWCOMER: {
    hands: 0,
    winRate: 0,
    profitRatio: 0,
  },
  RAT: {
    hands: 10,
    winRate: 15, // 15% win rate
    profitRatio: -20, // Can be losing money
  },
  CAT: {
    hands: 50,
    winRate: 25, // 25% win rate
    profitRatio: 5, // Slight profit
  },
  DOG: {
    hands: 200,
    winRate: 35, // 35% win rate
    profitRatio: 15, // Good profit
  },
};

/**
 * Determines a user's level based on their gameplay statistics
 * @param {Object} userStats - The user's statistics
 * @returns {String} level - The user's level (NEWCOMER, RAT, CAT, or DOG)
 */
const determineUserLevel = userStats => {
  if (!userStats) return 'NEWCOMER';

  const {totalHandsPlayed, winRate, profitRatio} = userStats;

  if (
    totalHandsPlayed >= LEVEL_THRESHOLDS.DOG.hands &&
    winRate >= LEVEL_THRESHOLDS.DOG.winRate &&
    profitRatio >= LEVEL_THRESHOLDS.DOG.profitRatio
  ) {
    return 'DOG';
  }

  if (
    totalHandsPlayed >= LEVEL_THRESHOLDS.CAT.hands &&
    winRate >= LEVEL_THRESHOLDS.CAT.winRate &&
    profitRatio >= LEVEL_THRESHOLDS.CAT.profitRatio
  ) {
    return 'CAT';
  }

  if (
    totalHandsPlayed >= LEVEL_THRESHOLDS.RAT.hands &&
    winRate >= LEVEL_THRESHOLDS.RAT.winRate &&
    profitRatio >= LEVEL_THRESHOLDS.RAT.profitRatio
  ) {
    return 'RAT';
  }

  return 'NEWCOMER';
};

/**
 * Updates a user's level based on their current statistics
 * @param {String} userId - The user's ID
 * @returns {Object} result - The result of the level update
 */
const updateUserLevel = async userId => {
  try {
    const stats = await UserStat.findOne({userId});
    if (!stats) {
      return {success: false, message: 'User stats not found'};
    }

    const currentLevel = determineUserLevel(stats);

    // Find user and update their level
    const user = await User.findById(userId);
    if (!user) {
      return {success: false, message: 'User not found'};
    }

    // Initialize level property if it doesn't exist
    if (!user.level) {
      user.level = 'NEWCOMER';
    }

    // Check if level has changed
    const hasLevelChanged = user.level !== currentLevel;

    // Update level if changed
    if (hasLevelChanged) {
      const oldLevel = user.level;
      user.level = currentLevel;
      await user.save();

      // Return success with level change information
      return {
        success: true,
        hasLevelChanged: true,
        oldLevel,
        newLevel: currentLevel,
        stats: {
          hands: stats.totalHandsPlayed,
          winRate: stats.winRate,
          profitRatio: stats.profitRatio,
          lastUpdated: stats.lastUpdated,
        },
      };
    }

    // Return success but no level change
    return {
      success: true,
      hasLevelChanged: false,
      currentLevel,
      stats: {
        hands: stats.totalHandsPlayed,
        winRate: stats.winRate,
        profitRatio: stats.profitRatio,
        lastUpdated: stats.lastUpdated,
      },
    };
  } catch (error) {
    console.error('Error updating user level:', error);
    return {success: false, message: `Error updating user level: ${error.message}`};
  }
};

/**
 * Checks and updates levels for all users or a specific user
 * @param {String} userId - Optional user ID (if omitted, checks all users)
 * @returns {Object} result - Summary of level updates
 */
const checkAndUpdateLevels = async (userId = null) => {
  try {
    // If specific user ID is provided
    if (userId) {
      return await updateUserLevel(userId);
    }

    // Otherwise, process all users
    const userStats = await UserStat.find({});
    const results = {
      success: true,
      processed: 0,
      levelChanges: 0,
      errors: 0,
      updates: [],
    };

    // Process each user
    for (const stat of userStats) {
      results.processed++;
      const updateResult = await updateUserLevel(stat.userId);

      if (!updateResult.success) {
        results.errors++;
      } else if (updateResult.hasLevelChanged) {
        results.levelChanges++;
        results.updates.push({
          userId: stat.userId,
          oldLevel: updateResult.oldLevel,
          newLevel: updateResult.newLevel,
        });
      }
    }

    return results;
  } catch (error) {
    console.error('Error checking and updating levels:', error);
    return {success: false, message: `Error checking and updating levels: ${error.message}`};
  }
};

/**
 * Gets level statistics for the entire player base
 * @returns {Object} levelStats - Statistics about player levels
 */
const getLevelDistribution = async () => {
  try {
    const users = await User.find({}).select('level');

    // Initialize counts
    const distribution = {
      NEWCOMER: 0,
      RAT: 0,
      CAT: 0,
      DOG: 0,
      UNKNOWN: 0,
    };

    // Count users in each level
    for (const user of users) {
      if (!user.level) {
        distribution.UNKNOWN++;
      } else if (distribution[user.level] !== undefined) {
        distribution[user.level]++;
      } else {
        distribution.UNKNOWN++;
      }
    }

    // Calculate percentages
    const total = users.length;
    const percentages = {};

    for (const level in distribution) {
      percentages[level] = total > 0 ? ((distribution[level] / total) * 100).toFixed(1) : 0;
    }

    return {
      success: true,
      totalUsers: total,
      distribution,
      percentages,
    };
  } catch (error) {
    console.error('Error getting level distribution:', error);
    return {success: false, message: `Error getting level distribution: ${error.message}`};
  }
};

/**
 * Gets the level requirements for advancement
 * @returns {Object} requirements - Level advancement requirements
 */
const getLevelRequirements = () => {
  return {
    success: true,
    requirements: LEVEL_THRESHOLDS,
  };
};

/**
 * Get level history for a specific user
 * @param {String} userId - The user's ID
 * @returns {Object} result - The user's level history
 */
const getUserLevelHistory = async userId => {
  try {
    // This assumes you've added a levelHistory field to the User model
    // If not, you would need to add this field to track level changes
    const user = await User.findById(userId).select('level levelHistory');

    if (!user) {
      return {success: false, message: 'User not found'};
    }

    // Get current stats to show progress toward next level
    const stats = await UserStat.findOne({userId});
    let nextLevel = null;
    let progressToNextLevel = {};

    // Calculate progress to next level
    if (stats) {
      const currentLevel = user.level || 'NEWCOMER';

      if (currentLevel === 'NEWCOMER') {
        nextLevel = 'RAT';
        progressToNextLevel = {
          hands: {
            current: stats.totalHandsPlayed,
            required: LEVEL_THRESHOLDS.RAT.hands,
            percentage: Math.min(100, Math.floor((stats.totalHandsPlayed / LEVEL_THRESHOLDS.RAT.hands) * 100)),
          },
          winRate: {
            current: stats.winRate,
            required: LEVEL_THRESHOLDS.RAT.winRate,
            percentage: Math.min(100, Math.floor((stats.winRate / LEVEL_THRESHOLDS.RAT.winRate) * 100)),
          },
          profitRatio: {
            current: stats.profitRatio,
            required: LEVEL_THRESHOLDS.RAT.profitRatio,
            percentage: Math.min(100, Math.floor((stats.profitRatio / LEVEL_THRESHOLDS.RAT.profitRatio) * 100)),
          },
        };
      } else if (currentLevel === 'RAT') {
        nextLevel = 'CAT';
        progressToNextLevel = {
          hands: {
            current: stats.totalHandsPlayed,
            required: LEVEL_THRESHOLDS.CAT.hands,
            percentage: Math.min(100, Math.floor((stats.totalHandsPlayed / LEVEL_THRESHOLDS.CAT.hands) * 100)),
          },
          winRate: {
            current: stats.winRate,
            required: LEVEL_THRESHOLDS.CAT.winRate,
            percentage: Math.min(100, Math.floor((stats.winRate / LEVEL_THRESHOLDS.CAT.winRate) * 100)),
          },
          profitRatio: {
            current: stats.profitRatio,
            required: LEVEL_THRESHOLDS.CAT.profitRatio,
            percentage: Math.min(100, Math.floor((stats.profitRatio / LEVEL_THRESHOLDS.CAT.profitRatio) * 100)),
          },
        };
      } else if (currentLevel === 'CAT') {
        nextLevel = 'DOG';
        progressToNextLevel = {
          hands: {
            current: stats.totalHandsPlayed,
            required: LEVEL_THRESHOLDS.DOG.hands,
            percentage: Math.min(100, Math.floor((stats.totalHandsPlayed / LEVEL_THRESHOLDS.DOG.hands) * 100)),
          },
          winRate: {
            current: stats.winRate,
            required: LEVEL_THRESHOLDS.DOG.winRate,
            percentage: Math.min(100, Math.floor((stats.winRate / LEVEL_THRESHOLDS.DOG.winRate) * 100)),
          },
          profitRatio: {
            current: stats.profitRatio,
            required: LEVEL_THRESHOLDS.DOG.profitRatio,
            percentage: Math.min(100, Math.floor((stats.profitRatio / LEVEL_THRESHOLDS.DOG.profitRatio) * 100)),
          },
        };
      }
    }

    return {
      success: true,
      currentLevel: user.level || 'NEWCOMER',
      nextLevel,
      progressToNextLevel,
      levelHistory: user.levelHistory || [],
      stats: stats
        ? {
            hands: stats.totalHandsPlayed,
            winRate: stats.winRate,
            profitRatio: stats.profitRatio,
            lastUpdated: stats.lastUpdated,
          }
        : null,
    };
  } catch (error) {
    console.error('Error getting user level history:', error);
    return {success: false, message: `Error getting user level history: ${error.message}`};
  }
};

// For the User schema, you will need to add these fields:
// - level: { type: String, enum: ['NEWCOMER', 'RAT', 'CAT', 'DOG'], default: 'NEWCOMER' }
// - levelHistory: [{ level: String, achievedAt: Date, default: [] }]

module.exports = {
  determineUserLevel,
  updateUserLevel,
  checkAndUpdateLevels,
  getLevelDistribution,
  getLevelRequirements,
  getUserLevelHistory,
};
