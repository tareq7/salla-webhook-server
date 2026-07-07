const express = require('express');

const app = express();
app.use(express.raw({ type: '*/*' }));
app.use(express.json()); // for the gclid tracking endpoint

// Arrays to store received data (acts as a temporary database/queue)
const webhookLogs = [];
const gclidMappings = {};

// 1. Endpoint for the Storefront Snippet to save the GCLID
app.post('/track-gclid', (req, res) => {
    const { cart_id, gclid } = req.body;
    if (cart_id && gclid) {
        gclidMappings[cart_id] = gclid;
        console.log(`Mapped Cart ${cart_id} to GCLID ${gclid}`);
    }
    res.status(200).send('OK');
});

app.post('/webhook', async (req, res) => {
    res.status(200).send('Webhook Received');
    
    // We only want the raw body for signature verification later
    const bodyString = req.body.toString('utf8');
    const timestamp = new Date().toISOString();
    
    webhookLogs.push({
        timestamp,
        headers: req.headers,
        body_raw: bodyString, // Save raw string so Python can verify signature exactly
        body: bodyString ? JSON.parse(bodyString) : null
    });
    
    if (webhookLogs.length > 100) webhookLogs.shift(); 
});

app.get('/logs', (req, res) => {
    res.json({ count: webhookLogs.length, logs: webhookLogs, mappings: gclidMappings });
});

// Endpoint for your laptop Python script to fetch the queue
app.get('/poll', (req, res) => {
    const data = {
        webhooks: [...webhookLogs],
        gclid_mappings: { ...gclidMappings }
    };
    webhookLogs.length = 0; // Clear the queue
    // We can clear old mappings if they grow too large, but for now it's fine.
    res.json(data);
});

app.get('/', (req, res) => {
    res.send('Salla Webhook Server is running! Visit /logs to see saved webhooks.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    
    // Self-ping to keep Render free tier awake
    const SERVER_URL = 'https://salla-webhook-server-lvpy.onrender.com';
    setInterval(() => {
        try {
            fetch(SERVER_URL).then(res => console.log(`Self-ping successful: ${res.status}`));
        } catch (e) {
            console.error('Self-ping failed:', e.message);
        }
    }, 14 * 60 * 1000); // 14 minutes
});
