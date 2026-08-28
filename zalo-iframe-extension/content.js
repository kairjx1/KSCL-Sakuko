
// --- ANTI BACKGROUND THROTTLE ---
try {
    let script = document.createElement('script');
    script.textContent = `
        Object.defineProperty(document, 'hidden', { get: function() { return false; } });
        Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; } });
        window.requestAnimationFrame = window.requestAnimationFrame || function(cb) { return setTimeout(cb, 16); };
    `;
    document.documentElement.appendChild(script);
    script.remove();
} catch(e) {}
// --------------------------------

console.log("🚀 KSCL Zalo Extension: Đã inject thành công vào chat.zalo.me!");

let allGroupData = {};

// Khôi phục session cũ nếu có
chrome.storage.local.get(['kscl_zalo_sessions'], (res) => {
    if (res.kscl_zalo_sessions) allGroupData = res.kscl_zalo_sessions;
});

// UI Overlay
const statusBox = document.createElement('div');
  statusBox.id = 'kscl-bot-widget';
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
  
  // Make widget draggable
  let isDragging = false;
  let dragMove = false;
  let startX, startY, initialLeft, initialTop;
  
  header.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragMove = false;
      startX = e.clientX;
      startY = e.clientY;
      let rect = statusBox.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      
      // Convert right/bottom to left/top for reliable dragging
      statusBox.style.right = 'auto';
      statusBox.style.bottom = 'auto';
      statusBox.style.left = initialLeft + 'px';
      statusBox.style.top = initialTop + 'px';
      
      e.preventDefault(); // prevent text selection
  });
  
  document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let dx = e.clientX - startX;
      let dy = e.clientY - startY;
      
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMove = true;
      
      statusBox.style.left = (initialLeft + dx) + 'px';
      statusBox.style.top = (initialTop + dy) + 'px';
  });
  
  document.addEventListener('mouseup', () => {
      isDragging = false;
  });
  
  header.addEventListener('click', (e) => {
      if (!dragMove) {
          toggleMinimize();
      }
  });

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
        
        if (!success || element.value !== value) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(element, value);
            } else {
                element.value = value;
            }
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
        } else {
            element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
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
        alert("KSCL [V2]: Không tìm thấy ô tìm kiếm Zalo.");
        chrome.storage.local.set({ kscl_scan_result: { status: 'DONE' } });
        isScanningPhone = false;
        return;
    }
    
    let phone = scanQueue[0];
    
    try {
        let clearBtn = document.querySelector('.search-clear, .btn-clear, i.fa-close, [icon="close"], .close-search');
        if (clearBtn) { try { clearBtn.click(); } catch(e){} }
        setNativeValue(searchInput, '');
        await sleep(300);
        
        setNativeValue(searchInput, phone);
          await reportProgress(phone, 'Đang gõ SĐT vào ô tìm kiếm...');
        
        let status = 'Không có';
        let name = '-';
        let uid = '-';
        let avatar = '';
        
        let targetItem = null;
        let card = null;
        
        for (let wait = 0; wait < 35; wait++) {
            await sleep(300);
            
            targetItem = null;
            card = null;
            
            // Primary check: Zalo's contact items
            let possibleCards = document.querySelectorAll('.contact-item, .search-res-item, .global-search-item, [data-id], .list-item');
            for (let item of possibleCards) {
                let text = item.innerText || '';
                let rawText = text.replace(/[\s\.\-\+]/g, '');
                
                // CRUCIAL: Do not falsely match recent chats!
                let isMatch = rawText.includes(phone) || 
                              text.toLowerCase().includes("tìm bạn qua") || 
                              text.toLowerCase().includes("tìm liên hệ");
                              
                if (isMatch) {
                    if (item.querySelector('img')) {
                        card = item;
                        break;
                    }
                }
            }
            
            // Fallback check: any div with image and phone
            if (!card) {
                let allDivs = document.querySelectorAll('div');
                for (let div of allDivs) {
                    let text = div.innerText || '';
                    let rawText = text.replace(/[\s\.\-\+]/g, '');
                    if (rawText.includes(phone)) {
                        if (div.querySelector('img') && text.length < 200) {
                            card = div;
                            // Find the most inner card-like div
                            let children = div.querySelectorAll('div');
                            for(let child of children) {
                                let ctext = child.innerText || '';
                                if (ctext.replace(/[\s\.\-\+]/g, '').includes(phone) && child.querySelector('img')) {
                                    card = child;
                                }
                            }
                            break;
                        }
                    }
                }
            }
            
            if (card) {
                status = 'Có Zalo';
                break;
            }
            
            let toast = document.querySelector('.toast, .snackbar, .error-msg, .search-empty');
            if (toast) {
                let tt = toast.innerText.toLowerCase();
                if (tt.includes("chưa đăng ký") || tt.includes("không tồn tại") || tt.includes("không tìm thấy") || tt.includes("không có kết quả") || tt.includes("không tìm thấy kết quả")) {
                    status = 'Không có';
                    break;
                }
            }
        }
        
        if (status === 'Có Zalo' && card) {
            let lines = card.innerText.split('\n').map(l => l.trim()).filter(l => l !== '');
            if (lines.length > 0) {
                name = lines[0];
                if ((name.includes(phone) || name.toLowerCase().includes('tìm')) && lines.length > 1) {
                    name = lines[1];
                }
            }
            let img = card.querySelector('img');
            if (img) avatar = img.src;
        }
        
        let clearBtn2 = document.querySelector('.search-clear, .btn-clear, i.fa-close, [icon="close"], .close-search');
        if (clearBtn2) { try { clearBtn2.click(); } catch(e){} }
        setNativeValue(searchInput, '');
        
        chrome.storage.local.set({ 
            kscl_scan_result: { 
                phone, status, name, uid, avatar, time: new Date().toISOString() 
            } 
        });
    } catch (err) {
        // Ignored
    }
    
    scanQueue.shift();
    isScanningPhone = false;
    
    if (scanQueue.length > 0) {
        setTimeout(processScanQueue, 3500);
    } else {
        chrome.storage.local.set({ kscl_scan_result: { status: 'DONE' } });
    }
}




