(function () {
    'use strict';

    var TRACKING_ENDPOINT = 'https://track.ssp-1.com/track-gclid';
    var STORAGE_KEY = 'pending_google_ads_click';
    var PROCESSED_ORDER_PREFIX = 'google_ads_order_sent_';
    var CLICK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    var MAX_TRACKING_ID_LENGTH = 256;
    var SALLA_WAIT_INTERVAL_MS = 250;
    var SALLA_MAX_WAIT_ATTEMPTS = 80;
    var requestInProgress = false;
    var trackerRegistered = false;

    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Order Attribution]');
        console.log.apply(console, args);
    }

    function warn() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Order Attribution]');
        console.warn.apply(console, args);
    }

    function errorLog() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[Order Attribution]');
        console.error.apply(console, args);
    }

    function maskValue(value) {
        if (value === null || value === undefined || value === '') return null;
        value = String(value);
        if (value.length <= 8) return value.substring(0, 2) + '***';
        return value.substring(0, 4) + '...' + value.substring(value.length - 4);
    }

    function getCookie(name) {
        var prefix = encodeURIComponent(name) + '=';
        var cookies = document.cookie ? document.cookie.split(';') : [];
        for (var i = 0; i < cookies.length; i++) {
            var cookie = cookies[i].trim();
            if (cookie.indexOf(prefix) === 0) {
                var value = cookie.substring(prefix.length);
                try { return decodeURIComponent(value); } catch (error) { return value; }
            }
        }
        return null;
    }

    function extractGaClientId() {
        var gaCookie = getCookie('_ga');
        if (!gaCookie) return null;
        var parts = gaCookie.split('.');
        if (parts.length < 2) return null;
        var firstPart = parts[parts.length - 2];
        var secondPart = parts[parts.length - 1];
        if (!/^\d+$/.test(firstPart) || !/^\d+$/.test(secondPart)) return null;
        return firstPart + '.' + secondPart;
    }

    function isValidTrackingId(value) {
        return typeof value === 'string' &&
            value.length > 0 &&
            value.length <= MAX_TRACKING_ID_LENGTH &&
            /^[A-Za-z0-9._~-]+$/.test(value) &&
            value.indexOf('ory_at_') !== 0 &&
            value.indexOf('ory_rt_') !== 0;
    }

    function readStoredValue() {
        try {
            var localValue = window.localStorage.getItem(STORAGE_KEY);
            if (localValue) return localValue;
        } catch (error) {
            warn('localStorage read failed:', error);
        }
        try { return window.sessionStorage.getItem(STORAGE_KEY); }
        catch (error) { warn('sessionStorage read failed:', error); return null; }
    }

    function saveClickData(clickData) {
        var serialized = JSON.stringify(clickData);
        try {
            window.localStorage.setItem(STORAGE_KEY, serialized);
            return true;
        } catch (error) {
            warn('localStorage write failed; trying sessionStorage.', error);
        }
        try {
            window.sessionStorage.setItem(STORAGE_KEY, serialized);
            return true;
        } catch (error) {
            errorLog('Unable to save click data:', error);
            return false;
        }
    }

    function clearStoredClick() {
        try { window.localStorage.removeItem(STORAGE_KEY); } catch (error) { warn('localStorage cleanup failed:', error); }
        try { window.sessionStorage.removeItem(STORAGE_KEY); } catch (error) { warn('sessionStorage cleanup failed:', error); }
    }

    function captureClickFromUrl() {
        var params = new URLSearchParams(window.location.search);
        var trackingTypes = ['gclid', 'wbraid', 'gbraid'];
        for (var i = 0; i < trackingTypes.length; i++) {
            var trackingType = trackingTypes[i];
            var trackingId = params.get(trackingType);
            if (isValidTrackingId(trackingId)) {
                var clickData = { tracking_id: trackingId, tracking_type: trackingType, captured_at: Date.now() };
                if (saveClickData(clickData)) {
                    log('Google Ads click captured.', { tracking_type: trackingType, masked_tracking_id: maskValue(trackingId) });
                }
                return clickData;
            }
        }
        return null;
    }

    function getStoredClickData() {
        var rawData = readStoredValue();
        if (!rawData) return null;
        try {
            var clickData = JSON.parse(rawData);
            var age = Date.now() - clickData.captured_at;
            var validType = clickData.tracking_type === 'gclid' || clickData.tracking_type === 'wbraid' || clickData.tracking_type === 'gbraid';
            if (typeof clickData.captured_at !== 'number' || age < 0 || age > CLICK_MAX_AGE_MS || !validType || !isValidTrackingId(clickData.tracking_id)) {
                clearStoredClick();
                return null;
            }
            return clickData;
        } catch (error) {
            clearStoredClick();
            return null;
        }
    }

    function extractOrderId(payload) {
        if (!payload || typeof payload !== 'object') return null;
        var possibleIds = [
            payload.order && payload.order.id,
            payload.data && payload.data.order && payload.data.order.id,
            payload.data && payload.data.id,
            payload.order_id,
            payload.transaction_id,
            payload.id
        ];
        for (var i = 0; i < possibleIds.length; i++) {
            if (possibleIds[i] === null || possibleIds[i] === undefined || possibleIds[i] === '') continue;
            var normalized = String(possibleIds[i]).trim();
            if (/^\d+$/.test(normalized)) return normalized;
        }
        return null;
    }

    function wasOrderProcessed(orderId) {
        try { return window.localStorage.getItem(PROCESSED_ORDER_PREFIX + orderId) === '1'; }
        catch (error) { return false; }
    }

    function markOrderProcessed(orderId) {
        try { window.localStorage.setItem(PROCESSED_ORDER_PREFIX + orderId, '1'); }
        catch (error) { warn('Unable to mark order as processed:', error); }
    }

    function handleOrderCompleted(payload) {
        log('Order Completed event received.', payload);
        var orderId = extractOrderId(payload);
        if (!orderId) { errorLog('No valid internal Order ID found.', payload); return; }
        if (wasOrderProcessed(orderId) || requestInProgress) return;
        var clickData = getStoredClickData();
        if (!clickData) { log('No pending Google Ads click exists.'); return; }
        requestInProgress = true;
        var requestBody = {
            entity_type: 'order',
            entity_id: orderId,
            tracking_id: clickData.tracking_id,
            tracking_type: clickData.tracking_type,
            client_id: extractGaClientId()
        };
        log('Sending order attribution.', {
            entity_id: orderId,
            tracking_type: requestBody.tracking_type,
            masked_tracking_id: maskValue(requestBody.tracking_id),
            masked_client_id: maskValue(requestBody.client_id)
        });
        fetch(TRACKING_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(requestBody),
            keepalive: true,
            credentials: 'omit'
        }).then(function (response) {
            if (!response.ok) throw new Error('Tracking server returned HTTP ' + response.status);
            markOrderProcessed(orderId);
            clearStoredClick();
            log('SUCCESS: Google Ads click linked to Salla Order ID:', orderId);
        }).catch(function (error) {
            errorLog('Order attribution failed:', error);
            warn('Pending click data was preserved.');
        }).then(function () { requestInProgress = false; });
    }

    function registerSallaTracker() {
        if (trackerRegistered || !window.Salla || typeof window.Salla.onReady !== 'function') return;
        trackerRegistered = true;
        window.Salla.onReady(function () {
            if (!window.Salla.analytics || typeof window.Salla.analytics.registerTracker !== 'function') {
                trackerRegistered = false;
                errorLog('Salla analytics.registerTracker is unavailable.');
                return;
            }
            window.Salla.analytics.registerTracker({
                name: 'GoogleAdsOrderAttribution',
                track: function (eventName, eventPayload) {
                    if (eventName === 'Order Completed') handleOrderCompleted(eventPayload);
                },
                page: function (pagePayload) { log('Page event received:', pagePayload); }
            });
            log('Device Mode tracker registered successfully.');
        });
    }

    function waitForSalla(attempt) {
        attempt = attempt || 0;
        if (window.Salla && typeof window.Salla.onReady === 'function') { registerSallaTracker(); return; }
        if (attempt < SALLA_MAX_WAIT_ATTEMPTS) {
            setTimeout(function () { waitForSalla(attempt + 1); }, SALLA_WAIT_INTERVAL_MS);
        } else {
            errorLog('Salla was not detected after ' + (SALLA_MAX_WAIT_ATTEMPTS * SALLA_WAIT_INTERVAL_MS / 1000) + ' seconds.');
        }
    }

    log('Order attribution tracker started.');
    captureClickFromUrl();
    waitForSalla(0);
})();
