const mongoHelper = require('../models/customdb');

async function recordRecruitEarning(recruitId, recruiterId, amount, type) {
  try {
    const earningData = {
      recruitId,
      recruiterId,
      amount,
      type
    };

    const result = await mongoHelper.create(
      mongoHelper.COLLECTIONS.RECRUIT_EARNINGS,
      earningData,
      mongoHelper.MODELS.RECRUIT_EARNING
    );

    return result.success ? result.data : null;
  } catch (error) {
    console.error('Error recording recruit earning:', error);
    return null;
  }
}

async function getRecruitsWithEarnings(recruiterId, limit = 30) {
  try {
    const userResult = await mongoHelper.findByIdWithPopulate(
      mongoHelper.COLLECTIONS.USERS,
      recruiterId,
      [{ path: 'recruits', select: 'username accountType walletAddress' }]
    );

    if (!userResult.success || !userResult.data) {
      return [];
    }

    const recruits = userResult.data.recruits || [];
    const recruitIds = recruits.map(r => r._id);

    if (recruitIds.length === 0) {
      return [];
    }

    // Get earnings for each recruit
    const recruitsWithEarnings = await Promise.all(
      recruits.slice(0, limit).map(async (recruit) => {
        const earningsResult = await mongoHelper.aggregate(
          mongoHelper.COLLECTIONS.RECRUIT_EARNINGS,
          [
            {
              $match: {
                recruitId: recruit._id,
                recruiterId: recruiterId
              }
            },
            {
              $group: {
                _id: null,
                totalEarnings: { $sum: '$amount' }
              }
            }
          ]
        );

        const totalEarnings = earningsResult.success && earningsResult.data.length > 0
          ? earningsResult.data[0].totalEarnings
          : 0;

        return {
          _id: recruit._id,
          username: recruit.username,
          accountType: recruit.accountType,
          walletAddress: recruit.walletAddress,
          totalEarnings
        };
      })
    );

    return recruitsWithEarnings;
  } catch (error) {
    console.error('Error getting recruits with earnings:', error);
    return [];
  }
}

async function addRecruit(userId, referralCode) {
  try {
    // Find recruiter by referral code
    const recruiterResult = await mongoHelper.find(
      mongoHelper.COLLECTIONS.USERS,
      { referralCode: referralCode }
    );

    if (!recruiterResult.success || recruiterResult.data.length === 0) {
      return { success: false, message: 'Invalid referral code' };
    }

    const recruiter = recruiterResult.data[0];

    if (recruiter._id === userId) {
      return { success: false, message: 'Cannot refer yourself' };
    }

    // Check if user already has a referrer
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
    if (!userResult.success) {
      return { success: false, message: 'User not found' };
    }

    if (userResult.data.referredBy) {
      return { success: false, message: 'You already have a referrer' };
    }

    // Update user with referrer
    await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      userId,
      { referredBy: recruiter._id },
      mongoHelper.MODELS.USER
    );

    // Add user to recruiter's recruits array
    const recruiterUpdateResult = await mongoHelper.findById(
      mongoHelper.COLLECTIONS.USERS,
      recruiter._id
    );

    if (recruiterUpdateResult.success) {
      const currentRecruits = recruiterUpdateResult.data.recruits || [];
      await mongoHelper.updateById(
        mongoHelper.COLLECTIONS.USERS,
        recruiter._id,
        { recruits: [...currentRecruits, userId] },
        mongoHelper.MODELS.USER
      );
    }

    return { success: true, message: 'Referral added successfully', recruiter: recruiter.username };
  } catch (error) {
    console.error('Error adding recruit:', error);
    return { success: false, message: error.message };
  }
}

module.exports = {
  recordRecruitEarning,
  getRecruitsWithEarnings,
  addRecruit
};
