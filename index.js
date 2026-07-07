const express = require('express');
const crypto = require('crypto');
const { saveGclid, getGclid, markForwarded } = require('./gclidStore');
const { normalizePhoneE164, hashForEnhancedConversions } = require('./phoneNormalizer');

const app = express();
// Keep the raw body so we can verify the signature perfectly
app.use(express.raw({ type: '*/*' }));

// Array to store received data for easy debugging (acts as a temporary queue)
const webhookLogs = [];

// Salla Webhook Secret Key
const SALLA_SECRET = process.env.SALLA_WEBHOOK_SECRET || 'efb67e53e47def3544de8d71c3532617cab5d3f791f370acd3e986d38e579616';
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL || 'https://server-side-tagging-ihka65rwnq-uc.a.run.app/purchase';

// Endpoint for the Storefront Snippet to save the GCLID
app.post('/track-gclid', async (req, res) => {
    try {
        const body = JSON.parse(req.body.toString('utf8'));
        // Support either order_id (Thank You page approach) or checkout_id/cart_id
        const joinId = body.order_id || body.checkout_id || body.cart_id;
        const gclid = body.gclid;
        
        if (joinId && gclid) {
            await saveGclid(joinId, gclid);
            console.log(`Mapped joinId ${joinId} to GCLID ${gclid}`);
        }
    } catch (e) {
        console.error('Failed to parse track-gclid body:', e.message);
    }
    res.status(200).send('OK');
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
        order_id: transactionId
    });
    if (webhookLogs.length > 100) webhookLogs.shift(); 

    // Idempotency Check using Redis
    const isNew = await markForwarded(transactionId);
    if (!isNew) {
        console.log(`Duplicate webhook for order ${transactionId}, skipping`);
        return res.status(200).send('OK'); // 200 so Salla doesn't keep retrying
    }

    // We only want to send paid/created orders to Google
    if (payload.event === 'order.payment.updated' || payload.event === 'order.created') {
        
        // Find GCLID (Wait for join key approach, defaults to order.id from Thank You page snippet)
        const gclid = await getGclid(transactionId);
        if (!gclid) {
            console.warn(`No gclid for order ${transactionId} — organic conversion or capture miss`);
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
            gclid: gclid,
            hashed_email: hashForEnhancedConversions(order.customer?.email),
            hashed_phone: e164Phone ? hashForEnhancedConversions(e164Phone) : null,
            original_status: order.status?.name
        };

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
        const gclid = await getGclid(orderId);
        res.json({ order_id: orderId, gclid: gclid || 'Not found' });
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
