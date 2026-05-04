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

  async findCompletedBotFunding(tableId, botId) {
    const result = await mongoHelper.find(mongoHelper.COLLECTIONS.FUNDING_RECORDS, {
      tableId,
      botId,
      status: 'COMPLETED'
    });

    return result.success && Array.isArray(result.data) && result.data.length > 0
      ? result.data[0]
      : null;
  }

  async recordBotTableFunding({
    tierId = null,
    botId,
    tableId,
    amount,
    txHash,
    houseWalletAddress,
    tableBlockchainId,
    tableAddress,
    status = 'COMPLETED',
    metadata = {}
  }) {
    const existing = await this.findCompletedBotFunding(tableId, botId);
    if (existing) {
      return { record: existing, duplicate: true };
    }

    const reserveAfter = tierId
      ? await this.calculateReserveAfter(tierId, amount)
      : null;

    const createResult = await mongoHelper.create(mongoHelper.COLLECTIONS.FUNDING_RECORDS, {
      tierId,
      botId,
      tableId,
      amount,
      txHash,
      houseWalletAddress,
      tableBlockchainId,
      tableAddress,
      status,
      metadata,
      timestamp: new Date(),
      reserveAfter,
      windowStart: new Date()
    });

    if (!createResult.success) {
      throw new Error(createResult.error || 'Failed to record bot table funding');
    }

    return { record: createResult.data, duplicate: false };
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
