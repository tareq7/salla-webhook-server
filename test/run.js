'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Module = require('node:module');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function makeStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key),
        dump: () => Object.fromEntries(values)
    };
}

function loadIndex(storeOverrides = {}) {
    process.env.SALLA_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.ADMIN_SECRET = 'test-admin-secret';
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.OBSERVATORY_SECRET = 'test-observatory-secret';

    const routes = [];
    const middlewares = [];
    const app = {
        disable() {}, set() {},
        use(...args) { middlewares.push(args); },
        post(path, ...handlers) { routes.push({ method: 'POST', path, handlers }); },
        get(path, ...handlers) { routes.push({ method: 'GET', path, handlers }); },
        listen() { throw new Error('listen should not run during tests'); }
    };
    const expressMock = function () { return app; };
    expressMock.text = options => ({ parser: 'text', options });
    expressMock.raw = options => ({ parser: 'raw', options });
    expressMock.json = options => ({ parser: 'json', options });
    const rateLimitMock = () => (req, res, next) => next();
    const storeMock = {
        claimConversion: async () => null,
        releaseConversionClaim: async () => {},
        markConversionSent: async () => {},
        deleteTrackingForOrder: async () => {},
        deleteOrderDetails: async () => {},
        getTrackingForOrder: async () => null,
        getOrderDetails: async () => null,
        scanKeys: async () => [],
        ...storeOverrides
    };
    const redisMock = { getRedis: async () => ({}), closeRedis: async () => {} };

    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'express') return expressMock;
        if (request === 'express-rate-limit') return rateLimitMock;
        if (request === './gclidStore') return storeMock;
        if (request === './redis') return redisMock;
        return originalLoad.call(this, request, parent, isMain);
    };
    const file = require.resolve('../index.js');
    delete require.cache[file];
    try {
        return { exported: require(file), app, routes, middlewares, storeMock };
    } finally {
        Module._load = originalLoad;
        delete require.cache[file];
    }
}

test('identifier validation matches tracker contract', () => {
    const { exported } = loadIndex();
    assert.equal(exported.validIdentifier('abc.DEF_123-~', 256), true);
    assert.equal(exported.validIdentifier('', 256), false);
    assert.equal(exported.validIdentifier('contains space', 256), false);
    assert.equal(exported.validIdentifier('x'.repeat(257), 256), false);
});

test('phone normalization handles common Saudi formats', () => {
    const { exported } = loadIndex();
    assert.equal(exported.normalizePhone('050 123 4567'), '+966501234567');
    assert.equal(exported.normalizePhone('501234567'), '+966501234567');
    assert.equal(exported.normalizePhone('00966501234567'), '+966501234567');
    assert.equal(exported.normalizePhone('abc'), null);
});

test('reconciliation states preserve lifecycle meaning and matched precedence', () => {
    const { exported } = loadIndex();
    assert.deepEqual(exported.buildReconciliationStates(
        ['sent:123', 'sent:invalid:id'],
        ['gclid:order:123', 'gclid:order:456', 'gclid:order:999', 'gclid:order:111'],
        ['order_details:123', 'order_details:789', 'order_details:999'],
        ['rejected_webhook:123', 'rejected_webhook:111', 'rejected_webhook:222']
    ), {
        123: 'matched',
        456: 'webhook_pending',
        789: 'browser_pending',
        999: 'processing_pending',
        111: 'webhook_rejected',
        222: 'webhook_rejected'
    });
});

