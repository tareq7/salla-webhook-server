const { getRedis } = require('./redis.js');

const GCLID_TTL_SECONDS = 60 * 60 * 24 * 30;      // capture window before we give up on a cart/order
const FORWARDED_TTL_SECONDS = 60 * 60 * 24 * 7;    // dedup window for webhook retries

const gclidKey = (joinId) => `gclid:${joinId}`;
const forwardedKey = (txnId) => `forwarded:${txnId}`;
const orderDetailsKey = (txnId) => `order_details:${txnId}`;

async function saveGclid(joinId, trackingId, trackingType, clientId) {
  const client = await getRedis();
  const value = JSON.stringify({ id: trackingId, type: trackingType || 'gclid', clientId });
  await client.set(gclidKey(joinId), value, { EX: GCLID_TTL_SECONDS });
}

async function getGclid(joinId) {
  const client = await getRedis();
  const val = await client.get(gclidKey(joinId));
  if (!val) return null;
  try {
      const parsed = JSON.parse(val);
      if (parsed && parsed.id && parsed.type) return parsed;
  } catch(e) {}
  return { id: val, type: 'gclid' }; 
}

async function deleteGclid(joinId) {
  const client = await getRedis();
  await client.del(gclidKey(joinId));
}

async function saveOrderDetails(txnId, details) {
  const client = await getRedis();
  details.__timestamp = Date.now();
  await client.set(orderDetailsKey(txnId), JSON.stringify(details), { EX: GCLID_TTL_SECONDS });
}

async function getOrderDetails(txnId) {
  const client = await getRedis();
  const val = await client.get(orderDetailsKey(txnId));
  return val ? JSON.parse(val) : null;
}

async function deleteOrderDetails(txnId) {
  const client = await getRedis();
  await client.del(orderDetailsKey(txnId));
}

// Returns true only the first time a given transaction id is seen (atomic NX check)
async function markForwarded(transactionId) {
    const redis = await getRedis();
    const key = `forwarded:${transactionId}`;
    // SET NX returns OK if set, null if it already existed
    const result = await redis.set(key, '1', { NX: true, EX: 604800 }); // 7 days
    return result !== null;
}

// Token storage for Salla app.store.authorize
async function saveMerchantToken(merchantId, tokenData) {
    const redis = await getRedis();
    const key = `merchant_token:${merchantId}`;
    // Store as JSON string, expires could be used for TTL but refresh tokens don't expire
    await redis.set(key, JSON.stringify(tokenData));
}

async function getMerchantToken(merchantId) {
    const redis = await getRedis();
    const key = `merchant_token:${merchantId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
}

module.exports = { saveGclid, getGclid, deleteGclid, saveOrderDetails, getOrderDetails, deleteOrderDetails, markForwarded, saveMerchantToken, getMerchantToken };
