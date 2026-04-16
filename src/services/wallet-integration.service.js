const mongoHelper = require('../models/customdb');
const blockchainService = require('./blockchain.service');

class WalletIntegrationService {
  constructor() {
    this.stalePendingMs = 5 * 60 * 1000;
  }

  generateTransactionId(prefix, gameId, userId = 'system') {
    return `${prefix}_${gameId || 'na'}_${userId}_${Date.now()}`;
  }

  async resolveUser(userId, role = 'User') {
    const userResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.USERS, userId);

    if (!userResult.success || !userResult.data) {
      throw new Error(`${role} not found`);
    }

    const user = userResult.data;
    if (!user.walletAddress) {
      throw new Error(`${role} wallet address not found`);
    }

    return user;
  }

  async findExistingTransaction(type, userId, gameId, idempotencyKey) {
    if (!idempotencyKey) {
      return null;
    }

    const existingResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, {
      userId,
      type,
      gameId,
      'metadata.idempotencyKey': idempotencyKey,
      status: { $in: ['PENDING', 'COMPLETED'] }
    });

    if (!existingResult.success || !existingResult.data || existingResult.data.length === 0) {
      return null;
    }

    return existingResult.data[0];
  }

  async findAnyTransaction(type, userId, gameId, idempotencyKey) {
    if (!idempotencyKey) {
      return null;
    }

    const existingResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, {
      userId,
      type,
      gameId,
      'metadata.idempotencyKey': idempotencyKey
    });

    if (!existingResult.success || !existingResult.data || existingResult.data.length === 0) {
      return null;
    }

    return existingResult.data[0];
  }

  async findLatestTableBuyInTransaction(userId, gameId, tableId, paymentContext) {
    const existingResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, {
      userId,
      type: 'BUY_IN_CHARGE',
      gameId,
      'metadata.tableId': tableId,
      'metadata.paymentContext': paymentContext,
      status: { $in: ['PENDING', 'COMPLETED', 'FAILED'] }
    });

    if (!existingResult.success || !Array.isArray(existingResult.data) || existingResult.data.length === 0) {
      return null;
    }

    return existingResult.data.sort((a, b) => {
      const aTime = new Date(a.updatedAt || a.updated_at || a.createdAt || 0).getTime();
      const bTime = new Date(b.updatedAt || b.updated_at || b.createdAt || 0).getTime();
      return bTime - aTime;
    })[0];
  }

  isPendingTransactionStale(transaction) {
    if (!transaction || transaction.status !== 'PENDING') {
      return false;
    }

    const referenceTime = new Date(
      transaction.updatedAt || transaction.updated_at || transaction.createdAt || Date.now()
    ).getTime();

    if (!Number.isFinite(referenceTime)) {
      return false;
    }

    return (Date.now() - referenceTime) > this.stalePendingMs;
  }

  async updateTransactionLedger(entryId, updates = {}) {
    const currentEntry = await mongoHelper.findById(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, entryId);
    const currentMetadata = currentEntry.success && currentEntry.data ? (currentEntry.data.metadata || {}) : {};
    const nextMetadata = updates.metadata
      ? { ...currentMetadata, ...updates.metadata }
      : currentMetadata;

    const balanceAfter = updates.walletAddress
      ? await this.safeGetBalance(updates.walletAddress)
      : (updates.balanceAfter ?? currentEntry.data?.balanceAfter ?? 0);

    const updateResult = await mongoHelper.updateById(
      mongoHelper.COLLECTIONS.TRANSACTION_LEDGER,
      entryId,
      {
        ...updates,
        metadata: nextMetadata,
        balanceAfter
      }
    );

    if (!updateResult.success) {
      throw new Error(`Failed to update transaction ledger: ${updateResult.error}`);
    }

    return updateResult.data;
  }

  async safeGetBalance(walletAddress) {
    if (!walletAddress) {
      return 0;
    }

    try {
      return parseFloat(await this.getPoolBalance(walletAddress));
    } catch (error) {
      return 0;
    }
  }

  async createOrRecycleLedgerEntry({
    existingTransaction = null,
    userId,
    type,
    amount,
    gameId,
    description,
    walletAddress,
    metadata = {}
  }) {
    if (existingTransaction?.status === 'COMPLETED') {
      return { entry: existingTransaction, duplicate: true };
    }

    if (existingTransaction?.status === 'PENDING') {
      if (this.isPendingTransactionStale(existingTransaction)) {
        const recycled = await this.updateTransactionLedger(existingTransaction._id, {
          amount,
          description,
          walletAddress,
          blockchainTxHash: null,
          status: 'PENDING',
          metadata: {
            ...metadata,
            previousPendingTransactionId: existingTransaction.transactionId || existingTransaction._id,
            previousPendingMarkedStaleAt: new Date().toISOString(),
            retriedAt: new Date().toISOString()
          }
        });
        return { entry: recycled, duplicate: false };
      }

      throw new Error(`A ${type} transaction is already in progress for ${gameId}`);
    }

    if (existingTransaction?.status === 'FAILED') {
      const recycled = await this.updateTransactionLedger(existingTransaction._id, {
        amount,
        description,
        walletAddress,
        blockchainTxHash: null,
        status: 'PENDING',
        metadata: {
          ...metadata,
          retriedAt: new Date().toISOString()
        }
      });
      return { entry: recycled, duplicate: false };
    }

    const created = await this.logTransaction({
      userId,
      type,
      amount,
      gameId,
      description,
      walletAddress,
      status: 'PENDING',
      metadata
    });

    if (!created) {
      throw new Error(`Failed to create ${type} ledger entry`);
    }

    return { entry: created, duplicate: false };
  }

  async chargeSetupFee(hostId, amount, gameId) {
    const host = await this.resolveUser(hostId, 'Host');
    const idempotencyKey = `setup_fee:${gameId}:${hostId}`;
    const existingTransaction = await this.findAnyTransaction(
      'SETUP_FEE_CHARGE',
      hostId,
      gameId,
      idempotencyKey
    );

    if (existingTransaction?.status === 'COMPLETED') {
      return {
        success: true,
        chargedAmount: Math.abs(existingTransaction.amount),
        walletAddress: host.walletAddress,
        transactionId: existingTransaction.transactionId,
        blockchainTxHash: existingTransaction.blockchainTxHash || null,
        blockchainPending: false,
        duplicate: true
      };
    }

    const currentBalance = await this.getPoolBalance(host.walletAddress);

    if (parseFloat(currentBalance) < amount) {
      throw new Error(`Insufficient pool balance. Required: ${amount}, Available: ${currentBalance}`);
    }

    const { entry: ledger } = await this.createOrRecycleLedgerEntry({
      existingTransaction,
      userId: hostId,
      type: 'SETUP_FEE_CHARGE',
      amount: -amount,
      gameId,
      description: `Setup fee for game ${gameId}`,
      walletAddress: host.walletAddress,
      metadata: {
        idempotencyKey,
        paymentCategory: 'PRIVATE_TABLE_SETUP_FEE',
        transferState: 'PENDING_SUBMISSION'
      }
    });

    let transferResult;
    try {
      transferResult = await this.transferSetupFeeFromPool(host.walletAddress, amount);
      if (!transferResult.success) {
        throw new Error(transferResult.error);
      }

      await this.updateTransactionLedger(ledger._id, {
        walletAddress: host.walletAddress,
        blockchainTxHash: transferResult.txHash,
        status: 'COMPLETED',
        metadata: {
          transferState: 'COMPLETED',
          confirmedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      await this.updateTransactionLedger(ledger._id, {
        walletAddress: host.walletAddress,
        status: 'FAILED',
        metadata: {
          transferState: 'FAILED',
          error: error.message,
          failedAt: new Date().toISOString()
        }
      });
      throw new Error(`Setup fee transfer failed: ${error.message}`);
    }

    return {
      success: true,
      chargedAmount: amount,
      walletAddress: host.walletAddress,
      transactionId: ledger?.transactionId || this.generateTransactionId('setup', gameId, hostId),
      blockchainTxHash: transferResult.txHash,
      blockchainPending: false
    };
  }

  async refundSetupFee(hostId, amount, gameId, reason = 'Table creation failed') {
    const host = await this.resolveUser(hostId, 'Host');
    const refundResult = await this.processRefundToPool(host.walletAddress, amount, gameId);

    if (!refundResult.success) {
      throw new Error(`Setup fee refund failed: ${refundResult.error}`);
    }

    await this.logTransaction({
      userId: hostId,
      type: 'BUY_IN_REFUND',
      amount,
      gameId,
      description: `Setup fee refund for ${gameId}: ${reason}`,
      walletAddress: host.walletAddress,
      blockchainTxHash: refundResult.txHash,
      status: refundResult.pending ? 'PENDING' : 'COMPLETED',
      metadata: { refundType: 'SETUP_FEE' }
    });

    return refundResult;
  }

  async getPoolBalance(walletAddress) {
    try {
      const { ethers } = require('ethers');
      const config = require('../config/config');
      const walletFactoryAbi = require('../services/walletfactory.json').abi;

      const provider = new ethers.JsonRpcProvider(config.POLYGON_URL);
      const walletFactoryContract = new ethers.Contract(config.WALLET_FACTORY_ADDRESS, walletFactoryAbi, provider);
      const poolBalance = await walletFactoryContract.getPlayerBalance(walletAddress);
      return ethers.formatUnits(poolBalance, 6);
    } catch (error) {
      throw new Error(`Failed to get pool balance: ${error.message}`);
    }
  }

  async transferSetupFeeFromPool(userWalletAddress, amount) {
    try {
      const config = require('../config/config');
      const platformWalletAddress = config.MASTER_POKER_TABLE_CONTRACT;
      const transferResult = await blockchainService.transferFromPoolToTable(
        userWalletAddress,
        platformWalletAddress,
        amount
      );

      if (!transferResult.success) {
        return { success: false, error: transferResult.error };
      }

      return {
        success: true,
        txHash: transferResult.txHash,
        amount,
        pending: transferResult.pending || false
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getPayoutSourceTable(sourceTableId) {
    if (!sourceTableId) {
      return null;
    }

    const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, sourceTableId);
    if (!tableResult.success || !tableResult.data) {
      return null;
    }

    return tableResult.data;
  }

  async queueTablePayout(user, amount, sourceTableId) {
    const payoutTable = await this.getPayoutSourceTable(sourceTableId);

    if (!payoutTable || !payoutTable.tableBlockchainId) {
      return {
        success: false,
        error: 'Payout source table is missing blockchain information'
      };
    }

    const queueResult = await blockchainService.queueWithdrawal(
      user._id || user.id,
      sourceTableId,
      payoutTable.tableBlockchainId,
      amount,
      user.walletAddress,
      user.email || 'no-reply@system.local',
      user.username || user.name || 'Player'
    );

    return {
      success: true,
      txHash: queueResult.jobId || null,
      pending: true,
      queueResult,
      sourceTableId,
      tableBlockchainId: payoutTable.tableBlockchainId
    };
  }

  async queuePlayerTableCashout(userId, amount, gameId, sourceTableId, options = {}) {
    const user = await this.resolveUser(userId, 'Player');
    const idempotencyKey = options.idempotencyKey || `table_cashout:${sourceTableId}:${userId}`;
    const existingTransaction = await this.findAnyTransaction(
      'TABLE_CASHOUT',
      userId,
      gameId,
      idempotencyKey
    );

    if (existingTransaction?.status === 'COMPLETED') {
      return {
        success: true,
        paidAmount: existingTransaction.amount,
        walletAddress: user.walletAddress,
        transactionId: existingTransaction.transactionId,
        blockchainPending: false,
        duplicate: true,
        sourceTableId
      };
    }

    if (existingTransaction?.status === 'PENDING') {
      return {
        success: true,
        paidAmount: existingTransaction.amount,
        walletAddress: user.walletAddress,
        transactionId: existingTransaction.transactionId,
        blockchainPending: true,
        duplicate: true,
        sourceTableId
      };
    }

    const ledgerInput = {
      existingTransaction,
      userId,
      type: 'TABLE_CASHOUT',
      amount,
      gameId,
      description: options.description || `Table cashout for game ${gameId}`,
      walletAddress: user.walletAddress,
      metadata: {
        idempotencyKey,
        payoutContext: options.payoutContext || 'TABLE_CASHOUT',
        sourceTableId
      }
    };

    const { entry: ledger } = await this.createOrRecycleLedgerEntry(ledgerInput);

    try {
      const payoutTable = await this.getPayoutSourceTable(sourceTableId);

      if (!payoutTable || !payoutTable.tableBlockchainId) {
        throw new Error('Payout source table is missing blockchain information');
      }

      const queueResult = await blockchainService.queueWithdrawal(
        user._id || user.id,
        sourceTableId,
        payoutTable.tableBlockchainId,
        amount,
        user.walletAddress,
        user.email || 'no-reply@system.local',
        user.username || user.name || 'Player',
        {
          ledgerEntryId: ledger._id,
          payoutContext: options.payoutContext || 'TABLE_CASHOUT'
        }
      );

      await this.updateTransactionLedger(ledger._id, {
        walletAddress: user.walletAddress,
        blockchainTxHash: queueResult.jobId || null,
        status: 'PENDING',
        metadata: {
          sourceTableId,
          queueResult,
          payoutContext: options.payoutContext || 'TABLE_CASHOUT',
          queuedAt: new Date().toISOString()
        }
      });

      return {
        success: true,
        paidAmount: amount,
        walletAddress: user.walletAddress,
        transactionId: ledger.transactionId,
        blockchainPending: true,
        sourceTableId
      };
    } catch (error) {
      await this.updateTransactionLedger(ledger._id, {
        walletAddress: user.walletAddress,
        status: 'FAILED',
        metadata: {
          error: error.message,
          sourceTableId,
          payoutContext: options.payoutContext || 'TABLE_CASHOUT',
          failedAt: new Date().toISOString()
        }
      });
      throw error;
    }
  }

  async payHostReward(hostId, amount, gameId, options = {}) {
    const host = await this.resolveUser(hostId, 'Host');
    const idempotencyKey = options.idempotencyKey || `host_reward:${gameId}:${hostId}`;
    const existingTransaction = await this.findExistingTransaction(
      'HOST_REWARD',
      hostId,
      gameId,
      idempotencyKey
    );

    if (existingTransaction) {
      return {
        success: true,
        paidAmount: existingTransaction.amount,
        walletAddress: host.walletAddress,
        transactionId: existingTransaction.transactionId,
        blockchainPending: existingTransaction.status === 'PENDING',
        duplicate: true,
        sourceTableId: options.sourceTableId
      };
    }

    const payoutResult = await this.queueTablePayout(host, amount, options.sourceTableId);

    if (!payoutResult.success) {
      await this.logTransaction({
        userId: hostId,
        type: 'HOST_REWARD',
        amount,
        gameId,
        description: `Failed host reward for game ${gameId}`,
        walletAddress: host.walletAddress,
        status: 'FAILED',
        metadata: { error: payoutResult.error, sourceTableId: options.sourceTableId, idempotencyKey }
      });
      throw new Error(payoutResult.error);
    }

    const ledger = await this.logTransaction({
      userId: hostId,
      type: 'HOST_REWARD',
      amount,
      gameId,
      description: `Host reward for game ${gameId}`,
      walletAddress: host.walletAddress,
      blockchainTxHash: payoutResult.txHash,
      status: 'PENDING',
      metadata: { sourceTableId: options.sourceTableId, queueResult: payoutResult.queueResult, idempotencyKey }
    });

    return {
      success: true,
      paidAmount: amount,
      walletAddress: host.walletAddress,
      transactionId: ledger?.transactionId || this.generateTransactionId('host_reward', gameId, hostId),
      blockchainPending: true,
      sourceTableId: options.sourceTableId
    };
  }

  async payAffiliateCommission(affiliateId, amount, gameId, referredUserId, options = {}) {
    const affiliate = await this.resolveUser(affiliateId, 'Affiliate');
    const recruitEarningsService = require('./recruitEarnings.service');
    const idempotencyKey = options.idempotencyKey || `affiliate:${gameId}:${affiliateId}`;
    const existingTransaction = await this.findExistingTransaction(
      'AFFILIATE_COMMISSION',
      affiliateId,
      gameId,
      idempotencyKey
    );

    if (existingTransaction) {
      return {
        success: true,
        paidAmount: existingTransaction.amount,
        walletAddress: affiliate.walletAddress,
        transactionId: existingTransaction.transactionId,
        blockchainPending: existingTransaction.status === 'PENDING',
        duplicate: true,
        sourceTableId: options.sourceTableId
      };
    }

    const payoutResult = await this.queueTablePayout(affiliate, amount, options.sourceTableId);

    if (!payoutResult.success) {
      await this.logTransaction({
        userId: affiliateId,
        type: 'AFFILIATE_COMMISSION',
        amount,
        gameId,
        description: `Failed affiliate commission for game ${gameId}`,
        walletAddress: affiliate.walletAddress,
        status: 'FAILED',
        metadata: { referredUserId, error: payoutResult.error, sourceTableId: options.sourceTableId, idempotencyKey }
      });
      throw new Error(payoutResult.error);
    }

    const ledger = await this.logTransaction({
      userId: affiliateId,
      type: 'AFFILIATE_COMMISSION',
      amount,
      gameId,
      description: `Affiliate commission for game ${gameId}`,
      walletAddress: affiliate.walletAddress,
      blockchainTxHash: payoutResult.txHash,
      status: 'PENDING',
      metadata: { referredUserId, sourceTableId: options.sourceTableId, queueResult: payoutResult.queueResult, idempotencyKey }
    });

    if (referredUserId) {
      await recruitEarningsService.recordRecruitEarning(
        referredUserId,
        affiliateId,
        amount,
        'affiliate_commission'
      );
    }

    return {
      success: true,
      paidAmount: amount,
      walletAddress: affiliate.walletAddress,
      transactionId: ledger?.transactionId || this.generateTransactionId('affiliate', gameId, affiliateId),
      blockchainPending: true,
      sourceTableId: options.sourceTableId
    };
  }

  async recordPlatformRevenue(amount, gameId, options = {}) {
    const normalizedAmount = Math.floor((Number(amount) + Number.EPSILON) * 100) / 100;

    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return {
        success: true,
        recordedAmount: 0,
        skipped: true,
        reason: 'No positive platform revenue to record'
      };
    }

    const idempotencyKey = options.idempotencyKey || `platform_revenue:${gameId}:${options.revenueType || 'company_net'}`;
    const existingTransactionResult = await mongoHelper.find(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, {
      type: 'PLATFORM_REVENUE',
      gameId,
      'metadata.idempotencyKey': idempotencyKey,
      status: { $in: ['PENDING', 'COMPLETED'] }
    });

    const existingTransaction = existingTransactionResult.success && existingTransactionResult.data?.[0]
      ? existingTransactionResult.data[0]
      : null;

    if (existingTransaction) {
      return {
        success: true,
        recordedAmount: existingTransaction.amount,
        transactionId: existingTransaction.transactionId,
        walletAddress: existingTransaction.walletAddress || null,
        duplicate: true,
        sourceTableId: options.sourceTableId
      };
    }

    const config = require('../config/config');
    const ledger = await this.logTransaction({
      userId: null,
      type: 'PLATFORM_REVENUE',
      amount: normalizedAmount,
      gameId,
      description: options.description || `Platform revenue retained for game ${gameId}`,
      walletAddress: config.MASTER_POKER_TABLE_CONTRACT,
      status: 'COMPLETED',
      metadata: {
        idempotencyKey,
        revenueType: options.revenueType || 'company_net',
        sourceTableId: options.sourceTableId || null,
        gameType: options.gameType || null,
        companyNet: options.companyNet ?? normalizedAmount,
        platformRevenue: options.platformRevenue ?? normalizedAmount,
        note: 'Recorded as retained platform commission in the master platform contract'
      }
    });

    if (!ledger) {
      throw new Error(`Failed to record platform revenue for game ${gameId}`);
    }

    return {
      success: true,
      recordedAmount: normalizedAmount,
      transactionId: ledger.transactionId,
      walletAddress: ledger.walletAddress,
      sourceTableId: options.sourceTableId
    };
  }

  async distributePrizePool(winners, gameId, options = {}) {
    const results = [];

    for (const winner of winners) {
      const { userId, amount, position } = winner;
      try {
        const user = await this.resolveUser(userId, 'Winner');
        const idempotencyKey = `prize:${gameId}:${userId}:${position}`;
        const existingTransaction = await this.findExistingTransaction(
          'PRIZE_PAYOUT',
          userId,
          gameId,
          idempotencyKey
        );

        if (existingTransaction) {
          results.push({
            userId,
            position,
            amount: existingTransaction.amount,
            success: true,
            walletAddress: user.walletAddress,
            transactionId: existingTransaction.transactionId,
            blockchainPending: existingTransaction.status === 'PENDING',
            duplicate: true
          });
          continue;
        }

        const payoutResult = await this.queueTablePayout(user, amount, options.sourceTableId);

        if (!payoutResult.success) {
          await this.logTransaction({
            userId,
            type: 'PRIZE_PAYOUT',
            amount,
            gameId,
            description: `Failed prize payout for game ${gameId}`,
            walletAddress: user.walletAddress,
            status: 'FAILED',
            metadata: { position, sourceTableId: options.sourceTableId, error: payoutResult.error, idempotencyKey }
          });
          throw new Error(payoutResult.error);
        }

        const ledger = await this.logTransaction({
          userId,
          type: 'PRIZE_PAYOUT',
          amount,
          gameId,
          description: `Prize payout for position ${position} in game ${gameId}`,
          walletAddress: user.walletAddress,
          blockchainTxHash: payoutResult.txHash,
          status: 'PENDING',
          metadata: { position, sourceTableId: options.sourceTableId, queueResult: payoutResult.queueResult, idempotencyKey }
        });

        results.push({
          userId,
          position,
          amount,
          success: true,
          walletAddress: user.walletAddress,
          transactionId: ledger?.transactionId || this.generateTransactionId('prize', gameId, userId),
          blockchainPending: true
        });
      } catch (error) {
        results.push({ userId, position, amount, success: false, error: error.message });
      }
    }

    return results;
  }

  async refundBuyIns(playerIds, buyInAmount, gameId) {
    const results = [];

    for (const playerId of playerIds) {
      try {
        const user = await this.resolveUser(playerId, 'Player');
        const refundResult = await this.processRefundToPool(user.walletAddress, buyInAmount, gameId);

        await this.logTransaction({
          userId: playerId,
          type: 'BUY_IN_REFUND',
          amount: buyInAmount,
          gameId,
          description: `Buy-in refund for game ${gameId}`,
          walletAddress: user.walletAddress,
          blockchainTxHash: refundResult.success ? refundResult.txHash : null,
          status: refundResult.success ? (refundResult.pending ? 'PENDING' : 'COMPLETED') : 'FAILED',
          metadata: refundResult.success ? {} : { error: refundResult.error }
        });

        if (!refundResult.success) {
          results.push({ userId: playerId, refundAmount: buyInAmount, success: false, error: refundResult.error });
          continue;
        }

        results.push({
          userId: playerId,
          refundAmount: buyInAmount,
          success: true,
          walletAddress: user.walletAddress,
          transactionId: this.generateTransactionId('refund', gameId, playerId),
          blockchainTxHash: refundResult.txHash,
          blockchainPending: refundResult.pending || false
        });
      } catch (error) {
        results.push({ userId: playerId, refundAmount: buyInAmount, success: false, error: error.message });
      }
    }

    return results;
  }

  async processRefundToPool(playerWalletAddress, amount, gameId) {
    try {
      const config = require('../config/config');
      const platformWalletAddress = config.MASTER_POKER_TABLE_CONTRACT;
      const transferResult = await blockchainService.transferFromPoolToTable(
        platformWalletAddress,
        playerWalletAddress,
        amount
      );

      if (!transferResult.success) {
        return { success: false, error: transferResult.error };
      }

      return {
        success: true,
        txHash: transferResult.txHash,
        amount,
        pending: transferResult.pending || false,
        gameId
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async chargeBuyIn(playerId, amount, gameId) {
    const user = await this.resolveUser(playerId, 'Player');
    const currentBalance = await this.getPoolBalance(user.walletAddress);

    if (parseFloat(currentBalance) < amount) {
      throw new Error(`Insufficient balance. Required: ${amount}, Available: ${currentBalance}`);
    }

    const ledger = await this.logTransaction({
      userId: playerId,
      type: 'BUY_IN_CHARGE',
      amount: -amount,
      gameId,
      description: `Buy-in reserved for game ${gameId}`,
      walletAddress: user.walletAddress,
      status: 'PENDING',
      metadata: {
        transferHandledByGameFlow: true,
        note: 'Blockchain table transfer is handled by the table join/orchestrator flow.'
      }
    });

    return {
      success: true,
      chargedAmount: amount,
      walletAddress: user.walletAddress,
      transactionId: ledger?.transactionId || this.generateTransactionId('buyin', gameId, playerId),
      blockchainPending: true
    };
  }

  async chargeBuyInToTable(playerId, amount, gameId, table, options = {}) {
    const user = await this.resolveUser(playerId, 'Player');
    const currentBalance = await this.getPoolBalance(user.walletAddress);
    if (parseFloat(currentBalance) < amount) {
      throw new Error(`Insufficient balance. Required: ${amount}, Available: ${currentBalance}`);
    }

    const tableId = table?._id?.toString?.() || table?.toString?.() || gameId;
    const paymentContext = options.paymentContext || 'TABLE_JOIN';
    const idempotencyKey = options.idempotencyKey || `buy_in:${gameId}:${tableId}:${playerId}:${paymentContext}`;
    let existingTransaction = await this.findAnyTransaction(
      'BUY_IN_CHARGE',
      playerId,
      gameId,
      idempotencyKey
    );

    if (!existingTransaction) {
      existingTransaction = await this.findLatestTableBuyInTransaction(
        playerId,
        gameId,
        tableId,
        paymentContext
      );
    }

    if (existingTransaction?.status === 'COMPLETED') {
      return {
        success: true,
        chargedAmount: Math.abs(existingTransaction.amount),
        walletAddress: user.walletAddress,
        transactionId: existingTransaction.transactionId,
        blockchainTxHash: existingTransaction.blockchainTxHash || null,
        blockchainPending: false,
        duplicate: true,
        table
      };
    }

    if (existingTransaction?.status === 'PENDING') {
      return {
        success: true,
        chargedAmount: Math.abs(existingTransaction.amount),
        walletAddress: user.walletAddress,
        transactionId: existingTransaction.transactionId,
        blockchainTxHash: existingTransaction.blockchainTxHash || null,
        blockchainPending: true,
        duplicate: true,
        table
      };
    }

    const { entry: ledger } = await this.createOrRecycleLedgerEntry({
      existingTransaction,
      userId: playerId,
      type: 'BUY_IN_CHARGE',
      amount: -amount,
      gameId,
      description: `Buy-in charged for ${paymentContext} on game ${gameId}`,
      walletAddress: user.walletAddress,
      metadata: {
        idempotencyKey,
        paymentContext,
        tableId,
        transferState: 'PENDING_SUBMISSION'
      }
    });

    let transferResult;
    try {
      transferResult = await blockchainService.prepareTableForJoin(
        table,
        amount,
        user.walletAddress,
        {
          transfer: true
        }
      );

      await this.updateTransactionLedger(ledger._id, {
        walletAddress: user.walletAddress,
        blockchainTxHash: transferResult.txHash || null,
        status: 'COMPLETED',
        metadata: {
          tableId: transferResult.table?._id || tableId,
          blockchainTableId: transferResult.table?.tableBlockchainId || table?.tableBlockchainId || null,
          blockchainAddress: transferResult.table?.blockchainAddress || table?.blockchainAddress || null,
          transferState: 'COMPLETED',
          confirmedAt: new Date().toISOString()
        }
      });

      return {
        success: true,
        chargedAmount: amount,
        walletAddress: user.walletAddress,
        transactionId: ledger.transactionId,
        blockchainTxHash: transferResult.txHash || null,
        blockchainPending: false,
        table: transferResult.table || table
      };
    } catch (error) {
      await this.updateTransactionLedger(ledger._id, {
        walletAddress: user.walletAddress,
        status: 'FAILED',
        metadata: {
          transferState: 'FAILED',
          error: error.message,
          failedAt: new Date().toISOString()
        }
      });
      throw error;
    }
  }

  async getUserBalance(userId) {
    const user = await this.resolveUser(userId, 'User');
    const poolBalance = await this.getPoolBalance(user.walletAddress);

    return {
      userId,
      walletAddress: user.walletAddress,
      poolBalance: parseFloat(poolBalance),
      lastUpdated: new Date()
    };
  }

  async addFunds(userId, amount, description = 'Admin credit') {
    const user = await this.resolveUser(userId, 'User');
    const ledger = await this.logTransaction({
      userId,
      type: 'ADMIN_CREDIT',
      amount,
      description,
      walletAddress: user.walletAddress,
      status: 'PENDING',
      metadata: { manualFundingRequired: true }
    });

    return {
      success: true,
      addedAmount: amount,
      walletAddress: user.walletAddress,
      transactionId: ledger?.transactionId || this.generateTransactionId('admin_credit', 'manual', userId),
      blockchainPending: true
    };
  }

  async logTransaction(transactionData) {
    const {
      userId,
      type,
      amount,
      gameId,
      description,
      walletAddress,
      blockchainTxHash = null,
      metadata = {},
      status = blockchainTxHash ? 'COMPLETED' : 'PENDING'
    } = transactionData;

    let balanceAfter = 0;
    if (walletAddress) {
      try {
        balanceAfter = parseFloat(await this.getPoolBalance(walletAddress));
      } catch (error) {
        balanceAfter = 0;
      }
    }

    const transactionLogData = {
      userId,
      type,
      amount,
      gameId,
      description,
      balanceAfter,
      walletAddress,
      blockchainTxHash,
      transactionId: this.generateTransactionId('txn', gameId, userId),
      metadata,
      status
    };

    const logResult = await mongoHelper.create(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, transactionLogData);
    return logResult.success ? logResult.data : null;
  }

  async validateSufficientBalance(userId, requiredAmount) {
    const user = await this.resolveUser(userId, 'User');
    const currentBalance = await this.getPoolBalance(user.walletAddress);
    const balance = parseFloat(currentBalance);

    return {
      sufficient: balance >= requiredAmount,
      currentBalance: balance,
      requiredAmount,
      shortfall: Math.max(0, requiredAmount - balance),
      walletAddress: user.walletAddress
    };
  }

  async batchProcessTransactions(transactions) {
    const results = [];

    for (const transaction of transactions) {
      try {
        let result;
        switch (transaction.type) {
          case 'CHARGE_SETUP_FEE':
            result = await this.chargeSetupFee(transaction.userId, transaction.amount, transaction.gameId);
            break;
          case 'PAY_HOST_REWARD':
            result = await this.payHostReward(transaction.userId, transaction.amount, transaction.gameId, transaction.options || {});
            break;
          case 'PAY_AFFILIATE':
            result = await this.payAffiliateCommission(
              transaction.userId,
              transaction.amount,
              transaction.gameId,
              transaction.referredUserId,
              transaction.options || {}
            );
            break;
          case 'CHARGE_BUY_IN':
            result = await this.chargeBuyIn(transaction.userId, transaction.amount, transaction.gameId);
            break;
          default:
            throw new Error(`Unknown transaction type: ${transaction.type}`);
        }

        results.push({ ...transaction, result, success: true });
      } catch (error) {
        results.push({ ...transaction, error: error.message, success: false });
      }
    }

    return results;
  }
}

module.exports = new WalletIntegrationService();
