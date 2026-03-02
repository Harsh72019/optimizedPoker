const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const config = require('../config/config');
const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const mongoHelper = require('../models/customdb');
const {  createInitialUserStats} = require('./player.service');
const { sendWelcomeEmail } = require('./email.service');

//blockchain part

async function getUserById(id) {
  try {
    // Get the user from the API
    const userResult = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, {_id: id});
    console.log("userResult",userResult)

    if (!userResult.success || !userResult.data) {
      return null;
    }

    const user = userResult.data;

    // Separately get the user stats
    const userStatsResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.USER_STATS, 'userId', id);

    // Combine the results
    return {
      ...user,
      userStats: userStatsResult.success ? userStatsResult.data : {},
    };
  } catch (error) {
    console.error('Error in getUserById:', error);
    return null;
  }
}

async function getUserProfile(id) {
  try {
    const userResult = await mongoHelper.findByIdWithPopulate(
      mongoHelper.COLLECTIONS.USERS,
      id,
      [{ path: 'recruits', select: 'username accountType walletAddress' }]
    );

    if (!userResult.success || !userResult.data) {
      throw new Error('User not found');
    }

    const user = userResult.data;
    
    // Ensure user stats exist
    await createInitialUserStats(id);
    const userStatsResult = await mongoHelper.findOne(mongoHelper.COLLECTIONS.USER_STATS, 'userId', id);
    const stats = userStatsResult.success ? userStatsResult.data : null;

    // Get recent 30 recruits with their earnings
    const recruitEarningsService = require('./recruitEarnings.service');
    const recruitsWithEarnings = await recruitEarningsService.getRecruitsWithEarnings(id, 30);

    return {
      _id: user._id,
      username: user.username,
      email: user.email,
      walletAddress: user.walletAddress,
      profilePic: user.profilePic,
      referralCode: user.referralCode,
      tier: user.accountType,
      chips: user.chips,
      handsFromNextTier: user.handsFromNextTier,
      reputation: user.reputation,
      wins: {
        totalHandsWon: stats?.totalHandsWon || 0,
        totalAmountWon: stats?.totalAmountWon || 0,
        winRate: stats?.winRate || 0,
        biggestWin: stats?.biggestWin || 0
      },
      recruits: recruitsWithEarnings,
      totalRecruits: user.recruits?.length || 0,
      createdAt: user.createdAt
    };
  } catch (error) {
    console.error('Error in getUserProfile:', error);
    throw error;
  }
}

const updateUserDetails = async (username, userId) => {
  try {
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      userId,
      { username },
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error('User not found');
    }

    return updateResult.data;
  } catch (error) {
    console.error('Error updating user details:', error);
    throw error;
  }
};


// Updated getUserByIdFromJwt function
async function getUserByIdFromJwt(token) {
  try {
    const decoded = await promisify(jwt.verify)(token, config.JWT_SECRET);
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, decoded.id);

    if (!userResult.success || !userResult.data) {
      return { error: true, message: 'User not found' };
    }

    return userResult.data;
  } catch (err) {
    throw new Error(err.message);
  }
}

// Updated getUsers function
async function getUsers(filters, options) {
  try {
    const skip = (options.page - 1) * options.limit;
    const result = await mongoHelper.paginate(mongoHelper.COLLECTIONS.USERS, filters, skip, options.limit);

    if (!result.success) {
      throw new Error(result.error);
    }

    return result.data;
  } catch (error) {
    console.error('Error in getUsers:', error);
    throw error;
  }
}

// Updated updateUserById function
async function updateUserById(id, newDetails) {
  try {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, id);

    if (!userResult.success || !userResult.data) {
      throw new ApiError(httpStatus.NOT_FOUND, 'User not found.');
    }

    const user = userResult.data;

    if (user.isBlocked) {
      throw new ApiError(httpStatus.FORBIDDEN, 'User has been blocked.');
    }

    const isNewEmail = newDetails.email && (!user.email || user.email === '');

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      id,
      newDetails,
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error);
    }

    if (isNewEmail) {
      try {
        await sendWelcomeEmail(newDetails.email, user.username || 'Poker Player');
        // console.log(`Welcome email sent to ${newDetails.email}`);
      } catch (emailError) {
        console.error(`Failed to send welcome email: ${emailError.message}`);
      }
    }

    return updateResult.data;
  } catch (error) {
    console.error('Error in updateUserById:', error);
    throw error;
  }
}


async function deleteUserById(id) {
  try {
    const result = await mongoHelper.deleteById(mongoHelper.COLLECTIONS.USERS, id);

    if (!result.success) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to delete the user');
    }

    return true;
  } catch (err) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to delete the user');
  }
}

async function updatePreferencesById(id, newPrefs) {
  try {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, id);

    if (!userResult.success || !userResult.data) {
      throw new Error('User not found');
    }

    const user = userResult.data;
    const updatedPreferences = {
      ...user.preferences,
      ...newPrefs,
    };

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      id,
      { preferences: updatedPreferences },
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error);
    }

    return updateResult.data;
  } catch (error) {
    console.error('Error in updatePreferencesById:', error);
    throw error;
  }
}




module.exports = {
  getUsers,
  getUserById,
  getUserProfile,
  updateUserById,
  deleteUserById,
  updatePreferencesById,
  getUserByIdFromJwt,
  updateUserDetails,
};
