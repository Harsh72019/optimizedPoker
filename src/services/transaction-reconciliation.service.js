const { ethers } = require('ethers');
const config = require('../config/config');
const mongoHelper = require('../models/customdb');
const tableManager = require('../table/table-manager.service');
const gameStateManager = require('../state/game-state');
const walletIntegrationService = require('./wallet-integration.service');
const blockchainService = require('./blockchain.service');
const MasterTableAbi = require('../blockchain/masterpokertable.json').abi;

class TransactionReconciliationService {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.POLYGON_URL);
    this.masterTableContract = new ethers.Contract(
      config.MASTER_POKER_TABLE_CONTRACT,
      MasterTableAbi,
      this.provider
    );
    this.usdtInterface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 value)'
    ]);
    this.noHashFailureMs = 2 * 60 * 1000;
    this.hashPendingGraceMs = 10 * 60 * 1000;
    this.legacyPayoutLookupRetryMs = 6 * 60 * 60 * 1000;
    this.legacyPayoutLookupMaxBlocks = 120000;
    this.legacyPayoutLookupChunkSize = 2000;
  }

  getTransactionAgeMs(transaction) {
    const reference = new Date(
      transaction.updatedAt || transaction.updated_at || transaction.createdAt || Date.now()
    ).getTime();
    return Math.max(0, Date.now() - reference);
  }

  getTableId(transaction) {
    return transaction?.metadata?.tableId || transaction?.gameId || null;
  }

  getTransactionCreatedAt(transaction) {
    const rawDate = transaction.createdAt || transaction.created_at || transaction.updatedAt || transaction.updated_at;
    if (!rawDate) return null;
    const createdAt = new Date(rawDate);
    return Number.isNaN(createdAt.getTime()) ? null : createdAt;
  }

  isBlockchainHash(value) {
    return typeof value === 'string' && /^0x([A-Fa-f0-9]{64})$/.test(value);
  }

  async getPendingBuyInTransactions() {
    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, {
      type: 'BUY_IN_CHARGE',
      status: 'PENDING'
    });

    if (!result.success || !Array.isArray(result.data)) {
      return [];
    }

    return result.data;
  }

  async getPendingPayoutTransactions() {
    const payoutTypes = ['TABLE_CASHOUT', 'HOST_REWARD', 'AFFILIATE_COMMISSION', 'PRIZE_PAYOUT'];
    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.TRANSACTION_LEDGER, {
      status: 'PENDING',
      type: { $in: payoutTypes }
    });

    if (!result.success || !Array.isArray(result.data)) {
      return [];
    }

    return result.data;
  }

  getWithdrawalJobId(transaction) {
    return transaction?.metadata?.queueResult?.jobId
      || transaction?.metadata?.withdrawalJobId
      || (String(transaction?.blockchainTxHash || '').startsWith('withdrawal-') ? transaction.blockchainTxHash : null);
  }

  shouldAttemptLegacyPayoutLookup(transaction) {
    const lastAttemptAt = transaction?.metadata?.legacyPayoutLookupAttemptedAt;
    if (!lastAttemptAt) {
      return true;
    }

    const lastAttemptTime = new Date(lastAttemptAt).getTime();
    if (!Number.isFinite(lastAttemptTime)) {
      return true;
    }

    return Date.now() - lastAttemptTime >= this.legacyPayoutLookupRetryMs;
  }

  async getPayoutSourceTable(transaction) {
    const sourceTableId = transaction?.metadata?.sourceTableId || transaction?.metadata?.tableId || transaction?.gameId;
    if (!sourceTableId) {
      return null;
    }

    const tableResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, sourceTableId);
    return tableResult.success && tableResult.data ? tableResult.data : null;
  }

  async getPayoutSourceTableAddress(table) {
    if (!table) {
      return null;
    }

    if (table.blockchainAddress && ethers.isAddress(table.blockchainAddress)) {
      return table.blockchainAddress;
    }

    if (!table.tableBlockchainId) {
      return null;
    }

    const tableInfo = await this.masterTableContract.getTable(table.tableBlockchainId);
    const tableAddress = tableInfo.tableAddress || tableInfo[0];
    return tableAddress && ethers.isAddress(tableAddress) ? tableAddress : null;
  }

  async estimateLookupBlockRange(transaction) {
    const latestBlock = await this.provider.getBlock('latest');
    const createdAt = this.getTransactionCreatedAt(transaction);
    const lookupStart = createdAt
      ? Math.floor(createdAt.getTime() / 1000) - (6 * 60 * 60)
      : latestBlock.timestamp - (24 * 60 * 60);
    const secondsBack = Math.max(0, latestBlock.timestamp - lookupStart);
    const estimatedBlocksBack = Math.ceil(secondsBack / 2) + 5000;
    const cappedBlocksBack = Math.min(estimatedBlocksBack, this.legacyPayoutLookupMaxBlocks);

    return {
      fromBlock: Math.max(0, latestBlock.number - cappedBlocksBack),
      toBlock: latestBlock.number
    };
  }

  async findLegacyPayoutTransfer(transaction) {
    if (!transaction.walletAddress || !ethers.isAddress(transaction.walletAddress)) {
      return null;
    }

    const amount = Number(transaction.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    const table = await this.getPayoutSourceTable(transaction);
    const tableAddress = await this.getPayoutSourceTableAddress(table);
    if (!tableAddress) {
      return null;
    }

    const expectedAmount = ethers.parseUnits(amount.toFixed(2), 6);
    const { fromBlock, toBlock } = await this.estimateLookupBlockRange(transaction);
    const transferTopic = this.usdtInterface.getEvent('Transfer').topicHash;
    const fromTopic = ethers.zeroPadValue(tableAddress, 32);
    const toTopic = ethers.zeroPadValue(transaction.walletAddress, 32);

    for (let start = fromBlock; start <= toBlock; start += this.legacyPayoutLookupChunkSize) {
      const end = Math.min(toBlock, start + this.legacyPayoutLookupChunkSize - 1);
      const logs = await this.provider.getLogs({
        address: config.USDT_TOKEN,
        fromBlock: start,
        toBlock: end,
        topics: [transferTopic, fromTopic, toTopic]
      });

      for (const log of logs) {
        const parsed = this.usdtInterface.parseLog(log);
        if (parsed.args.value === expectedAmount) {
          const receipt = await this.provider.getTransactionReceipt(log.transactionHash).catch(() => null);
          if (!receipt || receipt.status === 1) {
            return {
              txHash: log.transactionHash,
              blockNumber: log.blockNumber,
              sourceTableId: table._id,
              tableBlockchainId: table.tableBlockchainId || null,
              tableAddress
            };
          }
        }
      }
    }

    return null;
  }

  async markLegacyPayoutLookupAttempt(transaction, resultMetadata = {}) {
    await walletIntegrationService.updateTransactionLedger(transaction._id, {
      walletAddress: transaction.walletAddress,
      metadata: {
        legacyPayoutLookupAttemptedAt: new Date().toISOString(),
        legacyPayoutLookupAttempts: Number(transaction?.metadata?.legacyPayoutLookupAttempts || 0) + 1,
        ...resultMetadata
      }
    });
  }

  async shouldAutoRefundCompletedBuyIn(transaction) {
    const tableId = this.getTableId(transaction);
    if (!tableId) {
      return { refund: false, reason: 'missing_table_id' };
    }

    const tableDoc = await mongoHelper.findById(mongoHelper.COLLECTIONS.TABLES, tableId);
    if (!tableDoc.success || !tableDoc.data) {
      return { refund: false, reason: 'missing_table_document' };
    }

    const tableState = await tableManager.getTable(tableId);
    const tableStatus = tableState?.status || null;
    const gameState = await gameStateManager.getGame(tableId);
    const userId = transaction.userId?.toString?.() || transaction.userId;

    const isSeated = (tableState?.players || []).some(player => player.userId === userId);
    const gameStarted = !!gameState || ['IN_PROGRESS', 'SHOWDOWN_DELAY'].includes(tableStatus);

    if (isSeated) {
      return { refund: false, reason: 'player_already_seated' };
    }

    if (gameStarted) {
      return { refund: false, reason: 'game_already_started' };
    }

    return { refund: true, reason: 'confirmed_but_game_not_played', tableId };
  }

  async markBuyInFailed(transaction, reason, extraMetadata = {}) {
    await walletIntegrationService.updateTransactionLedger(transaction._id, {
      walletAddress: transaction.walletAddress,
      status: 'FAILED',
      metadata: {
        transferState: 'FAILED',
        reconciliationReason: reason,
        reconciledAt: new Date().toISOString(),
        ...extraMetadata
      }
    });
  }

  async markBuyInCompleted(transaction, txHash, extraMetadata = {}) {
    await walletIntegrationService.updateTransactionLedger(transaction._id, {
      walletAddress: transaction.walletAddress,
      blockchainTxHash: txHash || transaction.blockchainTxHash || null,
      status: 'COMPLETED',
      metadata: {
        transferState: 'COMPLETED',
        reconciledAt: new Date().toISOString(),
        ...extraMetadata
      }
    });
  }

  async queueRefundForMissedBuyIn(transaction, tableId) {
    const amount = Math.abs(Number(transaction.amount || 0));
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, reason: 'invalid_amount' };
    }

    const refundResult = await walletIntegrationService.queuePlayerTableCashout(
      transaction.userId,
      amount,
      transaction.gameId,
      tableId,
      {
        idempotencyKey: `reconcile_buyin_refund:${transaction.transactionId || transaction._id}`,
        payoutContext: 'STUCK_BUYIN_REFUND',
        description: `Auto refund for delayed buy-in on game ${transaction.gameId}`
      }
    );

    await walletIntegrationService.updateTransactionLedger(transaction._id, {
      walletAddress: transaction.walletAddress,
      metadata: {
        reconciliationRefundQueuedAt: new Date().toISOString(),
        reconciliationRefundTransactionId: refundResult.transactionId || null,
        reconciliationReason: 'confirmed_but_game_not_played'
      }
    });

    return { success: true, refundResult };
  }

  async reconcilePendingBuyIn(transaction) {
    const ageMs = this.getTransactionAgeMs(transaction);
    const txHash = transaction.blockchainTxHash;

    if (!this.isBlockchainHash(txHash)) {
      if (ageMs < this.noHashFailureMs) {
        return { action: 'skipped_recent_pending_without_hash' };
      }

      await this.markBuyInFailed(transaction, 'pending_without_blockchain_hash_timeout');
      return { action: 'marked_failed_no_hash' };
    }

    let receipt = null;
    try {
      receipt = await this.provider.getTransactionReceipt(txHash);
    } catch (error) {
      if (ageMs < this.hashPendingGraceMs) {
        return { action: 'skipped_receipt_check_error', error: error.message };
      }

      await this.markBuyInFailed(transaction, 'receipt_lookup_failed_after_timeout', {
        receiptLookupError: error.message
      });
      return { action: 'marked_failed_receipt_lookup_error' };
    }

    if (!receipt) {
      if (ageMs < this.hashPendingGraceMs) {
        return { action: 'still_waiting_for_confirmation' };
      }

      const tx = await this.provider.getTransaction(txHash).catch(() => null);
      if (!tx) {
        await this.markBuyInFailed(transaction, 'transaction_missing_after_timeout');
        return { action: 'marked_failed_missing_tx' };
      }

      return { action: 'still_pending_onchain' };
    }

    if (receipt.status !== 1) {
      await this.markBuyInFailed(transaction, 'transaction_reverted_onchain', {
        blockNumber: receipt.blockNumber
      });
      return { action: 'marked_failed_reverted' };
    }

    await this.markBuyInCompleted(transaction, txHash, {
      blockNumber: receipt.blockNumber,
      confirmedAt: new Date().toISOString()
    });

    const refundDecision = await this.shouldAutoRefundCompletedBuyIn(transaction);
    if (refundDecision.refund) {
      const refundOutcome = await this.queueRefundForMissedBuyIn(transaction, refundDecision.tableId);
      return { action: 'confirmed_and_refund_queued', refundOutcome };
    }

    await walletIntegrationService.updateTransactionLedger(transaction._id, {
      walletAddress: transaction.walletAddress,
      metadata: {
        reconciliationReason: refundDecision.reason,
        reconciledAt: new Date().toISOString()
      }
    });

    return { action: 'confirmed_no_refund', reason: refundDecision.reason };
  }

  async reconcilePendingBuyIns() {
    const pendingTransactions = await this.getPendingBuyInTransactions();
    const summary = {
      scanned: pendingTransactions.length,
      confirmed: 0,
      failed: 0,
      refundQueued: 0,
      skipped: 0,
      errors: []
    };

    for (const transaction of pendingTransactions) {
      try {
        const result = await this.reconcilePendingBuyIn(transaction);

        if (result.action === 'confirmed_and_refund_queued') {
          summary.confirmed += 1;
          summary.refundQueued += 1;
          continue;
        }

        if (result.action?.startsWith('confirmed')) {
          summary.confirmed += 1;
          continue;
        }

        if (result.action?.startsWith('marked_failed')) {
          summary.failed += 1;
          continue;
        }

        summary.skipped += 1;
      } catch (error) {
        summary.errors.push({
          transactionId: transaction.transactionId || transaction._id,
          error: error.message
        });
      }
    }

    return summary;
  }

  async reconcilePendingPayout(transaction) {
    const amount = Number(transaction.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      await walletIntegrationService.updateTransactionLedger(transaction._id, {
        walletAddress: transaction.walletAddress,
        status: 'COMPLETED',
        metadata: {
          reconciliationReason: 'zero_amount_payout',
          reconciledAt: new Date().toISOString()
        }
      });
      return { action: 'marked_completed_zero_amount' };
    }

    const jobId = this.getWithdrawalJobId(transaction);
    if (!jobId) {
      return this.reconcileLegacyPendingPayout(transaction, 'missing_withdrawal_job_id');
    }

    const job = await blockchainService.withdrawalQueue.getJob(jobId);
    if (!job) {
      return this.reconcileLegacyPendingPayout(transaction, 'withdrawal_job_not_found', { jobId });
    }

    const state = await job.getState();
    if (state === 'completed') {
      const returnValue = job.returnvalue || {};
      await walletIntegrationService.updateTransactionLedger(transaction._id, {
        walletAddress: transaction.walletAddress,
        blockchainTxHash: returnValue.transactionHash || transaction.blockchainTxHash || null,
        status: 'COMPLETED',
        metadata: {
          withdrawalJobId: jobId,
          reconciliationReason: 'withdrawal_job_completed',
          reconciledAt: new Date().toISOString()
        }
      });
      return { action: 'marked_completed_from_withdrawal_job', jobId };
    }

    if (state === 'failed') {
      await walletIntegrationService.updateTransactionLedger(transaction._id, {
        walletAddress: transaction.walletAddress,
        status: 'FAILED',
        metadata: {
          withdrawalJobId: jobId,
          reconciliationReason: 'withdrawal_job_failed',
          withdrawalFailureReason: job.failedReason || null,
          reconciledAt: new Date().toISOString()
        }
      });
      return { action: 'marked_failed_from_withdrawal_job', jobId };
    }

    return { action: `skipped_withdrawal_job_${state}`, jobId };
  }

  async reconcileLegacyPendingPayout(transaction, reason, extraMetadata = {}) {
    if (!this.shouldAttemptLegacyPayoutLookup(transaction)) {
      return { action: 'skipped_recent_legacy_payout_lookup', reason, ...extraMetadata };
    }

    const legacyTransfer = await this.findLegacyPayoutTransfer(transaction);
    if (legacyTransfer) {
      await walletIntegrationService.updateTransactionLedger(transaction._id, {
        walletAddress: transaction.walletAddress,
        blockchainTxHash: legacyTransfer.txHash,
        status: 'COMPLETED',
        metadata: {
          ...extraMetadata,
          reconciliationReason: 'legacy_onchain_transfer_found',
          legacyLookupReason: reason,
          legacyTransfer,
          reconciledAt: new Date().toISOString()
        }
      });

      return {
        action: 'marked_completed_from_legacy_onchain_transfer',
        reason,
        txHash: legacyTransfer.txHash,
        ...extraMetadata
      };
    }

    await this.markLegacyPayoutLookupAttempt(transaction, {
      ...extraMetadata,
      legacyLookupReason: reason,
      legacyPayoutLookupResult: 'not_found'
    });

    return { action: 'skipped_legacy_onchain_transfer_not_found', reason, ...extraMetadata };
  }

  async reconcilePendingPayouts() {
    const pendingTransactions = await this.getPendingPayoutTransactions();
    const summary = {
      scanned: pendingTransactions.length,
      completed: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    for (const transaction of pendingTransactions) {
      try {
        const result = await this.reconcilePendingPayout(transaction);

        if (result.action?.startsWith('marked_completed')) {
          summary.completed += 1;
          continue;
        }

        if (result.action?.startsWith('marked_failed')) {
          summary.failed += 1;
          continue;
        }

        summary.skipped += 1;
      } catch (error) {
        summary.errors.push({
          transactionId: transaction.transactionId || transaction._id,
          error: error.message
        });
      }
    }

    return summary;
  }
}

module.exports = new TransactionReconciliationService();
