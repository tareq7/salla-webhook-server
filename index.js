const express = require('express');
const crypto = require('crypto');
const { saveGclid, getGclid, deleteGclid, saveOrderDetails, getOrderDetails, deleteOrderDetails, markForwarded, saveMerchantToken, getMerchantToken } = require('./gclidStore');

const app = express();

const SALLA_SECRET = process.env.SALLA_WEBHOOK_SECRET || 'your_salla_webhook_secret';
const SGTM_URL = process.env.SGTM_URL || 'https://server-side-tagging-ihka65rwnq-uc.a.run.app';
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || 'G-KBLW70T89R';
const SALLA_CLIENT_ID = process.env.SALLA_CLIENT_ID || '';
const SALLA_CLIENT_SECRET = process.env.SALLA_CLIENT_SECRET || '';

// Support text/plain for the storefront snippet bypassing CORS preflight
app.use('/track-gclid', express.text({ type: 'text/plain' }));

// We keep raw body for webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));

// CORS headers so the storefront snippet can read response.ok and bypass preflight
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type'); // Removed X-Tracker-Auth to keep requests 'simple'
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
    
    // Strip international 00 prefix
    if (digits.startsWith('00')) {
        digits = digits.substring(2);
    }
    
    if (countryIso === 'SA') {
        if (digits.startsWith('05')) {
            digits = '966' + digits.substring(1);
        } else if (digits.startsWith('5') && digits.length === 9) {
            digits = '966' + digits;
        }
    }
    return '+' + digits;
}

