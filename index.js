const express = require('express');
const crypto = require('crypto');
const { saveGclid, getGclid, deleteGclid, saveOrderDetails, getOrderDetails, deleteOrderDetails, markForwarded, saveMerchantToken, getMerchantToken } = require('./gclidStore');

const app = express();

const SALLA_SECRET = process.env.SALLA_WEBHOOK_SECRET || 'your_salla_webhook_secret';
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL || '';

// We keep raw body for webhook signature verification
app.use(express.raw({ type: '*/*' }));
// Support text/plain for the storefront snippet bypassing CORS preflight
app.use(express.text({ type: 'text/plain' }));

// CORS headers so the storefront snippet can read response.ok
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// A simple in-memory log for debugging (not for production)
const webhookLogs = [];

// Helper function to hash email/phone for Google Enhanced Conversions
function hashForEnhancedConversions(value) {
    if (!value) return null;
    const cleanValue = String(value).trim().toLowerCase();
    return crypto.createHash('sha256').update(cleanValue).digest('hex');
}

// Basic E164 normalizer
function normalizePhoneE164(phoneStr, countryIso) {
    if (!phoneStr) return null;
    let digits = phoneStr.replace(/\D/g, '');
    if (countryIso === 'SA') {
        if (digits.startsWith('05')) {
            digits = '966' + digits.substring(1);
        } else if (digits.startsWith('5')) {
            digits = '966' + digits;
        }
    }
    return '+' + digits;
}

// Common function to send the final payload to sGTM/Cloud Run
async function sendToSgtm(orderId, tracking, orderDetails) {
    const sGtmPayload = {
        event_name: 'purchase',
        transaction_id: orderDetails.reference_id || orderId,
        value: orderDetails.amounts?.total?.amount || 0,
        currency: orderDetails.currency || 'SAR',
        hashed_email: hashForEnhancedConversions(orderDetails.customer?.email),
        hashed_phone: orderDetails.e164Phone ? hashForEnhancedConversions(orderDetails.e164Phone) : null,
        original_status: orderDetails.status?.name
    };

    if (tracking) {
        sGtmPayload[tracking.type] = tracking.id;
    }

    console.log('Sending to Cloud Run:', sGtmPayload);

    if (CLOUD_RUN_URL) {
        const response = await fetch(CLOUD_RUN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sGtmPayload)
        });
        if (!response.ok) {
            throw new Error(`Cloud Run returned ${response.status}`);
        }
        console.log('Successfully sent to Cloud Run');
    } else {
        console.log('CLOUD_RUN_URL is not set. Payload was generated but not sent.');
    }
}

// Endpoint for the Storefront Snippet to save the tracking parameter
app.post('/track-gclid', async (req, res) => {
    if (req.method === 'OPTIONS') return res.status(200).send();
    
    // Basic shared secret auth
    const auth = req.headers['x-tracker-auth'];
    if (auth !== 'storefront_super_secret_123') {
        return res.status(401).send('Unauthorized');
    }

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
            console.log(`Rendezvous match! Webhook was already here for order ${cleanJoinId}. Forwarding to sGTM.`);
            await sendToSgtm(cleanJoinId, { id: cleanTrackingId, type: trackingType }, orderDetails);
            
            // Clean up to save Redis space
            await deleteOrderDetails(cleanJoinId);
            await deleteGclid(cleanJoinId);
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

    // Check if already processed
    const isNew = await markForwarded(transactionId);
    if (!isNew) {
        console.log(`Duplicate webhook for order ${transactionId}, skipping`);
        return res.status(200).send('OK'); 
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
                console.log(`Rendezvous match! Client snippet was already here for order ${transactionId}. Forwarding to sGTM.`);
                await sendToSgtm(transactionId, tracking, order);
                
                // Clean up to save Redis space
                await deleteGclid(transactionId);
                await deleteOrderDetails(transactionId);
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
