// scripts/clear-redis.js

const redisClient = require('../../src/state/redis-client.js').getClient();

async function clearRedis() {
    try {
        console.log('🗑️  Clearing all Redis data...');
        
        await redisClient.flushall();
        
        console.log('✅ Redis cleared successfully');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error clearing Redis:', err.message);
        process.exit(1);
    }
}

clearRedis();