// Send purchase event to sGTM via GTag /g/collect wire format
async function sendToSgtm(orderId, tracking, orderDetails) {
    const txnId = orderDetails.reference_id || String(orderId);
    const value = parseFloat(orderDetails.amounts?.total?.amount) || 0;
    const currency = orderDetails.currency || 'SAR';

    const params = new URLSearchParams({
        v: '2',
        tid: GA4_MEASUREMENT_ID,
        cid: `server.${orderId}`,
        en: 'purchase',
        'ep.transaction_id': txnId,
        'ep.currency': currency,
        'epn.value': String(value),
    });

    // Add click attribution parameter
    if (tracking?.id) params.set(`ep.${tracking.type}`, tracking.id);

    // Enhanced Conversions: user data as event parameters
    // sGTM Event Data variables read these via their keyPath
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


// Endpoint for the Storefront Snippet to save the tracking parameter
app.post('/track-gclid', async (req, res) => {
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

        // Basic shared secret auth inside the payload (avoids CORS preflight)
        if (body.auth !== 'storefront_super_secret_123') {
            return res.status(401).send('Unauthorized');
        }

        const joinId = body.order_id || body.checkout_id || body.cart_id;
        const trackingId = body.tracking_id || body.gclid;
        const trackingType = body.tracking_type || 'gclid';
        
        // Input validation to prevent Redis exhaustion / garbage data
        if (!joinId || !trackingId) {
            return res.status(400).send('Missing joinId or trackingId');
        }
        
        const cleanJoinId = String(joinId).slice(0, 50);
        const cleanTrackingId = String(trackingId).slice(0, 200);
        
        if (!['gclid', 'wbraid', 'gbraid'].includes(trackingType)) {
            return res.status(400).send('Invalid tracking type');
        }

        await saveGclid(cleanJoinId, cleanTrackingId, trackingType);
        console.log(`Saved tracking info for order ${cleanJoinId} (${trackingType})`);
        
        // Rendezvous Check: Did the Salla webhook arrive before this tracking ping?
        const orderDetails = await getOrderDetails(cleanJoinId);
        if (orderDetails) {
            await sendToSgtm(cleanJoinId, { id: cleanTrackingId, type: trackingType }, orderDetails);
            
            // SWALLOW CLEANUP ERRORS to prevent 500s and duplicate sGTM fires
            try {
                await deleteOrderDetails(cleanJoinId);
                await deleteGclid(cleanJoinId);
            } catch (cleanupErr) {
                console.error("Rendezvous cleanup failed (conversion was already sent):", cleanupErr);
            }
        } else {
            console.log(`Tracking info received before webhook for order ${cleanJoinId}. Storing for rendezvous.`);
        }

        return res.status(200).send('OK');

    } catch (e) {
        console.error('Error in /track-gclid:', e.message);
        // Distinguish between JSON parse errors (400) and Redis/save errors (500)
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

    // Cryptographic Signature Verification using timingSafeEqual
    const hash = crypto.createHmac('sha256', SALLA_SECRET).update(bodyRaw).digest('hex');
    
    // Fixed: Buffer.from preserves length to make the length-mismatch check meaningful
    const sigBuffer = Buffer.from(signature, 'utf8');
    const hashBuffer = Buffer.from(hash, 'utf8');

    // Check length BEFORE timingSafeEqual to prevent TypeError crash
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

    // Log it for manual review
    webhookLogs.push({
        timestamp: new Date().toISOString(),
        event: payload.event,
        order_id: transactionId,
        source_details: order.source_details || null
    });
    if (webhookLogs.length > 100) webhookLogs.shift(); 

    // Add logging for source details to test the gclid theory
    if (payload.event === 'order.created' || payload.event === 'order.payment.updated') {
        console.log(`\n--- Order Webhook Received: ${payload.event} ---`);
        console.log(`Order ID: ${transactionId}`);
        if (order.source_details) {
            console.log(`Source Details:`, JSON.stringify(order.source_details, null, 2));
        } else {
            console.log('No source_details in payload.');
        }
        console.log('-------------------------------------------\n');
    }

    try {
        // Handle Salla OAuth token delivery synchronously
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

        // Process Purchase Webhooks via Rendezvous (Only for Paid orders)
        const isPaid = String(order.status?.slug || order.status?.name || '').toLowerCase() === 'paid' || 
                       String(order.payment_status || '').toLowerCase() === 'paid';
                       
        if ((payload.event === 'order.payment.updated' || payload.event === 'order.created') && isPaid) {
            
            // Check if already processed (Lock only on Paid orders)
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
            
            // Attach e164Phone for the sendToSgtm helper
            order.e164Phone = e164Phone;

            // Rendezvous Check: did the client snippet arrive first?
            const tracking = await getGclid(transactionId);
            
            if (tracking) {
                await sendToSgtm(transactionId, tracking, order);
                
                // SWALLOW CLEANUP ERRORS to prevent 500s and duplicate sGTM fires
                try {
                    await deleteGclid(transactionId);
                    await deleteOrderDetails(transactionId);
                } catch (cleanupErr) {
                    console.error("Rendezvous cleanup failed (conversion was already sent):", cleanupErr);
                }
            } else {
                console.log(`Webhook arrived before client snippet for order ${transactionId}. Storing order details for rendezvous.`);
                await saveOrderDetails(transactionId, order);
            }
        }
        
        return res.status(200).send('Webhook Processed');
    } catch (e) {
        console.error('Error processing webhook:', e.message);
        // If an error occurs (like Cloud Run failing), we must clear the idempotency lock
        // so Salla's next retry will be processed.
        const { getRedis } = require('./redis');
        const redis = await getRedis();
        await redis.del(`forwarded:${transactionId}`);
        
        return res.status(500).send('Internal Server Error');
    }
});

// Quick debug endpoint to check if an order is in Redis
app.get('/check-redis/:orderId', async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const tracking = await getGclid(orderId);
        const details = await getOrderDetails(orderId);
        res.json({ order_id: orderId, tracking: tracking || 'Not found', order_details: details || 'Not found' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/ai-token-fetch', async (req, res) => {
    try {
        const { getRedis } = require('./redis');
        const redis = await getRedis();
        const keys = await redis.keys('merchant_token:*');
        if (!keys || keys.length === 0) {
            return res.json({ status: 'No tokens found in Redis yet. Waiting for Salla webhook...' });
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

app.get('/logs', (req, res) => {
    res.json({ count: webhookLogs.length, logs: webhookLogs });
});

// A scheduled sweep that forwards stale unmatched order_details entries
// You should call this endpoint periodically (e.g., daily via a Cron job)
app.get('/cron/sweep-unmatched', async (req, res) => {
    try {
        const { getRedis } = require('./redis');
        const redis = await getRedis();
        
        // Find all order_details keys
        const keys = await redis.keys('order_details:*');
        if (!keys || keys.length === 0) {
            return res.status(200).json({ status: 'success', swept: 0, message: 'No unmatched orders found.' });
        }

        let sweptCount = 0;
        const sweptIds = [];

        for (const key of keys) {
            try {
                const txnId = key.replace('order_details:', '');
                const raw = await redis.get(key);
                if (raw) {
                    const orderDetails = JSON.parse(raw);
                    // Send to sGTM without tracking info (so we still get Enhanced Conversions signal)
                    await sendToSgtm(txnId, null, orderDetails);
                    // Clean up after successful send
                    await deleteOrderDetails(txnId);
                    sweptCount++;
                    sweptIds.push(txnId);
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
