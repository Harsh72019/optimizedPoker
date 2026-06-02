const mongoHelper = require('../models/customdb');
const accountWalletService = require('./account-wallet.service');
const promoRewardService = require('./promo-reward.service');

const DEFAULT_WEB2_SIGNUP_BONUS = 5;
const DEFAULT_WEB2_AD_REWARD = 1;

class CustodialWalletService {
  normalizeAmount(value) {
    const amount = Number(value || 0);
    if (!Number.isFinite(amount)) {
      return 0;
    }

    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }

  async getUser(userId) {
    const result = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);
    if (!result.success || !result.data) {
      throw new Error('User not found');
    }

    return result.data;
  }

  async updateUser(userId, updates = {}) {
    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.USERS,
      userId,
      updates,
      mongoHelper.MODELS.USER
    );

    if (!updateResult.success) {
      throw new Error(updateResult.error || 'Failed to update user');
    }

    return updateResult.data;
  }

  async logLedgerEntry(userId, type, amount, description, metadata = {}, status = 'COMPLETED') {
    const transactionId = `${type.toLowerCase()}_${userId}_${Date.now()}`;
    const ledgerResult = await mongoHelper.create(
      mongoHelper.COLLECTIONS.TRANSACTION_LEDGER,
      {
        userId,
        type,
        amount: this.normalizeAmount(amount),
        description,
        balanceAfter: 0,
        walletAddress: accountWalletService.normalizeWalletAddress(metadata.walletAddress) || null,
        blockchainTxHash: null,
        transactionId,
        metadata,
        status,
      },
      mongoHelper.MODELS.TRANSACTION_LEDGER
    );

    if (!ledgerResult.success) {
      throw new Error(ledgerResult.error || 'Failed to write custodial ledger entry');
    }

    return ledgerResult.data;
  }

  async grantSignupBonus(userId, amount = DEFAULT_WEB2_SIGNUP_BONUS) {
    const user = await this.getUser(userId);
    const normalizedAmount = this.normalizeAmount(amount);
    if (normalizedAmount <= 0) {
      return user;
    }

    const updatedUser = await this.updateUser(userId, {
      cashBalance: this.normalizeAmount(user.cashBalance) + normalizedAmount,
    });

    await this.logLedgerEntry(
      userId,
      'WEB2_SIGNUP_BONUS',
      normalizedAmount,
      'Welcome custodial balance credited',
      { source: 'WEB2_SIGNUP' }
    );

    return updatedUser;
  }

  async grantWeb2AdReward(userId, adViewId, amount = DEFAULT_WEB2_AD_REWARD) {
    const normalizedAdViewId = String(adViewId || '').trim();
    if (!normalizedAdViewId) {
      throw new Error('adViewId is required');
    }

    const user = await this.getUser(userId);
    if (user.authType !== 'web2') {
      throw new Error('This reward is available only for web2 users');
    }

    const existingRewardResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, {
      userId,
      type: 'WEB2_AD_REWARD',
      'metadata.adViewId': normalizedAdViewId,
    });

    if (existingRewardResult.success && existingRewardResult.data?.length) {
      return {
        duplicate: true,
        creditedAmount: 0,
        balance: await this.getCustodialSummary(userId),
      };
    }

    const normalizedAmount = this.normalizeAmount(amount);
    if (normalizedAmount <= 0) {
      throw new Error('Reward amount must be greater than zero');
    }

    await this.updateUser(userId, {
      cashBalance: this.normalizeAmount(user.cashBalance) + normalizedAmount,
    });

    await this.logLedgerEntry(
      userId,
      'WEB2_AD_REWARD',
      normalizedAmount,
      'Web2 ad reward credited to custodial balance',
      {
        adViewId: normalizedAdViewId,
        source: 'WEB2_AD_REWARD',
      }
    );

    return {
      duplicate: false,
      creditedAmount: normalizedAmount,
      balance: await this.getCustodialSummary(userId),
    };
  }

  getFundingSource(user = {}, requestedFundingSource = null) {
    const normalizedRequested = String(requestedFundingSource || '').trim().toUpperCase();
    const hasLinkedWallet = !!accountWalletService.getActiveWalletAddress(user);

    if (normalizedRequested === 'CUSTODIAL') {
      return 'CUSTODIAL';
    }

    if (normalizedRequested === 'WEB3') {
      if (!hasLinkedWallet) {
        throw new Error('Link a wallet before using wallet-funded play');
      }
      return 'WEB3';
    }

    if (user.authType === 'web2' || !hasLinkedWallet) {
      return 'CUSTODIAL';
    }

    return 'WEB3';
  }

  assertGameModeAllowed(user = {}, requestedFundingSource = null, gameMode = 'CASH') {
    const effectiveFundingSource = this.getFundingSource(user, requestedFundingSource);
    const normalizedGameMode = String(gameMode || 'CASH').trim().toUpperCase();

    if (effectiveFundingSource === 'CUSTODIAL' && normalizedGameMode !== 'CASH') {
      throw new Error('Custodial balance can only be used for normal cash games. Link a wallet to play tournaments or private tables.');
    }

    return effectiveFundingSource;
  }

  async getCustodialSummary(userId) {
    const user = await this.getUser(userId);
    return {
      cashBalance: this.normalizeAmount(user.cashBalance),
      promoBalance: this.normalizeAmount(user.promoBalance),
      lockedRewardBalance: this.normalizeAmount(user.lockedRewardBalance),
      rewardUnlocked: !!user.rewardUnlocked,
      currentGameFundingSource: user.currentGameFundingSource || null,
      currentGameTableId: user.currentGameTableId || null,
      activePayoutWallet: accountWalletService.getActiveWalletAddress(user),
      rewards: promoRewardService.buildRewardState(user),
    };
  }

  async recordDeposit(userId, amount, metadata = {}) {
    const user = await this.getUser(userId);
    const normalizedAmount = this.normalizeAmount(amount);
    if (normalizedAmount <= 0) {
      throw new Error('Deposit amount must be greater than zero');
    }

    const updatedUser = await this.updateUser(userId, {
      cashBalance: this.normalizeAmount(user.cashBalance) + normalizedAmount,
    });

    await this.logLedgerEntry(
      userId,
      'CUSTODIAL_DEPOSIT',
      normalizedAmount,
      'Custodial balance deposit recorded',
      metadata
    );

    const rewardResult = await promoRewardService.recordQualifyingDeposit(userId, normalizedAmount, {
      ...metadata,
      fundingSource: 'CUSTODIAL',
    });

    return {
      balance: await this.getCustodialSummary(userId),
      unlock: rewardResult,
      updatedUser,
    };
  }

  async chargeBuyIn(userId, amount, gameId, metadata = {}) {
    const user = await this.getUser(userId);
    const normalizedAmount = this.normalizeAmount(amount);
    const availableBalance = this.normalizeAmount(user.cashBalance);
    const shouldRecordQualifyingGame = metadata.recordQualifyingCashGame !== false;

    if (normalizedAmount <= 0) {
      throw new Error('Buy-in amount must be greater than zero');
    }

    if (availableBalance < normalizedAmount) {
      throw new Error(`Insufficient custodial balance. Required: ${normalizedAmount}, Available: ${availableBalance}`);
    }

    const updatedUser = await this.updateUser(userId, {
      cashBalance: this.normalizeAmount(availableBalance - normalizedAmount),
      currentGameFundingSource: 'CUSTODIAL',
      currentGameTableId: metadata.tableId || gameId || null,
    });

    await this.logLedgerEntry(
      userId,
      'CUSTODIAL_BUY_IN',
      -normalizedAmount,
      `Custodial buy-in for ${gameId || metadata.tableId || 'game'}`,
      {
        ...metadata,
        gameId,
        fundingSource: 'CUSTODIAL',
      }
    );

    if (shouldRecordQualifyingGame) {
      await promoRewardService.recordQualifyingCashGame(userId, normalizedAmount, {
        ...metadata,
        gameId,
        fundingSource: 'CUSTODIAL',
      });
    }

    return {
      success: true,
      chargedAmount: normalizedAmount,
      fundingSource: 'CUSTODIAL',
      blockchainPending: false,
      availableBalance: this.normalizeAmount(updatedUser.cashBalance),
    };
  }

  async reverseBuyInCharge(userId, amount, gameId, metadata = {}) {
    const user = await this.getUser(userId);
    const normalizedAmount = this.normalizeAmount(amount);

    if (normalizedAmount <= 0) {
      throw new Error('Reversal amount must be greater than zero');
    }

    const updatedUser = await this.updateUser(userId, {
      cashBalance: this.normalizeAmount(user.cashBalance) + normalizedAmount,
      currentGameFundingSource: null,
      currentGameTableId: null,
    });

    await this.logLedgerEntry(
      userId,
      'CUSTODIAL_BUY_IN_REVERSAL',
      normalizedAmount,
      `Custodial buy-in reversal for ${gameId || metadata.tableId || 'game'}`,
      {
        ...metadata,
        gameId,
        fundingSource: 'CUSTODIAL',
      }
    );

    return {
      success: true,
      refundedAmount: normalizedAmount,
      fundingSource: 'CUSTODIAL',
      availableBalance: this.normalizeAmount(updatedUser.cashBalance),
    };
  }

  async settleTableCashout(userId, amount, tableId, metadata = {}) {
    const user = await this.getUser(userId);
    const normalizedAmount = this.normalizeAmount(amount);
    if (normalizedAmount <= 0) {
      return {
        success: true,
        paidAmount: 0,
        fundingSource: 'CUSTODIAL',
      };
    }

    const updatedUser = await this.updateUser(userId, {
      cashBalance: this.normalizeAmount(user.cashBalance) + normalizedAmount,
      currentGameFundingSource: null,
      currentGameTableId: null,
    });

    await this.logLedgerEntry(
      userId,
      'CUSTODIAL_TABLE_CASHOUT',
      normalizedAmount,
      `Custodial table cashout from ${tableId}`,
      {
        ...metadata,
        tableId,
        fundingSource: 'CUSTODIAL',
      }
    );

    return {
      success: true,
      paidAmount: normalizedAmount,
      fundingSource: 'CUSTODIAL',
      availableBalance: this.normalizeAmount(updatedUser.cashBalance),
    };
  }

  async markFundingSession(userId, fundingSource, tableId = null) {
    return this.updateUser(userId, {
      currentGameFundingSource: fundingSource || null,
      currentGameTableId: tableId || null,
    });
  }

  async requestWithdrawal(userId, amount, walletAddress = null, metadata = {}) {
    const user = await this.getUser(userId);
    const normalizedAmount = this.normalizeAmount(amount);
    const availableBalance = this.normalizeAmount(user.cashBalance);
    const payoutWallet = accountWalletService.normalizeWalletAddress(
      walletAddress || accountWalletService.getActiveWalletAddress(user)
    );

    if (normalizedAmount <= 0) {
      throw new Error('Withdrawal amount must be greater than zero');
    }

    if (availableBalance < normalizedAmount) {
      throw new Error(`Insufficient custodial balance. Required: ${normalizedAmount}, Available: ${availableBalance}`);
    }

    if (!user.rewardUnlocked) {
      throw new Error('Withdrawals unlock only after a qualifying deposit and one qualifying cash game');
    }

    if (!payoutWallet) {
      throw new Error('Link a payout wallet before requesting withdrawal');
    }

    const updatedUser = await this.updateUser(userId, {
      cashBalance: this.normalizeAmount(availableBalance - normalizedAmount),
    });

    const ledger = await this.logLedgerEntry(
      userId,
      'CUSTODIAL_WITHDRAWAL_REQUEST',
      -normalizedAmount,
      'Custodial withdrawal requested',
      {
        ...metadata,
        payoutWallet,
        fundingSource: 'CUSTODIAL',
        manualReviewRequired: true,
      },
      'PENDING'
    );

    return {
      success: true,
      amount: normalizedAmount,
      payoutWallet,
      transactionId: ledger.transactionId,
      status: 'PENDING',
      availableBalance: this.normalizeAmount(updatedUser.cashBalance),
    };
  }
}

module.exports = new CustodialWalletService();
