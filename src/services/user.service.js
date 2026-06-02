const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const config = require('../config/config');
const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const mongoHelper = require('../models/customdb');
const {  createInitialUserStats} = require('./player.service');
const { sendWelcomeEmail } = require('./email.service');
const accountWalletService = require('./account-wallet.service');
const promoRewardService = require('./promo-reward.service');

//blockchain part

function normalizeId(value) {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return value._id.toString();
  return value.toString();
}

function uniqueIds(values = []) {
  return [...new Set(values.map(normalizeId).filter(Boolean))];
}

function getDisplayName(user) {
  return user?.name || user?.username || '';
}

function getFallbackNetWorth(user) {
  const explicitNetWorth = user?.netWorth ?? user?.networth;
  if (explicitNetWorth !== undefined && explicitNetWorth !== null) {
    return Number(explicitNetWorth) || 0;
  }

  return (Number(user?.balance) || 0) + (Number(user?.chips) || 0);
}

async function getNetWorth(user) {
  try {
    const walletIntegrationService = require('./wallet-integration.service');
    const balance = await walletIntegrationService.getUserBalance(user._id);
    if (balance && Number.isFinite(Number(balance.poolBalance))) {
      return Number(balance.poolBalance);
    }
  } catch (error) {
    console.error(`Failed to fetch proxy wallet balance for user ${user?._id}:`, error.message);
  }

  return getFallbackNetWorth(user);
}

async function formatSmallUserSummary(user, invitedBy = null, isBlocked = false) {
  return {
    userId: user._id,
    name: getDisplayName(user),
    username: user.username || '',
    profilePic: user.profilePic || null,
    invitedBy: invitedBy
      ? {
          userId: invitedBy._id,
          name: getDisplayName(invitedBy),
          username: invitedBy.username || '',
        }
      : null,
    rank: user.accountType || 'Human',
    netWorth: await getNetWorth(user),
    isBlocked,
  };
}

async function buildSmallUserSummary(userId, isBlocked = false) {
  const user = await findUserOrThrow(normalizeId(userId));
  let invitedBy = null;
  const referredById = normalizeId(user.referredBy);

  if (referredById) {
    const invitedByResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, referredById);
    invitedBy = invitedByResult.success ? invitedByResult.data : null;
  }

  return formatSmallUserSummary(user, invitedBy, isBlocked);
}

