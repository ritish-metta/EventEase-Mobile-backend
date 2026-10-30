// config/redis.js
// Central Redis connection — same pattern as your config/db.js for MongoDB

const { createClient } = require('redis');

let redisClient;

const connectRedis = async () => {
  redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    socket: {
      reconnectStrategy: (retries) => {
        // Retry with backoff, cap at 5s, give up noisy logs after a while
        const delay = Math.min(retries * 100, 5000);
        console.log(`Redis reconnect attempt 🔴 ${retries}, retrying in ${delay}ms`);
        return delay;
      },
    },
  });

  redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err.message);
  });

  redisClient.on('connect', () => {
    console.log('Redis connecting...🌐');
  });

  redisClient.on('ready', () => {
    console.log('Redis Connected & Ready✅');
  });

  await redisClient.connect();

  return redisClient;
};

const getRedis = () => {
  if (!redisClient) throw new Error('Redis not initialized! Call connectRedis() first.');
  return redisClient;
};

module.exports = { connectRedis, getRedis };