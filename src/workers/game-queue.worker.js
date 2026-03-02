// src/workers/game-queue.worker.js

const { Worker } = require('bullmq');
const config = require('../config/config');
const handPersister = require('./hand-persister');

const worker = new Worker('game-events', async (job) => {
    const { type, data } = job.data;

    switch (type) {
        case 'PERSIST_HAND':
            await handPersister.persist(data.tableId);
            break;
        default:
            console.warn(`Unknown job type: ${type}`);
    }
}, {
    connection: {
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        password: config.REDIS_PASSWORD,
    },
});

worker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} failed:`, err.message);
});

module.exports = worker;
