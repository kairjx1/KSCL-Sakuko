console.log("🚀 KSCL Zalo Extension: Đã inject thành công vào chat.zalo.me!");

let allGroupData = {};

// Khôi phục session cũ nếu có
chrome.storage.local.get(['kscl_zalo_sessions'], (res) => {
    if (res.kscl_zalo_sessions) allGroupData = res.kscl_zalo_sessions;
});

// UI Overlay
const statusBox = document.createElement('div');
statusBox.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#1e293b; color:#10b981; padding:15px; border-radius:12px; z-index:999999; font-size:13px; font-family:sans-serif; box-shadow:0 10px 15px -3px rgba(0,0,0,0.3); border:1px solid #334155; width:220px; transition:0.3s;';
document.body.appendChild(statusBox);

// Header & Minimize logic
const header = document.createElement('div');
header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; cursor:pointer;';
const title = document.createElement('div');
title.innerHTML = '🤖 KSCL Bot';
title.style.fontWeight = 'bold';
title.style.color = '#fff';

const minBtn = document.createElement('button');
minBtn.innerHTML = '−';
minBtn.style.cssText = 'background:transparent; color:#94a3b8; border:none; cursor:pointer; font-size:18px; font-weight:bold; outline:none; padding:0 5px;';

header.appendChild(title);
header.appendChild(minBtn);
statusBox.appendChild(header);

const contentBox = document.createElement('div');
contentBox.style.marginTop = '10px';
statusBox.appendChild(contentBox);

let isMinimized = false;
function toggleMinimize() {
    isMinimized = !isMinimized;
    if (isMinimized) {
        contentBox.style.display = 'none';
        minBtn.innerHTML = '+';
        statusBox.style.width = '120px';
        statusBox.style.padding = '10px';
    } else {
        contentBox.style.display = 'block';
        minBtn.innerHTML = '−';
        statusBox.style.width = '220px';
        statusBox.style.padding = '15px';
    }
}
header.onclick = toggleMinimize;

const infoText = document.createElement('div');
infoText.innerHTML = 'Đang khởi động...';
contentBox.appendChild(infoText);

// Nút Gợi ý trả lời (AI Auto-Draft)
const autoReplyBtn = document.createElement('button');
autoReplyBtn.innerHTML = '✨ AI: Hỗ trợ soạn tin';
autoReplyBtn.style.cssText = 'display:block; margin-top:12px; width:100%; padding:10px; background:#3b82f6; color:white; border:none; border-radius:6px; cursor:pointer; font-weight:bold; transition:0.2s;';
autoReplyBtn.onmouseover = () => autoReplyBtn.style.background = '#2563eb';
autoReplyBtn.onmouseout = () => autoReplyBtn.style.background = '#3b82f6';
contentBox.appendChild(autoReplyBtn);

// Nút Xóa bộ nhớ
const clearBtn = document.createElement('button');
clearBtn.innerText = '🗑 Xóa phiên làm việc';
clearBtn.style.cssText = 'display:block; margin-top:8px; width:100%; padding:6px; background:#ef4444; color:white; border:none; border-radius:6px; cursor:pointer; font-size:11px;';
contentBox.appendChild(clearBtn);

clearBtn.onclick = () => {
    allGroupData = {};
    chrome.storage.local.remove('kscl_zalo_sessions');
    infoText.innerHTML = `Đã xóa sạch bộ nhớ!`;
};

