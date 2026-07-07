const { getRedis } = require('./redis.js');

const GCLID_TTL_SECONDS = 60 * 60 * 24 * 30;      // capture window before we give up on a cart/order
const FORWARDED_TTL_SECONDS = 60 * 60 * 24 * 7;    // dedup window for webhook retries

const gclidKey = (joinId) => `gclid:${joinId}`;
const forwardedKey = (txnId) => `forwarded:${txnId}`;

async function saveGclid(joinId, gclid) {
  const client = await getRedis();
  await client.set(gclidKey(joinId), gclid, { EX: GCLID_TTL_SECONDS });
}

async function getGclid(joinId) {
  const client = await getRedis();
  return client.get(gclidKey(joinId)); // null if missing/expired, never throws
}

// Returns true only the first time a given transaction id is seen (atomic NX check)
async function markForwarded(transactionId) {
  const client = await getRedis();
  const result = await client.set(forwardedKey(transactionId), '1', {
    EX: FORWARDED_TTL_SECONDS,
    NX: true,
  });
  return result === 'OK';
}

module.exports = { saveGclid, getGclid, markForwarded };