// --- BULK MESSAGE LOGIC ---
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.kscl_cmd_stop_bulk_msg) {
        bulkMsgQueue = [];
        isBulkMessaging = false;
        let w = document.getElementById('kscl-bot-widget');
        if (w) w.style.display = 'block';
    }
});

let bulkMsgQueue = [];
let currentBulkMsg = '';
let currentBulkAttachment = null;
let isBulkMessaging = false;

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.kscl_cmd_bulk_msg) {
        let payload = changes.kscl_cmd_bulk_msg.newValue;
        if (payload && payload.phones && payload.phones.length > 0) {
            bulkMsgQueue = [...payload.phones];
            currentBulkMsg = payload.message;
            currentBulkAttachment = payload.attachment || null;
            if (!isBulkMessaging) {
                processBulkMsgQueue();
            }
        }
    }
});

async function reportProgress(phone, stepName) {
    chrome.storage.local.set({ 
        kscl_bulk_msg_result: { 
            phone: phone, 
            status: 'PROGRESS', 
            step: stepName,
            time: new Date().toISOString() 
        } 
    });
    await sleep(200);
}

async function processBulkMsgQueue(isContinuation = false) {
    if (bulkMsgQueue.length === 0) {
        chrome.storage.local.set({ kscl_bulk_msg_result: { status: 'DONE' } });
        isBulkMessaging = false;
        let w = document.getElementById('kscl-bot-widget');
        if (w) w.style.display = 'block';
        return;
    }
    
    let w = document.getElementById('kscl-bot-widget');
    if (w) w.style.display = 'none';
    
    if (isBulkMessaging && !isContinuation && bulkMsgQueue.length > 0 && !document.hidden) {
        // Prevent concurrent loops if not a continuation
    }
    isBulkMessaging = true;
    
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
        alert("KSCL [V2]: Không tìm thấy ô tìm kiếm Zalo.");
        chrome.storage.local.set({ kscl_bulk_msg_result: { status: 'DONE' } });
        isBulkMessaging = false;
        return;
    }
    
    let phone = bulkMsgQueue[0];
    let msgStatus = 'FAILED';
      await reportProgress(phone, 'Đang chuẩn bị tìm kiếm SĐT...');
    
    try {
        let clearBtn = document.querySelector('.search-clear, .btn-clear, i.fa-close, [icon="close"], .close-search');
        if (clearBtn) { try { clearBtn.click(); } catch(e){} }
        setNativeValue(searchInput, '');
        await sleep(300);
        
        setNativeValue(searchInput, phone);
          await reportProgress(phone, 'Đang gõ SĐT vào ô tìm kiếm...');
        
        let targetItem = null;
        let card = null;
        
        for (let wait = 0; wait < 35; wait++) {
            await sleep(300);
            
            // Primary check: Zalo's contact items
            let possibleCards = document.querySelectorAll('.contact-item, .search-res-item, .global-search-item, [data-id], .list-item');
            for (let item of possibleCards) {
                let text = item.innerText || '';
                let rawText = text.replace(/[\s\.\-\+]/g, '');
                
                // CRUCIAL: Do not falsely match recent chats!
                let isMatch = rawText.includes(phone) || 
                              text.toLowerCase().includes("tìm bạn qua") || 
                              text.toLowerCase().includes("tìm liên hệ");
                              
                if (isMatch) {
                    if (item.querySelector('img')) {
                        card = item;
                        break;
                    }
                }
            }
            
            // Fallback check: any div with image and phone
            if (!card) {
                let allDivs = document.querySelectorAll('div');
                for (let div of allDivs) {
                    let text = div.innerText || '';
                    let rawText = text.replace(/[\s\.\-\+]/g, '');
                    if (rawText.includes(phone)) {
                        if (div.querySelector('img') && text.length < 200) {
                            card = div;
                            // Find the most inner card-like div
                            let children = div.querySelectorAll('div');
                            for(let child of children) {
                                let ctext = child.innerText || '';
                                if (ctext.replace(/[\s\.\-\+]/g, '').includes(phone) && child.querySelector('img')) {
                                    card = child;
                                }
                            }
                            break;
                        }
                    }
                }
            }
            
            if (card) {
                break;
            }
            
            let toast = document.querySelector('.toast, .snackbar, .error-msg, .search-empty');
            if (toast) {
                let tt = toast.innerText.toLowerCase();
                if (tt.includes("chưa đăng ký") || tt.includes("không tồn tại") || tt.includes("không tìm thấy") || tt.includes("không có kết quả") || tt.includes("không tìm thấy kết quả")) {
                    break;
                }
            }
        }
        
        if (card) {
            // Click to open chat
            card.click();
            await reportProgress(phone, 'Đã tìm thấy, đang mở đoạn chat...');
            await sleep(1500); // Wait for chat to load
            
            let chatInput = document.querySelector('#richInput, .chat-input, [contenteditable="true"]');
            if (!chatInput) {
                let allContentEditable = document.querySelectorAll('[contenteditable="true"]');
                for (let ce of allContentEditable) {
                    if (ce.offsetHeight > 20) {
                        chatInput = ce;
                        break;
                    }
                }
            }
            
            if (chatInput) {
                chatInput.focus();
                
                if (currentBulkMsg !== '') {
                    document.execCommand('insertText', false, currentBulkMsg);
                    chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                    await sleep(500);
                }
                
                // If we have an attachment, try to paste it
                if (currentBulkAttachment) {
                  await reportProgress(phone, 'Đang tải file đính kèm vào bộ nhớ...');
                    try {
                        let res = await fetch(currentBulkAttachment.data);
                        let blob = await res.blob();
                        let file = new File([blob], currentBulkAttachment.name, { type: currentBulkAttachment.type });
                        
                        let dt = new DataTransfer();
                        dt.items.add(file);
                        
                        let pasteEvent = new ClipboardEvent('paste', {
                            clipboardData: dt,
                            bubbles: true,
                            cancelable: true
                        });
                        chatInput.dispatchEvent(pasteEvent);
                          await reportProgress(phone, 'Đã dán file đính kèm, đang chờ Zalo upload...');
                        await sleep(3500); // Wait for Zalo preview modal to appear or attach and finish uploading image
                        
                        // Wait a bit more if Zalo shows a modal for image
                        let sendModalBtn = document.querySelector('.modal-content .btn-primary, .ReactModalPortal .btn-primary');
                        if (sendModalBtn && (sendModalBtn.innerText.toLowerCase().includes('gửi') || sendModalBtn.innerText.toLowerCase().includes('send'))) {
                            sendModalBtn.click();
                            await sleep(1000);
                        }
                    } catch (e) {
                        console.error("KSCL: Failed to paste attachment", e);
                    }
                }
                
                // If we pasted an image, Zalo might have already sent it if we pressed the modal button.
                // But if there was text, we might still need to press Enter.
                // Let's just press Enter or click Send to be safe.
                if (currentBulkMsg !== '' || currentBulkAttachment) {
                    // Try to find the Send button explicitly
                    let sendBtn = document.querySelector('.btn-send, .send-btn, [icon="send"], [icon="send-2"], [icon="Send_2"], [data-id="btn_Send_Msg"], [data-translate-inner="STR_SEND"]');
                    
                    if (!sendBtn) {
                        // Fallback: look for a blue button or a button with an icon that looks like send
                        let icons = document.querySelectorAll('i[icon*="send"], div[icon*="send"], span[icon*="send"]');
                        for (let ic of icons) {
                            if (ic.offsetWidth > 0) {
                                sendBtn = ic;
                                break;
                            }
                        }
                    }
                    
                    // 0. Force a space if empty to wake up React's Send Button state
                    await reportProgress(phone, 'Đang chuẩn bị bấm Gửi...');
                      if (currentBulkMsg === '' && currentBulkAttachment) {
                        document.execCommand('insertText', false, ' ');
                        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                        await sleep(300);
                    }
                    
                    // 1. Aggressive Button Click
                    if (!sendBtn) {
                        // Look for the blue circle button specifically
                        let allDivs = document.querySelectorAll('div');
                        for (let d of allDivs) {
                            if (d.getAttribute('data-id') === 'btn_Send_Msg' || d.getAttribute('icon') === 'send-2') {
                                sendBtn = d;
                                break;
                            }
                        }
                    }
                    
                    // If still no send button, try to find it near chatInput
                    if (!sendBtn && chatInput) {
                        let container = chatInput.closest('[data-id="div_Main_Chat_Input_Container"]') || chatInput.parentElement.parentElement.parentElement;
                        if (container) {
                            let svgs = container.querySelectorAll('svg, i');
                            if (svgs.length > 0) {
                                // The last SVG is usually the send button
                                sendBtn = svgs[svgs.length - 1];
                                if (sendBtn.parentElement) sendBtn = sendBtn.parentElement;
                            }
                        }
                    }
                    
                    if (sendBtn) {
                        let targets = [sendBtn, sendBtn.parentElement, sendBtn.parentElement?.parentElement];
                        for (let t of targets) {
                            if (!t) continue;
                            const mouseEventInit = { bubbles: true, cancelable: true, view: window };
                            t.dispatchEvent(new MouseEvent('pointerdown', mouseEventInit));
                            t.dispatchEvent(new MouseEvent('mousedown', mouseEventInit));
                            t.dispatchEvent(new MouseEvent('pointerup', mouseEventInit));
                            t.dispatchEvent(new MouseEvent('mouseup', mouseEventInit));
                            t.dispatchEvent(new MouseEvent('click', mouseEventInit));
                            try { t.click(); } catch(e){}
                        }
                    }
                    
                    // RE-FETCH chat input because React might have destroyed and recreated it after pasting!
                    chatInput = document.querySelector('#richInput, .chat-input, [contenteditable="true"]');
                    if (!chatInput) {
                        let allContentEditable = document.querySelectorAll('[contenteditable="true"]');
                        for (let ce of allContentEditable) {
                            if (ce.offsetHeight > 20) { chatInput = ce; break; }
                        }
                    }
                    if (chatInput) {
                        chatInput.focus();
                        chatInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                        await sleep(300);
                    }

                    // 1b. Re-fetch Send button after input event
                    if (!sendBtn || !document.body.contains(sendBtn)) {
                        let allDivs = document.querySelectorAll('div');
                        for (let d of allDivs) {
                            if (d.getAttribute('data-id') === 'btn_Send_Msg' || d.getAttribute('icon') === 'send-2' || d.getAttribute('data-translate-inner') === 'STR_SEND') {
                                sendBtn = d;
                                break;
                            }
                        }
                    }
                    if (sendBtn) {
                        let targets = [sendBtn, sendBtn.parentElement, sendBtn.parentElement?.parentElement];
                        for (let t of targets) {
                            if (!t) continue;
                            const mouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: 10, clientY: 10 };
                            t.dispatchEvent(new MouseEvent('pointerdown', mouseEventInit));
                            t.dispatchEvent(new MouseEvent('mousedown', mouseEventInit));
                            t.dispatchEvent(new MouseEvent('pointerup', mouseEventInit));
                            t.dispatchEvent(new MouseEvent('mouseup', mouseEventInit));
                            t.dispatchEvent(new MouseEvent('click', mouseEventInit));
                            try { t.click(); } catch(e){}
                        }
                    }

                    // 2. Aggressive Enter Key (with selection focus)
                    if (chatInput) {
                        try {
                            let range = document.createRange();
                            range.selectNodeContents(chatInput);
                            range.collapse(false);
                            let sel = window.getSelection();
                            sel.removeAllRanges();
                            sel.addRange(range);
                        } catch(e){}
                        chatInput.focus();
                        
                        let eventTypes = ['keydown', 'keypress', 'keyup'];
                        for (let type of eventTypes) {
                            chatInput.dispatchEvent(new KeyboardEvent(type, { 
                                key: 'Enter', 
                                code: 'Enter', 
                                keyCode: 13, 
                                which: 13,
                                charCode: 13,
                                bubbles: true,
                                cancelable: true,
                                composed: true
                            }));
                        }
                    }
                    
                    // Tell widget what happened
                    let wTxt = document.querySelector('#kscl-bot-widget div:nth-child(2) div');
                    if (wTxt) {
                        wTxt.innerText = "SendBtn Found: " + !!sendBtn;
                    }
                }
                
                await reportProgress(phone, 'Đã bấm Gửi xong!');
                  msgStatus = 'SUCCESS';
                await sleep(1000); // Wait after sending
            }
        }
        
        let clearBtn2 = document.querySelector('.search-clear, .btn-clear, i.fa-close, [icon="close"], .close-search');
        if (clearBtn2) { try { clearBtn2.click(); } catch(e){} }
        setNativeValue(searchInput, '');
        
    } catch (err) {
        // Ignored
    }
    
    chrome.storage.local.set({ 
        kscl_bulk_msg_result: { 
            phone: phone, 
            status: msgStatus, 
            time: new Date().toISOString() 
        } 
    });
    
    bulkMsgQueue.shift();
    
    if (bulkMsgQueue.length > 0) {
        setTimeout(() => processBulkMsgQueue(true), 3500);
    } else {
        chrome.storage.local.set({ kscl_bulk_msg_result: { status: 'DONE' } });
        isBulkMessaging = false;
    }
}

