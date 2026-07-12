const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { 
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
} = require('./gclidStore');

const app = express();

const SALLA_SECRET = process.env.SALLA_WEBHOOK_SECRET;
if (!SALLA_SECRET) throw new Error('SALLA_WEBHOOK_SECRET is required');

const ADMIN_SECRET = process.env.ADMIN_SECRET;
if (!ADMIN_SECRET) throw new Error('ADMIN_SECRET is required');

const CRON_SECRET = process.env.CRON_SECRET || 'default_cron_secret_replace_in_prod';

const SGTM_URL = process.env.SGTM_URL || 'https://server-side-tagging-ihka65rwnq-uc.a.run.app';
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || 'G-KBLW70T89R';
const SALLA_CLIENT_ID = process.env.SALLA_CLIENT_ID || '';
const SALLA_CLIENT_SECRET = process.env.SALLA_CLIENT_SECRET || '';

// Rate Limiter for the public /track-gclid endpoint
const trackLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many requests from this IP, please try again later.'
});

// Support text/plain for the storefront snippet bypassing CORS preflight
app.use('/track-gclid', express.text({ type: 'text/plain' }));

// We keep raw body for webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));

// CORS headers so the storefront snippet can read response.ok
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// A simple in-memory log for debugging (not for production)
const webhookLogs = [];

// Salla OAuth token refresh with mutex (single-use refresh tokens)
async function getSallaAccessToken(merchantId) {
    const tokenData = await getMerchantToken(merchantId);
    if (!tokenData) throw new Error(`No token for merchant ${merchantId}`);

    if (tokenData.expires_at && Date.now() < (tokenData.expires_at * 1000) - 300000) {
        return tokenData.access_token;
    }

    const { getRedis } = require('./redis');
    const redis = await getRedis();
    const lockKey = `refresh_lock:${merchantId}`;
    const acquired = await redis.set(lockKey, '1', { NX: true, EX: 30 });

    if (!acquired) {
        await new Promise(r => setTimeout(r, 2000));
        return getSallaAccessToken(merchantId);
    }

    try {
        const res = await fetch('https://accounts.salla.sa/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                client_id: SALLA_CLIENT_ID,
                client_secret: SALLA_CLIENT_SECRET,
                refresh_token: tokenData.refresh_token,
            }),
        });
        if (!res.ok) throw new Error(`Salla refresh failed: ${res.status}`);
        const newTokens = await res.json();

        await saveMerchantToken(merchantId, {
            access_token: newTokens.access_token,
            refresh_token: newTokens.refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + newTokens.expires_in,
            scope: newTokens.scope,
        });
        return newTokens.access_token;
    } finally {
        await redis.del(lockKey);
    }
}

// Basic E164 normalizer
function normalizePhoneE164(phoneStr, countryIso) {
    if (!phoneStr) return null;
    let digits = phoneStr.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.substring(2);
    if (countryIso === 'SA') {
        if (digits.startsWith('05')) digits = '966' + digits.substring(1);
        else if (digits.startsWith('5') && digits.length === 9) digits = '966' + digits;
    }
    const finalPhone = '+' + digits;
    if (finalPhone.length < 8 || finalPhone.length > 16) return null;
    return finalPhone;
}

// Send purchase event to sGTM via GTag /g/collect wire format
async function sendToSgtm(orderId, tracking, orderDetails) {
    const txnId = orderDetails.reference_id || String(orderId);
    const value = parseFloat(orderDetails.amounts?.total?.amount) || 0;
    const currency = orderDetails.currency || 'SAR';
    const clientId = tracking?.clientId || `server.${orderId}`;

    const params = new URLSearchParams({
        v: '2',
        tid: GA4_MEASUREMENT_ID,
        cid: clientId,
        en: 'purchase',
        'ep.transaction_id': txnId,
        'ep.currency': currency,
        'epn.value': String(value),
        dl: 'https://ssp-1.com/thank-you',
    });

    // Add click attribution parameter
    if (tracking?.id) params.set(`ep.${tracking.type}`, tracking.id);

    // Enhanced Conversions: user data as event parameters
    const email = orderDetails.customer?.email;
    const phone = orderDetails.e164Phone;
    const firstName = orderDetails.customer?.first_name;
    const lastName = orderDetails.customer?.last_name;
    const city = orderDetails.customer?.city;
    const country = orderDetails.customer?.country?.code || 'SA';

    if (email) params.set('ep.user_data.email_address', email.trim().toLowerCase());
    if (phone) params.set('ep.user_data.phone_number', phone);
    if (firstName) params.set('ep.user_data.address.first_name', firstName);
    if (lastName) params.set('ep.user_data.address.last_name', lastName);
    if (city) params.set('ep.user_data.address.city', city);
    if (country) params.set('ep.user_data.address.country', country);

    const url = `${SGTM_URL}/g/collect?${params.toString()}`;
    console.log('Sending to sGTM:', url.slice(0, 300));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok && response.status !== 204) {
            throw new Error(`sGTM returned ${response.status}`);
        }
        console.log('Successfully sent to sGTM');
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