test('reconciliation endpoint exposes status only to the dedicated observer', async () => {
    const keys = {
        'sent:*': ['sent:123'],
        'gclid:order:*': ['gclid:order:456'],
        'order_details:*': ['order_details:789'],
        'rejected_webhook:*': ['rejected_webhook:999']
    };
    const { routes } = loadIndex({ scanKeys: async pattern => keys[pattern] || [] });
    const route = routes.find(value => value.method === 'GET' && value.path === '/internal/reconciliation');
    const createResponse = () => ({
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; }
    });
    for (const headers of [{}, { authorization: 'Bearer wrong-secret' }]) {
        const unauthorizedResponse = createResponse();
        await route.handlers.at(-1)({ headers }, unauthorizedResponse);
        assert.equal(unauthorizedResponse.statusCode, 401);
        assert.equal(unauthorizedResponse.body, 'Unauthorized');
    }
    const response = createResponse();
    await route.handlers.at(-1)({ headers: { authorization: 'Bearer test-observatory-secret' } }, response);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        status: 'success',
        states: {
            123: 'matched',
            456: 'webhook_pending',
            789: 'browser_pending',
            999: 'webhook_rejected'
        }
    });
});

test('conversion cleanup failure does not report a sent conversion as failed', async () => {
    const calls = [];
    const { exported } = loadIndex({
        claimConversion: async () => 'owner',
        markConversionSent: async () => calls.push('marked'),
        deleteTrackingForOrder: async () => { throw new Error('cleanup failed'); },
        deleteOrderDetails: async () => calls.push('details-deleted'),
        releaseConversionClaim: async () => calls.push('released')
    });
    const oldFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 204 });
    try {
        assert.equal(await exported.processConversion('123', null, { clientId: '1.2' }, {
            reference_id: 10,
            amounts: { total: { amount: 5 } },
            currency: 'SAR',
            customer: {}
        }), true);
        assert.deepEqual(calls, ['marked', 'details-deleted']);
    } finally {
        global.fetch = oldFetch;
    }
});

test('conversion failure releases the claim', async () => {
    const calls = [];
    const { exported } = loadIndex({
        claimConversion: async () => 'owner',
        releaseConversionClaim: async () => calls.push('released')
    });
    const oldFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 500 });
    try {
        await assert.rejects(() => exported.processConversion('123', null, null, {
            reference_id: 10,
            amounts: { total: { amount: 5 } },
            currency: 'SAR',
            customer: {}
        }), /sGTM returned 500/);
        assert.deepEqual(calls, ['released']);
    } finally {
        global.fetch = oldFetch;
    }
});


test('conversion claim atomically checks sent marker and acquires processing lock', async () => {
    let evalCall;
    const redis = {
        eval: async (script, options) => {
            evalCall = { script, options };
            return 1;
        }
    };
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === './redis.js') return { getRedis: async () => redis };
        return originalLoad.call(this, request, parent, isMain);
    };
    const file = require.resolve('../gclidStore.js');
    delete require.cache[file];
    try {
        const store = require(file);
        const owner = await store.claimConversion('123');
        assert.match(owner, /^[0-9a-f-]{36}$/i);
        assert.match(evalCall.script, /exists/);
        assert.match(evalCall.script, /'NX'/);
        assert.deepEqual(evalCall.options.keys, ['sent:123', 'processing:123']);
        assert.equal(evalCall.options.arguments[0], owner);
        assert.equal(evalCall.options.arguments[1], '60');
    } finally {
        Module._load = originalLoad;
        delete require.cache[file];
    }
});

