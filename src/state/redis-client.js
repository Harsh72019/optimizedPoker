const Redis = require('ioredis');

class RedisClient {
  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      username: process.env.REDIS_USERNAME, // needed for Redis Cloud
      password: process.env.REDIS_PASSWORD,
      tls: {}, // ✅ VERY IMPORTANT
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