const mongoHelper = require('./src/models/customdb');

async function clearAllQueues() {
  try {
    const subTiersResult = await mongoHelper.getAll(mongoHelper.COLLECTIONS.SUB_TIERS);
    const subTiers = subTiersResult.data || [];
    
    for (const subTier of subTiers) {
      if (subTier.playersInQueue && subTier.playersInQueue.length > 0) {
        await mongoHelper.updateById(
          mongoHelper.COLLECTIONS.SUB_TIERS,
          subTier._id,
          { playersInQueue: [] }
        );
        console.log(`✅ Cleared ${subTier.playersInQueue.length} players from ${subTier.name}`);
      }
    }
    
    console.log('✅ All queues cleared');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

clearAllQueues();