test('tracker sends order-only text/plain payload and clears click after success', async () => {
    const localStorage = makeStorage();
    const sessionStorage = makeStorage();
    let tracker;
    let request;
    const context = {
        window: {
            location: { search: '?gclid=test-click-123', href: 'https://ssp-1.com/?gclid=test-click-123' },
            localStorage,
            sessionStorage,
            Salla: {
                onReady: cb => cb(),
                analytics: { registerTracker: value => { tracker = value; } }
            }
        },
        document: { cookie: '_ga=GA1.1.123456789.1700000000' },
        URLSearchParams,
        console: { log() {}, warn() {}, error() {} },
        setTimeout,
        fetch: async (url, options) => {
            request = { url, options };
            return { ok: true, status: 200 };
        },
        Promise
    };
    context.window.window = context.window;
    vm.runInNewContext(fs.readFileSync(require.resolve('../tracker.js'), 'utf8'), context);
    assert.ok(tracker);
    assert.ok(localStorage.getItem('pending_google_ads_click'));
    tracker.track('Cart Updated', { cart: { id: 'old-cart' } });
    assert.equal(request, undefined);
    tracker.track('Order Completed', { order: { id: 1671795666 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(request.url, 'https://track.ssp-1.com/track-gclid');
    assert.equal(request.options.headers['Content-Type'], 'text/plain;charset=UTF-8');
    assert.deepEqual(JSON.parse(request.options.body), {
        entity_type: 'order',
        entity_id: '1671795666',
        tracking_id: 'test-click-123',
        tracking_type: 'gclid',
        client_id: '123456789.1700000000'
    });
    assert.equal(localStorage.getItem('pending_google_ads_click'), null);
});

test('tracker preserves click after server failure', async () => {
    const click = JSON.stringify({ tracking_id: 'test-click-456', tracking_type: 'gclid', captured_at: Date.now() });
    const localStorage = makeStorage({ pending_google_ads_click: click });
    let tracker;
    const context = {
        window: {
            location: { search: '', href: 'https://ssp-1.com/thank-you' },
            localStorage,
            sessionStorage: makeStorage(),
            Salla: {
                onReady: cb => cb(),
                analytics: { registerTracker: value => { tracker = value; } }
            }
        },
        document: { cookie: '' }, URLSearchParams,
        console: { log() {}, warn() {}, error() {} }, setTimeout,
        fetch: async () => ({ ok: false, status: 500 }), Promise
    };
    context.window.window = context.window;
    vm.runInNewContext(fs.readFileSync(require.resolve('../tracker.js'), 'utf8'), context);
    tracker.track('Order Completed', { data: { id: 99 } });
    assert.equal(localStorage.getItem('pending_google_ads_click'), click);
});

test('reconciliation fallback matches by order_id, checkout_id, and reference_id', async () => {
    const trackingStore = new Map();
    const orderDetailsStore = new Map();
    const mappingsStore = new Map();

    const { exported } = loadIndex({
        getOrderDetails: async (orderId) => orderDetailsStore.get(orderId),
        getTrackingForOrder: async (orderId, cartId, referenceId) => {
            return trackingStore.get(orderId) || trackingStore.get(cartId) || trackingStore.get(referenceId) || null;
        },
        getOrderIdByCartId: async (cartId) => mappingsStore.get(`cart:${cartId}`),
        getOrderIdByReferenceId: async (refId) => mappingsStore.get(`ref:${refId}`),
        claimConversion: async () => 'owner_token',
        markConversionSent: async () => {}
    });

    orderDetailsStore.set('664467442', {
        id: '664467442',
        cart_id: '1851080500',
        reference_id: '273025367',
        amounts: { total: { amount: 10 } },
        currency: 'SAR'
    });
    mappingsStore.set('cart:1851080500', '664467442');
    mappingsStore.set('ref:273025367', '664467442');

    trackingStore.set('664467442', { id: 'gclid_order_id', type: 'gclid' });
    let matched = await exported.reconcile('664467442', '1851080500');
    assert.equal(matched, true);

    trackingStore.clear();
    trackingStore.set('1851080500', { id: 'gclid_cart_id', type: 'gclid' });
    matched = await exported.reconcile('664467442', '1851080500');
    assert.equal(matched, true);

    trackingStore.clear();
    trackingStore.set('273025367', { id: 'gclid_ref_id', type: 'gclid' });
    matched = await exported.reconcile('664467442', '1851080500');
    assert.equal(matched, true);
});

(async () => {

    let failures = 0;
    for (const item of tests) {
        try {
            await item.fn();
            console.log('ok -', item.name);
        } catch (error) {
            failures++;
            console.error('not ok -', item.name);
            console.error(error.stack || error);
        }
    }
    if (failures) process.exitCode = 1;
    else console.log(`\n${tests.length} tests passed`);
})();
