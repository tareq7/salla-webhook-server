(async function () {
    'use strict';

    var TRACKING_ENDPOINT = 'https://track.ssp-1.com/track-gclid';
    var STORAGE_KEY = 'pending_google_ads_click';
    var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    var MAX_TRACKING_ID_LENGTH = 256;
    var MAX_ENTITY_ID_LENGTH = 128;
    var ENTITY_WAIT_MS = 15000;
    var ENTITY_POLL_MS = 500;

    function getCookie(name) {
        var prefix = encodeURIComponent(name) + '=';
        var cookies = document.cookie ? document.cookie.split(';') : [];

        for (var i = 0; i < cookies.length; i++) {
            var cookie = cookies[i].trim();
            if (cookie.indexOf(prefix) === 0) {
                var value = cookie.substring(prefix.length);
                try {
                    return decodeURIComponent(value);
                } catch (error) {
                    return value;
                }
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

    function isValidIdentifier(value, maxLength) {
        return typeof value === 'string' &&
            value.length > 0 &&
            value.length <= maxLength &&
            /^[A-Za-z0-9._~-]+$/.test(value) &&
            !value.startsWith('ory_at_') &&
            !value.startsWith('ory_rt_');
    }

    function getClickDataFromUrl() {
        var params = new URLSearchParams(window.location.search);
        var types = ['gclid', 'wbraid', 'gbraid'];

        for (var i = 0; i < types.length; i++) {
            var type = types[i];
            var value = params.get(type);
            if (isValidIdentifier(value, MAX_TRACKING_ID_LENGTH)) {
                return {
                    tracking_id: value,
                    tracking_type: type,
                    captured_at: Date.now()
                };
            }
        }
        return null;
    }

    function storageGet() {
        try {
            return window.localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            try {
                return window.sessionStorage.getItem(STORAGE_KEY);
            } catch (fallbackError) {
                return null;
            }
        }
    }

    function storageSet(value) {
        try {
            window.localStorage.setItem(STORAGE_KEY, value);
            return true;
        } catch (error) {
            try {
                window.sessionStorage.setItem(STORAGE_KEY, value);
                return true;
            } catch (fallbackError) {
                return false;
            }
        }
    }

    function storageRemove() {
        try { window.localStorage.removeItem(STORAGE_KEY); } catch (error) {}
        try { window.sessionStorage.removeItem(STORAGE_KEY); } catch (error) {}
    }

    function saveClickData(data) {
        if (data) storageSet(JSON.stringify(data));
    }

    function loadClickData() {
        var raw = storageGet();
        if (!raw) return null;

        try {
            var data = JSON.parse(raw);
            var age = Date.now() - data.captured_at;
            var expired = typeof data.captured_at !== 'number' || age < 0 || age > MAX_AGE_MS;
            var valid = ['gclid', 'wbraid', 'gbraid'].indexOf(data.tracking_type) !== -1 &&
                isValidIdentifier(data.tracking_id, MAX_TRACKING_ID_LENGTH);

            if (expired || !valid) {
                storageRemove();
                return null;
            }
            return data;
        } catch (error) {
            storageRemove();
            return null;
        }
    }

    function normalizedEntity(type, value) {
        var id = value == null ? '' : String(value);
        return isValidIdentifier(id, MAX_ENTITY_ID_LENGTH) ? {
            entity_type: type,
            entity_id: id
        } : null;
    }

    function getJoinEntity() {
        try {
            if (window.salla && window.salla.config && typeof window.salla.config.get === 'function') {
                var order = normalizedEntity('order', window.salla.config.get('order.id'));
                if (order) return order;

                var cart = normalizedEntity('cart', window.salla.config.get('cart.id'));
                if (cart) return cart;
            }

            if (window.Salla && window.Salla.cart) {
                return normalizedEntity('cart', window.Salla.cart.id);
            }
        } catch (error) {
            console.error('Unable to read the commerce context', error);
        }
        return null;
    }

    function wait(milliseconds) {
        return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
    }

    async function waitForJoinEntity() {
        var deadline = Date.now() + ENTITY_WAIT_MS;
        var entity;
        do {
            entity = getJoinEntity();
            if (entity) return entity;
            await wait(ENTITY_POLL_MS);
        } while (Date.now() < deadline);
        return null;
    }

    async function sendTrackingEvent(clickData, entity) {
        var payload = {
            entity_type: entity.entity_type,
            entity_id: entity.entity_id,
            tracking_id: clickData.tracking_id,
            tracking_type: clickData.tracking_type,
            client_id: extractGaClientId()
        };

        try {
            var response = await fetch(TRACKING_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body: JSON.stringify(payload),
                keepalive: true,
                credentials: 'omit'
            });

            if (!response.ok) throw new Error('Tracking endpoint returned HTTP ' + response.status);
            storageRemove();
            return true;
        } catch (error) {
            console.error('Tracking ping failed', error);
            return false;
        }
    }

    var currentClickData = getClickDataFromUrl();
    if (currentClickData) saveClickData(currentClickData);

    var clickData = currentClickData || loadClickData();
    if (!clickData) return;

    var entity = await waitForJoinEntity();
    if (entity) await sendTrackingEvent(clickData, entity);
})();
