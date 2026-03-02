const mongoHelper = require('../models/customdb');

class FundingService {
  async bankReserveAllows(tierId, amount) {
    const tierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, tierId);
    const tier = tierResult.data;
    
    if (!tier) return false;

    // Check if tier has enough reserve
    const reserve = tier.bankAllocatedReserve || 0;
    const recentBurn = await this.getRecentBurnRate(tierId);
    const availableReserve = reserve - recentBurn;
    
    return availableReserve >= amount;
  }

  async recordFunding(tierId, botId, tableId, amount) {
    const reserveAfter = await this.calculateReserveAfter(tierId, amount);
    
    await mongoHelper.create(mongoHelper.COLLECTIONS.FUNDING_RECORDS, {
      tierId,
      botId,
      tableId,
      amount,
      timestamp: new Date(),
      reserveAfter,
      windowStart: new Date()
    });
  }

  async getRecentBurnRate(tierId) {
    const tierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, tierId);
    const tier = tierResult.data;
    
    if (!tier) return 0;
    
    // Default to 1 hour window if not specified
    const windowSeconds = tier.burnWindowSeconds || 3600;
    const windowStart = new Date(Date.now() - (windowSeconds * 1000));
    
    const recordsResult = await mongoHelper.find(mongoHelper.COLLECTIONS.FUNDING_RECORDS, {
      tierId: tierId,
      timestamp: { $gte: windowStart }
    });
    const records = recordsResult.data || [];
    
    return records.reduce((sum, record) => sum + record.amount, 0);
  }

  async calculateReserveAfter(tierId, amount) {
    const tierResult = await mongoHelper.findById(mongoHelper.COLLECTIONS.TIERS, tierId);
    const tier = tierResult.data;
    
    const recentBurn = await this.getRecentBurnRate(tierId);
    return tier.bankAllocatedReserve - recentBurn - amount;
  }
}

module.exports = new FundingService();
