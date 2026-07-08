const express = require('express');
const crypto = require('crypto');
const { saveGclid, getGclid, markForwarded, saveMerchantToken } = require('./gclidStore');
const { normalizePhoneE164, hashForEnhancedConversions } = require('./phoneNormalizer');

const app = express();
// Keep the raw body so we can verify the signature perfectly
app.use(express.raw({ type: '*/*' }));

// Array to store received data for easy debugging (acts as a temporary queue)
const webhookLogs = [];

// Salla Webhook Secret Key
const SALLA_SECRET = process.env.SALLA_WEBHOOK_SECRET || 'efb67e53e47def3544de8d71c3532617cab5d3f791f370acd3e986d38e579616';
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL || 'https://server-side-tagging-ihka65rwnq-uc.a.run.app/purchase';

// Endpoint for the Storefront Snippet to save the tracking parameter
app.post('/track-gclid', async (req, res) => {
    try {
        if (!req.body || req.body.length === 0) {
            return res.status(400).send('Empty body');
        }

        const body = JSON.parse(req.body.toString('utf8'));
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
        console.log(`Mapped joinId ${cleanJoinId} to tracking ${cleanTrackingId} (${trackingType})`);
        
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
    
    // Pad lengths to prevent length-based early exit, though they should both be 64 char hex strings
    const sigBuffer = Buffer.alloc(64, signature, 'utf8');
    const hashBuffer = Buffer.alloc(64, hash, 'utf8');

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

    // Idempotency Check using Redis
    const isNew = await markForwarded(transactionId);
    if (!isNew) {
        console.log(`Duplicate webhook for order ${transactionId}, skipping`);
        return res.status(200).send('OK'); // 200 so Salla doesn't keep retrying
    }

    // Handle Salla OAuth token delivery
    if (payload.event === 'app.store.authorize') {
        const merchantId = payload.merchant;
        if (merchantId && payload.data) {
            const { access_token, refresh_token, expires, scope } = payload.data;
            await saveMerchantToken(merchantId, {
                access_token,
                refresh_token,
                expires_at: expires, // Absolute Unix timestamp
                scope
            });
            console.log(`Saved new authorization tokens for merchant ${merchantId} to Redis`);
        }
    }

    // We only want to send paid/created orders to Google
    if (payload.event === 'order.payment.updated' || payload.event === 'order.created') {
        
        // Find tracking info
        const tracking = await getGclid(transactionId);
        if (!tracking) {
            console.warn(`No tracking info for order ${transactionId} — organic conversion or capture miss`);
        }
        
        // GCC Phone Normalization (Assuming SA, can be dynamic if order country is known)
        // Check order.customer.country or similar if available, otherwise default to SA.
        let countryIso = 'SA';
        if (order.shipping && order.shipping.address && order.shipping.address.country_code) {
             countryIso = order.shipping.address.country_code.toUpperCase();
        }

        const e164Phone = normalizePhoneE164(order.customer?.mobile, countryIso) || normalizePhoneE164(order.customer?.mobile, 'SA');
        
        // Format for sGTM
        const sGtmPayload = {
            event_name: 'purchase',
            transaction_id: order.reference_id || transactionId,
            value: order.amounts?.total?.amount || 0,
            currency: order.currency || 'SAR',
            hashed_email: hashForEnhancedConversions(order.customer?.email),
            hashed_phone: e164Phone ? hashForEnhancedConversions(e164Phone) : null,
            original_status: order.status?.name
        };

        if (tracking) {
            sGtmPayload[tracking.type] = tracking.id;
        }

        console.log('Sending to Cloud Run:', sGtmPayload);

        if (CLOUD_RUN_URL) {
            try {
                await fetch(CLOUD_RUN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(sGtmPayload)
                });
                console.log('Successfully sent to Cloud Run');
            } catch (error) {
                console.error('Failed to send to Cloud Run:', error.message);
                // If it fails to send, we might want to unmark it as forwarded so it retries, 
                // but for now we swallow the error to return 200 to Salla.
            }
        } else {
            console.log('CLOUD_RUN_URL is not set. Payload was generated but not sent.');
        }
    }

    // Always respond 200 to Salla so it knows we processed it
    res.status(200).send('Webhook Processed');
});

// Quick debug endpoint to check if an order is in Redis
app.get('/check-redis/:orderId', async (req, res) => {
    try {
        const orderId = req.params.orderId;
        const tracking = await getGclid(orderId);
        res.json({ order_id: orderId, tracking: tracking || 'Not found' });
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