// Input validation helper
function isValidIdentifier(value, maxLength) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= maxLength &&
        /^[A-Za-z0-9._~-]+$/.test(value)
    );
}

// Endpoint for the Storefront Snippet to save the tracking parameter (Public)
app.post('/track-gclid', trackLimiter, async (req, res) => {
    try {
        if (!req.body || req.body.length === 0) {
            return res.status(400).send('Empty body');
        }

        let body;
        if (typeof req.body === 'string') {
            body = JSON.parse(req.body);
        } else if (Buffer.isBuffer(req.body)) {
            body = JSON.parse(req.body.toString('utf8'));
        } else {
            body = req.body;
        }

        const entityType = body.entity_type;
        const entityId = body.entity_id;
        const trackingId = body.tracking_id;
        const trackingType = body.tracking_type;
        const clientId = body.client_id;
        
        // Enforce strict input validation
        if (!['cart', 'order'].includes(entityType)) {
            return res.status(400).send('Invalid entity type');
        }
        if (!isValidIdentifier(entityId, 128)) {
            return res.status(400).send('Invalid entity ID');
        }
        if (!isValidIdentifier(trackingId, 256)) {
            return res.status(400).send('Invalid tracking ID');
        }
        if (!['gclid', 'wbraid', 'gbraid'].includes(trackingType)) {
            return res.status(400).send('Invalid tracking type');
        }
        if (clientId && !isValidIdentifier(clientId, 100)) {
            return res.status(400).send('Invalid client ID');
        }

        // Save tracking parameter in Redis
        await saveTracking(entityType, entityId, { tracking_id: trackingId, tracking_type: trackingType, client_id: clientId });
        console.log(`Saved tracking info for ${entityType} ${entityId} (${trackingType})`);
        
        // Rendezvous Check: Did the Salla webhook arrive before this tracking ping?
        if (entityType === 'cart') {
            const orderId = await getOrderIdByCartId(entityId);
            if (orderId) {
                const orderDetails = await getOrderDetails(orderId);
                if (orderDetails) {
                    await sendToSgtm(orderId, { id: trackingId, type: trackingType, clientId }, orderDetails);
                    await deleteOrderDetails(orderId);
                    await deleteTrackingForOrder(orderId, entityId);
                }
            }
        } else if (entityType === 'order') {
            const orderDetails = await getOrderDetails(entityId);
            if (orderDetails) {
                const cartId = orderDetails.cart_id ? String(orderDetails.cart_id) : null;
                await sendToSgtm(entityId, { id: trackingId, type: trackingType, clientId }, orderDetails);
                await deleteOrderDetails(entityId);
                await deleteTrackingForOrder(entityId, cartId);
            }
        }

        return res.status(200).send('OK');

    } catch (e) {
        console.error('Error in /track-gclid:', e.message);
        if (e instanceof SyntaxError) {
            return res.status(400).send('Invalid JSON');
        }
        return res.status(500).send('Internal Server Error');
    }
});

