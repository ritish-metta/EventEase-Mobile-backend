// Redis browser: server stats, key search (SCAN, never KEYS), view / set / delete keys.

const { createClient } = require('redis');

const MAX_KEYS = 300;
const MAX_ITEMS = 200; // list/set/hash items shown per key

module.exports = function redis(ctx) {
  let client = null;

  async function getClient() {
    if (client?.isReady) return client;
    client?.destroy?.();
    client = createClient({
      url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
      socket: { connectTimeout: 3000, reconnectStrategy: false },
    });
    client.on('error', () => {}); // surfaced through the failing request instead
    try {
      await client.connect();
    } catch (err) {
      client = null;
      throw new ctx.HttpError(503, `Can't connect to Redis: ${err.message}`);
    }
    return client;
  }

  const keyParam = (req) => {
    const key = String(req.query.key ?? req.body?.key ?? '');
    if (!key) throw new ctx.HttpError(400, 'key is required');
    return key;
  };

  ctx.app.get('/api/redis/info', async (req, res) => {
    const c = await getClient();
    const info = {};
    for (const line of (await c.info()).split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) info[line.slice(0, i)] = line.slice(i + 1);
    }
    const hits = Number(info.keyspace_hits || 0);
    const misses = Number(info.keyspace_misses || 0);
    res.json({
      success: true,
      version: info.redis_version,
      uptimeSec: Number(info.uptime_in_seconds),
      clients: Number(info.connected_clients),
      memory: info.used_memory_human,
      peakMemory: info.used_memory_peak_human,
      maxMemory: info.maxmemory_human,
      opsPerSec: Number(info.instantaneous_ops_per_sec),
      hitRate: hits + misses ? +((hits / (hits + misses)) * 100).toFixed(1) : null,
      expiredKeys: Number(info.expired_keys),
      evictedKeys: Number(info.evicted_keys),
      keys: await c.dbSize(),
      keyspace: Object.fromEntries(Object.entries(info).filter(([k]) => /^db\d+$/.test(k))),
    });
  });

  ctx.app.get('/api/redis/keys', async (req, res) => {
    const c = await getClient();
    const pattern = String(req.query.pattern || '*');
    const keys = [];
    for await (const batch of c.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      keys.push(...(Array.isArray(batch) ? batch : [batch])); // v5+ yields arrays, v4 single keys
      if (keys.length >= MAX_KEYS) break;
    }
    const sliced = keys.slice(0, MAX_KEYS).sort();
    const details = await Promise.all(sliced.map(async (key) => ({ key, type: await c.type(key), ttl: await c.ttl(key) })));
    res.json({ success: true, keys: details, truncated: keys.length >= MAX_KEYS });
  });

  ctx.app.get('/api/redis/key', async (req, res) => {
    const c = await getClient();
    const key = keyParam(req);
    const type = await c.type(key);
    if (type === 'none') throw new ctx.HttpError(404, 'Key not found');
    const ttl = await c.ttl(key);
    let value;
    let size;
    switch (type) {
      case 'string':
        value = await c.get(key);
        size = value?.length ?? 0;
        break;
      case 'hash':
        size = await c.hLen(key);
        value = Object.fromEntries(Object.entries(await c.hGetAll(key)).slice(0, MAX_ITEMS));
        break;
      case 'list':
        size = await c.lLen(key);
        value = await c.lRange(key, 0, MAX_ITEMS - 1);
        break;
      case 'set':
        size = await c.sCard(key);
        value = (await c.sMembers(key)).slice(0, MAX_ITEMS);
        break;
      case 'zset':
        size = await c.zCard(key);
        value = await c.zRangeWithScores(key, 0, MAX_ITEMS - 1);
        break;
      default:
        value = `(preview not supported for type "${type}")`;
    }
    res.json({ success: true, key, type, ttl, size, value });
  });

  ctx.app.post('/api/redis/key', async (req, res) => {
    const c = await getClient();
    const key = keyParam(req);
    const value = String(req.body?.value ?? '');
    const ttl = parseInt(req.body?.ttl, 10);
    if (ttl > 0) await c.set(key, value, { EX: ttl });
    else await c.set(key, value);
    res.json({ success: true, message: `Saved ${key}` });
  });

  ctx.app.delete('/api/redis/key', async (req, res) => {
    const c = await getClient();
    const key = keyParam(req);
    const removed = await c.del(key);
    res.json({ success: true, message: removed ? `Deleted ${key}` : `${key} did not exist` });
  });

  ctx.app.post('/api/redis/flushdb', async (req, res) => {
    const c = await getClient();
    await c.flushDb();
    res.json({ success: true, message: 'All keys in the current database were deleted' });
  });
};
