(function() {
    console.log("[Google Ads] GCLID Tracker Initializing...");

    // Utility to get a cookie
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    function getBestGclid() {
        const custom = getCookie('_gclid_salla');
        if (custom) return custom;
        
        const gclAw = getCookie('_gcl_aw');
        if (gclAw) {
            const parts = gclAw.split('.');
            if (parts.length >= 3) return parts[2];
        }
        return null;
    }

    // Utility to set a cookie
    function setCookie(name, value, days) {
        const d = new Date();
        d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
        // Use SameSite=Strict and Secure to ensure cookie isn't dropped by modern browsers
        document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/;SameSite=Strict;Secure`;
    }

    // 1. Capture GCLID from URL on any landing page
    const urlParams = new URLSearchParams(window.location.search);
    // Support the backup_gclid={gclid} trick to bypass Safari ITP stripping
    const gclid = urlParams.get('gclid') || urlParams.get('backup_gclid');
    if (gclid) {
        setCookie('_gclid_salla', gclid, 90);
        console.log("[Google Ads] Saved GCLID to cookie:", gclid);
    }

    // 2. Check if we are on the Thank You page (look for the injected order ID)
    document.addEventListener('DOMContentLoaded', () => {
        const orderDataEl = document.getElementById('salla-order-data');
        const orderId = orderDataEl ? orderDataEl.dataset.orderId : null;
        const storedGclid = getBestGclid();

        if (orderId && storedGclid) {
            // Send mapping to Render server
            // Ensure this matches your Render server URL
            const RENDER_SERVER_URL = 'https://salla-webhook-server-lvpy.onrender.com/track-gclid'; 
            
            const payload = new Blob([JSON.stringify({ order_id: orderId, gclid: storedGclid })], { type: 'application/json' });
            const success = navigator.sendBeacon(RENDER_SERVER_URL, payload);
            
            if (success) {
                console.log("[Google Ads] Successfully dispatched mapping for Order ID:", orderId);
                // Optional: Clear cookie to prevent re-sending on page reload
                // setCookie('_gclid_salla', '', -1);
            } else {
                console.error("[Google Ads] sendBeacon failed for Order ID:", orderId);
            }
        }
    });
})();
