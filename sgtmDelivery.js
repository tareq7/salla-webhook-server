'use strict';

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function integerEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function retryAfterMs(response, now = Date.now()) {
    const value = response.headers?.get?.('retry-after');
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryableStatus(status) {
    return RETRYABLE_STATUSES.has(status) || status >= 500;
}

class SgtmDeliveryError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'SgtmDeliveryError';
        Object.assign(this, details);
    }
}

async function responseExcerpt(response) {
    try {
        return String(await response.text()).replace(/\s+/g, ' ').trim().slice(0, 256);
    } catch {
        return '';
    }
}

async function deliver(url, options = {}) {
    const fetchFn = options.fetchFn || global.fetch;
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const random = options.random || Math.random;
    const maxAttempts = options.maxAttempts || integerEnv('SGTM_MAX_ATTEMPTS', 3, 1, 5);
    const timeoutMs = options.timeoutMs || integerEnv('SGTM_TIMEOUT_MS', 4000, 1000, 15000);
    const baseDelayMs = options.baseDelayMs || integerEnv('SGTM_RETRY_BASE_MS', 300, 50, 2000);
    const maxDelayMs = options.maxDelayMs || integerEnv('SGTM_RETRY_MAX_MS', 2000, 100, 10000);
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchFn(url, { method: 'POST', signal: controller.signal });
            if (response.ok) {
                return { attempts: attempt, status: response.status, durationMs: Date.now() - startedAt };
            }

            const retryable = retryableStatus(response.status);
            const excerpt = await responseExcerpt(response);
            if (!retryable || attempt === maxAttempts) {
                throw new SgtmDeliveryError(`sGTM returned ${response.status}`, {
                    code: 'SGTM_HTTP_ERROR', status: response.status, attempts: attempt, retryable, excerpt
                });
            }

            const requestedDelay = retryAfterMs(response);
            const exponentialDelay = baseDelayMs * (2 ** (attempt - 1)) * (0.75 + random() * 0.5);
            await sleep(Math.min(maxDelayMs, requestedDelay ?? exponentialDelay));
        } catch (error) {
            if (error instanceof SgtmDeliveryError) throw error;
            if (attempt === maxAttempts) {
                const timedOut = error?.name === 'AbortError';
                throw new SgtmDeliveryError(timedOut ? 'sGTM request timed out' : 'sGTM network request failed', {
                    code: timedOut ? 'SGTM_TIMEOUT' : 'SGTM_NETWORK_ERROR',
                    attempts: attempt,
                    retryable: true,
                    cause: error
                });
            }
            const delay = baseDelayMs * (2 ** (attempt - 1)) * (0.75 + random() * 0.5);
            await sleep(Math.min(maxDelayMs, delay));
        } finally {
            clearTimeout(timeout);
        }
    }

    throw new SgtmDeliveryError('sGTM delivery exhausted', { code: 'SGTM_EXHAUSTED', attempts: maxAttempts });
}

module.exports = { deliver, retryAfterMs, retryableStatus, SgtmDeliveryError };