async function findUserOrThrow(userId, message = 'User not found') {
  const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);

  if (!userResult.success || !userResult.data) {
    throw new ApiError(httpStatus.NOT_FOUND, message);
  }

  return userResult.data;
}

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
      [
        {
          path: 'recruits',
          collection: mongoHelper.COLLECTIONS.USERS,
          select: 'username accountType walletAddress profilePic createdAt'
        },
        {
          path: 'referredBy',
          collection: mongoHelper.COLLECTIONS.USERS,
          select: 'username accountType referralCode profilePic'
        }
      ]
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
    const [recruitsWithEarnings, referralSummary] = await Promise.all([
      recruitEarningsService.getRecruitsWithEarnings(id, 30),
      recruitEarningsService.getReferralProfileSummary(id)
    ]);

    return {
      _id: user._id,
      username: user.username,
      email: user.email,
      walletAddress: accountWalletService.getActiveWalletAddress(user),
      wallet: accountWalletService.buildWalletSummary(user),
      profilePic: user.profilePic,
      referralCode: user.referralCode,
      tier: user.accountType,
      chips: user.chips,
      handsFromNextTier: user.handsFromNextTier,
      reputation: user.reputation,
      rewards: await promoRewardService.getRewardStatus(id),
      invitedBy: user.referredBy
        ? {
            _id: user.referredBy._id,
            username: user.referredBy.username,
            tier: user.referredBy.accountType,
            referralCode: user.referredBy.referralCode,
            profilePic: user.referredBy.profilePic || null
          }
        : null,
      wins: {
        totalHandsWon: stats?.totalHandsWon || 0,
        totalHandsPlayed: stats?.totalHandsPlayed || 0,
        totalAmountWon: stats?.totalAmountWon || 0,
        winRate: stats?.winRate || 0,
        biggestWin: stats?.biggestWin || 0
      },
      referral: referralSummary || {
        referralCode: user.referralCode,
        referredBy: user.referredBy?._id || null,
        totalRecruits: user.recruits?.length || 0,
        recruitsByTier: { Human: 0, Rat: 0, Cat: 0, Dog: 0 },
        commissionRate: 30,
        totalEarnings: 0,
        totalCommissionEvents: 0,
        earningsByType: {
          deposit: 0,
          game_win: 0,
          affiliate_commission: 0
        }
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

async function addFriend(userId, friendUserId) {
  const currentUserId = normalizeId(userId);
  const targetUserId = normalizeId(friendUserId);

  if (!targetUserId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Friend userId is required.');
  }

  if (currentUserId === targetUserId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'You cannot add yourself as a friend.');
  }

  const [user, friend] = await Promise.all([
    findUserOrThrow(currentUserId),
    findUserOrThrow(targetUserId, 'Friend user not found'),
  ]);

  if (friend.isBlocked) {
    throw new ApiError(httpStatus.FORBIDDEN, 'This user account is blocked.');
  }

  const blockedUsers = uniqueIds(user.blockedUsers);
  if (blockedUsers.includes(targetUserId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Unblock this user before adding them as a friend.');
  }

  const friends = uniqueIds(user.friends);
  if (!friends.includes(targetUserId)) {
    friends.push(targetUserId);
  }

  const updateResult = await mongoHelper.updateById(
    mongoHelper.COLLECTIONS.USERS,
    currentUserId,
    { friends },
    mongoHelper.MODELS.USER
  );

  if (!updateResult.success) {
    throw new Error(updateResult.error);
  }

  return buildSmallUserSummary(friend._id, false);
}

async function blockFriend(userId, blockedUserId) {
  const currentUserId = normalizeId(userId);
  const targetUserId = normalizeId(blockedUserId);

  if (!targetUserId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Blocked userId is required.');
  }

  if (currentUserId === targetUserId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'You cannot block yourself.');
  }

  const [user, blockedUser] = await Promise.all([
    findUserOrThrow(currentUserId),
    findUserOrThrow(targetUserId, 'User to block not found'),
  ]);

  const blockedUsers = uniqueIds(user.blockedUsers);

  if (!blockedUsers.includes(targetUserId)) {
    blockedUsers.push(targetUserId);
  }

  const updateResult = await mongoHelper.updateById(
    mongoHelper.COLLECTIONS.USERS,
    currentUserId,
    { blockedUsers },
    mongoHelper.MODELS.USER
  );

  if (!updateResult.success) {
    throw new Error(updateResult.error);
  }

  return buildSmallUserSummary(blockedUser._id, true);
}

async function hasBlockedUserConflict(userId, otherUserIds = []) {
  const currentUserId = normalizeId(userId);
  const normalizedOtherIds = uniqueIds(otherUserIds).filter(id => id !== currentUserId);

  if (!currentUserId || normalizedOtherIds.length === 0) {
    return false;
  }

  const user = await findUserOrThrow(currentUserId);
  const blockedSet = new Set(uniqueIds(user.blockedUsers));

  for (const otherUserId of normalizedOtherIds) {
    if (blockedSet.has(otherUserId)) {
      return true;
    }

    const otherUser = await findUserOrThrow(otherUserId, 'Blocked relationship user not found');
    const otherBlockedSet = new Set(uniqueIds(otherUser.blockedUsers));
    if (otherBlockedSet.has(currentUserId)) {
      return true;
    }
  }

  return false;
}

async function unblockFriend(userId, blockedUserId) {
  const currentUserId = normalizeId(userId);
  const targetUserId = normalizeId(blockedUserId);

  if (!targetUserId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Blocked userId is required.');
  }

  const [user, unblockedUser] = await Promise.all([
    findUserOrThrow(currentUserId),
    findUserOrThrow(targetUserId, 'User to unblock not found'),
  ]);

  const blockedUsers = uniqueIds(user.blockedUsers).filter(id => id !== targetUserId);

  const updateResult = await mongoHelper.updateById(
    mongoHelper.COLLECTIONS.USERS,
    currentUserId,
    { blockedUsers },
    mongoHelper.MODELS.USER
  );

  if (!updateResult.success) {
    throw new Error(updateResult.error);
  }

  return buildSmallUserSummary(unblockedUser._id, false);
}

async function getFriends(userId) {
  const user = await findUserOrThrow(normalizeId(userId));
  const friendIds = uniqueIds(user.friends);
  const blockedSet = new Set(uniqueIds(user.blockedUsers));

  const friends = [];
  for (const friendId of friendIds) {
    const friendResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, friendId);
    if (!friendResult.success || !friendResult.data) {
      continue;
    }

    const friend = friendResult.data;
    let invitedBy = null;
    const referredById = normalizeId(friend.referredBy);
    if (referredById) {
      const invitedByResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, referredById);
      invitedBy = invitedByResult.success ? invitedByResult.data : null;
    }

    friends.push(await formatSmallUserSummary(friend, invitedBy, blockedSet.has(friendId)));
  }

  return friends;
}

async function getSmallUserData(userId) {
  return buildSmallUserSummary(userId, false);
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
  addFriend,
  blockFriend,
  unblockFriend,
  hasBlockedUserConflict,
  getFriends,
  getSmallUserData,
};