autoReplyBtn.onclick = async () => {
    autoReplyBtn.innerHTML = '⏳ AI Đang nghĩ...';
    
    const titleEl = document.querySelector('.header-title, .chat-title, .title');
    const currentChatName = titleEl ? titleEl.innerText.trim() : 'Cuộc trò chuyện';
    
    const msgs = allGroupData[currentChatName] || [];
    if (msgs.length === 0) {
        alert("Chưa quét được tin nhắn nào trong nhóm này!");
        autoReplyBtn.innerHTML = '✨ AI: Hỗ trợ soạn tin';
        return;
    }
    
    let chatContext = "";
    msgs.slice(-15).forEach(m => { 
        chatContext += `${m.sender}: ${m.content}
`;
    });
    
    chrome.storage.local.get(['kscl_bot_config'], async (res) => {
        const apiKey = res.kscl_bot_config?.apiKey;
        const deepseekKey = res.kscl_bot_config?.deepseekKey;
        const aiProvider = res.kscl_bot_config?.aiProvider || 'gemini';
        
        if (!apiKey && !deepseekKey) {
            alert('Vui lòng mở tab KSCL Dashboard, vào Cấu hình Bot và bấm "Lưu Cấu hình" 1 lần để Bot ghi nhớ API Key!');
            autoReplyBtn.innerHTML = '✨ AI: Hỗ trợ soạn tin';
            return;
        }
        
        try {
            const inputDiv = document.querySelector('#richInput') || document.querySelector('.input-box');
            let userDraft = "";
            if (inputDiv) {
                userDraft = inputDiv.innerText.trim();
            }
            
            let prompt = "";
            if (userDraft.length > 0) {
                prompt = `ĐOẠN CHAT NGỮ CẢNH:
${chatContext}

Ý NHÁP CỦA TÔI: "${userDraft}"

YÊU CẦU: Dựa vào ý nháp của tôi, hãy viết lại thành một câu trả lời hoàn chỉnh để gửi qua Zalo.
Tiêu chí:
- Giọng điệu chuyên nghiệp, khéo léo nhưng PHẢI CỰC KỲ TỰ NHIÊN, GIỐNG NGƯỜI THẬT ĐANG CHAT.
- Tuyệt đối không dùng văn phong robot, máy móc, sáo rỗng hay "văn mẫu".
- Dùng từ ngữ gần gũi, thực tế của môi trường công sở/bán hàng Việt Nam (VD: vâng, dạ, ok ạ, anh/chị... tùy ngữ cảnh).
- Trả lời thẳng vào vấn đề, không vòng vo.
- Không dùng ký hiệu markdown (như **). Chỉ in ra đúng nội dung câu trả lời cuối cùng, tuyệt đối không giải thích thêm.`;
            } else {
                prompt = `ĐOẠN CHAT NGỮ CẢNH:
${chatContext}

YÊU CẦU: Dựa vào đoạn chat trên, hãy tự động nghĩ ra và soạn 1 câu trả lời tiếp theo để gửi qua Zalo.
Tiêu chí:
- Giọng điệu chuyên nghiệp, khéo léo nhưng PHẢI CỰC KỲ TỰ NHIÊN, GIỐNG NGƯỜI THẬT ĐANG CHAT.
- Ngắn gọn, súc tích (1-2 câu).
- Tuyệt đối không dùng văn phong robot, máy móc, sáo rỗng hay "văn mẫu".
- Dùng từ ngữ gần gũi, thực tế của môi trường công sở/bán hàng Việt Nam (VD: vâng, dạ, ok ạ, anh/chị... tùy ngữ cảnh).
- Không dùng ký hiệu markdown (như **). Chỉ in ra đúng nội dung câu trả lời cuối cùng, tuyệt đối không giải thích thêm.`;
            }
            
            let replyText = "";
            let primaryFailed = false;
            
            const runGemini = async () => {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
                const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7 } }) });
                const result = await response.json();
                if (result.error) throw new Error(result.error.message);
                return result.candidates[0].content.parts[0].text.trim();
            };
            
            const runDeepseek = async () => {
                const response = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${deepseekKey}` }, body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], temperature: 0.7 }) });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error?.message || "Lỗi DeepSeek");
                return result.choices[0].message.content.trim();
            };

            if (aiProvider === 'deepseek') {
                try {
                    replyText = await runDeepseek();
                } catch(e) {
                    if (apiKey) replyText = await runGemini();
                    else throw e;
                }
            } else {
                try {
                    replyText = await runGemini();
                } catch(e) {
                    if (deepseekKey) replyText = await runDeepseek();
                    else throw e;
                }
            }
            
            replyText = replyText.replace(/\*/g, '');
            
            if (inputDiv) {
                inputDiv.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, replyText);
            } else {
                navigator.clipboard.writeText(replyText);
                alert('Đã copy gợi ý vào khay nhớ tạm! Bấm Ctrl+V vào ô chat để dán.');
            }
        } catch (e) {
            alert('Lỗi gọi AI: ' + e.message);
        }
        autoReplyBtn.innerHTML = '✨ AI: Hỗ trợ soạn tin';
    });
};

function extractZaloMessages() {
    const titleEl = document.querySelector('.header-title, .chat-title, .title');
    const currentChatName = titleEl ? titleEl.innerText.trim() : 'Cuộc trò chuyện';
    
    const messageElements = document.querySelectorAll('.chat-date, .date, .time-divider, .message-view__msg-item, .chat-message');
    
    let currentGroupMessages = [];
    let lastDate = new Date().toLocaleDateString('vi-VN'); // Default to today
    
    messageElements.forEach(el => {
        // Try to check if this is a date divider
        const dateText = el.innerText.trim();
        // Match standard date formats like "22/08/2026", "22/08", "Hôm qua", "Hôm nay", "Thứ 2"
        if (el.classList.contains('chat-date') || el.classList.contains('date') || /^(Hôm nay|Hôm qua|Thứ \d|Chủ nhật|\d{1,2}\/\d{1,2}(\/\d{4})?)/i.test(dateText)) {
            if (dateText.length < 20 && !dateText.includes(':')) {
                lastDate = dateText;
            }
        }
        
        const sender = el.querySelector('.card-sender-name, .msg-author')?.innerText.trim() || 'Ai đó';
        const content = el.querySelector('.text, .msg-text, .chat-message-content')?.innerText.trim();
        let time = el.querySelector('.msg-time, .time')?.innerText.trim() || "";
        
        if (time && !time.includes(lastDate) && !/^\d{1,2}\/\d{1,2}/.test(time)) {
            time = `${lastDate} ${time}`;
        } else if (!time) {
            time = `${lastDate} ${new Date().toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'})}`;
        }
        
        if (content && content.length > 0 && !el.classList.contains('chat-date') && !el.classList.contains('time-divider')) {
            currentGroupMessages.push({ sender, time, content });
        }
    });

    if (currentGroupMessages.length > 0) {
        if (currentGroupMessages.length > 150) currentGroupMessages = currentGroupMessages.slice(-150);
        allGroupData[currentChatName] = currentGroupMessages;
        chrome.storage.local.set({ kscl_zalo_sessions: allGroupData });
        
        infoText.innerHTML = `Đang đọc: <b style="color:#fff">${currentChatName}</b><br/>Đã nhớ: <b style="color:#fff">${Object.keys(allGroupData).length} nhóm</b>`;
    }
}
setInterval(extractZaloMessages, 2000);

