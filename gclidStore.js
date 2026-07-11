const { getRedis } = require('./redis.js');

const GCLID_TTL_SECONDS = 60 * 60 * 24 * 30;      // 30 days capture window
const FORWARDED_TTL_SECONDS = 60 * 60 * 24 * 7;    // 7 days deduplication window

// Key patterns
const cartGclidKey = (cartId) => `gclid:cart:${cartId}`;
const orderGclidKey = (orderId) => `gclid:order:${orderId}`;
const cartToOrderKey = (cartId) => `cart_to_order:${cartId}`;
const orderDetailsKey = (orderId) => `order_details:${orderId}`;
const forwardedKey = (txnId) => `forwarded:${txnId}`;

/**
 * Saves a browser tracking click event.
 * Matches entityType ('cart' or 'order') and stores click parameters.
 */
async function saveTracking(entityType, entityId, trackingData) {
    const client = await getRedis();
    const key = entityType === 'cart' ? cartGclidKey(entityId) : orderGclidKey(entityId);
    const value = JSON.stringify({
        id: trackingData.tracking_id,
        type: trackingData.tracking_type,
        clientId: trackingData.client_id,
        timestamp: Date.now()
    });
    await client.set(key, value, { EX: GCLID_TTL_SECONDS });
}

/**
 * Double-lookup to find click tracking details for a completed order.
 * Checks gclid:order:${orderId} first, then falls back to gclid:cart:${cartId}.
 */
async function getTrackingForOrder(orderId, cartId) {
    const client = await getRedis();
    
    // 1. Check order tracking first (in case tracking fired late on thank-you page)
    let val = await client.get(orderGclidKey(orderId));
    if (val) {
        try { return JSON.parse(val); } catch (e) {}
    }
    
    // 2. Check cart tracking (standard flow)
    if (cartId) {
        val = await client.get(cartGclidKey(cartId));
        if (val) {
            try { return JSON.parse(val); } catch (e) {}
        }
    }
    
    return null;
}

/**
 * Atomic cleanup of all Redis keys associated with a mapped conversion.
 */
async function deleteTrackingForOrder(orderId, cartId) {
    const client = await getRedis();
    const keys = [orderGclidKey(orderId)];
    if (cartId) {
        keys.push(cartGclidKey(cartId));
        keys.push(cartToOrderKey(cartId));
    }
    await client.del(keys);
}

/**
 * Saves order details (webhook payload) when the webhook arrives before tracking.
 * If cartId is present, also saves a mapping cartId -> orderId.
 */
async function saveOrderDetails(orderId, cartId, details) {
    const client = await getRedis();
    details.__timestamp = Date.now();
    
    await client.set(orderDetailsKey(orderId), JSON.stringify(details), { EX: GCLID_TTL_SECONDS });
    
    if (cartId) {
        await client.set(cartToOrderKey(cartId), String(orderId), { EX: GCLID_TTL_SECONDS });
    }
}

/**
 * Fetches order details by order ID.
 */
async function getOrderDetails(orderId) {
    const client = await getRedis();
    const val = await client.get(orderDetailsKey(orderId));
    return val ? JSON.parse(val) : null;
}

/**
 * Deletes order details when the rendezvous is complete.
 */
async function deleteOrderDetails(orderId) {
    const client = await getRedis();
    await client.del(orderDetailsKey(orderId));
}

/**
 * Returns mapped orderId if a cartId is already associated with an order.
 */
async function getOrderIdByCartId(cartId) {
    const client = await getRedis();
    return await client.get(cartToOrderKey(cartId));
}

/**
 * Returns true only the first time a given transaction id is seen (atomic NX check)
 */
async function markForwarded(transactionId) {
    const redis = await getRedis();
    const key = forwardedKey(transactionId);
    const result = await redis.set(key, '1', { NX: true, EX: FORWARDED_TTL_SECONDS });
    return result !== null;
}

// Token storage for Salla app.store.authorize
async function saveMerchantToken(merchantId, tokenData) {
    const redis = await getRedis();
    const key = `merchant_token:${merchantId}`;
    await redis.set(key, JSON.stringify(tokenData));
}

async function getMerchantToken(merchantId) {
    const redis = await getRedis();
    const key = `merchant_token:${merchantId}`;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
}

module.exports = {
    saveTracking,
    getTrackingForOrder,
    deleteTrackingForOrder,
    saveOrderDetails,
    getOrderDetails,
    deleteOrderDetails,
    getOrderIdByCartId,
    markForwarded,
    saveMerchantToken,
    getMerchantToken
};
