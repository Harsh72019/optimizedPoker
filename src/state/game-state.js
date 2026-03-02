// src/state/game-state.manager.js

const redisClient = require('./redis-client').getClient();

class GameStateManager {
  constructor() {
    this.prefix = 'game:';
    this.lockPrefix = 'lock:game:';
  }

  getKey(tableId) {
    return `${this.prefix}${tableId}`;
  }

  getLockKey(tableId) {
    return `${this.lockPrefix}${tableId}`;
  }

  async createGame(tableId, initialState) {
    await redisClient.set(
      this.getKey(tableId),
      JSON.stringify(initialState),
      'EX',
      3600
    );
  }

  async getGame(tableId) {
    const data = await redisClient.get(this.getKey(tableId));
    return data ? JSON.parse(data) : null;
  }

  async updateGame(tableId, state) {
    await redisClient.set(
      this.getKey(tableId),
      JSON.stringify(state),
      'EX',
      3600
    );
  }

  async deleteGame(tableId) {
    await redisClient.del(this.getKey(tableId));
  }

  // 🔒 Atomic lock (prevents race conditions)
  async acquireLock(tableId, ttl = 5) {
    const result = await redisClient.set(
      this.getLockKey(tableId),
      '1',
      'NX',
      'EX',
      ttl
    );

    return result === 'OK';
  }

  async releaseLock(tableId) {
    await redisClient.del(this.getLockKey(tableId));
  }

  // 🔥 Atomic bet update using Lua
  async atomicBet(tableId, playerId, amount) {
    const script = `
      local key = KEYS[1]
      local playerId = ARGV[1]
      local amount = tonumber(ARGV[2])

      local game = redis.call("GET", key)
      if not game then return nil end

      local data = cjson.decode(game)

      for i, p in ipairs(data.players) do
        if p.id == playerId then
          p.chips = p.chips - amount
          p.chipsInPot = (p.chipsInPot or 0) + amount
        end
      end

      data.pot = data.pot + amount

      redis.call("SET", key, cjson.encode(data))
      return data.pot
    `;

    return redisClient.eval(
      script,
      1,
      this.getKey(tableId),
      playerId,
      amount
    );
  }
}

module.exports = new GameStateManager();