﻿﻿// Zalo Scanner Worker
let scanQueue = [];
let isScanningPhone = false;

function debugLog(msg) {
    chrome.storage.local.set({ kscl_scan_debug: `[Zalo Worker] ${msg}` });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.kscl_scan_trigger) {
        chrome.storage.local.get(['kscl_scan_queue'], (res) => {
            scanQueue = res.kscl_scan_queue || [];
            debugLog("Nhận được hàng chờ quét: " + scanQueue.length + " số");
            if (scanQueue.length > 0 && !isScanningPhone) {
                processScanQueue().catch(e => {
                    debugLog("Lỗi nghiêm trọng trong quá trình quét: " + e.message);
                    chrome.storage.local.set({ kscl_scan_result: { status: 'DONE' } });
                    isScanningPhone = false;
                });
            }
        });
    }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

function setNativeValue(element, value) {
    try {
        element.focus();
        element.select();
        let success = document.execCommand('insertText', false, value);
        
        if (!success) {
            const valueSetter = Object.getOwnPropertyDescriptor(element, 'value');
            const prototype = Object.getPrototypeOf(element);
            const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value');
            
            if (valueSetter && valueSetter.set && prototypeValueSetter && prototypeValueSetter.set && valueSetter.set !== prototypeValueSetter.set) {
                prototypeValueSetter.set.call(element, value);
            } else if (prototypeValueSetter && prototypeValueSetter.set) {
                prototypeValueSetter.set.call(element, value);
            } else {
                element.value = value;
            }
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: value, bubbles: true, cancelable: true }));
        }
    } catch (e) {
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

async function processScanQueue() {
    if (scanQueue.length === 0) {
        chrome.storage.local.set({ kscl_scan_result: { status: 'DONE' } });
        return;
    }
    
    if (isScanningPhone) return;
    isScanningPhone = true;
    debugLog("Bắt đầu processScanQueue");
    
    let searchInput = document.querySelector('#contact-search-input, #global-search-input, .cp-txt-search');
    if (!searchInput) {
        let inputs = document.querySelectorAll('input');
        for (let inp of inputs) {
            if (inp.placeholder && inp.placeholder.toLowerCase().includes('m ki')) {
                searchInput = inp;
                break;
            }
        }
    }
    if (!searchInput) {
        let allInputs = document.querySelectorAll('input[type="text"], input');
        for (let inp of allInputs) {
            if (inp.offsetWidth > 0 && inp.offsetHeight > 0) {
                searchInput = inp;
                break;
            }
        }
    }
    
    if (!searchInput) {
        debugLog("Không tìm thấy ô tìm kiếm Zalo.");
        alert("KSCL [V2]: Không tìm thấy ô tìm kiếm Zalo. Vui lòng mở Zalo Web ở giao diện chuẩn.");
        chrome.storage.local.set({ kscl_scan_result: { status: 'DONE' } });
        isScanningPhone = false;
        return;
    }
    
    let phone = scanQueue[0];
    
    try {
        setNativeValue(searchInput, phone);
        
        debugLog("Đã gõ SĐT vào ô tìm kiếm, chờ 1.5s...");
        await sleep(1500); 
        
        let status = 'Chưa xác định';
        let name = '-';
        let uid = '-';
        let avatar = '';
        
        let searchResults = document.querySelectorAll('div');
        let targetItem = null;
        
        for (let item of searchResults) {
            let text = item.innerText || '';
            if (text.includes(phone) && (text.includes('điện thoại') || text.toLowerCase().includes('phone'))) {
                if (!targetItem || item.innerText.length < targetItem.innerText.length) {
                    targetItem = item;
                }
            }
        }
        
        let found = false;
        if (targetItem) {
            debugLog("Tìm thấy thẻ Contact, tiến hành click...");
            try { targetItem.click(); } catch(e) {}
            await sleep(1500);
            
            let profileModal = document.querySelector('.profile-dialog, .modal-content, [data-id="div_Profile_Modal"]');
            if (profileModal) {
                debugLog("Thấy Profile Modal. Đang trích xuất...");
                status = 'Có Zalo';
                found = true;
                
                let nameEl = profileModal.querySelector('.pi-name, .name, .truncate');
                if (nameEl) name = nameEl.innerText.trim();
                
                let avatarEl = profileModal.querySelector('img.avatar, img.a-child');
                if (avatarEl) avatar = avatarEl.src;
                
                let closeBtn = profileModal.querySelector('.btn-close, .close, [icon="close"]');
                if (closeBtn) closeBtn.click();
                else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
                await sleep(500);
            } else {
                let chatHeader = document.querySelector('.chat-header-info, .header-title');
                if (chatHeader) {
                    status = 'Có Zalo';
                    found = true;
                    name = chatHeader.innerText.split('
')[0].trim();
                }
            }
        }
        
        if (!found) {
            debugLog("Không thấy thẻ Contact. Kiểm tra toast lỗi...");
            let toast = document.querySelector('.toast, .snackbar, .error-msg');
            if (toast && (toast.innerText.toLowerCase().includes("chưa đăng ký") || toast.innerText.toLowerCase().includes("không tồn tại") || toast.innerText.toLowerCase().includes("không tìm thấy"))) {
                debugLog("Thấy thông báo: Chưa đăng ký.");
                status = 'Không có';
                found = true;
            } else {
                debugLog("Không thấy Profile, cũng không thấy Toast. Báo Không có.");
                status = 'Không có'; 
                found = true;
            }
        }
        
        setNativeValue(searchInput, '');
        
        chrome.storage.local.set({ 
            kscl_scan_result: { 
                phone, status, name, uid, avatar, time: new Date().toISOString() 
            } 
        });
        debugLog(`Hoàn tất SĐT ${phone} -> ${status}`);
    } catch (err) {
        debugLog("Lỗi vòng lặp SĐT " + phone + ": " + err.message);
    }
    
    scanQueue.shift();
    isScanningPhone = false;
    
    if (scanQueue.length > 0) {
        setTimeout(processScanQueue, 1000);
    } else {
        chrome.storage.local.set({ kscl_scan_result: { status: 'DONE' } });
    }
}

