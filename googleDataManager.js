'use strict';

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';
const STATUS_URL = 'https://datamanager.googleapis.com/v1/requestStatus:retrieve';
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
let cachedToken = null;

function integerEnv(name, fallback, min, max, env = process.env) {
    const value = Number.parseInt(env[name], 10);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function enabled(env = process.env) {
    return String(env.GOOGLE_DATA_MANAGER_ENABLED || '').toLowerCase() === 'true';
}

function config(env = process.env) {
    if (!enabled(env)) return { enabled: false };
    const required = [
        'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN',
        'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_CONVERSION_ACTION_ID'
    ];
    const missing = required.filter(name => !env[name]);
    if (missing.length) throw new DataManagerError(`Missing Data Manager configuration: ${missing.join(', ')}`, {
        code: 'DATA_MANAGER_CONFIG_ERROR', retryable: false
    });
    if (!/^\d+$/.test(env.GOOGLE_ADS_CUSTOMER_ID) || !/^\d+$/.test(env.GOOGLE_ADS_CONVERSION_ACTION_ID)) {
        throw new DataManagerError('Google Ads customer and conversion action IDs must be numeric', {
            code: 'DATA_MANAGER_CONFIG_ERROR', retryable: false
        });
    }
    return {
        enabled: true,
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
        customerId: env.GOOGLE_ADS_CUSTOMER_ID,
        conversionActionId: env.GOOGLE_ADS_CONVERSION_ACTION_ID,
        timeoutMs: integerEnv('GOOGLE_DATA_MANAGER_TIMEOUT_MS', 8000, 1000, 20000, env),
        maxAttempts: integerEnv('GOOGLE_DATA_MANAGER_MAX_ATTEMPTS', 3, 1, 5, env),
        baseDelayMs: integerEnv('GOOGLE_DATA_MANAGER_RETRY_BASE_MS', 400, 50, 3000, env),
        maxDelayMs: integerEnv('GOOGLE_DATA_MANAGER_RETRY_MAX_MS', 3000, 100, 15000, env)
    };
}

function trackingFingerprint(trackingId) {
    return trackingId ? crypto.createHash('sha256').update(String(trackingId)).digest('hex').slice(0, 16) : null;
}

function eventTimestamp(order, now = new Date()) {
    const candidates = [order?.__eventTimestamp, order?.created_at, order?.date?.date];
    for (const candidate of candidates) {
        if (!candidate) continue;
        let normalized = String(candidate).trim();
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)) {
            normalized = normalized.replace(' ', 'T').replace(/\.\d+$/, '') + '+03:00';
        }
        const parsed = new Date(normalized);
        if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
    }
    return now.toISOString();
}

function buildPayload(orderId, tracking, order, deliveryConfig = config(), now = new Date()) {
    if (!deliveryConfig.enabled) return null;
    if (!tracking?.id || !['gclid', 'gbraid', 'wbraid'].includes(tracking.type)) {
        throw new DataManagerError('A supported Google Ads click identifier is required', {
            code: 'DATA_MANAGER_IDENTIFIER_REQUIRED', retryable: false
        });
    }
    const transactionId = String(order?.reference_id || orderId);
    const value = Number.parseFloat(order?.amounts?.total?.amount);
    if (!Number.isFinite(value)) {
        throw new DataManagerError('A finite conversion value is required', {
            code: 'DATA_MANAGER_VALUE_INVALID', retryable: false
        });
    }
    return {
        destinations: [{
            operatingAccount: { accountType: 'GOOGLE_ADS', accountId: deliveryConfig.customerId },
            loginAccount: { accountType: 'GOOGLE_ADS', accountId: deliveryConfig.customerId },
            productDestinationId: deliveryConfig.conversionActionId
        }],
        events: [{
            adIdentifiers: { [tracking.type]: tracking.id },
            conversionValue: value,
            currency: String(order?.currency || 'SAR').toUpperCase(),
            eventTimestamp: eventTimestamp(order, now),
            transactionId,
            eventSource: 'WEB'
        }],
        validateOnly: false
    };
}

class DataManagerError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'DataManagerError';
        Object.assign(this, details);
    }
}

async function responseJson(response) {
    try { return await response.json(); } catch { return {}; }
}

function errorReason(body) {
    const details = Array.isArray(body?.error?.details) ? body.error.details : [];
    for (const detail of details) {
        if (detail?.reason) return String(detail.reason);
        const violation = Array.isArray(detail?.fieldViolations) ? detail.fieldViolations[0] : null;
        if (violation?.reason) return String(violation.reason);
    }
    return body?.error?.status ? String(body.error.status) : null;
}

function countReasons(value) {
    return (Array.isArray(value) ? value : []).map(item => ({
        reason: String(item?.reason || 'UNSPECIFIED'),
        recordCount: String(item?.recordCount || '0')
    }));
}

function summarizeStatus(body) {
    const destinations = (Array.isArray(body?.requestStatusPerDestination) ? body.requestStatusPerDestination : []).map(item => ({
        requestStatus: String(item?.requestStatus || 'REQUEST_STATUS_UNKNOWN'),
        recordCount: String(item?.eventsIngestionStatus?.recordCount || '0'),
        errors: countReasons(item?.errorInfo?.errorCounts),
        warnings: countReasons(item?.warningInfo?.warningCounts)
    }));
    const statuses = new Set(destinations.map(item => item.requestStatus));
    return {
        status: destinations.length === 0
            ? 'REQUEST_STATUS_UNKNOWN'
            : statuses.size === 1
                ? destinations[0].requestStatus
                : 'MIXED',
        destinations
    };
}

