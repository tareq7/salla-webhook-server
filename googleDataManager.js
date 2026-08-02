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
    if (String(env.GOOGLE_ADS_CUSTOMER_DATA_CONSENT_GRANTED || '').toLowerCase() !== 'true') {
        throw new DataManagerError('Explicit customer data consent must be configured before Data Manager delivery', {
            code: 'DATA_MANAGER_CONSENT_CONFIG_ERROR', retryable: false
        });
    }
    return {
        enabled: true,
        clientId: env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
        customerId: env.GOOGLE_ADS_CUSTOMER_ID,
        conversionActionId: env.GOOGLE_ADS_CONVERSION_ACTION_ID,
        customerDataConsentGranted: true,
        timeoutMs: integerEnv('GOOGLE_DATA_MANAGER_TIMEOUT_MS', 8000, 1000, 20000, env),
        maxAttempts: integerEnv('GOOGLE_DATA_MANAGER_MAX_ATTEMPTS', 3, 1, 5, env),
        baseDelayMs: integerEnv('GOOGLE_DATA_MANAGER_RETRY_BASE_MS', 400, 50, 3000, env),
        maxDelayMs: integerEnv('GOOGLE_DATA_MANAGER_RETRY_MAX_MS', 3000, 100, 15000, env)
    };
}

function trackingFingerprint(trackingId) {
    return trackingId ? crypto.createHash('sha256').update(String(trackingId)).digest('hex').slice(0, 16) : null;
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeEmail(value) {
    if (value === null || value === undefined) return null;
    const email = String(value).toLowerCase().replace(/\s+/g, '');
    const separator = email.lastIndexOf('@');
    if (separator < 1 || separator === email.length - 1 || email.indexOf('@') !== separator) return null;
    let local = email.slice(0, separator);
    const domain = email.slice(separator + 1);
    if (!domain.includes('.') || /[^a-z0-9.!#$%&'*+/=?^_`{|}~@-]/i.test(email)) return null;
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
        local = local.split('+', 1)[0].replace(/\./g, '');
    }
    return local ? `${local}@${domain}` : null;
}

function normalizePhoneNumber(value, dialCode) {
    if (value === null || value === undefined || value === '') return null;
    const raw = String(value).trim();
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    const countryDialCode = String(dialCode || '').replace(/\D/g, '');
    if (countryDialCode && !digits.startsWith(countryDialCode)) {
        if (digits.startsWith('0')) digits = `${countryDialCode}${digits.slice(1)}`;
        else if (!raw.startsWith('+')) digits = `${countryDialCode}${digits}`;
    } else if (!countryDialCode) {
        if (digits.startsWith('05') && digits.length === 10) digits = `966${digits.slice(1)}`;
        else if (digits.startsWith('5') && digits.length === 9) digits = `966${digits}`;
    }
    return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

function normalizeName(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).normalize('NFKC').toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, ' ').trim();
    return normalized || null;
}

function firstValue(values) {
    return values.find(value => value !== null && value !== undefined && String(value).trim()) ?? null;
}

function nameParts(order) {
    const customer = order?.customer || {};
    let givenName = normalizeName(customer.first_name);
    let familyName = normalizeName(customer.last_name);
    if (givenName && familyName) return { givenName, familyName };
    const fullName = normalizeName(customer.full_name);
    const parts = fullName?.split(' ').filter(Boolean) || [];
    if (!givenName) givenName = parts[0] || null;
    if (!familyName) familyName = parts.length > 1 ? parts.at(-1) : null;
    return { givenName, familyName };
}

function addressIdentifier(order) {
    const shippingAddress = order?.shipping?.address || {};
    const shipTo = order?.shipments?.[0]?.ship_to || {};
    const { givenName, familyName } = nameParts(order);
    const regionCode = String(firstValue([
        order?.customer?.country_code, shippingAddress.country_code, shipTo.country_code
    ]) || '').trim().toUpperCase();
    const postalCode = String(firstValue([shippingAddress.postal_code, shipTo.postal_code]) || '').trim();
    if (!givenName || !familyName || !/^[A-Z]{2}$/.test(regionCode) || !postalCode) return null;
    return {
        address: {
            givenName: sha256Hex(givenName),
            familyName: sha256Hex(familyName),
            regionCode,
            postalCode
        }
    };
}

function buildUserData(order) {
    const customer = order?.customer || {};
    const shipTo = (Array.isArray(order?.shipments) ? order.shipments : []).map(item => item?.ship_to || {});
    const emails = [customer.email].map(normalizeEmail).filter(Boolean);
    const regionCode = String(firstValue([
        customer.country_code, order?.shipping?.address?.country_code, shipTo[0]?.country_code
    ]) || '').trim().toUpperCase();
    const dialCode = customer.mobile_code || (regionCode === 'SA' ? '966' : null);
    const phones = [order?.e164Phone, customer.mobile]
        .map(value => normalizePhoneNumber(value, dialCode)).filter(Boolean);
    const identifiers = [];
    for (const email of [...new Set(emails)].slice(0, 4)) identifiers.push({ emailAddress: sha256Hex(email) });
    for (const phone of [...new Set(phones)].slice(0, 4)) identifiers.push({ phoneNumber: sha256Hex(phone) });
    const address = addressIdentifier(order);
    if (address) identifiers.push(address);
    return identifiers.length ? { userIdentifiers: identifiers.slice(0, 10) } : null;
}

function customerIdentifierTypes(order) {
    const identifiers = buildUserData(order)?.userIdentifiers || [];
    return [...new Set(identifiers.map(identifier => Object.keys(identifier)[0]))];
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
    const supportedTracking = Boolean(tracking?.id && ['gclid', 'gbraid', 'wbraid'].includes(tracking.type));
    const userData = buildUserData(order);
    if (userData && deliveryConfig.customerDataConsentGranted !== true) {
        throw new DataManagerError('Explicit customer data consent is required for user identifiers', {
            code: 'DATA_MANAGER_CONSENT_REQUIRED', retryable: false
        });
    }
    if (!supportedTracking && !userData) {
        throw new DataManagerError('A supported Google Ads click identifier or customer identifier is required', {
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
    const event = {
        conversionValue: value,
        currency: String(order?.currency || 'SAR').toUpperCase(),
        eventTimestamp: eventTimestamp(order, now),
        transactionId,
        eventSource: 'WEB'
    };
    if (supportedTracking) event.adIdentifiers = { [tracking.type]: tracking.id };
    if (userData) event.userData = userData;
    return {
        destinations: [{
            operatingAccount: { accountType: 'GOOGLE_ADS', accountId: deliveryConfig.customerId },
            loginAccount: { accountType: 'GOOGLE_ADS', accountId: deliveryConfig.customerId },
            productDestinationId: deliveryConfig.conversionActionId
        }],
        events: [event],
        consent: { adUserData: 'CONSENT_GRANTED' },
        encoding: 'HEX',
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
    const identifierTypes = customerIdentifierTypes(order);
    const supportedTracking = Boolean(tracking?.id && ['gclid', 'gbraid', 'wbraid'].includes(tracking.type));
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
                trackingType: supportedTracking ? tracking.type : null,
                trackingFingerprint: supportedTracking ? trackingFingerprint(tracking.id) : null,
                customerIdentifierTypes: identifierTypes
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
    normalizeEmail, normalizePhoneNumber, normalizeName, buildUserData, customerIdentifierTypes,
    buildPayload, trackingFingerprint, summarizeStatus, accessToken, deliver, retrieveStatus, resetTokenCache
};
