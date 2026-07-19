'use strict';
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const store = require('./gclidStore');
const { getRedis, closeRedis } = require('./redis');

const required = name => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
};
const SALLA_SECRET = required('SALLA_WEBHOOK_SECRET');
const ADMIN_SECRET = required('ADMIN_SECRET');
const CRON_SECRET = required('CRON_SECRET');
const SGTM_URL = new URL(process.env.SGTM_URL || 'https://server-side-tagging-ihka65rwnq-uc.a.run.app').origin;
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || 'G-KBLW70T89R';
const SALLA_CLIENT_ID = process.env.SALLA_CLIENT_ID || '';
const SALLA_CLIENT_SECRET = process.env.SALLA_CLIENT_SECRET || '';
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use('/track-gclid', express.text({ type: ['text/plain', 'application/json'], limit: '4kb' }));
app.use('/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.size > 0 && !ALLOWED_ORIGINS.has(origin)) {
        return res.status(403).send('Origin not allowed');
    }
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false });
const webhookLogs = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function validIdentifier(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9._~-]+$/.test(value);
}
function authorized(req, secret) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(secret);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function normalizePhone(phone) {
    if (!phone) return null;
    let digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('05') && digits.length === 10) digits = `966${digits.slice(1)}`;
    else if (digits.startsWith('5') && digits.length === 9) digits = `966${digits}`;
    return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