// Webhook Receiver from Salla
app.post('/webhook', async (req, res) => {
    const signature = req.headers['x-salla-signature'];
    const bodyRaw = req.body;
    
    if (!signature) {
        console.error('Missing signature');
        return res.status(401).send('Unauthorized');
    }

    // Cryptographic Signature Verification
    const hash = crypto.createHmac('sha256', SALLA_SECRET).update(bodyRaw).digest('hex');
    const sigBuffer = Buffer.from(signature, 'utf8');
    const hashBuffer = Buffer.from(hash, 'utf8');

    if (sigBuffer.length !== hashBuffer.length || !crypto.timingSafeEqual(sigBuffer, hashBuffer)) {
        console.error('Signature verification failed! Dropping request.');
        return res.status(401).send('Unauthorized');
    }
    
    const bodyString = bodyRaw.toString('utf8');
    const payload = bodyString ? JSON.parse(bodyString) : null;
    
    if (!payload || !payload.data) {
        return res.status(400).send('Bad Request');
    }

    const order = payload.data;
    const transactionId = String(order.id);

    // Log for manual review
    webhookLogs.push({
        timestamp: new Date().toISOString(),
        event: payload.event,
        order_id: transactionId,
        source_details: order.source_details || null
    });
    if (webhookLogs.length > 100) webhookLogs.shift(); 

    if (payload.event === 'order.created' || payload.event === 'order.payment.updated') {
        console.log(`\n--- Order Webhook Received: ${payload.event} ---`);
        console.log(`Order ID: ${transactionId}`);
        if (order.source_details) {
            console.log(`Source Details:`, JSON.stringify(order.source_details, null, 2));
        }
        console.log('-------------------------------------------\n');
    }

    try {
        if (payload.event === 'app.store.authorize') {
            const merchantId = payload.merchant;
            if (merchantId && payload.data) {
                const { access_token, refresh_token, expires, scope } = payload.data;
                await saveMerchantToken(merchantId, {
                    access_token,
                    refresh_token,
                    expires_at: expires, 
                    scope
                });
                console.log(`Saved new authorization tokens for merchant ${merchantId} to Redis`);
            }
            return res.status(200).send('Webhook Processed');
        }

        // Process Purchase Webhooks (Only for Paid orders)
        const isPaid = String(order.status?.slug || order.status?.name || '').toLowerCase() === 'paid' || 
                       String(order.payment_status || '').toLowerCase() === 'paid';
                       
        if ((payload.event === 'order.payment.updated' || payload.event === 'order.created') && isPaid) {
            
            // Check if already processed
            const isNew = await markForwarded(transactionId);
            if (!isNew) {
                console.log(`Duplicate paid webhook for order ${transactionId}, skipping`);
                return res.status(200).send('OK'); 
            }
            
            let countryIso = 'SA';
            if (order.shipping && order.shipping.address && order.shipping.address.country_code) {
                 countryIso = order.shipping.address.country_code.toUpperCase();
            }

            const e164Phone = normalizePhoneE164(order.customer?.mobile, countryIso) || normalizePhoneE164(order.customer?.mobile, 'SA');
            order.e164Phone = e164Phone;

            const cartId = order.cart_id ? String(order.cart_id) : null;

            // Rendezvous Check: did the client snippet arrive first?
            const tracking = await getTrackingForOrder(transactionId, cartId);
            
            if (tracking) {
                await sendToSgtm(transactionId, tracking, order);
                await deleteTrackingForOrder(transactionId, cartId);
                await deleteOrderDetails(transactionId);
            } else {
                console.log(`Webhook arrived before client snippet for order ${transactionId}. Storing order details for rendezvous.`);
                await saveOrderDetails(transactionId, cartId, order);
            }
        }
        
        return res.status(200).send('Webhook Processed');
    } catch (e) {
        console.error('Error processing webhook:', e.message);
        const { getRedis } = require('./redis');
        const redis = await getRedis();
        await redis.del(`forwarded:${transactionId}`);
        return res.status(500).send('Internal Server Error');
    }
});

// Quick debug endpoint
app.get('/check-redis/:orderId', async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const tracking = await getTrackingForOrder(orderId, null);
        const details = await getOrderDetails(orderId);
        res.json({ order_id: orderId, tracking: tracking || 'Not found', order_details: details || 'Not found' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/admin/tokens', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${ADMIN_SECRET}`) {
            return res.status(401).send('Unauthorized');
        }

        const { getRedis } = require('./redis');
        const redis = await getRedis();
        const keys = await redis.keys('merchant_token:*');
        if (!keys || keys.length === 0) {
            return res.json({ status: 'No tokens found in Redis yet.' });
        }
        const tokens = {};
        for (const key of keys) {
            tokens[key] = await redis.get(key);
        }
        res.json({ status: 'success', data: tokens });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/admin/logs', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${ADMIN_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }
    res.json({ count: webhookLogs.length, logs: webhookLogs });
});

