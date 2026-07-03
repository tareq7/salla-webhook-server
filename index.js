const express = require('express');

const app = express();
// Keep the raw body so we can pass it along perfectly if needed
app.use(express.raw({ type: '*/*' }));

// This is the endpoint Salla will call
app.post('/webhook', async (req, res) => {
    // 1. Immediately acknowledge the webhook to satisfy Salla's 30s timeout
    res.status(200).send('Webhook Received');
    console.log('--- New Salla Webhook ---');
    console.log('Headers:', req.headers);

    const bodyString = req.body.toString('utf8');
    console.log('Body:', bodyString);

    // 2. (Optional) Forward the webhook to your laptop if it's online!
    const NGROK_URL = process.env.LOCAL_NGROK_URL; 
    if (NGROK_URL) {
        try {
            console.log(`Forwarding to ${NGROK_URL}/webhook...`);
            await fetch(`${NGROK_URL}/webhook`, {
                method: 'POST',
                headers: {
                    'Content-Type': req.headers['content-type'] || 'application/json',
                    'Authorization': req.headers['authorization'] || '',
                    'X-Salla-Signature': req.headers['x-salla-signature'] || ''
                },
                body: req.body // Send the exact raw bytes
            });
            console.log('Forwarded successfully to laptop.');
        } catch (error) {
            console.error('Failed to forward to laptop (is ngrok running?):', error.message);
        }
    }
});

// A simple GET endpoint so you can verify the server is running in your browser
app.get('/', (req, res) => {
    res.send('Salla Webhook Server is running!');
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
