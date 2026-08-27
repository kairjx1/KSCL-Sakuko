
if (!window.location.hostname.includes('kscl-sakuko.pages.dev') && 
    !window.location.hostname.includes('localhost') && 
    window.location.hostname !== '127.0.0.1') {
    // Only run on KSCL Dashboard
} else {
console.log("%c[KSCL EXTENSION] DASHBOARD SCRIPT IS RUNNING!", "color: lime; font-size: 20px; font-weight: bold;");
window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'REQ_ZALO_MESSAGES') {
            chrome.storage.local.get(['kscl_zalo_sessions'], (res) => {
                window.postMessage({ type: 'RES_ZALO_MESSAGES', payload: res.kscl_zalo_sessions || {} }, '*');
            });
        }
        
        if (event.data && event.data.type === 'UPDATE_CONFIG') {
            chrome.storage.local.set({ kscl_bot_config: event.data.payload });
        }
        
        if (event.data && event.data.type === 'START_PHONE_SCAN') {
            chrome.storage.local.set({ 
                kscl_scan_queue: event.data.payload.phones, 
                kscl_scan_status: 'RUNNING',
                kscl_scan_trigger: Date.now() 
            });
        }
        
        if (event.data && event.data.type === 'STOP_PHONE_SCAN') {
            chrome.storage.local.set({ kscl_scan_status: 'STOPPED' });
        }
        
        if (event.data && event.data.type === 'PING_EXTENSION') {
            window.postMessage({ type: 'PONG_EXTENSION' }, '*');
        }
    });
    
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.kscl_scan_result) {
                window.postMessage({ type: 'RES_SCAN_RESULT', payload: changes.kscl_scan_result.newValue }, '*');
            }
            if (changes.kscl_scan_debug) {
                window.postMessage({ type: 'DEBUG_SCAN', payload: changes.kscl_scan_debug.newValue }, '*');
            }
        }
    });
    
}
