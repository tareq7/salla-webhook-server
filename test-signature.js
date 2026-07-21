const crypto = require('crypto');

const SECRET = process.env.SALLA_WEBHOOK_SECRET;
if (!SECRET) throw new Error('SALLA_WEBHOOK_SECRET is required');
const ENDPOINT = 'http://localhost:3000/webhook';

const samplePayload = JSON.stringify({
  event: 'order.payment.updated',
  data: { id: 999999, reference_id: 12345, customer: { id: 1, email: 'test@example.com', mobile: '0501234567' } },
});

function sign(body) {
  return crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

async function send(label, body, signature) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Salla-Signature': signature },
    body,
  });
  console.log(`${label}: ${res.status} (expected ${label.includes('valid') ? 200 : 401})`);
}

async function runTests() {
  await send('valid signature', samplePayload, sign(samplePayload));
  const tampered = samplePayload.replace('999999', '000000');
  await send('tampered body, stale signature', tampered, sign(samplePayload)); // signature won't match new body
  await send('garbage signature', samplePayload, 'deadbeef'.repeat(8));
}

runTests();
