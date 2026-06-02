const mongoHelper = require('../models/customdb');

const DEFAULT_AD_REWARD = 1;
const DEFAULT_REWARD_CAP = 2;
const DEFAULT_UNLOCK_DEPOSIT = 5;
const DEFAULT_UNLOCK_GAMES = 1;

class PromoRewardService {
  normalizeAmount(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) {
      return 0;
    }

    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }

  buildRewardState(user = {}) {
    const rewardState = user.rewardState || {};
    const totalPromoCreditsGranted = this.normalizeAmount(rewardState.totalPromoCreditsGranted);
    const maxRewardCap = this.normalizeAmount(rewardState.maxRewardCap || DEFAULT_REWARD_CAP);
    return {
      promoBalance: this.normalizeAmount(user.promoBalance),
      cashBalance: this.normalizeAmount(user.cashBalance),
      lockedRewardBalance: this.normalizeAmount(user.lockedRewardBalance),
      rewardUnlocked: !!user.rewardUnlocked,
      maxRewardCap,
      unlockDepositThreshold: this.normalizeAmount(rewardState.unlockDepositThreshold || DEFAULT_UNLOCK_DEPOSIT),
      unlockCashGamesRequired: Number(rewardState.unlockCashGamesRequired || DEFAULT_UNLOCK_GAMES),
      qualifyingDepositTotal: this.normalizeAmount(rewardState.qualifyingDepositTotal),
      qualifyingCashGamesPlayed: Number(rewardState.qualifyingCashGamesPlayed || 0),
      totalPromoCreditsGranted,
      totalLockedRewardsEarned: this.normalizeAmount(rewardState.totalLockedRewardsEarned),
      totalUnlockedRewards: this.normalizeAmount(rewardState.totalUnlockedRewards),
      rewardCapRemaining: this.normalizeAmount(Math.max(0, maxRewardCap - totalPromoCreditsGranted)),
      lastAdRewardClaimAt: rewardState.lastAdRewardClaimAt || null,
      unlockedAt: rewardState.unlockedAt || null,
    };
  }

  async getUser(userId) {
    const result = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
    if (!result.success || !result.data) {
      throw new Error('User not found');
    }

    return result.data;
  }

  async saveRewardState(userId, user, updates = {}) {
    const currentRewardState = user.rewardState || {};
    const nextRewardState = updates.rewardState
      ? { ...currentRewardState, ...updates.rewardState }
      : currentRewardState;

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      userId,
      {
        ...updates,
        rewardState: nextRewardState,
      },
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error || 'Failed to update reward state');
    }

    return updateResult.data;
  }

  async findExistingRewardEvent(userId, type, idempotencyKey) {
    if (!idempotencyKey) {
      return null;
    }

    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, {
      userId,
      type,
      'metadata.idempotencyKey': idempotencyKey,
    });

    return result.success && result.data?.length ? result.data[0] : null;
  }

  async logRewardEvent(userId, type, amount, description, metadata = {}) {
    await mongoHelper.create(
      mongoHelper.COLLECTIONS.TRANSACTION_LEDGER,
      {
        userId,
        type,
        amount,
        description,
        balanceAfter: 0,
        walletAddress: null,
        blockchainTxHash: null,
        transactionId: `${type.toLowerCase()}_${userId}_${Date.now()}`,
        metadata,
        status: 'COMPLETED',
      },
      mongoHelper.MODELS.TRANSACTION_LEDGER
    );
  }

  async grantAdReward(userId, adViewId, amount = DEFAULT_AD_REWARD) {
    const idempotencyKey = `ad_reward:${adViewId}`;
    const existingEvent = await this.findExistingRewardEvent(userId, 'PROMO_AD_REWARD', idempotencyKey);
    const user = await this.getUser(userId);

    if (existingEvent) {
      return {
        duplicate: true,
        rewardState: this.buildRewardState(user),
      };
    }

    const normalizedAmount = this.normalizeAmount(amount);
    const rewardState = this.buildRewardState(user);
    const creditedAmount = Math.min(normalizedAmount, rewardState.rewardCapRemaining);

    if (creditedAmount <= 0) {
      return {
        duplicate: false,
        capped: true,
        creditedAmount: 0,
        rewardState,
      };
    }

    const updatedUser = await this.saveRewardState(userId, user, {
      promoBalance: this.normalizeAmount(user.promoBalance) + creditedAmount,
      lockedRewardBalance: this.normalizeAmount(user.lockedRewardBalance) + creditedAmount,
      rewardState: {
        totalPromoCreditsGranted: this.normalizeAmount((user.rewardState?.totalPromoCreditsGranted || 0) + creditedAmount),
        totalLockedRewardsEarned: this.normalizeAmount((user.rewardState?.totalLockedRewardsEarned || 0) + creditedAmount),
        lastAdRewardClaimAt: new Date().toISOString(),
      },
    });

    await this.logRewardEvent(
      userId,
      'PROMO_AD_REWARD',
      creditedAmount,
      'Promotional ad reward credited as locked balance',
      {
        idempotencyKey,
        adViewId,
      }
    );

    return {
      duplicate: false,
      capped: creditedAmount < normalizedAmount,
      creditedAmount,
      rewardState: this.buildRewardState(updatedUser),
    };
  }

  async recordQualifyingDeposit(userId, amount, metadata = {}) {
    const user = await this.getUser(userId);
    const normalizedAmount = this.normalizeAmount(amount);
    const updatedUser = await this.saveRewardState(userId, user, {
      rewardState: {
        qualifyingDepositTotal: this.normalizeAmount((user.rewardState?.qualifyingDepositTotal || 0) + normalizedAmount),
      },
    });

    await this.logRewardEvent(
      userId,
      'QUALIFYING_DEPOSIT_RECORDED',
      normalizedAmount,
      'Qualifying deposit recorded for reward unlock',
      metadata
    );

    return this.unlockEligibleRewards(updatedUser._id || userId);
  }

  async recordQualifyingCashGame(userId, buyInAmount, metadata = {}) {
    const user = await this.getUser(userId);
    const updatedUser = await this.saveRewardState(userId, user, {
      rewardState: {
        qualifyingCashGamesPlayed: Number(user.rewardState?.qualifyingCashGamesPlayed || 0) + 1,
      },
    });

    await this.logRewardEvent(
      userId,
      'QUALIFYING_CASH_GAME_RECORDED',
      this.normalizeAmount(buyInAmount),
      'Qualifying cash-funded game recorded for reward unlock',
      metadata
    );

    return this.unlockEligibleRewards(updatedUser._id || userId);
  }

  async creditLockedReward(userId, amount, metadata = {}) {
    const user = await this.getUser(userId);
    const rewardState = this.buildRewardState(user);
    const availableCap = this.normalizeAmount(rewardState.maxRewardCap - rewardState.lockedRewardBalance);
    const normalizedAmount = Math.min(this.normalizeAmount(amount), availableCap);

    if (normalizedAmount <= 0) {
      return {
        creditedAmount: 0,
        rewardState,
      };
    }

    const updatedUser = await this.saveRewardState(userId, user, {
      lockedRewardBalance: rewardState.lockedRewardBalance + normalizedAmount,
      rewardState: {
        totalLockedRewardsEarned: this.normalizeAmount((user.rewardState?.totalLockedRewardsEarned || 0) + normalizedAmount),
      },
    });

    await this.logRewardEvent(
      userId,
      'LOCKED_REWARD_CREDIT',
      normalizedAmount,
      'Locked promotional reward credited',
      metadata
    );

    return {
      creditedAmount: normalizedAmount,
      rewardState: this.buildRewardState(updatedUser),
    };
  }

  async unlockEligibleRewards(userId) {
    const user = await this.getUser(userId);
    const rewardState = this.buildRewardState(user);
    const meetsDeposit = rewardState.qualifyingDepositTotal >= rewardState.unlockDepositThreshold;
    const meetsGames = rewardState.qualifyingCashGamesPlayed >= rewardState.unlockCashGamesRequired;
    const unlockAmount = rewardState.lockedRewardBalance;

    if (!meetsDeposit || !meetsGames || unlockAmount <= 0) {
      return {
        unlocked: false,
        rewardState,
      };
    }

    const updatedUser = await this.saveRewardState(userId, user, {
      cashBalance: this.normalizeAmount(user.cashBalance) + unlockAmount,
      lockedRewardBalance: 0,
      rewardUnlocked: true,
      rewardState: {
        totalUnlockedRewards: this.normalizeAmount((user.rewardState?.totalUnlockedRewards || 0) + unlockAmount),
        unlockedAt: new Date().toISOString(),
      },
    });

    await this.logRewardEvent(
      userId,
      'LOCKED_REWARD_UNLOCKED',
      unlockAmount,
      'Locked rewards unlocked into cash balance',
      {
        qualifyingDepositTotal: rewardState.qualifyingDepositTotal,
        qualifyingCashGamesPlayed: rewardState.qualifyingCashGamesPlayed,
      }
    );

    return {
      unlocked: true,
      unlockedAmount: unlockAmount,
      rewardState: this.buildRewardState(updatedUser),
    };
  }

  async getRewardStatus(userId) {
    const user = await this.getUser(userId);
    return this.buildRewardState(user);
  }
}

module.exports = new PromoRewardService();
