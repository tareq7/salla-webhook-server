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

function loadIndex(storeOverrides = {}, dataManagerOverrides = {}) {
    process.env.SALLA_WEBHOOK_SECRET = 'test-webhook-secret';
    process.env.ADMIN_SECRET = 'test-admin-secret';
    process.env.CRON_SECRET = 'test-cron-secret';
    process.env.OBSERVATORY_SECRET = 'test-observatory-secret';
    delete process.env.GOOGLE_DATA_MANAGER_ENABLED;

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
        saveDataManagerReceipt: async () => {},
        getDataManagerReceipt: async () => null,
        getTrackingForOrder: async () => null,
        getOrderDetails: async () => null,
        scanKeys: async () => [],
        ...storeOverrides
    };
    const redisMock = { getRedis: async () => ({}), closeRedis: async () => {} };
    const dataManagerMock = {
        enabled: () => false,
        trackingFingerprint: value => value ? 'test-fingerprint' : null,
        deliver: async () => ({ enabled: false }),
        retrieveStatus: async () => ({ enabled: false }),
        ...dataManagerOverrides
    };

    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'express') return expressMock;
        if (request === 'express-rate-limit') return rateLimitMock;
        if (request === './gclidStore') return storeMock;
        if (request === './redis') return redisMock;
        if (request === './googleDataManager') return dataManagerMock;
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

test('sGTM delivery retries transient responses and reports the final attempt', async () => {
    const { deliver } = require('../sgtmDelivery');
    const statuses = [503, 429, 204];
    const delays = [];
    const result = await deliver('https://example.test/g/collect', {
        fetchFn: async () => {
            const status = statuses.shift();
            return {
                ok: status === 204,
                status,
                headers: { get: name => name === 'retry-after' && status === 429 ? '0.01' : null },
                text: async () => 'temporarily unavailable'
            };
        },
        sleep: async ms => delays.push(ms),
        random: () => 0.5,
        maxAttempts: 3,
        timeoutMs: 1000,
        baseDelayMs: 100,
        maxDelayMs: 1000
    });
    assert.equal(result.attempts, 3);
    assert.equal(result.status, 204);
    assert.deepEqual(delays, [100, 10]);
});

test('sGTM delivery does not retry permanent client errors', async () => {
    const { deliver } = require('../sgtmDelivery');
    let calls = 0;
    await assert.rejects(() => deliver('https://example.test/g/collect', {
        fetchFn: async () => {
            calls++;
            return { ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad request' };
        },
        sleep: async () => assert.fail('permanent errors must not sleep'),
        maxAttempts: 3,
        timeoutMs: 1000
    }), error => {
        assert.equal(error.code, 'SGTM_HTTP_ERROR');
        assert.equal(error.status, 400);
        assert.equal(error.attempts, 1);
        return true;
    });
    assert.equal(calls, 1);
});

test('sGTM delivery retries network failures without leaking the request URL', async () => {
    const { deliver } = require('../sgtmDelivery');
    let calls = 0;
    await assert.rejects(() => deliver('https://example.test/g/collect?ep.transaction_id=secret-order', {
        fetchFn: async () => {
            calls++;
            throw new TypeError('fetch failed');
        },
        sleep: async () => {},
        random: () => 0.5,
        maxAttempts: 2,
        timeoutMs: 1000,
        baseDelayMs: 1
    }), error => {
        assert.equal(error.code, 'SGTM_NETWORK_ERROR');
        assert.equal(error.attempts, 2);
        assert.doesNotMatch(error.message, /secret-order/);
        return true;
    });
    assert.equal(calls, 2);
});

test('Data Manager payload uses the website conversion action and contains no customer PII', () => {
    const { buildPayload } = require('../googleDataManager');
    const payload = buildPayload('1394366923', { id: 'valid-gclid', type: 'gclid' }, {
        reference_id: 274120304,
        amounts: { total: { amount: 297.37 } },
        currency: 'sar',
        __eventTimestamp: 'Sun Jul 26 2026 09:41:52 GMT+0300',
        customer: { email: 'must-not-leak@example.test', mobile: '+966500000000' }
    }, {
        enabled: true,
        customerId: '5365425266',
        conversionActionId: '6883871446'
    });
    assert.deepEqual(payload.destinations, [{
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '5365425266' },
        loginAccount: { accountType: 'GOOGLE_ADS', accountId: '5365425266' },
        productDestinationId: '6883871446'
    }]);
    assert.deepEqual(payload.events, [{
        adIdentifiers: { gclid: 'valid-gclid' },
        conversionValue: 297.37,
        currency: 'SAR',
        eventTimestamp: '2026-07-26T06:41:52.000Z',
        transactionId: '274120304',
        eventSource: 'WEB'
    }]);
    assert.doesNotMatch(JSON.stringify(payload), /must-not-leak|966500000000/);
});

test('Data Manager retries a transient response and returns the diagnostic request ID', async () => {
    const { deliver, resetTokenCache } = require('../googleDataManager');
    resetTokenCache();
    const statuses = [503, 200];
    const delays = [];
    const result = await deliver('123', { id: 'click-123', type: 'gclid' }, {
        reference_id: 456,
        amounts: { total: { amount: 12.5 } },
        currency: 'SAR'
    }, {
        config: {
            enabled: true, customerId: '5365425266', conversionActionId: '6883871446',
            timeoutMs: 1000, maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000
        },
        accessToken: 'test-access-token',
        fetchFn: async (_url, request) => {
            assert.equal(request.headers.Authorization, 'Bearer test-access-token');
            const status = statuses.shift();
            return {
                ok: status === 200, status,
                json: async () => status === 200 ? { requestId: 'request-abc' } : { error: { status: 'UNAVAILABLE' } }
            };
        },
        sleep: async ms => delays.push(ms),
        random: () => 0.5
    });
    assert.equal(result.requestId, 'request-abc');
    assert.equal(result.attempts, 2);
    assert.deepEqual(delays, [100]);
});

