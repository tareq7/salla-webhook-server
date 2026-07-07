const { createClient } = require('redis');

const redis = createClient({ url: process.env.REDIS_URL }); // rediss://default:<pw>@<host>:<port>
redis.on('error', (err) => console.error('Redis Client Error', err));

let connected = false;
async function getRedis() {
  if (!connected) {
    await redis.connect();
    connected = true;
  }
  return redis;
}

module.exports = { getRedis };
