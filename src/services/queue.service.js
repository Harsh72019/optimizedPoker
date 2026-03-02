const mongoHelper = require('../models/customdb');

class QueueService {
  async addToQueue(playerId, subTierId) {
    const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
    const subTier = subTierResult.data;
    
    if (!subTier.playersInQueue) {
      subTier.playersInQueue = [];
    }
    
    subTier.playersInQueue.push({
      playerId: playerId,
      enqueuedAt: new Date()
    });
    
    await mongoHelper.updateById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId, {
      playersInQueue: subTier.playersInQueue
    });
    
    console.log(`📥 Added user ${playerId} to queue for subTier ${subTierId}`);
  }

  async getSubTierQ(subTierId) {
    const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
    return subTierResult.data?.playersInQueue || [];
  }

  async removeFromQueue(playerId, subTierId) {
    const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
    const subTier = subTierResult.data;
    
    if (subTier && subTier.playersInQueue) {
      subTier.playersInQueue = subTier.playersInQueue.filter(
        entry => entry.playerId.toString() !== playerId.toString()
      );
      
      await mongoHelper.updateById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId, {
        playersInQueue: subTier.playersInQueue
      });
    }
  }

  async getQueuePosition(playerId, subTierId) {
    const subTierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.SUB_TIERS, subTierId);
    const subTier = subTierResult.data;
    
    if (!subTier || !subTier.playersInQueue) return -1;
    
    const playerIndex = subTier.playersInQueue.findIndex(
      entry => entry.playerId.toString() === playerId.toString()
    );
    return playerIndex >= 0 ? playerIndex + 1 : -1;
  }
}

module.exports = new QueueService();
