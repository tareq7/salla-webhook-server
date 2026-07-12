'use strict';
const { createClient } = require('redis');
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', error => console.error('Redis client error', { message: error.message }));
let connectionPromise;
async function getRedis() {
    if (redis.isReady) return redis;
    if (!connectionPromise) connectionPromise = redis.connect().catch(error => { connectionPromise = null; throw error; });
    await connectionPromise;
    return redis;
}
async function closeRedis() { if (redis.isOpen) await redis.quit(); }
module.exports = { getRedis, closeRedis };
