const cron = require('node-cron');
const {userService, tournamentService} = require('../services');
const {deleteInactiveTables} = require('../services/table.service');
const queueMatcher = require('../services/queueMatcher.service');
const mongoHelper = require('../models/customdb');

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
        const usersResult = await mongoHelper.find(mongoHelper.COLLECTIONS.USERS, {});
        const users = usersResult.data || [];
        
        for (const user of users) {
          if (!user.cooldown || !user.cooldown.recentGames || user.cooldown.recentGames.length === 0) {
            continue;
          }
          
          const now = Date.now();
          const validGames = user.cooldown.recentGames.filter(game => {
            return new Date(game.expiresAt) > now;
          });
          
          if (validGames.length !== user.cooldown.recentGames.length) {
            const newCounts = {};
            for (const game of validGames) {
              for (const oppId of game.opponents) {
                newCounts[oppId] = (newCounts[oppId] || 0) + 1;
              }
            }
            
            await mongoHelper.updateById(
              mongoHelper.COLLECTIONS.USERS,
              user._id,
              { 
                'cooldown.recentGames': validGames,
                'cooldown.opponentCounts': newCounts
              }
            );
            console.log(`[CRON] Cleaned cooldown for user ${user._id}`);
          }
        }
      } catch (error) {
        console.error('[CRON] Cooldown cleanup error:', error.message);
      }
    });
  }
};
