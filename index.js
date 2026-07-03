const express = require('express');

const app = express();
app.use(express.raw({ type: '*/*' }));

// Array to store received webhooks (acts as a temporary database/queue)
const webhookLogs = [];

app.post('/webhook', async (req, res) => {
    res.status(200).send('Webhook Received');
    
    const bodyString = req.body.toString('utf8');
    const timestamp = new Date().toISOString();
    
    // Save to our array
    webhookLogs.push({
        timestamp,
        headers: req.headers,
        body: bodyString ? JSON.parse(bodyString) : null
    });
    
    // Keep only the last 100 to prevent running out of memory
    if (webhookLogs.length > 100) {
        webhookLogs.shift(); 
    }

    // Optional: Forward to ngrok if it's set
    const NGROK_URL = process.env.LOCAL_NGROK_URL; 
    if (NGROK_URL) {
        try {
            await fetch(`${NGROK_URL}/webhook`, {
                method: 'POST',
                headers: {
                    'Content-Type': req.headers['content-type'] || 'application/json',
                    'Authorization': req.headers['authorization'] || '',
                    'X-Salla-Signature': req.headers['x-salla-signature'] || ''
                },
                body: req.body
            });
        } catch (error) {
            console.error('Failed to forward to laptop:', error.message);
        }
    }
});

// Endpoint to view saved webhooks in your browser!
app.get('/logs', (req, res) => {
    res.json({
        count: webhookLogs.length,
        logs: webhookLogs
    });
});

// Endpoint for your laptop script to fetch and clear the webhooks (Queue polling)
app.get('/poll', (req, res) => {
    const data = [...webhookLogs];
    webhookLogs.length = 0; // Clear the queue after fetching
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