async function fetchWithTimeout(fetchFn, url, init, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchFn(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
}

async function accessToken(deliveryConfig, options = {}) {
    const now = options.nowMs ? options.nowMs() : Date.now();
    if (!options.disableTokenCache && cachedToken && cachedToken.expiresAt > now + 60000) return cachedToken.value;
    const fetchFn = options.fetchFn || global.fetch;
    let response;
    try {
        response = await fetchWithTimeout(fetchFn, TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: deliveryConfig.clientId,
                client_secret: deliveryConfig.clientSecret,
                refresh_token: deliveryConfig.refreshToken
            })
        }, deliveryConfig.timeoutMs);
    } catch (error) {
        throw new DataManagerError(error?.name === 'AbortError' ? 'Google OAuth token request timed out' : 'Google OAuth token request failed', {
            code: error?.name === 'AbortError' ? 'DATA_MANAGER_TOKEN_TIMEOUT' : 'DATA_MANAGER_TOKEN_NETWORK_ERROR',
            retryable: true, cause: error
        });
    }
    const body = await responseJson(response);
    if (!response.ok || !body.access_token) {
        throw new DataManagerError('Google OAuth token request was rejected', {
            code: 'DATA_MANAGER_TOKEN_REJECTED', status: response.status,
            reason: body.error ? String(body.error) : null, retryable: response.status >= 500
        });
    }
    if (!options.disableTokenCache) cachedToken = {
        value: body.access_token,
        expiresAt: now + Math.max(60, Number(body.expires_in) || 3600) * 1000
    };
    return body.access_token;
}

async function deliver(orderId, tracking, order, options = {}) {
    const deliveryConfig = options.config || config();
    if (!deliveryConfig.enabled) return { enabled: false };
    const payload = buildPayload(orderId, tracking, order, deliveryConfig, options.now || new Date());
    const fetchFn = options.fetchFn || global.fetch;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const random = options.random || Math.random;
    const token = options.accessToken || await accessToken(deliveryConfig, options);
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= deliveryConfig.maxAttempts; attempt++) {
        let response;
        try {
            response = await fetchWithTimeout(fetchFn, INGEST_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }, deliveryConfig.timeoutMs);
        } catch (error) {
            if (attempt === deliveryConfig.maxAttempts) {
                throw new DataManagerError(error?.name === 'AbortError' ? 'Data Manager request timed out' : 'Data Manager network request failed', {
                    code: error?.name === 'AbortError' ? 'DATA_MANAGER_TIMEOUT' : 'DATA_MANAGER_NETWORK_ERROR',
                    attempts: attempt, retryable: true, cause: error
                });
            }
            const delay = deliveryConfig.baseDelayMs * (2 ** (attempt - 1)) * (0.75 + random() * 0.5);
            await sleep(Math.min(deliveryConfig.maxDelayMs, delay));
            continue;
        }
        const body = await responseJson(response);
        if (response.ok && body.requestId) {
            return {
                enabled: true, requestId: String(body.requestId), attempts: attempt,
                status: response.status, durationMs: Date.now() - startedAt,
                trackingFingerprint: trackingFingerprint(tracking.id)
            };
        }
        const retryable = RETRYABLE_STATUSES.has(response.status) || response.status >= 500;
        if (!retryable || attempt === deliveryConfig.maxAttempts) {
            throw new DataManagerError(response.ok ? 'Data Manager response omitted requestId' : 'Data Manager request was rejected', {
                code: response.ok ? 'DATA_MANAGER_RESPONSE_INVALID' : 'DATA_MANAGER_HTTP_ERROR',
                status: response.status, reason: errorReason(body), attempts: attempt, retryable
            });
        }
        const delay = deliveryConfig.baseDelayMs * (2 ** (attempt - 1)) * (0.75 + random() * 0.5);
        await sleep(Math.min(deliveryConfig.maxDelayMs, delay));
    }
    throw new DataManagerError('Data Manager delivery exhausted', { code: 'DATA_MANAGER_EXHAUSTED', retryable: true });
}

async function retrieveStatus(requestId, options = {}) {
    const deliveryConfig = options.config || config();
    if (!deliveryConfig.enabled) return { enabled: false };
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 512) {
        throw new DataManagerError('A valid Data Manager request ID is required', {
            code: 'DATA_MANAGER_REQUEST_ID_INVALID', retryable: false
        });
    }
    const fetchFn = options.fetchFn || global.fetch;
    const token = options.accessToken || await accessToken(deliveryConfig, options);
    let response;
    try {
        const url = `${STATUS_URL}?${new URLSearchParams({ requestId })}`;
        response = await fetchWithTimeout(fetchFn, url, {
            method: 'GET', headers: { Authorization: `Bearer ${token}` }
        }, deliveryConfig.timeoutMs);
    } catch (error) {
        throw new DataManagerError(error?.name === 'AbortError' ? 'Data Manager status request timed out' : 'Data Manager status request failed', {
            code: error?.name === 'AbortError' ? 'DATA_MANAGER_STATUS_TIMEOUT' : 'DATA_MANAGER_STATUS_NETWORK_ERROR',
            retryable: true, cause: error
        });
    }
    const body = await responseJson(response);
    if (!response.ok) {
        throw new DataManagerError('Data Manager status request was rejected', {
            code: 'DATA_MANAGER_STATUS_HTTP_ERROR', status: response.status,
            reason: errorReason(body), retryable: response.status === 404 || RETRYABLE_STATUSES.has(response.status) || response.status >= 500
        });
    }
    return { enabled: true, ...summarizeStatus(body) };
}

function resetTokenCache() { cachedToken = null; }

module.exports = {
    TOKEN_URL, INGEST_URL, STATUS_URL, DataManagerError, enabled, config, eventTimestamp,
    buildPayload, trackingFingerprint, summarizeStatus, accessToken, deliver, retrieveStatus, resetTokenCache
};
