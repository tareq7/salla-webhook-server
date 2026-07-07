const express = require('express');
const crypto = require('crypto');

const app = express();
// Keep the raw body so we can verify the signature perfectly
app.use(express.raw({ type: '*/*' }));

// Array to store received data (acts as a temporary database/queue)
const webhookLogs = [];
const gclidMappings = {};

// Salla Webhook Secret Key
const SALLA_SECRET = 'efb67e53e47def3544de8d71c3532617cab5d3f791f370acd3e986d38e579616';
const CLOUD_RUN_URL = process.env.CLOUD_RUN_URL || 'https://server-side-tagging-ihka65rwnq-uc.a.run.app/purchase';

// Hashing helper for Google Ads
function hashData(data) {
    if (!data) return null;
    const cleanData = data.toString().trim().toLowerCase();
    return crypto.createHash('sha256').update(cleanData).digest('hex');
}

// 1. Endpoint for the Storefront Snippet to save the GCLID
app.post('/track-gclid', (req, res) => {
    try {
        const body = JSON.parse(req.body.toString('utf8'));
        const { cart_id, gclid } = body;
        if (cart_id && gclid) {
            gclidMappings[cart_id] = gclid;
            console.log(`Mapped Cart ${cart_id} to GCLID ${gclid}`);
        }
    } catch (e) {
        console.error('Failed to parse track-gclid body:', e.message);
    }
    res.status(200).send('OK');
});

// 2. Webhook Receiver from Salla
app.post('/webhook', async (req, res) => {
    // Always respond 200 immediately to Salla
    res.status(200).send('Webhook Received');
    
    const signature = req.headers['x-salla-signature'];
    const bodyRaw = req.body;
    
    // Cryptographic Signature Verification
    const hash = crypto.createHmac('sha256', SALLA_SECRET).update(bodyRaw).digest('hex');
    if (hash !== signature) {
        console.error('Signature verification failed! Dropping request.');
        return;
    }
    
    const bodyString = bodyRaw.toString('utf8');
    const payload = bodyString ? JSON.parse(bodyString) : null;
    
    if (!payload || !payload.data) return;

    // Log it for manual review
    webhookLogs.push({
        timestamp: new Date().toISOString(),
        event: payload.event,
        order_id: payload.data.id
    });
    if (webhookLogs.length > 100) webhookLogs.shift(); 

    // We only want to send paid orders to Google
    if (payload.event === 'order.payment.updated' || payload.event === 'order.created') {
        const order = payload.data;
        
        // Find GCLID (try cart_id first)
        const gclid = gclidMappings[order.cart_id] || null;
        
        // Format for sGTM
        const sGtmPayload = {
            event_name: 'purchase',
            transaction_id: order.reference_id || order.id,
            value: order.amounts?.total?.amount || 0,
            currency: order.currency || 'SAR',
            gclid: gclid,
            hashed_email: hashData(order.customer?.email),
            hashed_phone: hashData(order.customer?.mobile),
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
            }
        } else {
            console.log('CLOUD_RUN_URL is not set. Payload was generated but not sent.');
        }
    }
});

app.get('/logs', (req, res) => {
    res.json({ count: webhookLogs.length, logs: webhookLogs, mappings: gclidMappings });
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
