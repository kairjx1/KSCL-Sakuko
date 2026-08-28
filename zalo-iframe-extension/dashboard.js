
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
            // KILL THE TIMEOUT IN MAIN WORLD IMMEDIATELY
            try {
                const s = document.createElement('script');
                s.textContent = "setTimeout(() => { if (typeof isScanning !== 'undefined') isScanning = false; if (typeof scannedCount !== 'undefined') scannedCount = 1; }, 100);";
                document.head.appendChild(s);
                s.remove();
            } catch(e) {}
            
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
        
                if (event.data && event.data.type === 'CMD_STOP_BULK_MSG') {
            chrome.storage.local.set({ kscl_cmd_stop_bulk_msg: Date.now() });
        }
        if (event.data && event.data.type === 'CMD_START_BULK_MSG') {
            let p = event.data.payload;
            p._ts = Date.now(); // Force local change
            chrome.storage.local.set({ kscl_cmd_bulk_msg: p });
        }
        
        if (event.data && event.data.type === 'CMD_START_INVITE') {
            let p = event.data.payload;
            p._ts = Date.now(); // Force local change
            chrome.storage.local.set({ kscl_cmd_invite: p });
        }
        
        if (event.data && event.data.type === 'CMD_START_AUTOCARE') {
            let p = event.data.payload;
            p._ts = Date.now(); // Force local change
            chrome.storage.local.set({ kscl_cmd_autocare: p });
        }
    });
    
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.kscl_scan_result) {
                
                window.postMessage({ type: 'RES_SCAN_RESULT', payload: changes.kscl_scan_result.newValue }, '*');
                
                // Inject script to fix page variables in the main world
                try {
                    const s = document.createElement('script');
                    s.textContent = "if (typeof isScanning !== 'undefined') isScanning = false;";
                    document.head.appendChild(s);
                    s.remove();
                } catch(e) {}
            }
            if (changes.kscl_bulk_msg_result) {
                window.postMessage({ type: 'RES_BULK_MSG_RESULT', payload: changes.kscl_bulk_msg_result.newValue }, '*');
            }
            if (changes.kscl_invite_result) {
                window.postMessage({ type: 'RES_INVITE_RESULT', payload: changes.kscl_invite_result.newValue }, '*');
                try {
                    const data = changes.kscl_invite_result.newValue;
                    const s = document.createElement('script');
                    s.textContent = `
                        if ('${data.status}' === 'DONE') {
                            isInviting = false;
                            document.getElementById('btnStartInvite').innerHTML = '<i class="fa fa-magic"></i> Bắt đầu tự động chọn';
                            document.getElementById('btnStartInvite').disabled = false;
                            document.getElementById('inviteProgressText').innerText = 'Đã hoàn thành! Vui lòng tự bấm nút Xác Nhận trên Zalo.';
                            showToast("Hoàn thành quá trình chọn!");
                        } else {
                            let sent = parseInt(document.getElementById('inviteSelected').innerText || '0');
                            let failed = parseInt(document.getElementById('inviteFailed').innerText || '0');
                            let total = parseInt(document.getElementById('inviteTotal').innerText || '1');
                            
                            if ('${data.status}' === 'SUCCESS') sent++;
                            else failed++;
                            
                            document.getElementById('inviteSelected').innerText = sent;
                            document.getElementById('inviteFailed').innerText = failed;
                            
                            let progress = Math.round(((sent + failed) / total) * 100);
                            if (progress > 100) progress = 100;
                            
                            document.getElementById('inviteProgressFill').style.width = progress + '%';
                            document.getElementById('inviteProgressText').innerText = 'Đang chọn... ' + progress + '% (${data.phone}: ${data.status})';
                        }
                    `;
                    document.head.appendChild(s);
                    s.remove();
                } catch(e) {}
            }
            if (changes.kscl_autocare_result) {
                window.postMessage({ type: 'RES_AUTOCARE_RESULT', payload: changes.kscl_autocare_result.newValue }, '*');
                
                try {
                    const data = changes.kscl_autocare_result.newValue;
                    const s = document.createElement('script');
                    s.textContent = `
                        if ('${data.status}' === 'DONE') {
                            isAutocare = false;
                            document.getElementById('btnStartAutocare').innerHTML = '<i class="fa fa-rocket"></i> Bắt đầu gửi Yêu cầu Kết Bạn';
                            document.getElementById('btnStartAutocare').disabled = false;
                            document.getElementById('autocareProgressText').innerText = 'Đã hoàn thành! Mọi yêu cầu kết bạn đã được gửi đi.';
                            showToast("Hoàn thành tự động kết bạn!");
                        } else {
                            let sent = parseInt(document.getElementById('autocareSent').innerText || '0');
                            let failed = parseInt(document.getElementById('autocareFailed').innerText || '0');
                            let total = parseInt(document.getElementById('autocareTotal').innerText || '1');
                            
                            if ('${data.status}' === 'SUCCESS') sent++;
                            else failed++;
                            
                            document.getElementById('autocareSent').innerText = sent;
                            document.getElementById('autocareFailed').innerText = failed;
                            
                            let progress = Math.round(((sent + failed) / total) * 100);
                            if (progress > 100) progress = 100;
                            
                            document.getElementById('autocareProgressFill').style.width = progress + '%';
                            document.getElementById('autocareProgressText').innerText = 'Đang chạy... ' + progress + '% (${data.phone}: ${data.status})';
                        }
                    `;
                    document.head.appendChild(s);
                    s.remove();
                } catch(e) {}
            }
            if (changes.kscl_scan_debug) {
                window.postMessage({ type: 'DEBUG_SCAN', payload: changes.kscl_scan_debug.newValue }, '*');
            }
        }
    });
    
}