// --- INVITE MEMBER LOGIC ---
let inviteQueue = [];
let isInviting = false;

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.kscl_cmd_invite) {
        let payload = changes.kscl_cmd_invite.newValue;
        if (payload && payload.phones && payload.phones.length > 0) {
            inviteQueue = [...payload.phones];
            if (!isInviting) {
                processInviteQueue();
            }
        }
    }
});

async function processInviteQueue() {
    if (inviteQueue.length === 0) {
        chrome.storage.local.set({ kscl_invite_result: { status: 'DONE' } });
        isInviting = false;
        return;
    }
    
    isInviting = true;
    
    // Find modal search input (usually inside a ReactModalPortal or .zl-modal)
    // Zalo's add member modal has an input placeholder "Nhập tên, số điện thoại..."
    let searchInput = null;
    let allInputs = document.querySelectorAll('input[type="text"], input');
    for (let inp of allInputs) {
        if (inp.placeholder && (inp.placeholder.toLowerCase().includes('nhập') || inp.placeholder.toLowerCase().includes('số điện thoại') || inp.placeholder.toLowerCase().includes('tìm')) && (inp.closest('.zl-modal') || inp.closest('.ReactModalPortal') || inp.closest('.modal-content') || inp.closest('[data-id="div_AddMember_SearchInput"]'))) {
            searchInput = inp;
            break;
        }
    }
    
    if (!searchInput) {
        // Fallback: look for ANY visible input that is NOT the main search input
        for (let inp of allInputs) {
            if (inp.offsetWidth > 0 && inp.offsetHeight > 0 && inp.id !== 'contact-search-input' && inp.id !== 'global-search-input') {
                searchInput = inp;
                break;
            }
        }
    }
    
    if (!searchInput) {
        alert("KSCL [V2]: Không tìm thấy ô tìm kiếm trong cửa sổ 'Thêm thành viên'. Vui lòng bấm nút 'Thêm thành viên' trên Zalo trước khi chạy!");
        chrome.storage.local.set({ kscl_invite_result: { status: 'DONE' } });
        isInviting = false;
        return;
    }
    
    let phone = inviteQueue[0];
    let msgStatus = 'FAILED';
      await reportProgress(phone, 'Đang chuẩn bị tìm kiếm SĐT...');
    
    try {
        // Clear input first
        let clearBtn = searchInput.parentElement ? searchInput.parentElement.querySelector('i.fa-close, [icon="close"], .btn-clear') : null;
        if (clearBtn) { try { clearBtn.click(); } catch(e){} }
        setNativeValue(searchInput, '');
        await sleep(300);
        
        // Type phone number
        setNativeValue(searchInput, phone);
          await reportProgress(phone, 'Đang gõ SĐT vào ô tìm kiếm...');
        
        let targetItem = null;
        
        // Wait for search result in modal
        for (let wait = 0; wait < 35; wait++) {
            await sleep(300);
            
            // Search results in modal usually are radio buttons or div with contact name
            // Let's find the nearest container of searchInput and search inside it, or just search globally for the phone number
            let allElements = document.querySelectorAll('.zl-modal div, .ReactModalPortal div, .modal-content div, [data-id="div_AddMember_Item"]');
            targetItem = null;
            
            for (let item of allElements) {
                let text = item.innerText || '';
                let rawText = text.replace(/[\s\.\-\+]/g, '');
                if (rawText.includes(phone) || text.includes(phone)) {
                    // Check if it's a clickable contact item (usually has a checkbox or avatar)
                    if (item.querySelector('img') || item.classList.contains('contact-item') || item.querySelector('.checkbox') || item.querySelector('input[type="checkbox"]') || item.querySelector('input[type="radio"]')) {
                        targetItem = item;
                        break;
                    }
                }
            }
            
            // If we found a direct match, break
            if (targetItem) break;
            
            // Or look for toast / empty state
            let emptyState = document.querySelector('.zl-modal .empty-search, .ReactModalPortal .search-empty');
            if (emptyState && emptyState.innerText.toLowerCase().includes("không tìm thấy")) {
                break;
            }
        }
        
        if (targetItem) {
            // Click to select
            targetItem.click();
            // If there's a specific checkbox inside, try clicking that too just in case
            let cb = targetItem.querySelector('input[type="checkbox"], input[type="radio"], .checkbox, .custom-checkbox');
            if (cb) {
                try { cb.click(); } catch(e){}
            }
            await reportProgress(phone, 'Đã bấm Gửi xong!');
                  msgStatus = 'SUCCESS';
            await sleep(500); // Wait for checkbox animation
        }
        
        // Clear input for next number
        let clearBtn2 = searchInput.parentElement ? searchInput.parentElement.querySelector('i.fa-close, [icon="close"], .btn-clear') : null;
        if (clearBtn2) { try { clearBtn2.click(); } catch(e){} }
        setNativeValue(searchInput, '');
        
    } catch (err) {
        // Ignored
    }
    
    chrome.storage.local.set({ 
        kscl_invite_result: { 
            phone: phone, 
            status: msgStatus, 
            time: new Date().toISOString() 
        } 
    });
    
    inviteQueue.shift();
    
    if (inviteQueue.length > 0) {
        // Delay 1.5s between selections inside the modal is usually safe enough since it doesn't trigger the global search rate limit as aggressively, but let's use 2.5s to be safe
        setTimeout(() => processInviteQueue(), 2500);
    } else {
        chrome.storage.local.set({ kscl_invite_result: { status: 'DONE' } });
        isInviting = false;
    }
}