async function sendToSgtm(orderId, tracking, order) {
    const transactionId = String(order.reference_id || orderId);
    const value = Number.parseFloat(order.amounts?.total?.amount);
    const params = new URLSearchParams({
        v: '2', tid: GA4_MEASUREMENT_ID, cid: tracking?.clientId || `server.${orderId}`,
        en: 'purchase', 'ep.transaction_id': transactionId,
        'ep.currency': order.currency || 'SAR', 'epn.value': String(Number.isFinite(value) ? value : 0),
        dl: 'https://ssp-1.com/thank-you'
    });
    if (tracking?.id) params.set(`ep.${tracking.type}`, tracking.id);
    const userData = {
        'ep.user_data.email_address': order.customer?.email?.trim().toLowerCase(),
        'ep.user_data.phone_number': order.e164Phone,
        'ep.user_data.address.first_name': order.customer?.first_name,
        'ep.user_data.address.last_name': order.customer?.last_name,
        'ep.user_data.address.city': order.customer?.city,
        'ep.user_data.address.country': order.customer?.country?.code || 'SA'
    };
    for (const [name, valuePart] of Object.entries(userData)) if (valuePart) params.set(name, valuePart);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${SGTM_URL}/g/collect?${params}`, { method: 'POST', signal: controller.signal });
        if (!response.ok) throw new Error(`sGTM returned ${response.status}`);
        console.log('Purchase sent to sGTM', { transactionId, attributed: Boolean(tracking?.id) });
    } finally { clearTimeout(timeout); }
}

async function processConversion(orderId, cartId, tracking, order) {
    const owner = await store.claimConversion(orderId);
    if (!owner) return false;
    let sent = false;
    try {
        await sendToSgtm(orderId, tracking, order);
        await store.markConversionSent(orderId, owner);
        sent = true;
    } catch (error) {
        await store.releaseConversionClaim(orderId, owner).catch(releaseError => console.error('Claim release failed', releaseError.message));
        throw error;
    }

    const cleanupResults = await Promise.allSettled([
        store.deleteTrackingForOrder(orderId, cartId),
        store.deleteOrderDetails(orderId)
    ]);
    for (const result of cleanupResults) {
        if (result.status === 'rejected') {
            console.error('Post-conversion cleanup failed', result.reason?.message || result.reason);
        }
    }
    return sent;
}

async function reconcile(orderId, cartId) {
    const [tracking, order] = await Promise.all([store.getTrackingForOrder(orderId, cartId), store.getOrderDetails(orderId)]);
    if (!tracking || !order) return false;
    return processConversion(orderId, cartId, tracking, order);
}

app.post('/track-gclid', trackLimiter, async (req, res) => {
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '') : req.body;
        const { entity_type: type, entity_id: id, tracking_id: trackingId, tracking_type: trackingType, client_id: clientId } = body;
        if (!['cart', 'order'].includes(type)) return res.status(400).send('Invalid entity type');
        if (!validIdentifier(id, 128)) return res.status(400).send('Invalid entity ID');
        if (!validIdentifier(trackingId, 256)) return res.status(400).send('Invalid tracking ID');
        if (!['gclid', 'wbraid', 'gbraid'].includes(trackingType)) return res.status(400).send('Invalid tracking type');
        if (clientId != null && !validIdentifier(clientId, 100)) return res.status(400).send('Invalid client ID');
        await store.saveTracking(type, id, { tracking_id: trackingId, tracking_type: trackingType, client_id: clientId });
        const orderId = type === 'order' ? id : await store.getOrderIdByCartId(id);
        const matched = orderId ? await reconcile(String(orderId), type === 'cart' ? id : null) : false;
        res.status(200).json({ status: 'stored', matched });
    } catch (error) {
        if (error instanceof SyntaxError) return res.status(400).send('Invalid JSON');
        console.error('Tracking error', error.message);
        res.status(500).send('Internal Server Error');
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-salla-signature'];
        if (typeof signature !== 'string') return res.status(401).send('Unauthorized');
        const expected = crypto.createHmac('sha256', SALLA_SECRET).update(req.body).digest('hex');
        const a = Buffer.from(signature); const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send('Unauthorized');
        let payload;
        try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).send('Invalid JSON'); }
        if (!payload?.event || !payload.data) return res.status(400).send('Bad Request');
        if (payload.event === 'app.store.authorize') {
            if (!payload.merchant) return res.status(400).send('Missing merchant');
            const { access_token, refresh_token, expires, scope } = payload.data;
            if (!access_token || !refresh_token) return res.status(400).send('Missing tokens');
            await store.saveMerchantToken(payload.merchant, { access_token, refresh_token, expires_at: expires, scope });
            return res.status(200).send('Webhook Processed');
        }
        const order = payload.data;
        const orderId = String(order.id || '');
        if (!validIdentifier(orderId, 128)) return res.status(400).send('Invalid order ID');
        webhookLogs.push({ timestamp: new Date().toISOString(), event: payload.event, order_id: orderId });
        if (webhookLogs.length > 100) webhookLogs.shift();
        const statusSlug = String(order.status?.slug || '').toLowerCase();
        const paid = statusSlug !== 'payment_pending' &&
                     statusSlug !== 'canceled' &&
                     statusSlug !== 'cancelled' &&
                     order.is_pending_payment === false;
        if (['order.created', 'order.payment.updated'].includes(payload.event) && paid) {
            const storedOrder = { ...order, e164Phone: normalizePhone(order.customer?.mobile) };
            const cartId = order.cart_id ? String(order.cart_id) : (order.checkout_id ? String(order.checkout_id) : null);
            await store.saveOrderDetails(orderId, cartId, storedOrder);
            await reconcile(orderId, cartId); // write then re-read closes the lost-wakeup race
        } else {
            await store.saveRejectedWebhook(orderId, payload);
        }
        res.status(200).send('Webhook Processed');
    } catch (error) {
        console.error('Webhook error', error.message);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/readyz', async (req, res) => { try { await (await getRedis()).ping(); res.json({ status: 'ready' }); } catch { res.status(503).json({ status: 'not-ready' }); } });
app.get('/admin/logs', (req, res) => authorized(req, ADMIN_SECRET) ? res.json({ count: webhookLogs.length, logs: webhookLogs }) : res.status(401).send('Unauthorized'));
app.get('/admin/raw-dump', async (req, res) => {
    if (!authorized(req, ADMIN_SECRET)) return res.status(401).send('Unauthorized');
    try {
        const redis = await getRedis();
        const clicks = await store.scanKeys('gclid:*');
        const dump = {};
        for (const c of clicks) {
            try { dump[c] = JSON.parse(await redis.get(c)); } catch(e) { dump[c] = await redis.get(c); }
        }
        res.json({ status: 'success', total: clicks.length, data: dump });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/admin/db-status', async (req, res) => {
    if (!authorized(req, ADMIN_SECRET)) return res.status(401).send('Unauthorized');
    try {
        const [sent, clicks, orders, mappings, rejected] = await Promise.all([
            store.scanKeys('sent:*'), store.scanKeys('gclid:*'), store.scanKeys('order_details:*'), store.scanKeys('cart_to_order:*'), store.scanKeys('rejected_webhook:*')
        ]);
        res.json({ status: 'success', summary: { processed_orders_count: sent.length, pending_clicks_count: clicks.length, pending_orders_count: orders.length, cart_to_order_mappings_count: mappings.length, rejected_webhooks_count: rejected.length } });
    } catch (error) { res.status(500).json({ error: 'Internal Server Error' }); }
});
app.get('/admin/rejected-webhooks', async (req, res) => {
    if (!authorized(req, ADMIN_SECRET)) return res.status(401).send('Unauthorized');
    try {
        const keys = await store.scanKeys('rejected_webhook:*');
        const redis = await getRedis();
        const results = [];
        for (const k of keys) {
            const val = await redis.get(k);
            if (val) {
                try {
                    results.push(JSON.parse(val));
                } catch {
                    results.push({ key: k, error: 'Invalid JSON' });
                }
            }
        }
        res.json({ count: results.length, webhooks: results });
    } catch (error) {
        console.error('Error fetching rejected webhooks', error.message);
        res.status(500).send('Internal Server Error');
    }
});
app.get('/cron/sweep-unmatched', async (req, res) => {
    if (!authorized(req, CRON_SECRET)) return res.status(401).send('Unauthorized');
    try {
        const redis = await getRedis(); const keys = await store.scanKeys('order_details:*');
        let swept = 0;
        for (const detailsKey of keys) {
            const raw = await redis.get(detailsKey); if (!raw) continue;
            const order = JSON.parse(raw); if (Date.now() - (order.__timestamp || 0) <= 86400000) continue;
            const orderId = detailsKey.slice('order_details:'.length);
            if (await processConversion(orderId, order.cart_id ? String(order.cart_id) : null, null, order)) swept++;
        }
        res.json({ status: 'success', swept });
    } catch (error) { console.error('Sweep error', error.message); res.status(500).json({ error: 'Internal Server Error' }); }
});
app.use('/admin/delete-keys', express.json({ limit: '4kb' }));
app.post('/admin/delete-keys', async (req, res) => {
    if (!authorized(req, ADMIN_SECRET)) return res.status(401).send('Unauthorized');
    try {
        const redis = await getRedis();
        const keys = Array.isArray(req.body) ? req.body : [];
        if (!keys.length) return res.status(400).json({ error: 'Provide an array of key names' });
        let deleted = 0;
        for (const key of keys) {
            if (typeof key === 'string' && key.length < 256) { deleted += await redis.del(key); }
        }
        res.json({ status: 'success', deleted });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/admin/snapshot', async (req, res) => {
    if (!authorized(req, ADMIN_SECRET)) return res.status(401).send('Unauthorized');
    try {
        const redis = await getRedis();
        const prefixes = ['gclid:*', 'order_details:*', 'sent:*', 'cart_to_order:*', 'rejected_webhook:*', 'merchant_token:*', 'processing:*'];
        const snapshot = { created_at: new Date().toISOString(), data: {} };
        for (const pattern of prefixes) {
            const keys = await store.scanKeys(pattern);
            for (const key of keys) {
                const raw = await redis.get(key);
                try { snapshot.data[key] = JSON.parse(raw); } catch { snapshot.data[key] = raw; }
            }
        }
        snapshot.total_keys = Object.keys(snapshot.data).length;
        const snapshotKey = `snapshot:${Date.now()}`;
        await redis.set(snapshotKey, JSON.stringify(snapshot), { EX: 60 * 60 * 24 * 30 });
        res.json({ status: 'success', snapshot_key: snapshotKey, total_keys: snapshot.total_keys, data: snapshot.data });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

async function getSallaAccessToken(merchantId) {


    for (let attempt = 0; attempt < 10; attempt++) {
        const token = await store.getMerchantToken(merchantId);
        if (!token) throw new Error(`No token for merchant ${merchantId}`);
        if (token.expires_at && Date.now() < token.expires_at * 1000 - 300000) return token.access_token;
        const redis = await getRedis(); const owner = crypto.randomUUID(); const lockKey = `refresh_lock:${merchantId}`;
        if (await redis.set(lockKey, owner, { NX: true, EX: 30 })) {
            try {
                if (!SALLA_CLIENT_ID || !SALLA_CLIENT_SECRET) throw new Error('Salla OAuth credentials are not configured');
                const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
                let response;
                try { response = await fetch('https://accounts.salla.sa/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: SALLA_CLIENT_ID, client_secret: SALLA_CLIENT_SECRET, refresh_token: token.refresh_token }), signal: controller.signal }); }
                finally { clearTimeout(timeout); }
                if (!response.ok) throw new Error(`Salla refresh failed: ${response.status}`);
                const fresh = await response.json();
                await store.saveMerchantToken(merchantId, { access_token: fresh.access_token, refresh_token: fresh.refresh_token || token.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(fresh.expires_in), scope: fresh.scope });
                return fresh.access_token;
            } finally { await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", { keys: [lockKey], arguments: [owner] }); }
        }
        await sleep(250 + attempt * 100);
    }
    throw new Error(`Token refresh timed out for merchant ${merchantId}`);
}

let server;
if (require.main === module) {
    server = app.listen(process.env.PORT || 3000, () => console.log(`Server listening on port ${process.env.PORT || 3000}`));
    process.on('SIGTERM', () => server.close(async () => { await closeRedis(); process.exit(0); }));
}
module.exports = { app, authorized, normalizePhone, validIdentifier, reconcile, processConversion, sendToSgtm, getSallaAccessToken };
