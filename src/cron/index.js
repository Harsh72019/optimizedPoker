const cron = require('node-cron');
const {tournamentGameService} = require('../services');
const queueMatcher = require('../services/queueMatcher.service');
const mongoHelper = require('../models/customdb');
const transactionReconciliationService = require('../services/transaction-reconciliation.service');

let io = null;

module.exports = {
  initCron: (socketIo) => {
    io = socketIo;

    cron.schedule('* * * * *', async () => {
      await tournamentGameService.commencePendingTournaments(io);
    });

    cron.schedule('*/5 * * * * *', async () => {
      try {
        const subTiersResult = await mongoHelper.getAll(mongoHelper.COLLECTIONS.SUB_TIERS);
        const subTiers = subTiersResult?.data || [];
        for (const subTier of subTiers) {
          if (subTier.playersInQueue && subTier.playersInQueue.length > 0) {
            await queueMatcher.processQueuedPlayers(subTier._id, io);
          }
        }
      } catch (error) {
        console.error('[CRON] Queue processor error:', error);
      }
    });

    cron.schedule('0 * * * *', async () => {
      try {
      } catch (error) {
        console.error('[CRON] Cooldown cleanup error:', error.message);
      }
    });

    cron.schedule('*/30 * * * * *', async () => {
      try {
        const summary = await transactionReconciliationService.reconcilePendingBuyIns();
        if (summary.scanned > 0 || summary.errors.length > 0) {
        }

        const payoutSummary = await transactionReconciliationService.reconcilePendingPayouts();
        if (payoutSummary.scanned > 0 || payoutSummary.errors.length > 0) {
        }
      } catch (error) {
        console.error('[CRON] Transaction reconciliation error:', error.message);
      }
    });
  }
};
