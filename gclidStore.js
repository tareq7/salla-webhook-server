'use strict';

const crypto = require('crypto');
const { getRedis } = require('./redis.js');

const DATA_TTL_SECONDS = 60 * 60 * 24 * 30;
const SENT_TTL_SECONDS = 60 * 60 * 24 * 90;
const PROCESSING_TTL_SECONDS = 60;

const key = (namespace, id) => `${namespace}:${id}`;
const cartGclidKey = id => key('gclid:cart', id);
const orderGclidKey = id => key('gclid:order', id);
const cartToOrderKey = id => key('cart_to_order', id);
const referenceToOrderKey = id => key('reference_to_order', id);
const orderDetailsKey = id => key('order_details', id);
const sentKey = id => key('sent', id);
const processingKey = id => key('processing', id);

function parseJson(value, label) {
    if (!value) return null;
    try { return JSON.parse(value); } catch (error) {
        throw new Error(`Invalid JSON stored for ${label}`, { cause: error });
    }
}

async function saveTracking(entityType, entityId, trackingData) {
    const client = await getRedis();
    const trackingKey = entityType === 'cart' ? cartGclidKey(entityId) : orderGclidKey(entityId);
    await client.set(trackingKey, JSON.stringify({
        id: trackingData.tracking_id,
        type: trackingData.tracking_type,
        clientId: trackingData.client_id || null,
        timestamp: Date.now()
    }), { EX: DATA_TTL_SECONDS });
}

async function getTrackingForOrder(orderId, cartId, referenceId) {
    const client = await getRedis();
    const orderValue = await client.get(orderGclidKey(orderId));
    if (orderValue) return parseJson(orderValue, orderGclidKey(orderId));
    if (cartId) {
        const cartValue = await client.get(cartGclidKey(cartId));
        if (cartValue) return parseJson(cartValue, cartGclidKey(cartId));
        const cartOrderValue = await client.get(orderGclidKey(cartId));
        if (cartOrderValue) return parseJson(cartOrderValue, orderGclidKey(cartId));
    }
    if (referenceId) {
        const refValue = await client.get(orderGclidKey(referenceId));
        if (refValue) return parseJson(refValue, orderGclidKey(referenceId));
    }
    return null;
}

async function deleteTrackingForOrder(orderId, cartId, referenceId) {
    const client = await getRedis();
    const keys = [orderGclidKey(orderId)];
    if (cartId) keys.push(cartGclidKey(cartId), cartToOrderKey(cartId), orderGclidKey(cartId));
    if (referenceId) keys.push(orderGclidKey(referenceId), referenceToOrderKey(referenceId));
    await client.del(keys);
}

async function saveOrderDetails(orderId, cartId, details) {
    const client = await getRedis();
    const stored = { ...details, __timestamp: Date.now() };
    const commands = client.multi()
        .set(orderDetailsKey(orderId), JSON.stringify(stored), { EX: DATA_TTL_SECONDS });
    if (cartId) commands.set(cartToOrderKey(cartId), String(orderId), { EX: DATA_TTL_SECONDS });
    if (details.reference_id) commands.set(referenceToOrderKey(String(details.reference_id)), String(orderId), { EX: DATA_TTL_SECONDS });
    await commands.exec();
    return stored;
}

async function getOrderDetails(orderId) {
    const client = await getRedis();
    return parseJson(await client.get(orderDetailsKey(orderId)), orderDetailsKey(orderId));
}

async function deleteOrderDetails(orderId) {
    const client = await getRedis();
    await client.del(orderDetailsKey(orderId));
}

async function getOrderIdByCartId(cartId) {
    return (await getRedis()).get(cartToOrderKey(cartId));
}

async function getOrderIdByReferenceId(referenceId) {
    return (await getRedis()).get(referenceToOrderKey(referenceId));
}

async function claimConversion(transactionId) {
    const redis = await getRedis();
    const owner = crypto.randomUUID();
    const result = await redis.eval(
        "if redis.call('exists', KEYS[1]) == 1 then return 0 end; " +
        "if redis.call('set', KEYS[2], ARGV[1], 'NX', 'EX', ARGV[2]) then return 1 else return 0 end",
        {
            keys: [sentKey(transactionId), processingKey(transactionId)],
            arguments: [owner, String(PROCESSING_TTL_SECONDS)]
        }
    );
    return result === 1 ? owner : null;
}

async function releaseConversionClaim(transactionId, owner) {
    const redis = await getRedis();
    await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        { keys: [processingKey(transactionId)], arguments: [owner] }
    );
}

async function markConversionSent(transactionId, owner) {
    const redis = await getRedis();
    const result = await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[2], '1', 'EX', ARGV[2]); redis.call('del', KEYS[1]); return 1 else return 0 end",
        { keys: [processingKey(transactionId), sentKey(transactionId)], arguments: [owner, String(SENT_TTL_SECONDS)] }
    );
    if (result !== 1) throw new Error(`Lost conversion claim for ${transactionId}`);
}

async function scanKeys(pattern) {
    const redis = await getRedis();
    const keys = [];
    for await (const found of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        if (Array.isArray(found)) keys.push(...found); else keys.push(found);
    }
    return keys;
}

function tokenEncryptionKey() {
    const encoded = process.env.TOKEN_ENCRYPTION_KEY;
    if (!encoded) throw new Error('TOKEN_ENCRYPTION_KEY is required for merchant token storage');
    const encryptionKey = Buffer.from(encoded, 'base64');
    if (encryptionKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    return encryptionKey;
}

function encryptJson(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', tokenEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
}

function decryptJson(value) {
    const envelope = parseJson(value, 'merchant token');
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenEncryptionKey(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
}

async function saveMerchantToken(merchantId, tokenData) {
    await (await getRedis()).set(key('merchant_token', merchantId), encryptJson(tokenData));
}

async function getMerchantToken(merchantId) {
    const data = await (await getRedis()).get(key('merchant_token', merchantId));
    return data ? decryptJson(data) : null;
}

const REJECTED_TTL_SECONDS = 60 * 60 * 24;
const rejectedKey = id => key('rejected_webhook', id);

async function saveRejectedWebhook(orderId, payload) {
    const client = await getRedis();
    await client.set(rejectedKey(orderId), JSON.stringify({
        payload,
        timestamp: Date.now()
    }), { EX: REJECTED_TTL_SECONDS });
}

module.exports = {
    saveTracking, getTrackingForOrder, deleteTrackingForOrder,
    saveOrderDetails, getOrderDetails, deleteOrderDetails, getOrderIdByCartId, getOrderIdByReferenceId,
    claimConversion, releaseConversionClaim, markConversionSent, scanKeys,
    saveMerchantToken, getMerchantToken, saveRejectedWebhook
};
