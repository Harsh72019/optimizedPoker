// src/state/player-state.manager.js

const redisClient = require('./redis-client').getClient();

class PlayerStateManager {
  constructor() {
    this.balancePrefix = 'balance:';
    this.playerPrefix = 'player:';
  }

  getBalanceKey(userId) {
    return `${this.balancePrefix}${userId}`;
  }

  getPlayerKey(tableId, userId) {
    return `${this.playerPrefix}${tableId}:${userId}`;
  }

  async setBalance(userId, tableId, amount) {
    await redisClient.hset(
      this.getBalanceKey(userId),
      tableId,
      amount
    );
  }

  async getBalance(userId, tableId) {
    const value = await redisClient.hget(
      this.getBalanceKey(userId),
      tableId
    );
    return value ? parseInt(value) : 0;
  }

  async updateStatus(tableId, userId, status) {
    await redisClient.hset(
      this.getPlayerKey(tableId, userId),
      'status',
      status
    );
  }

  async getStatus(tableId, userId) {
    return redisClient.hget(
      this.getPlayerKey(tableId, userId),
      'status'
    );
  }

  async removePlayer(tableId, userId) {
    await redisClient.del(this.getPlayerKey(tableId, userId));
  }
}

module.exports = new PlayerStateManager();