app.get('/admin/db-status', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${ADMIN_SECRET}`) {
            return res.status(401).send('Unauthorized');
        }

        const { getRedis } = require('./redis');
        const redis = await getRedis();
        
        const forwardedKeys = await redis.keys('forwarded:*');
        const gclidKeys = await redis.keys('gclid:*');
        const orderDetailsKeys = await redis.keys('order_details:*');
        const cartToOrderKeys = await redis.keys('cart_to_order:*');

        const forwarded = forwardedKeys.map(k => k.replace('forwarded:', ''));
        const pendingClicks = {};
        for (const key of gclidKeys) {
            try {
                const val = await redis.get(key);
                pendingClicks[key] = val ? JSON.parse(val) : null;
            } catch (e) {
                pendingClicks[key] = await redis.get(key);
            }
        }

        const pendingOrders = {};
        for (const key of orderDetailsKeys) {
            const val = await redis.get(key);
            if (val) {
                try {
                    const parsed = JSON.parse(val);
                    pendingOrders[key] = {
                        order_id: parsed.id,
                        reference_id: parsed.reference_id,
                        total: parsed.amounts?.total?.amount,
                        currency: parsed.currency,
                        email: parsed.customer?.email,
                        timestamp: parsed.__timestamp
                    };
                } catch(e) {
                    pendingOrders[key] = 'parse_error';
                }
            }
        }

        res.json({
            status: 'success',
            summary: {
                processed_orders_count: forwarded.length,
                pending_clicks_count: gclidKeys.length,
                pending_orders_count: orderDetailsKeys.length,
                cart_to_order_mappings_count: cartToOrderKeys.length
            },
            processed_orders: forwarded,
            pending_clicks: pendingClicks,
            pending_orders: pendingOrders
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Scheduled sweep endpoint
app.get('/cron/sweep-unmatched', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${CRON_SECRET}`) {
            return res.status(401).send('Unauthorized');
        }

        const { getRedis } = require('./redis');
        const redis = await getRedis();
        
        const keys = await redis.keys('order_details:*');
        if (!keys || keys.length === 0) {
            return res.status(200).json({ status: 'success', swept: 0, message: 'No unmatched orders found.' });
        }

        let sweptCount = 0;
        const sweptIds = [];
        const now = Date.now();
        const ONE_DAY = 24 * 60 * 60 * 1000;

        for (const key of keys) {
            try {
                const txnId = key.replace('order_details:', '');
                
                const lockKey = `sweep_lock:${txnId}`;
                const acquired = await redis.set(lockKey, '1', { NX: true, EX: 60 });
                if (!acquired) continue;

                try {
                    const raw = await redis.get(key);
                    if (raw) {
                        const orderDetails = JSON.parse(raw);
                        
                        const timestamp = orderDetails.__timestamp || 0;
                        if (now - timestamp > ONE_DAY) {
                            await sendToSgtm(txnId, null, orderDetails);
                            await deleteOrderDetails(txnId);
                            sweptCount++;
                            sweptIds.push(txnId);
                        }
                    }
                } finally {
                    await redis.del(lockKey);
                }
            } catch (err) {
                console.error(`Error sweeping key ${key}:`, err.message);
            }
        }

        res.status(200).json({ status: 'success', swept: sweptCount, ids: sweptIds });
    } catch (e) {
        console.error('Sweep error:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    const SERVER_URL = process.env.RENDER_EXTERNAL_URL || 'https://salla-webhook-server-lvpy.onrender.com';
    setInterval(() => {
        try {
            fetch(SERVER_URL).then(res => console.log(`Self-ping successful: ${res.status}`));
        } catch (e) {
            console.error('Self-ping failed:', e.message);
        }
    }, 14 * 60 * 1000);
});
