const { getRedis, closeRedis } = require('./redis');
const { scanKeys } = require('./gclidStore');

async function dump() {
    try {
        const redis = await getRedis();
        const patterns = ['gclid:*', 'cart_to_order:*', 'order_details:*', 'sent:*', 'processing:*', 'rejected_webhook:*'];
        const dump = {};
        for (const pattern of patterns) {
            const keys = await scanKeys(pattern);
            for (const key of keys) {
                const val = await redis.get(key);
                try {
                    dump[key] = JSON.parse(val);
                } catch {
                    dump[key] = val;
                }
            }
        }
        console.log(JSON.stringify(dump, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await closeRedis();
    }
}
dump();