// --- AUTOCARE (ADD FRIEND) LOGIC ---
let autocareQueue = [];
let currentAutocareMsg = '';
let isAutocareRunning = false;

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.kscl_cmd_autocare) {
        let payload = changes.kscl_cmd_autocare.newValue;
        if (payload && payload.phones && payload.phones.length > 0) {
            autocareQueue = [...payload.phones];
            currentAutocareMsg = payload.message;
            if (!isAutocareRunning) {
                processAutocareQueue();
            }
        }
    }
});

async function processAutocareQueue() {
    if (autocareQueue.length === 0) {
        chrome.storage.local.set({ kscl_autocare_result: { status: 'DONE' } });
        isAutocareRunning = false;
        return;
    }
    
    isAutocareRunning = true;
    
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
        alert("KSCL [V2]: Không tìm thấy ô tìm kiếm Zalo.");
        chrome.storage.local.set({ kscl_autocare_result: { status: 'DONE' } });
        isAutocareRunning = false;
        return;
    }
    
    let phone = autocareQueue[0];
    let msgStatus = 'FAILED';
      await reportProgress(phone, 'Đang chuẩn bị tìm kiếm SĐT...');
    
    try {
        let clearBtn = document.querySelector('.search-clear, .btn-clear, i.fa-close, [icon="close"], .close-search');
        if (clearBtn) { try { clearBtn.click(); } catch(e){} }
        setNativeValue(searchInput, '');
        await sleep(300);
        
        setNativeValue(searchInput, phone);
          await reportProgress(phone, 'Đang gõ SĐT vào ô tìm kiếm...');
        
        let targetItem = null;
        let card = null;
        
        for (let wait = 0; wait < 35; wait++) {
            await sleep(300);
            
            let allElements = document.querySelectorAll('div, span');
            targetItem = null;
            
            for (let item of allElements) {
                let text = item.innerText || '';
                let rawText = text.replace(/[\s\.\-\+]/g, '');
                if (rawText.includes(phone)) {
                    if (!targetItem || text.length < (targetItem.innerText || '').length) {
                        targetItem = item;
                    }
                }
            }
            
            if (targetItem) {
                card = targetItem;
                for (let i = 0; i < 6; i++) {
                    if (card && card.querySelector && card.querySelector('img')) break;
                    if (card && card.parentElement) card = card.parentElement;
                }
                
                if (card && card.querySelector && card.querySelector('img')) {
                    break;
                }
            }
            
            let toast = document.querySelector('.toast, .snackbar, .error-msg, .search-empty');
            if (toast) {
                let tt = toast.innerText.toLowerCase();
                if (tt.includes("chưa đăng ký") || tt.includes("không tồn tại") || tt.includes("không tìm thấy") || tt.includes("không có kết quả") || tt.includes("không tìm thấy kết quả")) {
                    break;
                }
            }
        }
        
        if (card) {
            // Click to open profile or chat
            card.click();
            await reportProgress(phone, 'Đã tìm thấy, đang mở đoạn chat...');
            await sleep(1500); // Wait for chat/profile to load
            
            // Look for 'Kết bạn' button in the chat header or main view
            let addFriendBtn = null;
            let buttons = document.querySelectorAll('div[role="button"], button, div.clickable');
            for (let b of buttons) {
                if ((b.innerText && b.innerText.toLowerCase().includes('kết bạn')) || (b.title && b.title.toLowerCase().includes('kết bạn'))) {
                    // Make sure it's not the "Search" button that says "Tìm bạn bè"
                    if (b.innerText && b.innerText.length < 20) {
                        addFriendBtn = b;
                        break;
                    }
                }
            }
            
            if (addFriendBtn) {
                addFriendBtn.click();
                await sleep(1000); // Wait for Add Friend Modal
                
                // Find the greeting message textarea inside the modal
                let modalTextarea = document.querySelector('.zl-modal textarea, .ReactModalPortal textarea, textarea');
                if (modalTextarea) {
                    setNativeValue(modalTextarea, ''); // clear default greeting
                    await sleep(100);
                    setNativeValue(modalTextarea, currentAutocareMsg);
                    modalTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                    await sleep(300);
                }
                
                // Click "Kết bạn" (Confirm) button in the modal
                let confirmBtns = document.querySelectorAll('.zl-modal .btn-primary, .ReactModalPortal .btn-primary, .btn.btn-primary');
                for (let cb of confirmBtns) {
                    if (cb.innerText && cb.innerText.toLowerCase().includes('kết bạn')) {
                        cb.click();
                        await reportProgress(phone, 'Đã bấm Gửi xong!');
                  msgStatus = 'SUCCESS';
                        break;
                    }
                }
                await sleep(1500); // wait for request to be sent
            } else {
                // Already friends, or button not found
                msgStatus = 'FAILED_OR_ALREADY_FRIENDS';
            }
        }
        
        let clearBtn2 = document.querySelector('.search-clear, .btn-clear, i.fa-close, [icon="close"], .close-search');
        if (clearBtn2) { try { clearBtn2.click(); } catch(e){} }
        setNativeValue(searchInput, '');
        
    } catch (err) {
        // Ignored
    }
    
    chrome.storage.local.set({ 
        kscl_autocare_result: { 
            phone: phone, 
            status: msgStatus, 
            time: new Date().toISOString() 
        } 
    });
    
    autocareQueue.shift();
    
    if (autocareQueue.length > 0) {
        setTimeout(() => processAutocareQueue(), 3500);
    } else {
        chrome.storage.local.set({ kscl_autocare_result: { status: 'DONE' } });
        isAutocareRunning = false;
    }
}
