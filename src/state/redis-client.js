// src/state/redis-client.js

const Redis = require('ioredis');
const config = require('../config/config');

class RedisClient {
  constructor() {
    this.redis = new Redis({
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      password: "",
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

    this.redis.on('connect', () =>
      console.log('✅ Redis connected')
    );

    this.redis.on('error', (err) =>
      console.error('❌ Redis error:', err)
    );
  }

  getClient() {
    return this.redis;
  }
}

module.exports = new RedisClient();