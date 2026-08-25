window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'REQ_ZALO_MESSAGES') {
        chrome.storage.local.get(['kscl_zalo_sessions'], (res) => {
            window.postMessage({
                type: 'RES_ZALO_MESSAGES',
                payload: res.kscl_zalo_sessions || {}
            }, '*');
        });
    }
    if (event.data && event.data.type === 'UPDATE_CONFIG') {
        chrome.storage.local.set({ kscl_bot_config: event.data.payload });
    }
});