const cron = require('node-cron');
const {userService, tournamentService} = require('../services');
const {deleteInactiveTables} = require('../services/table.service');
const queueMatcher = require('../services/queueMatcher.service');
const mongoHelper = require('../models/customdb');
const transactionReconciliationService = require('../services/transaction-reconciliation.service');

let io = null;

module.exports = {
  initCron: (socketIo) => {
    io = socketIo;

    cron.schedule('* * * * *', async () => {
      await deleteInactiveTables();
      await tournamentService.commencePendingTournaments();
    });

    cron.schedule('*/5 * * * * *', async () => {
      try {
        console.log('[CRON] Processing queued players...');
        const subTiersResult = await mongoHelper.getAll(mongoHelper.COLLECTIONS.SUB_TIERS);
        const subTiers = subTiersResult?.data || [];
        for (const subTier of subTiers) {
          if (subTier.playersInQueue && subTier.playersInQueue.length > 0) {
            console.log(`[CRON] Processing ${subTier.playersInQueue.length} queued players in ${subTier.name}`);
            await queueMatcher.processQueuedPlayers(subTier._id, io);
          }
        }
      } catch (error) {
        console.error('[CRON] Queue processor error:', error);
      }
    });

    cron.schedule('0 * * * *', async () => {
      try {
        console.log('[CRON] Cooldown cleanup skipped: cooldown is enforced by games played, not wall-clock time.');
      } catch (error) {
        console.error('[CRON] Cooldown cleanup error:', error.message);
      }
    });

    cron.schedule('*/30 * * * * *', async () => {
      try {
        const summary = await transactionReconciliationService.reconcilePendingBuyIns();
        if (summary.scanned > 0 || summary.errors.length > 0) {
          console.log('[CRON] Buy-in reconciliation summary:', summary);
        }
      } catch (error) {
        console.error('[CRON] Buy-in reconciliation error:', error.message);
      }
    });
  }
};
