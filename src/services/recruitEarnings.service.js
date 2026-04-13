const mongoHelper = require('../models/customdb');

function floorToCents(amount) {
  return Math.floor((Number(amount) + Number.EPSILON) * 100) / 100;
}

async function recordRecruitEarning(recruitId, recruiterId, amount, type) {
  try {
    if (!recruitId || !recruiterId || !amount || amount <= 0) {
      return null;
    }

    const earningData = {
      recruitId,
      recruiterId,
      amount: floorToCents(amount),
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
      [{
        path: 'recruits',
        collection: mongoHelper.COLLECTIONS.USERS,
        select: 'username accountType walletAddress profilePic createdAt'
      }]
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
          profilePic: recruit.profilePic || null,
          joinedAt: recruit.createdAt || null,
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
    const normalizedReferralCode = String(referralCode || '').trim().toUpperCase();
    if (!normalizedReferralCode) {
      return { success: false, message: 'Referral code is required' };
    }

    // Find recruiter by referral code
    const recruiterResult = await mongoHelper.find(
      mongoHelper.COLLECTIONS.USERS,
      { referralCode: normalizedReferralCode }
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
      if (!currentRecruits.includes(userId)) {
        await mongoHelper.updateById(
          mongoHelper.COLLECTIONS.USERS,
          recruiter._id,
          { recruits: [...currentRecruits, userId] },
          mongoHelper.MODELS.USER
        );
      }
    }

    return { success: true, message: 'Referral added successfully', recruiter: recruiter.username };
  } catch (error) {
    console.error('Error adding recruit:', error);
    return { success: false, message: error.message };
  }
}

async function getRecruiterForUser(userId) {
  try {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
    if (!userResult.success || !userResult.data?.referredBy) {
      return null;
    }

    const recruiterResult = await mongoHelper.findById(
      mongoHelper.COLLECTIONS.USERS,
      userResult.data.referredBy
    );

    return recruiterResult.success ? recruiterResult.data : null;
  } catch (error) {
    console.error('Error getting recruiter for user:', error);
    return null;
  }
}

async function getReferralProfileSummary(userId) {
  try {
    const [userResult, earningsResult] = await Promise.all([
      mongoHelper.findByIdWithPopulate(
        mongoHelper.COLLECTIONS.USERS,
        userId,
        [{
          path: 'recruits',
          collection: mongoHelper.COLLECTIONS.USERS,
          select: 'username accountType walletAddress profilePic createdAt'
        }]
      ),
      mongoHelper.aggregate(mongoHelper.COLLECTIONS.RECRUIT_EARNINGS, [
        {
          $match: {
            recruiterId: userId
          }
        },
        {
          $group: {
            _id: '$type',
            totalAmount: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    if (!userResult.success || !userResult.data) {
      return null;
    }

    const recruits = userResult.data.recruits || [];
    const recruitsByTier = { Human: 0, Rat: 0, Cat: 0, Dog: 0 };

    recruits.forEach(recruit => {
      const tier = recruit.accountType || 'Human';
      recruitsByTier[tier] = (recruitsByTier[tier] || 0) + 1;
    });

    const earningsByType = {
      deposit: 0,
      game_win: 0,
      affiliate_commission: 0
    };

    let totalEarnings = 0;
    let totalCommissionEvents = 0;

    if (earningsResult.success && Array.isArray(earningsResult.data)) {
      earningsResult.data.forEach(entry => {
        earningsByType[entry._id] = floorToCents(entry.totalAmount || 0);
        totalEarnings += Number(entry.totalAmount || 0);
        totalCommissionEvents += Number(entry.count || 0);
      });
    }

    return {
      referralCode: userResult.data.referralCode,
      referredBy: userResult.data.referredBy || null,
      totalRecruits: recruits.length,
      recruitsByTier,
      commissionRate: 30,
      totalEarnings: floorToCents(totalEarnings),
      totalCommissionEvents,
      earningsByType
    };
  } catch (error) {
    console.error('Error getting referral profile summary:', error);
    return null;
  }
}

module.exports = {
  recordRecruitEarning,
  getRecruitsWithEarnings,
  addRecruit,
  getRecruiterForUser,
  getReferralProfileSummary
};