test('Data Manager status response preserves Google processing errors without event data', async () => {
    const { retrieveStatus } = require('../googleDataManager');
    const result = await retrieveStatus('request-abc', {
        config: { enabled: true, timeoutMs: 1000 },
        accessToken: 'test-access-token',
        fetchFn: async url => {
            assert.match(url, /requestStatus:retrieve\?requestId=request-abc$/);
            return {
                ok: true, status: 200,
                json: async () => ({ requestStatusPerDestination: [{
                    requestStatus: 'FAILED',
                    eventsIngestionStatus: { recordCount: '1' },
                    errorInfo: { errorCounts: [{ recordCount: '1', reason: 'PROCESSING_ERROR_REASON_INVALID_CLICK' }] }
                }] })
            };
        }
    });
    assert.deepEqual(result, {
        enabled: true,
        status: 'FAILED',
        destinations: [{
            requestStatus: 'FAILED', recordCount: '1',
            errors: [{ reason: 'PROCESSING_ERROR_REASON_INVALID_CLICK', recordCount: '1' }],
            warnings: []
        }]
    });
    assert.doesNotMatch(JSON.stringify(result), /request-abc|test-access-token/);
});

test('Data Manager treats a not-yet-visible request status as retryable', async () => {
    const { retrieveStatus } = require('../googleDataManager');
    await assert.rejects(() => retrieveStatus('request-propagating', {
        config: { enabled: true, timeoutMs: 1000 },
        accessToken: 'test-access-token',
        fetchFn: async () => ({
            ok: false, status: 404,
            json: async () => ({ error: { status: 'NOT_FOUND' } })
        })
    }), error => {
        assert.equal(error.code, 'DATA_MANAGER_STATUS_HTTP_ERROR');
        assert.equal(error.status, 404);
        assert.equal(error.retryable, true);
        return true;
    });
});

test('protected Data Manager status endpoint stores the terminal diagnostic', async () => {
    const saved = [];
    const { routes } = loadIndex({
        getDataManagerReceipt: async () => ({ requestId: 'request-abc', status: 'submitted', submittedAt: '2026-08-02T00:00:00.000Z' }),
        saveDataManagerReceipt: async (id, receipt) => saved.push({ id, receipt })
    }, {
        retrieveStatus: async () => ({
            enabled: true, status: 'SUCCESS',
            destinations: [{ requestStatus: 'SUCCESS', recordCount: '1', errors: [], warnings: [] }]
        })
    });
    const route = routes.find(value => value.method === 'GET' && value.path === '/admin/data-manager-status');
    const response = {
        statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; }
    };
    await route.handlers.at(-1)({ headers: { authorization: 'Bearer test-admin-secret' }, query: { transaction_id: '274120304' } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.delivery.status, 'SUCCESS');
    assert.equal(saved[0].id, '274120304');
    assert.equal(saved[0].receipt.destinations[0].recordCount, '1');
});

test('conversion is marked sent only after Data Manager accepts it', async () => {
    const calls = [];
    const { exported } = loadIndex({
        claimConversion: async () => 'owner',
        markConversionSent: async () => calls.push('marked'),
        saveDataManagerReceipt: async (_id, receipt) => calls.push(`receipt:${receipt.requestId}`),
        deleteTrackingForOrder: async () => {},
        deleteOrderDetails: async () => {}
    }, {
        enabled: () => true,
        deliver: async () => ({ requestId: 'dm-request-1', trackingFingerprint: 'fingerprint', attempts: 1, status: 200, durationMs: 10 })
    });
    const oldFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 204 });
    try {
        assert.equal(await exported.processConversion('123', null, { id: 'gclid', type: 'gclid' }, {
            reference_id: 456, amounts: { total: { amount: 5 } }, currency: 'SAR', customer: {}
        }), true);
        assert.deepEqual(calls, ['receipt:dm-request-1', 'marked']);
    } finally { global.fetch = oldFetch; }
});

test('Data Manager failure keeps the conversion retryable', async () => {
    const calls = [];
    const { exported } = loadIndex({
        claimConversion: async () => 'owner',
        releaseConversionClaim: async () => calls.push('released')
    }, {
        enabled: () => true,
        deliver: async () => { throw Object.assign(new Error('rejected'), { code: 'DATA_MANAGER_HTTP_ERROR', retryable: false }); }
    });
    const oldFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 204 });
    try {
        await assert.rejects(() => exported.processConversion('123', null, { id: 'gclid', type: 'gclid' }, {
            reference_id: 456, amounts: { total: { amount: 5 } }, currency: 'SAR', customer: {}
        }), /rejected/);
        assert.deepEqual(calls, ['released']);
    } finally { global.fetch = oldFetch; }
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
    const requestBody = JSON.parse(request.options.body);
    assert.match(requestBody.click_captured_at, /^\d{4}-\d{2}-\d{2}T/);
    delete requestBody.click_captured_at;
    assert.deepEqual(requestBody, {
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

    const oldFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 204 });
    try {
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
    } finally {
        global.fetch = oldFetch;
    }
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
