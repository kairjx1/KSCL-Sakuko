
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
    });
    
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.kscl_scan_result) {
                
                window.postMessage({ type: 'RES_SCAN_RESULT', payload: changes.kscl_scan_result.newValue }, '*');
                
                // FORCE UI UPDATE LOCALLY TO BYPASS CLOUDFLARE
                try {
                // Inject script to fix page variables in the main world
                // Inject script to fix page variables in the main world
                const s = document.createElement('script');
                const newDataStr = JSON.stringify(changes.kscl_scan_result.newValue);
                s.textContent = `const newData = ${newDataStr};
                    if (typeof isScanning !== 'undefined') isScanning = false;
                    if (typeof scanResults !== 'undefined' && newData && newData.status !== 'DONE') {
                        scanResults.push(newData);
                    }
                `;
                document.head.appendChild(s);
                s.remove();

                    const data = changes.kscl_scan_result.newValue;
                    if (data.status === 'DONE') {
                        let lbl = document.getElementById('lblProgressText');
                        if (lbl) lbl.innerText = 'Đã quét xong toàn bộ danh sách!';
                        let btn = document.getElementById('btnStartScan');
                        if (btn) { btn.innerHTML = '▶ Bắt đầu quét'; btn.disabled = false; }
                        return;
                    }
                    
                    let tbody = document.getElementById('tblResults');
                    if (tbody) {
                        const tr = document.createElement('tr');
                        tr.innerHTML = `<td style="color:#60a5fa">${data.phone}</td>
                            <td><span class="status-badge status-${data.status === 'Có Zalo' ? 'zalo' : (data.status === 'Không có' ? 'no-zalo' : 'unknown')}">${data.status}</span></td>
                            <td><div style="display:flex; align-items:center; gap:8px;">${data.avatar ? '<img src="'+data.avatar+'" style="width:24px;height:24px;border-radius:50%;">' : ''}<span>${data.name}</span></div></td>
                            <td style="color:#94a3b8">${data.uid}</td>
                            <td style="color:#94a3b8">${new Date(data.time).toLocaleTimeString()}</td>`;
                        tbody.insertBefore(tr, tbody.firstChild);
                    }
                    
                    if (data.status === 'Có Zalo') {
                        let hasZalo = parseInt(document.getElementById('statHasZalo').innerText || 0) + 1;
                        document.getElementById('statHasZalo').innerText = hasZalo;
                    } else if (data.status === 'Không có') {
                        let noZalo = parseInt(document.getElementById('statNoZalo').innerText || 0) + 1;
                        document.getElementById('statNoZalo').innerText = noZalo;
                    }
                    let scannedCount = parseInt(document.getElementById('statScanned').innerText || 0) + 1;
                    document.getElementById('statScanned').innerText = scannedCount;
                    
                    let totalStr = document.getElementById('phoneListInput') ? document.getElementById('phoneListInput').value : '';
                    let total = totalStr ? totalStr.trim().split('\n').filter(p => p.trim() !== '').length : 1;
                    let progress = Math.round((scannedCount / total) * 100);
                    if (progress > 100) progress = 100;
                    let progressLbl = document.getElementById('lblProgressText');
                    if (progressLbl && !progressLbl.innerText.includes('Đã hủy')) progressLbl.innerText = 'Đang quét... ' + progress + '%';
                    let progressFill = document.getElementById('progressFill');
                    if (progressFill) progressFill.style.width = progress + '%';
                } catch(e) {}

            }
            if (changes.kscl_scan_debug) {
                window.postMessage({ type: 'DEBUG_SCAN', payload: changes.kscl_scan_debug.newValue }, '*');
            }
        }
    });
    
}
