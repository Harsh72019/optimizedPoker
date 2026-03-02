// src/queues/game-queue.js

const { Queue } = require('bullmq');
const config = require('../config/config');

const gameQueue = new Queue('game-events', {
    connection: {
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
    },
});

module.exports = gameQueue;
