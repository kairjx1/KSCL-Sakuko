const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const runner = require('./agent-runner');
const { getSystemInfo } = require('./setup-check');

// BUG NGHIÊM TRỌNG đã tìm ra (báo qua ảnh chụp thật — đang chat, gửi kèm vài ảnh đính kèm cho
// agent xử lý, thì MẤT KẾT NỐI và KHÔNG BAO GIỜ tự hồi phục, phải khởi động lại hẳn KAgent):
// server.js KHÔNG HỀ có bất kỳ lớp bắt lỗi toàn cục nào (`uncaughtException`/
// `unhandledRejection`) — trong khi `ws.on('message', async (raw) => {...})` là 1 hàm async
// dùng làm event listener, lỗi ném ra bên trong (kể cả từ code xử lý file đính kèm mới, hay
// BẤT KỲ chỗ nào khác trong toàn bộ switch/case) không có ai `catch` sẽ trở thành 1
// "unhandled rejection" — mặc định Node.js (từ v15+) SẼ TỰ THOÁT TIẾN TRÌNH khi gặp việc này.
// Kết quả: 1 lỗi nhỏ bất kỳ, ở BẤT KỲ tính năng nào, làm SẬP TOÀN BỘ server, rớt kết nối của
// TẤT CẢ mọi người đang chat cùng lúc, và service không tự khởi động lại (phải mở lại tay).
// Đây là lỗ hổng nghiêm trọng nhất từng phát hiện trong toàn bộ dự án — ưu tiên vá đầu tiên,
// đặt ở TRÊN CÙNG file, trước cả mọi require/logic khác, để bắt được lỗi từ bất kỳ đâu.
// BUG THẬT tiềm ẩn đã tìm ra khi thiết kế cơ chế "nạp lại core ngay trong tiến trình" (server.js
// giờ có thể bị require() lại NHIỀU LẦN sau khi xoá `require.cache`, xem launcher.js's
// global.__kagentReloadCore): đăng ký thẳng `process.on(...)` như bình thường sẽ CHỒNG THÊM 2
// listener mới trên `process` mỗi lần nạp lại core, không ai gỡ bản cũ — rò rỉ dần, tới lần thứ
// 11 Node cảnh báo "MaxListenersExceededWarning". Chỉ đăng ký 1 LẦN DUY NHẤT cho cả vòng đời
// tiến trình (không phải mỗi lần module này được require) — giống cách đã vá cho agent-runner.js.
if (!global.__kagentProcessHandlersRegistered) {
  global.__kagentProcessHandlersRegistered = true;
  process.on('uncaughtException', (err) => {
    console.error('[KAgent] ⚠️ LỖI KHÔNG BẮT ĐƯỢC (đã chặn không cho sập server):', err && (err.stack || err.message || err));
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[KAgent] ⚠️ PROMISE LỖI KHÔNG BẮT ĐƯỢC (đã chặn không cho sập server):', reason && (reason.stack || reason.message || reason));
  });
}

const PORT = process.env.KAGENT_PORT || process.env.PORT || 8766;
// DATA_DIR: khi đóng gói exe, data lưu cạnh exe; khi dev thì trong thư mục kagent/data
const DATA_DIR = process.env.KAGENT_DATA_DIR || path.join(__dirname, 'data');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
const PUBLIC_DIR = process.env.KAGENT_PUBLIC_DIR || path.join(__dirname, 'public');
// no-cache cho .html: launcher tải index.html mới mỗi lần khởi động app, nhưng nếu
// trình duyệt/webview giữ cache cũ thì người dùng vẫn thấy giao diện cũ dù file trên
// đĩa đã mới — ép revalidate mỗi lần load để tránh lẫn lộn "đã sửa mà không thấy gì".
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// Cache relay credentials từ client (cập nhật mỗi khi client kết nối WS với token)
// Dùng bởi AI khi gọi /api/memory qua curl (không có Bearer header)
const _relaySession = { token: null, userId: null };
function cacheRelaySession(token, userId) {
  if (token) _relaySession.token = token;
  if (userId) _relaySession.userId = userId;
}

// ─── SETUP CONFIG ───────────────────────────────────────────────────────────
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function writeConfig(data) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

// Redirect / → setup nếu chưa setup xong
app.get('/', (req, res) => {
  const cfg = readConfig();
  if (!cfg.setupDone) return res.redirect('/setup.html');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Relay auth callback — Lark OAuth redirect về đây
app.get('/auth/success', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Config cho frontend biết relay URL
const RELAY_URL = 'https://kagent-relay.kairjx1.workers.dev';
const SERVER_SECRET = 'kagent-server-2026-kscl'; // Phải khớp wrangler.toml
app.get('/api/relay-config', (req, res) => {
  res.json({ relayUrl: RELAY_URL });
});

// BUG THẬT phát hiện khi rà soát (báo cáo người dùng "Invalid host defined options" khi
// bấm Chắt lọc ngay): fetch() (Fetch API, vẫn experimental ở Node 18) bên trong file .exe
// đóng gói bằng pkg KHÔNG ổn định — đã từng phát hiện + vá cho các lệnh auto-update
// (UPDATE_BASE), nhưng TOÀN BỘ lệnh gọi relay (chat, tin nhắn, tóm tắt, bộ nhớ...) vẫn
// dùng fetch() thường nên vẫn dính lỗi này. LÝ DO BỎ SÓT: suốt phiên làm việc test bằng
// `node server.js` trực tiếp (fetch ổn định trong Node thường) — KHÔNG chạy qua đúng file
// .exe thật, nên không bắt được lỗi chỉ xảy ra khi đóng gói. Từ nay MỌI lệnh gọi relay dùng
// hàm này (module https gốc, ổn định), không dùng fetch() thường nữa.
function httpsRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    // QUAN TRỌNG: truyền THẲNG chuỗi url cho https.request (để Node tự parse), giống
    // đúng cách httpsGetText/httpsGetBuffer đã chạy ổn định — KHÔNG tự tách hostname/
    // port/path bằng new URL() rồi dựng lại object. Bản đầu tự tách thủ công gây lỗi
    // thật "Invalid host defined options" khi chạy trong file .exe đóng gói bằng pkg
    // (đã tái hiện + xác nhận bằng test qua đúng file .exe thật, không phải node
    // server.js — lỗi này KHÔNG xuất hiện khi chạy node thường nên dễ bỏ sót).
    const method = opts.method || 'GET';
    const headers = { 'User-Agent': 'KAgent', ...(opts.headers || {}) };
    let bodyData = null;
    if (opts.body !== undefined) {
      bodyData = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }
    const req = https.request(url, { method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: async () => { try { return JSON.parse(data); } catch { return null; } },
        text: async () => data,
      }));
    });
    req.setTimeout(opts.timeoutMs || 10000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// ─── RELAY SERVER SYNC ───────────────────────────────────────────────────────
// Server tự sync messages lên relay mà không cần cookie user
async function relayEnsureChat(chatId, chatName, agentId, userId) {
  try {
    await httpsRequest(`${RELAY_URL}/server/sync-chat`, {
      method: 'POST',
      headers: { 'X-Server-Key': SERVER_SECRET },
      body: { chatId, chatName, agent: agentId, userId: userId || 'server' },
    });
  } catch {}
}

async function relaySyncMessage(chatId, role, content, id) {
  if (!content || !content.trim()) return;
  try {
    // Truyền id (khi có) để relay dùng ĐÚNG id đó thay vì tự sinh — cho phép xóa 1 tin
    // nhắn ở cả local db lẫn relay bằng chung 1 mã, xem chi tiết ở nơi gọi hàm này.
    await httpsRequest(`${RELAY_URL}/server/sync-msg`, {
      method: 'POST',
      headers: { 'X-Server-Key': SERVER_SECRET },
      body: { chatId, role, content: content.trim(), id },
    });
  } catch {}
}

// Load lịch sử từ relay để inject làm context
async function relayGetHistory(chatId, limit = 20) {
  try {
    // timeoutMs: nếu thiếu, relay chậm/treo sẽ làm Promise.all ở case 'prompt'
    // KHÔNG BAO GIỜ resolve → agent KHÔNG BAO GIỜ được khởi động, im lặng tuyệt đối,
    // không lỗi, không log — chính xác kiểu "bấm gửi mà không thấy gì chạy" người dùng
    // gặp phải. Đã tái hiện được lỗi này bằng test thật trước khi vá.
    const res = await httpsRequest(`${RELAY_URL}/server/chats/${chatId}/messages?limit=${limit}`, {
      headers: { 'X-Server-Key': SERVER_SECRET },
      timeoutMs: 6000,
    });
    if (!res.ok) return [];
    return (await res.json()) || [];
  } catch { return []; }
}

// Tổng số tin nhắn THẬT của chat, lấy từ relay (D1) — bền qua restart, không như đếm
// bằng biến RAM. Dùng để tính đúng mốc auto-summarize mỗi 20 tin dù server có restart
// giữa chừng (release/update KAgent rất hay restart process).
async function relayGetMessageCount(chatId) {
  try {
    const res = await httpsRequest(`${RELAY_URL}/server/chats/${chatId}/messages/count`, {
      headers: { 'X-Server-Key': SERVER_SECRET },
    });
    if (!res.ok) return 0;
    const d = await res.json();
    return d?.count || 0;
  } catch { return 0; }
}

// Phase 3: Load tóm tắt phiên trước (cross-machine memory)
async function relayGetSummary(chatId) {
  try {
    const res = await httpsRequest(`${RELAY_URL}/server/chat-summary/${chatId}`, {
      headers: { 'X-Server-Key': SERVER_SECRET },
      timeoutMs: 6000, // xem giải thích ở relayGetHistory
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Phase 4: Đọc memory của user từ relay (inject vào AI context)
async function relayGetMemory(userId) {
  if (!userId) return {};
  try {
    const res = await httpsRequest(`${RELAY_URL}/server/memory/${encodeURIComponent(userId)}`, {
      headers: { 'X-Server-Key': SERVER_SECRET },
      timeoutMs: 6000, // xem giải thích ở relayGetHistory
    });
    if (!res.ok) return {};
    return (await res.json()) || {};
  } catch { return {}; }
}

// Phase 3: Lưu tóm tắt phiên làm việc lên relay
async function relaySaveSummary(chatId, summary, msgCount) {
  try {
    await httpsRequest(`${RELAY_URL}/server/chat-summary`, {
      method: 'POST',
      headers: { 'X-Server-Key': SERVER_SECRET },
      body: { chatId, summary, msgCount },
    });
  } catch {}
}

// Phase 3: Gọi 1 CLI agent ở chế độ --print để tóm tắt (không streaming, 1 lượt).
// Thử claude trước (nhanh/free, khuyến nghị) — nếu máy không cài/không chạy được thì
// fallback sang agent khác đang có cài trên máy (agy...) để auto-summarize không bị
// câm lặng thất bại mãi mãi trên những máy không có Claude Code CLI.
// Spawn 1 lệnh, gom stdout, có timeout — dùng cross-spawn (KHÔNG dùng child_process.execFile
// trần) vì nhiều CLI agent cài qua npm global trên Windows thực chất là file .cmd wrapper
// (gemini, opencode...), và execFile trần KHÔNG tự resolve .cmd qua PATHEXT như cmd.exe làm
// (đây là đúng lý do cross-spawn tồn tại) — gọi thẳng execFile('gemini', ...) luôn ném
// "ENOENT" dù lệnh đó chạy tốt trong chat thật (chat thật dùng cross-spawn, chỗ này trước
// đây lại dùng execFile trần nên bị hỏng riêng chỉ ở tính năng tóm tắt).
// opts.input (nếu có) → ghi vào stdin của tiến trình con rồi đóng (xem lý do ở runPrintLLM).
function spawnCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('cross-spawn');
    let child;
    // BUG THẬT KHÁC NỮA, chỉ lộ ra khi test qua ĐÚNG file .exe đóng gói (không phải
    // "node server.js" như lúc đầu tưởng đã xong việc) — không truyền `cwd` tường minh
    // thì cross-spawn dùng process.cwd() mặc định của tiến trình, mà bên trong snapshot
    // pkg, cwd đó là 1 đường dẫn ẢO trong snapshot (không tồn tại thật trên đĩa) — khiến
    // cross-spawn's tự kiểm tra file .cmd/.exe qua fs.existsSync() luôn thất bại, ném
    // "The system cannot find the file specified." dù lệnh đó chạy tốt trong chat thật
    // (agent-runner.js's spawn() luôn truyền cwd:s.workDir — thư mục THẬT — nên không
    // bao giờ dính bug này). Luôn truyền 1 thư mục THẬT trên đĩa (os.tmpdir()) ở đây.
    try { child = spawn(cmd, args, { cwd: require('os').tmpdir(), windowsHide: true, stdio: [opts.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(e); }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('timeout'));
    }, opts.timeout || 30000);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().slice(0, 300) || `exit code ${code}`));
    });
    if (opts.input != null && child.stdin) {
      child.stdin.write(opts.input, 'utf8');
      child.stdin.end();
    }
  });
}

async function runPrintLLM(prompt, preferredAgentId) {
  // BUG GỐC THẬT SỰ đã tìm ra (sau khi nghi oan các lệnh gọi relay/fetch): dòng này trước
  // đây dùng `await import(...)` (dynamic import ESM) cho module LÕI Node thay vì
  // `require()` thường — dòng này KHÔNG nằm trong try/catch nào của hàm, và dynamic
  // import() với module lõi lại không ổn định khi chạy trong snapshot đóng gói của pkg,
  // ném lỗi khó hiểu "Invalid host defined options" (không liên quan gì tới URL/relay).
  // Đã xác nhận bằng log debug từng bước qua ĐÚNG file .exe thật: lỗi luôn xảy ra ngay khi
  // vào runPrintLLM, trước khi kịp thử "claude" — require() thường ổn định tuyệt đối.
  // BUG THẬT KHÁC NỮA đã tìm ra (báo qua ảnh chụp — vẫn báo lỗi dù đã sửa hết flags/cwd/stdin ở
  // trên): 30 giây là QUÁ NGẮN cho hội thoại dài thật. Test lại với ĐÚNG nội dung 1 chat thật
  // (35 tin nhắn) qua đúng file .exe đóng gói — claude trả lời đúng, chất lượng tốt, nhưng mất
  // 29.5 GIÂY, sát nút ngưỡng 30s cũ tới mức chỉ cần dao động bình thường của LLM (mạng chậm 1
  // chút, model nghĩ lâu hơn vài giây) là bị `spawnCapture` tự SIGKILL giữa chừng, rơi xuống thử
  // agent khác — mà agent khác (gemini đang lỗi tài khoản, agent chưa quen) dễ fail tiếp, ra
  // đúng toast "Không agent nào tóm tắt được" dù thật ra cơ chế không có lỗi gì, chỉ là hết giờ.
  // Nâng lên 90s — vẫn nằm gọn trong hạn 180s phía client (index.html đã có AbortSignal.timeout
  // 180000 + banner "có thể mất 1-2 phút").
  const opts = { timeout: 90000 };

  // BUG THẬT KHÁC đã tìm ra (tách biệt hoàn toàn với bug "Invalid host defined options"
  // ở trên): prompt tóm tắt LUÔN nhiều dòng (nối các tin nhắn bằng '\n\n'). Trên Windows,
  // "claude" (và gemini/codex/opencode) là các CLI cài qua npm global, thực chất resolve
  // ra file ".cmd" wrapper — muốn chạy phải đi qua "cmd.exe /c", mà cmd.exe KHÔNG xử lý
  // được newline nhúng trong 1 tham số dòng lệnh (cắt cụt tại dòng đầu tiên, coi phần sau
  // như lệnh khác). Hậu quả: claude/agent NHẬN ĐƯỢC prompt bị cắt cụt (chỉ còn câu hướng
  // dẫn, mất hết phần "Cuộc hội thoại:..."), vẫn CHẠY THÀNH CÔNG (exit code 0, có
  // "text" thật) nên các dòng try/catch không hề bắt được — nhưng model trả lời kiểu
  // "không thấy nội dung hội thoại nào" vì đúng là nó không nhận được. Đã xác nhận bằng
  // cách gọi TRỰC TIẾP claude qua cross-spawn với đúng prompt thật — tái hiện y hệt lỗi.
  // Fix cho claude: đưa prompt qua STDIN thay vì argv — đã test xác nhận claude --print
  // đọc đúng, đầy đủ từ stdin khi không có tham số vị trí. Test lại cùng prompt qua stdin
  // ra kết quả tóm tắt đúng hoàn toàn.
  // BUG THẬT KHÁC NỮA đã tìm ra (báo qua ảnh chụp — bản tóm tắt lẫn nội dung "agsmem",
  // placeholder {{CWD}}/{{FILE_VAO}}/{{FILE_RA}}/{{BANG_NHANH}}... hoàn toàn không liên quan
  // tới cuộc hội thoại thật, LẶP LẠI dù đã thêm `--disable-slash-commands`): `claude` là CLI
  // trợ lý AGENTIC ĐẦY ĐỦ, không phải model gọi trần — MỌI lần chạy `claude --print` đều tự
  // nạp CLAUDE.md toàn cục + skill đã cài làm system context. `--disable-slash-commands` chỉ
  // tắt được phần "gọi được /skill-name", KHÔNG ngăn được việc model tự liên tưởng/lẫn lộn với
  // kiến thức skill nó đã biết — đã xác nhận lại bằng test lặp 3 lần CÙNG 1 prompt: có lần
  // sạch, có lần vẫn lẫn agsmem, thậm chí có lần in cả cảnh báo nội bộ về
  // `.claude/settings.local.json` ra thẳng stdout. `--bare` (tắt hẳn CLAUDE.md) thì lại phá
  // luôn đăng nhập OAuth/gói thuê bao. Kết luận: `claude` CĂN BẢN không đáng tin cậy để dùng
  // như 1 "model gọi trần" cho việc nội bộ này, dù đã cố hết cách vá qua flag.
  //
  // So sánh trực tiếp: test CÙNG 1 prompt dài thật (35 tin nhắn) qua AntiGravity (agy) — LUÔN
  // ra kết quả sạch, đúng, không lẫn gì (agy không có hệ thống skill/CLAUDE.md kiểu Claude Code
  // nên không dính bug này). Đổi hẳn THỨ TỰ ưu tiên: thử các agent "thuần" (antigravity, gemini,
  // opencode, codex...) TRƯỚC, chỉ dùng `claude` làm phương án CUỐI CÙNG khi không còn agent nào
  // khác cài trên máy — thay vì trước đây claude luôn được thử đầu tiên.
  // Người dùng chỉ ra đúng: "tôi tưởng dùng AI nào thì AI đó tự tóm tắt chứ" — hợp lý, vì đây là
  // chat của HỌ với ĐÚNG agent họ chọn, không phải 1 tác vụ nền vô danh. Ưu tiên đúng agent của
  // chính cuộc chat đó lên ĐẦU danh sách thử (nếu có cài và không phải claude/shell) — chỉ khi
  // agent đó lỗi/không cài mới rơi xuống thứ tự dự phòng đã kiểm chứng (agent thuần khác, rồi
  // claude cuối cùng) để không bao giờ "trắng tay" hoàn toàn.
  const flatPrompt = prompt.replace(/\r?\n+/g, ' ');
  let candidates = runner.getAvailableAgents().filter(a => a.installed && a.id !== 'claude' && a.id !== 'shell');
  if (preferredAgentId && preferredAgentId !== 'claude' && preferredAgentId !== 'shell') {
    const idx = candidates.findIndex(a => a.id === preferredAgentId);
    if (idx > 0) candidates = [candidates[idx], ...candidates.slice(0, idx), ...candidates.slice(idx + 1)];
  }
  for (const a of candidates) {
    try {
      const cfg = runner.getAgentConfigPublic(a.id);
      if (!cfg || !cfg.safeArgs) continue;
      const cmd = runner.resolveAgentCmdPublic(a.id);
      if (!cmd) continue;
      // BUG THẬT đã tìm ra: prompt tóm tắt LUÔN nhiều dòng, các CLI cài qua npm global trên
      // Windows resolve ra file ".cmd" wrapper — chạy qua cmd.exe, mà cmd.exe KHÔNG xử lý được
      // newline nhúng trong 1 tham số dòng lệnh (cắt cụt tại dòng đầu). Làm phẳng newline
      // thành khoảng trắng trước khi nhét vào argv — nhãn "User:"/"Assistant:" vẫn giữ nguyên
      // nên model vẫn phân biệt được ranh giới từng lượt dù mất xuống dòng.
      const args = runner.buildArgs(cfg.safeArgs, flatPrompt);
      const { stdout } = await spawnCapture(cmd, args, opts);
      // antigravity (và agent nào khác khai streamJson:'agy') trả về stream-json từng dòng,
      // không phải text thô — phải gom text_delta của agent_response lại.
      const text = cfg.streamJson === 'agy' ? extractAgyStreamText(stdout) : stdout.trim();
      if (text) {
        console.log(`[KAgent] runPrintLLM: dùng agent "${a.id}" thành công`);
        return text;
      }
    } catch (e2) { console.error(`[KAgent] runPrintLLM: agent "${a.id}" lỗi —`, e2.message); }
  }

  // claude: PHƯƠNG ÁN CUỐI (xem giải thích ở trên) — vẫn giữ `--disable-slash-commands` +
  // stdin làm phòng ngừa thêm dù không tuyệt đối tin cậy, còn hơn không có gì.
  try {
    const { stdout } = await spawnCapture('claude', ['--print', '--output-format', 'text', '--disable-slash-commands'], { ...opts, input: prompt });
    if (stdout.trim()) {
      console.log('[KAgent] runPrintLLM: dùng agent "claude" (phương án cuối) thành công');
      return stdout.trim();
    }
  } catch (e) {
    console.error('[KAgent] runPrintLLM: claude lỗi —', e.message);
  }
  return '';
}

// Gom text_delta của các step_update.agent_response trong output stream-json của agy
// (AntiGravity) thành 1 đoạn text liền — cùng field đã xác nhận đúng qua bắt luồng thật
// trong agent-runner.js (handleAgyLine).
function extractAgyStreamText(stdout) {
  let text = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const su = ev.step_update;
      if (ev.event === 'step_update' && su?.step_type === 'agent_response' && su.text_delta) {
        text += su.text_delta;
      }
    } catch { /* dòng không phải JSON hợp lệ, bỏ qua */ }
  }
  return text.trim();
}

// Phase 3: Auto-summarize cuộc hội thoại (chạy bất đồng bộ, không block)
// Giống /compact của Claude Code — nén lịch sử thành briefing ngắn gọn
// Key lưu hướng dẫn tùy chỉnh do người dùng nhập ở panel "🧠 Bộ nhớ" (dùng chung cơ chế /api/memory).
// Nếu chưa lưu gì thì dùng nguyên văn DEFAULT_SUMMARY_INSTRUCTION — client cũng lấy đúng chuỗi này
// (qua GET /api/summary-prompt-default) để điền sẵn vào ô nhập, cho người dùng thấy mặc định là gì.
const MEMORY_PROMPT_KEY = '_summary_prompt_override';
// Cập nhật theo yêu cầu người dùng ("bỏ cái Agsmem đi, tóm tắt này AI sau đọc có hiểu được
// không") sau khi thấy bản tóm tắt thật vẫn kể lể 1 lượt gọi skill agsmem bị lỗi/bỏ dở ngay đầu
// hội thoại — đúng sự thật nhưng không giúp gì cho AI đọc lại sau này, chỉ tổ dài dòng. Thêm rõ:
// (a) bỏ qua tangent/lỗi không còn liên quan, (b) viết thẳng cho 1 AI khác đọc để TIẾP TỤC việc,
// không phải tường thuật lại quá trình cho người đọc thường.
const DEFAULT_SUMMARY_INSTRUCTION = 'Hãy viết lại tóm tắt cuộc hội thoại dưới đây thành một đoạn briefing ngắn gọn (dưới 400 từ) bằng tiếng Việt, dành cho MỘT AI KHÁC đọc lại sau này để tiếp tục đúng công việc — không phải tường thuật lại quá trình cho người đọc thường. Briefing phải bao gồm: (1) Mục tiêu/vấn đề đang giải quyết, (2) Những gì đã làm và quyết định quan trọng, (3) Trạng thái hiện tại và bước tiếp theo. BỎ QUA hoàn toàn các lượt gọi lệnh/công cụ/skill bị lỗi cấu hình, bị bỏ dở, hoặc lạc đề không liên quan tới công việc chính — trừ khi nó vẫn là vướng mắc CHƯA giải quyết và người dùng cần biết để xử lý tiếp. Đi thẳng vào nội dung, không kể lể "ban đầu có một lệnh...". Giữ nguyên thuật ngữ và con số gốc, ý nào lặp lại thì gộp làm một.';

// BUG THẬT đã sửa: hàm này trước đây return "trắng" (undefined) khi chưa đủ 10 tin nhắn —
// endpoint /api/chats/:id/summarize-now vẫn báo {ok:true} vì bản thân request không lỗi gì,
// khiến người dùng thấy toast "✅ Đã cập nhật" dù THỰC RA CHƯA LÀM GÌ CẢ (đã tái hiện đúng
// bằng 1 chat chỉ có 6/20 tin). Giờ luôn trả về {ok, reason} rõ ràng để gọi nơi biết chính
// xác có thật sự tóm tắt hay không, không báo thành công giả.
async function autoSummarizeChat(chatId, recentHistory, lastAssistantMsg, relayToken, preferredAgentId) {
  try {
    // Lấy toàn bộ lịch sử từ relay (tối đa 100 messages)
    const allMsgs = await relayGetHistory(chatId, 100);
    if (allMsgs.length < 10) return { ok: false, reason: `Cần ít nhất 10 tin nhắn để chắt lọc, hiện có ${allMsgs.length}` };

    // Tóm tắt cũ (nếu có) — đưa vào prompt để LLM tự gộp + tự nêu rõ khi có mâu thuẫn,
    // thay vì đè mất thông tin cũ trong im lặng.
    const prevSummary = await relayGetSummary(chatId);

    const historyForSummary = allMsgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 500)}`) // cắt nếu quá dài
      .join('\n\n');

    // Hướng dẫn chắt lọc — người dùng có thể tự sửa qua panel "🧠 Bộ nhớ" (giống ô "Cách chất lọc"
    // bên AGS: điền sẵn mặc định, sửa trực tiếp là thay hẳn, không sửa thì dùng nguyên mặc định).
    // BUG THẬT NGHIÊM TRỌNG đã tìm ra (báo qua yêu cầu "test toàn bộ, không cho phép lỗi tái diễn"
    // — dữ liệu thật trên máy admin bị dính đúng lỗi này từ 2 ngày trước mà không ai biết): giá
    // trị đã lưu ở đây (`MEMORY_PROMPT_KEY`, sửa qua UI, KHÔNG có validation gì) vô tình bị dán
    // nhầm nguyên văn nội dung module Kim Tiêm "Chắt lọc dữ liệu sau 20 câu chat" (dành cho CLI
    // AGSMem riêng, có placeholder CHƯA ĐIỀN {{CWD}}/{{FILE_VAO}}/{{FILE_RA}}/{{BANG_NHANH}}) vào
    // NGAY SAU hướng dẫn tóm tắt thật — mọi lần "chắt lọc" từ đó tới giờ đều gửi placeholder rỗng
    // này cho model, khiến model bỏ qua việc tóm tắt thật, quay lại HỎI LẠI "cho tôi biết
    // {{FILE_VAO}} là gì" (đã tái hiện + xác nhận bằng test thật qua summarize-now). Đây ĐÚNG là
    // kiểu lỗi lặp lại người dùng phàn nàn ("dùng ổn 1 thời gian lại lỗi y như cũ") — vá 1 lần ở
    // ngọn (agent priority) không đủ, vì nguồn ô nhiễm nằm ở DỮ LIỆU đã lưu chứ không phải code.
    // Chặn tận gốc: coi bất kỳ placeholder `{{...}}` CHƯA ĐƯỢC ĐIỀN nào trong hướng dẫn đã lưu là
    // dữ liệu hỏng — tự động bỏ qua, dùng lại DEFAULT_SUMMARY_INSTRUCTION thay vì gửi rác cho
    // model, đồng thời log rõ để biết mà vào sửa lại ô nhập.
    let instruction = readMemory()[MEMORY_PROMPT_KEY]?.value?.trim() || DEFAULT_SUMMARY_INSTRUCTION;
    if (/\{\{[A-Z_]+\}\}/.test(instruction)) {
      console.error(`[KAgent] ⚠ Hướng dẫn chắt lọc đã lưu (panel Bộ nhớ) chứa placeholder chưa điền (vd {{CWD}}) — dữ liệu hỏng, tạm dùng lại mặc định. Vào Cấu hình > Bộ nhớ sửa lại ô "Cách chất lọc".`);
      instruction = DEFAULT_SUMMARY_INSTRUCTION;
    }

    const prompt = `${instruction}
${prevSummary && prevSummary.summary ? `\nTÓM TẮT TRƯỚC ĐÓ (đã có ${prevSummary.msg_count || '?'} tin nhắn):\n${prevSummary.summary}\n\nGộp tóm tắt trước với đoạn hội thoại mới bên dưới thành MỘT bản duy nhất. Nếu có điều gì trong đoạn mới CHỌI với tóm tắt trước (đổi quyết định, đổi số liệu, đổi hướng làm...), ĐỪNG âm thầm ghi đè — ghi rõ một dòng dạng "⚠️ MÂU THUẪN: trước đó là <cũ>, giờ có vẻ là <mới>" ngay trong briefing để người đọc lại biết mà xác nhận lại.\n` : ''}
Cuộc hội thoại${prevSummary && prevSummary.summary ? ' (phần mới)' : ''}:\n${historyForSummary}`;

    const summary = await runPrintLLM(prompt, preferredAgentId);
    let ok = false, reason = '';
    if (summary && summary.length > 50) {
      await relaySaveSummary(chatId, summary, allMsgs.length);
      console.log(`[KAgent] 🧠 Auto-summarized chat ${chatId} (${allMsgs.length} msgs)`);
      ok = true;
    } else {
      reason = 'Không agent nào tóm tắt được (kiểm tra CLI agent có cài/đăng nhập chưa) — giữ nguyên tóm tắt cũ';
      console.error('[KAgent] autoSummarize:', reason);
    }

    // Đúng ý thiết kế người dùng: sau nhiều lượt chat, AI tự "đẩy" các sự thật LÂU DÀI về
    // CHÍNH NGƯỜI DÙNG (không phải nội dung công việc của riêng chat này) ra bộ nhớ cá nhân
    // — người dùng tự xem/sửa/xóa qua tab "🧠 Bộ nhớ" trong Cấu hình. Chỉ chạy khi có token
    // (đã đăng nhập Lark/email) — bộ nhớ cá nhân gắn theo user_id trên relay, không có ở chế
    // độ Local. Lỗi ở bước này KHÔNG được làm hỏng việc tóm tắt chat ở trên — best-effort.
    const token = relayToken || _relaySession.token;
    if (token) await extractPersonalFacts(historyForSummary, token).catch(e => console.error('[KAgent] extractPersonalFacts error:', e.message));

    return ok ? { ok: true } : { ok: false, reason };
  } catch (e) {
    console.error('[KAgent] autoSummarize error:', e.message);
    return { ok: false, reason: e.message };
  }
}

// Trích "sự thật lâu dài về người dùng" từ đoạn hội thoại, ghi vào bảng memory (per-user,
// D1) qua CHÍNH route Bearer đã có sẵn (/api/memory) — dùng token thật của người dùng, không
// cần route riêng ở relay. An toàn: JSON hỏng/model không trả đúng định dạng → bỏ qua im
// lặng, không ảnh hưởng gì tới luồng chat chính.
async function extractPersonalFacts(historyText, token) {
  const prompt = `Từ đoạn hội thoại dưới đây, trích ra các SỰ THẬT LÂU DÀI VỀ CHÍNH NGƯỜI DÙNG (không phải nội dung công việc/dự án cụ thể của cuộc chat này) mà nên nhớ xuyên suốt MỌI cuộc chat trong tương lai — ví dụ: sở thích cách làm việc, vai trò/chức danh, quy tắc họ luôn yêu cầu AI tuân theo, thông tin liên hệ họ tự nói ra.

CHỈ trích thông tin THẬT SỰ xuất hiện rõ ràng trong đoạn hội thoại — TUYỆT ĐỐI không suy đoán/bịa. Nếu không có gì thuộc loại này, trả về mảng rỗng [].

Trả về ĐÚNG JSON, không thêm chữ nào khác ngoài JSON, tối đa 5 mục:
[{"key": "ten_ngan_gon_khong_dau_khong_cach", "value": "nội dung ngắn gọn"}]

Cuộc hội thoại:
${historyText}`;

  const raw = await runPrintLLM(prompt);
  if (!raw) return;
  const jsonMatch = raw.match(/\[[\s\S]*\]/); // phòng khi model bọc thêm ```json hoặc chữ thừa
  if (!jsonMatch) return;
  let facts;
  try { facts = JSON.parse(jsonMatch[0]); } catch { return; }
  if (!Array.isArray(facts)) return;

  for (const f of facts.slice(0, 5)) {
    if (!f || !f.key || f.value === undefined || f.value === null) continue;
    try {
      await httpsRequest(`${RELAY_URL}/api/memory`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { key: String(f.key).slice(0, 60), value: String(f.value).slice(0, 500), tags: ['auto'] },
        timeoutMs: 6000,
      });
    } catch { /* 1 fact lỗi không chặn các fact khác */ }
  }
  if (facts.length) console.log(`[KAgent] 🧠 Đã tự ghi ${facts.length} fact vào bộ nhớ cá nhân`);
}

// ─── RELAY MODULE CACHE ─────────────────────────────────────────────────────
let _moduleCache = null;
let _moduleCacheAt = 0;

async function getRelayModules(token) {
  // Cache 60 giây (per token)
  const cacheKey = token || 'anon';
  if (_moduleCache && _moduleCache._token === cacheKey && Date.now() - _moduleCacheAt < 60000) return _moduleCache._data;
  try {
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await httpsRequest(`${RELAY_URL}/api/modules`, { headers, timeoutMs: 6000 }); // xem giải thích ở relayGetHistory
    const data = await res.json();
    const list = Array.isArray(data) ? data.filter(m => m.enabled) : [];
    _moduleCache = { _token: cacheKey, _data: list };
    _moduleCacheAt = Date.now();
    return list;
  } catch { return []; }
}

// ─── SETUP API ──────────────────────────────────────────────────────────────
app.get('/api/setup/check', (req, res) => res.json(getSystemInfo()));
app.get('/api/system-info', (req, res) => res.json(getSystemInfo()));

app.post('/api/setup/agents', (req, res) => {
  const cfg = readConfig();
  cfg.enabledAgents = req.body.agents || [];
  writeConfig(cfg);
  res.json({ ok: true });
});

app.post('/api/setup/finish', (req, res) => {
  const cfg = readConfig();
  cfg.setupDone = true;
  cfg.setupAt = Date.now();
  writeConfig(cfg);
  res.json({ ok: true });
});

app.get('/api/setup/status', (req, res) => {
  res.json(readConfig());
});

// Reset setup (dùng khi cần cài lại)
app.post('/api/setup/reset', (req, res) => {
  writeConfig({});
  res.json({ ok: true });
});

// (Đã gỡ '/api/relay/chats/:chatId/messages' — route này KHÔNG kiểm tra ai đang hỏi,
// chỉ cần biết đúng chatId là đọc được nội dung của BẤT KỲ ai, phát hiện khi rà soát
// bảo mật. Client giờ gọi thẳng relay's '/api/chats/:id/messages' (Bearer + kiểm tra
// user_id thật) qua relayFetch — xem loadRelayHistory() trong index.html.)

// ── Admin proxy → relay (dùng relay token từ session) ───────────────────────
function relayAdminProxy(method, relayPath) {
  return async (req, res) => {
    // Dùng token từ request header (admin.html gửi Bearer token)
    const token = (req.headers.authorization || '').replace('Bearer ', '') || _relaySession.token;
    if (!token) return res.status(401).json({ error: 'Chưa đăng nhập relay' });
    try {
      const opts = { method, headers: { 'Authorization': `Bearer ${token}` } };
      if (method !== 'GET' && req.body && Object.keys(req.body).length) opts.body = req.body;
      const r = await httpsRequest(`${RELAY_URL}${relayPath}`, opts);
      const data = (await r.json().catch(() => ({}))) || {};
      res.status(r.status).json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}

app.get('/api/admin/users', relayAdminProxy('GET', '/api/admin/users'));
app.patch('/api/admin/users/:id', (req, res) => relayAdminProxy('PATCH', `/api/admin/users/${req.params.id}`)(req, res));
app.delete('/api/admin/users/:id', (req, res) => relayAdminProxy('DELETE', `/api/admin/users/${req.params.id}`)(req, res));
app.post('/api/admin/accounts', relayAdminProxy('POST', '/api/admin/accounts'));
app.post('/api/admin/set-role', relayAdminProxy('POST', '/api/admin/set-role'));

// Đặt lại mật khẩu (Server-to-Server / Local API)
app.post('/api/auth/reset-password', async (req, res) => {
  const { identifier, password, password_hash } = req.body || {};
  if (!identifier || (!password && !password_hash)) {
    return res.status(400).json({ error: 'Thiếu identifier (email/username) hoặc mật khẩu mới' });
  }
  try {
    const r = await httpsRequest(`${RELAY_URL}/server/auth/reset-password`, {
      method: 'POST',
      headers: { 'X-Server-Key': SERVER_SECRET },
      body: { identifier, password, password_hash }
    });
    const data = (await r.json().catch(() => ({}))) || {};
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── REST API ───────────────────────────────────────────────────────────────

// ── MEMORY API ──────────────────────────────────────────────────────────────
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
function readMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch { return {}; }
}
function writeMemory(data) {
  const dir = path.dirname(MEMORY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/memory', (req, res) => {
  const mem = readMemory();
  const { tag } = req.query;
  if (tag) {
    const filtered = Object.fromEntries(
      Object.entries(mem).filter(([, v]) => v.tags?.includes(tag))
    );
    return res.json(filtered);
  }
  res.json(mem);
});

app.get('/api/memory/:key', (req, res) => {
  const mem = readMemory();
  const item = mem[req.params.key];
  if (!item) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(item);
});

app.post('/api/memory', (req, res) => {
  const { key, value, tags = [] } = req.body;
  if (!key || value === undefined) return res.status(400).json({ error: 'Cần key và value' });
  // Chặn tận gốc dữ liệu hỏng dạng "dán nhầm nội dung template khác vào đây" — xem giải thích
  // đầy đủ ở autoSummarizeChat (đã tái hiện + xác nhận: đúng nguyên nhân khiến chắt lọc gửi rác
  // cho model suốt 2 ngày mà không ai biết vì API vẫn báo {ok:true} bình thường). Một prompt/
  // ghi chú thật của người dùng không bao giờ chứa placeholder dạng {{CHU_HOA}} chưa điền —
  // sự xuất hiện của nó luôn là dấu hiệu dán nhầm nội dung, từ chối lưu ngay tại đây thay vì để
  // lỗi âm thầm chờ tới lúc dùng mới lộ ra.
  if (typeof value === 'string' && /\{\{[A-Z_]+\}\}/.test(value)) {
    return res.status(400).json({
      error: 'Nội dung chứa placeholder chưa điền (vd {{CWD}}, {{FILE_VAO}}) — có vẻ bạn dán nhầm nội dung template khác vào đây. Vui lòng kiểm tra lại và dán đúng nội dung mong muốn.',
    });
  }
  const mem = readMemory();
  mem[key] = { value, tags, updatedAt: Date.now() };
  writeMemory(mem);
  // Sync lên relay — dùng token từ request hoặc cached session
  const token = req.body.relayToken || req.headers['x-relay-token'] || _relaySession.token;
  if (token && RELAY_URL) {
    httpsRequest(`${RELAY_URL}/api/memory`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: { key, value, tags },
    }).catch(() => {});
  }
  res.json({ ok: true, key });
});

app.delete('/api/memory/:key', async (req, res) => {
  const mem = readMemory();
  delete mem[req.params.key];
  writeMemory(mem);
  // BUG THẬT đã tìm ra khi người dùng hỏi "đã thực sự xóa khỏi bộ nhớ của bot chưa" — trước đây
  // gọi xóa trên relay kiểu "bắn rồi quên" (không await, .catch nuốt lỗi im lặng) rồi LUÔN báo
  // {ok:true} ngay, kể cả khi relay lỗi/mất mạng đúng lúc đó. Cache local (readMemory/writeMemory)
  // chỉ để server tự dùng khi build prompt lúc CHƯA đăng nhập relay — nơi bot THẬT SỰ đọc mỗi
  // lần chat là D1 qua relay (xem relayGetMemory trong WS 'prompt' handler), nên nếu xóa relay
  // thất bại mà vẫn báo "đã xóa", mục đó VẪN CÒN trong bộ nhớ bot dù UI báo đã hết. Giờ đợi kết
  // quả thật từ relay trước khi trả lời, báo đúng nếu xóa trên relay thất bại.
  const token = req.query.relayToken || req.headers['x-relay-token'] || _relaySession.token;
  if (token && RELAY_URL) {
    try {
      const r = await httpsRequest(`${RELAY_URL}/api/memory/${encodeURIComponent(req.params.key)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!r.ok) return res.status(502).json({ ok: false, error: 'Xóa trên relay thất bại — mục có thể vẫn còn trong bộ nhớ bot, thử lại' });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'Không kết nối được relay để xóa — mục có thể vẫn còn trong bộ nhớ bot, thử lại' });
    }
  }
  res.json({ ok: true });
});

// Pull memory từ relay về local (gọi khi mở máy mới lần đầu)
app.post('/api/memory/pull-relay', async (req, res) => {
  const token = req.body?.relayToken || req.headers['x-relay-token'] || _relaySession.token;
  if (!token || !RELAY_URL) return res.json({ ok: false, reason: 'no_token' });
  try {
    const r = await httpsRequest(`${RELAY_URL}/api/memory`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!r.ok) return res.json({ ok: false, reason: 'relay_error' });
    const relayMem = (await r.json()) || {};
    const mem = readMemory();
    let count = 0;
    for (const [key, item] of Object.entries(relayMem)) {
      // Relay thắng nếu mới hơn local
      if (!mem[key] || (item.updatedAt || 0) > (mem[key].updatedAt || 0)) {
        mem[key] = item;
        count++;
      }
    }
    writeMemory(mem);
    res.json({ ok: true, pulled: count, total: Object.keys(mem).length });
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

// ── TASKS API ────────────────────────────────────────────────────────────────
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { return []; }
}
function writeTasks(data) {
  const dir = path.dirname(TASKS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/tasks', (req, res) => {
  const tasks = readTasks();
  const { status } = req.query;
  res.json(status ? tasks.filter(t => t.status === status) : tasks);
});

app.post('/api/tasks', (req, res) => {
  const { title, description = '', status = 'todo', priority = 'normal' } = req.body;
  if (!title) return res.status(400).json({ error: 'Cần title' });
  const tasks = readTasks();
  const task = { id: uuidv4(), title, description, status, priority, createdAt: Date.now(), result: '' };
  tasks.push(task);
  writeTasks(tasks);
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const tasks = readTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Không tìm thấy' });
  Object.assign(tasks[idx], req.body, { updatedAt: Date.now() });
  writeTasks(tasks);
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  let tasks = readTasks();
  tasks = tasks.filter(t => t.id !== req.params.id);
  writeTasks(tasks);
  res.json({ ok: true });
});

// ── FILES API ────────────────────────────────────────────────────────────────
const { exec } = require('child_process');

app.post('/api/files/view', (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Cần path' });
  // Mở bằng app mặc định — cross-platform
  const platform = require('os').platform();
  const safe = filePath.replace(/"/g, '\\"');
  let cmd, opts;
  if (platform === 'win32') { cmd = `start "" "${safe}"`; opts = { shell: 'cmd.exe' }; }
  else if (platform === 'darwin') { cmd = `open "${safe}"`; opts = {}; }
  else { cmd = `xdg-open "${safe}"`; opts = {}; }
  exec(cmd, opts, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, opened: filePath });
  });
});

app.get('/api/files/list', (req, res) => {
  const dir = req.query.dir || process.cwd();
  fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      path: path.join(dir, e.name)
    })));
  });
});

app.post('/api/files/read', (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Cần path' });
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ ok: true, content, size: content.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mở thẳng app Antigravity đã cài trên máy (không qua AGS) — dùng khi agy báo chưa đăng
// nhập, để người dùng đăng nhập Google ngay trong app thật thay vì phải tự dò đường mở.
app.post('/api/open-antigravity', (req, res) => {
  const os = require('os');
  const candidates = os.platform() === 'win32'
    ? [path.join(os.homedir(), 'AppData/Local/Programs/Antigravity/Antigravity.exe')]
    : ['/Applications/Antigravity.app'];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) return res.status(404).json({ error: 'Chưa tìm thấy app Antigravity đã cài trên máy này' });
  try {
    const opener = os.platform() === 'darwin' ? 'open' : found;
    const args = os.platform() === 'darwin' ? [found] : [];
    require('child_process').spawn(opener, args, { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/open-url', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Cần url' });
  const platform = require('os').platform();
  let cmd, opts;
  if (platform === 'win32') { cmd = `start "" "${url}"`; opts = { shell: 'cmd.exe' }; }
  else if (platform === 'darwin') { cmd = `open "${url}"`; opts = {}; }
  else { cmd = `xdg-open "${url}"`; opts = {}; }
  exec(cmd, opts, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, opened: url });
  });
});

// ── PROMPT CONFIG API ────────────────────────────────────────────────────────
const PROMPT_CFG_FILE = path.join(DATA_DIR, 'prompt-config.json');
function readPromptCfg() {
  try { return JSON.parse(fs.readFileSync(PROMPT_CFG_FILE, 'utf8')); } catch { return {}; }
}
function writePromptCfg(data) {
  const dir = path.dirname(PROMPT_CFG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROMPT_CFG_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/prompt-config', (req, res) => res.json(readPromptCfg()));
app.post('/api/prompt-config', (req, res) => {
  const cfg = { ...readPromptCfg(), ...req.body };
  writePromptCfg(cfg);
  res.json({ ok: true, config: cfg });
});

// Projects
// userId (relayUser.open_id/id) truyền qua query/body — dùng để lọc project/chat theo
// đúng người đang đăng nhập, tránh 2 người dùng chung máy nhìn thấy/sửa của nhau.
app.get('/api/projects', (req, res) => res.json(db.getProjects(req.query.userId || null)));
app.post('/api/projects', (req, res) => {
  const { name, path: p, workDir, promptPrefix, promptSuffix, userId } = req.body;
  const id = uuidv4();
  db.createProject(id, name, p || '', { workDir: workDir || '', promptPrefix: promptPrefix || '', promptSuffix: promptSuffix || '', userId: userId || null });
  res.json({ id, name, workDir: workDir || '', promptPrefix: promptPrefix || '', promptSuffix: promptSuffix || '' });
});
app.patch('/api/projects/:id', (req, res) => {
  const { name, workDir, promptPrefix, promptSuffix } = req.body;
  const updated = db.updateProject(req.params.id, { name, workDir: workDir || '', promptPrefix: promptPrefix || '', promptSuffix: promptSuffix || '' });
  if (updated) res.json(updated); else res.status(404).json({ error: 'Not found' });
});
app.delete('/api/projects/:id', (req, res) => {
  db.deleteProject(req.params.id);
  res.json({ ok: true });
});

// ── Projects Extra — lưu workDir / promptPrefix / promptSuffix local theo relay project ID ──
const PROJ_EXTRA_FILE = path.join(DATA_DIR, 'projects-extra.json');
function readProjExtra() { try { return JSON.parse(fs.readFileSync(PROJ_EXTRA_FILE, 'utf8')); } catch { return {}; } }
function writeProjExtra(d) { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PROJ_EXTRA_FILE, JSON.stringify(d, null, 2)); }
app.get('/api/projects-extra', (req, res) => res.json(readProjExtra()));
app.post('/api/projects-extra', (req, res) => {
  const { id, workDir, promptPrefix, promptSuffix } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const d = readProjExtra();
  d[id] = { workDir: workDir || '', promptPrefix: promptPrefix || '', promptSuffix: promptSuffix || '' };
  writeProjExtra(d);
  res.json({ ok: true });
});

// Chats
app.get('/api/projects/:pid/chats', (req, res) => res.json(db.getChats(req.params.pid, req.query.userId || null)));
app.post('/api/projects/:pid/chats', (req, res) => {
  const { name, agent, userId } = req.body;
  const id = uuidv4();
  db.createChat(id, req.params.pid, name || 'Cuộc chat mới', agent || 'claude', userId || null);
  res.json({ id, name, agent });
});
app.patch('/api/chats/:id', (req, res) => {
  db.updateChatName(req.params.id, req.body.name);
  res.json({ ok: true });
});
app.delete('/api/chats/:id', (req, res) => {
  runner.killSession(req.params.id);
  db.deleteChat(req.params.id);
  res.json({ ok: true });
});

// Messages
app.get('/api/chats/:id/messages', (req, res) => res.json(db.getMessages(req.params.id)));

// Xóa 1 tin nhắn THẬT — cả local db lẫn relay D1, cùng bằng 1 ID (xem giải thích ở
// nơi sinh userMsgId/assistantMsgId trong 'case prompt' phía dưới). Trước đây nút
// Xóa trên UI chỉ gỡ khỏi DOM, không gọi endpoint nào cả nên tin nhắn luôn "sống lại"
// mỗi khi mở lại chat hoặc đăng nhập lại (dữ liệu gốc chưa từng bị xóa).
app.delete('/api/messages/:id', async (req, res) => {
  const id = req.params.id;
  try { db.deleteMessage(id); } catch {}
  try {
    await httpsRequest(`${RELAY_URL}/server/messages/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-Server-Key': SERVER_SECRET },
    });
  } catch {}
  res.json({ ok: true });
});

// Tiến độ tóm tắt bộ nhớ — cho client hiện đếm "[X/20]" tới lần tự động tóm tắt tiếp theo
// (mỗi 20 tin, xem SUMMARY_EVERY trong autoSummarizeChat).
app.get('/api/chats/:id/memory-status', async (req, res) => {
  const SUMMARY_EVERY = 20;
  const count = await relayGetMessageCount(req.params.id);
  const remaining = count === 0 ? SUMMARY_EVERY : (SUMMARY_EVERY - (count % SUMMARY_EVERY || SUMMARY_EVERY));
  res.json({ count, every: SUMMARY_EVERY, remaining });
});

// Đọc lại bản tóm tắt đã chắt lọc — TRƯỚC ĐÂY thiếu hẳn endpoint này: chắt lọc xong lưu
// đúng vào D1 nhưng KHÔNG có chỗ nào cho người dùng xem lại nội dung, khiến bấm "Chắt lọc
// ngay" xong không biết nó "hiện ở đâu". Client hiện ra ngay trong panel "🧠 Bộ nhớ".
app.get('/api/chats/:id/summary', async (req, res) => {
  try {
    const s = await relayGetSummary(req.params.id);
    res.json(s || { summary: null });
  } catch (e) {
    res.json({ summary: null });
  }
});

// Chắt lọc bộ nhớ NGAY — nút bấm thủ công, không cần đợi đủ 20 tin.
// Dùng lại nguyên hàm autoSummarizeChat đã test kỹ (chỉ cần chatId, 2 tham số còn lại
// không dùng tới trong thân hàm — nó tự lấy lịch sử mới nhất từ relay).
app.post('/api/chats/:id/summarize-now', async (req, res) => {
  try {
    const token = req.body?.relayToken || req.headers['x-relay-token'] || _relaySession.token;
    const result = await autoSummarizeChat(req.params.id, null, null, token, req.body?.agentId);
    res.json(result || { ok: false, reason: 'Không rõ nguyên nhân' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hướng dẫn chắt lọc mặc định — client fetch để điền sẵn vào ô nhập trong panel "🧠 Bộ nhớ"
// khi người dùng chưa tự lưu hướng dẫn riêng, cho họ thấy mặc định đang là gì trước khi sửa.
app.get('/api/summary-prompt-default', (req, res) => res.json({ text: DEFAULT_SUMMARY_INSTRUCTION }));

// Prompt history
app.get('/api/prompt-history', (req, res) => res.json(db.getPromptHistory()));

// Agents info
app.get('/api/agents', (req, res) => res.json(runner.getAvailableAgents()));
app.get('/api/agents-config', (req, res) => {
  // Đọc agents-config.json: ưu tiên cạnh exe, fallback về __dirname (dev)
  const exeDir = path.dirname(process.execPath);
  const diskPath = path.join(exeDir, 'agents-config.json');
  const devPath  = path.join(__dirname, 'agents-config.json');
  const configPath = fs.existsSync(diskPath) ? diskPath : devPath;
  try { res.json(JSON.parse(fs.readFileSync(configPath, 'utf8'))); }
  catch { res.json({ agents: {} }); }
});
app.post('/api/agents-config', (req, res) => {
  // HTML có thể update agents-config.json mà không cần rebuild exe
  const exeDir = path.dirname(process.execPath);
  const diskPath = path.join(exeDir, 'agents-config.json');
  const devPath  = path.join(__dirname, 'agents-config.json');
  const configPath = fs.existsSync(diskPath) ? diskPath : devPath;
  try {
    fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Install agent CLI (SSE stream) ────────────────────────────────────────────
app.get('/api/install-agent', (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: 'missing agentId' });

  // Lấy installCmd từ agents-config
  const exeDir = path.dirname(process.execPath);
  const diskPath = path.join(exeDir, 'agents-config.json');
  const devPath  = path.join(__dirname, 'agents-config.json');
  const cfgPath = fs.existsSync(diskPath) ? diskPath : devPath;
  let installCmd = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    installCmd = cfg.agents?.[agentId]?.installCmd || null;
  } catch {}

  // ── Special case: antigravity — tự tìm URL mới nhất và download installer ──
  if (agentId === 'antigravity') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    (async () => {
      try {
        send('log', '🔍 Đang tìm phiên bản mới nhất của Antigravity...\n');
        const html = await fetch('https://antigravity.google/download').then(r => r.text());
        const match = html.match(/https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-hub\/[^"']+\/windows-x64\/Antigravity-x64\.exe/);
        if (!match) throw new Error('Không tìm được URL download');
        const url = match[0];
        send('log', `📦 URL: ${url}\n`);
        const tmpPath = path.join(os.tmpdir(), 'Antigravity-x64.exe');
        send('log', `⬇ Đang tải xuống... (có thể mất 1-2 phút)\n`);
        const fileRes = await fetch(url);
        if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`);
        const total = parseInt(fileRes.headers.get('content-length') || '0');
        let received = 0;
        const chunks = [];
        const reader = fileRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total) send('log', `   ${Math.round(received / total * 100)}% (${Math.round(received/1024/1024)}MB / ${Math.round(total/1024/1024)}MB)\r`);
        }
        const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
        fs.writeFileSync(tmpPath, buf);
        send('log', `\n✅ Tải xong! Đang mở installer...\n`);
        require('child_process').spawn(tmpPath, [], { detached: true, stdio: 'ignore' }).unref();
        send('log', `\n🎉 Installer đang chạy!\n→ Sau khi cài xong, khởi động lại KAgent để nhận diện AntiGravity.\n`);
        send('done', { ok: true });
      } catch (e) {
        send('log', `\n❌ Lỗi: ${e.message}\n`);
        send('done', { ok: false });
      }
      res.end();
    })();
    return;
  }

  if (!installCmd) return res.status(400).json({ error: 'Không có installCmd cho agent này' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  send('log', `▶ Bắt đầu cài: ${installCmd}\n`);

  const [cmd, ...args] = installCmd.split(' ');
  const child = require('cross-spawn').spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
    shell: process.platform === 'win32'
  });

  child.stdout.on('data', d => send('log', d.toString()));
  child.stderr.on('data', d => send('log', d.toString()));
  child.on('close', code => {
    if (code === 0) {
      send('log', '\n✅ Cài đặt thành công!\n');
      send('done', { ok: true });
    } else {
      send('log', `\n❌ Lỗi (exit code ${code})\n`);
      send('done', { ok: false, code });
    }
    res.end();
  });
  child.on('error', err => {
    send('log', `\n❌ Lỗi: ${err.message}\n`);
    send('done', { ok: false });
    res.end();
  });

  req.on('close', () => { try { child.kill(); } catch {} });
});
app.get('/api/sessions', (req, res) => res.json(runner.getAllSessions()));

// ─── Dynamic model list cho Claude — khác agy/opencode: Claude Code CLI KHÔNG có
// lệnh liệt kê model máy đọc được (đã kiểm tra thật), nên không hỏi thẳng CLI được.
// Thay vào đó đọc cache do kagent-relay tự đồng bộ hàng ngày từ Anthropic API thật
// (xem syncClaudeModels trong kagent-relay/src/index.js) — lỗi gì cũng trả về rỗng,
// client tự fallback về danh sách tĩnh trong agents-config.json, không vỡ UI.
app.get('/api/claude-models', async (req, res) => {
  try {
    const r = await httpsRequest(`${RELAY_URL}/server/claude-models`, {
      headers: { 'X-Server-Key': SERVER_SECRET },
      timeoutMs: 6000,
    });
    if (!r.ok) return res.json({ models: [] });
    const data = (await r.json()) || { models: [] };
    res.json(data);
  } catch {
    res.json({ models: [] });
  }
});

// ─── Dynamic model list cho Codex (OpenAI) — cùng lý do như Claude: Codex CLI
// KHÔNG có lệnh liệt kê model máy đọc được (đã kiểm tra thật). Đọc cache do
// kagent-relay tự đồng bộ hàng ngày từ OpenAI API (xem syncCodexModels).
app.get('/api/codex-models', async (req, res) => {
  try {
    const r = await httpsRequest(`${RELAY_URL}/server/codex-models`, {
      headers: { 'X-Server-Key': SERVER_SECRET },
      timeoutMs: 6000,
    });
    if (!r.ok) return res.json({ models: [] });
    const data = (await r.json()) || { models: [] };
    res.json(data);
  } catch {
    res.json({ models: [] });
  }
});

// ─── Dynamic model list cho agy (AntiGravity) ─────────────────────────────────
app.get('/api/agy-models', (req, res) => {
  const agentCmd = runner.resolveAgentCmdPublic('antigravity');
  if (!agentCmd) return res.status(404).json({ error: 'agy not found' });
  const { execFile } = require('child_process');
  execFile(agentCmd, ['models'], { timeout: 10000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const models = stdout.split('\n')
      .filter(line => line.includes('\t'))
      .map(line => {
        const [id, ...rest] = line.split('\t');
        return { id: id.trim(), name: rest.join('\t').trim() };
      })
      .filter(m => m.id && m.name);
    res.json({ models });
  });
});

// Danh sách model THẬT của opencode trên máy này — giống agy-models ở trên. Danh sách
// tĩnh trong agents-config.json (anthropic/claude-sonnet-5, openai/gpt-4o...) là các
// provider phải TỰ cấu hình API key qua `opencode providers`; nếu máy chưa cấu hình gì,
// opencode chỉ có models miễn phí riêng của nó (opencode/big-pickle...) — chọn nhầm model
// tĩnh không tồn tại làm opencode báo lỗi ngay từ lượt chat đầu tiên, tưởng như "mất".
app.get('/api/opencode-models', (req, res) => {
  const agentCmd = runner.resolveAgentCmdPublic('opencode');
  if (!agentCmd) return res.status(404).json({ error: 'opencode not found' });
  const { execFile } = require('child_process');
  // shell:true cần thiết trên Windows: "opencode" là shim .cmd của npm global install
  // (không phải .exe), execFile không tự cộng đuôi .cmd nên báo ENOENT dù lệnh có thật
  // trên máy — đã tái hiện lỗi này trực tiếp trước khi vá. An toàn ở đây vì tham số
  // truyền vào là chuỗi CỐ ĐỊNH ('models'), không có input người dùng để chèn lệnh.
  execFile(agentCmd, ['models'], { timeout: 15000, shell: true }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const models = stdout.split('\n')
      .map(l => l.trim())
      .filter(l => l && l.includes('/'))
      .map(id => ({ id, name: id.split('/').slice(1).join('/') || id }));
    res.json({ models });
  });
});

// Modules (Phase 3 — admin)
app.get('/api/modules', (req, res) => res.json(db.getAllModules()));
app.post('/api/modules', (req, res) => {
  const { name, description, system_prompt } = req.body;
  const id = uuidv4();
  db.createModule(id, name, description, system_prompt);
  res.json({ id, name });
});
app.patch('/api/modules/:id', (req, res) => {
  db.toggleModule(req.params.id, req.body.enabled ? 1 : 0);
  res.json({ ok: true });
});
app.delete('/api/modules/:id', (req, res) => {
  db.deleteModule(req.params.id);
  res.json({ ok: true });
});

// ─── WebSocket ──────────────────────────────────────────────────────────────
// Map chatId → Set<WebSocket>
const chatClients = new Map();

function broadcast(chatId, msg) {
  const clients = chatClients.get(chatId);
  if (!clients) return;
  const data = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

wss.on('connection', (ws) => {
  let currentChatId = null;
  let clientRelayToken = null; // token từ client để gọi relay

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Bọc toàn bộ switch trong try/catch làm lớp phòng thủ thứ 2 (lớp 1 là
    // process.on('uncaughtException'/'unhandledRejection') ở đầu file): lỗi ở đây được báo
    // lại đúng client đang gặp, thay vì (trước khi có 2 lớp này) làm sập cả tiến trình và rớt
    // kết nối của TẤT CẢ mọi người đang chat cùng lúc.
    try {
    switch (msg.type) {

      // ── Join chat room ──
      case 'join': {
        const requestedChatId = msg.chatId;
        // BẢO MẬT: xác minh THẬT quyền sở hữu chat trước khi cho join — phát hiện khi rà
        // soát: trước đây join tin tưởng thẳng chatId client gửi lên, không kiểm tra gì cả,
        // nghĩa là ai biết đúng 1 chatId (UUID) là đọc/tiếp tục được chat của người khác.
        // Gọi thẳng route relay đã có sẵn kiểm tra `user_id` thật (404 nếu không đúng chủ).
        if (msg.relayToken) {
          try {
            const ownCheck = await httpsRequest(`${RELAY_URL}/api/chats/${requestedChatId}/messages`, {
              headers: { Authorization: `Bearer ${msg.relayToken}` },
              timeoutMs: 6000,
            });
            if (!ownCheck.ok) {
              ws.send(JSON.stringify({ type: 'error', message: 'Không có quyền truy cập chat này' }));
              return;
            }
          } catch { /* relay tạm gián đoạn — cho qua, tránh khóa cứng người dùng vì lỗi mạng */ }
        }

        // Rời room cũ
        if (currentChatId && chatClients.has(currentChatId)) {
          chatClients.get(currentChatId).delete(ws);
        }
        currentChatId = requestedChatId;
        if (msg.relayToken) { clientRelayToken = msg.relayToken; cacheRelaySession(msg.relayToken, msg.relayUserId); }
        if (!chatClients.has(currentChatId)) chatClients.set(currentChatId, new Set());
        chatClients.get(currentChatId).add(ws);

        // Gửi lịch sử messages
        const messages = db.getMessages(currentChatId);
        ws.send(JSON.stringify({ type: 'history', messages }));

        // Gửi trạng thái session
        ws.send(JSON.stringify({ type: 'status', status: runner.getSessionStatus(currentChatId) }));
        break;
      }

      // ── Start agent ──
      case 'start': {
        if (!currentChatId) return;
        // Chat có thể chỉ tồn tại trên relay (D1), không có trong local db
        const chat = db.getChatById(currentChatId) || { agent: msg.agent || 'claude' };

        // Inject modules vào session
        const modules = db.getModules();
        if (modules.length > 0) {
          const moduleInfo = modules.map(m => `[Module: ${m.name}] ${m.system_prompt || ''}`).join('\n');
          broadcast(currentChatId, { type: 'output', data: `\r\n\x1b[36m[KAgent] Đã nạp ${modules.length} module(s)\x1b[0m\r\n` });
        }

        const result = runner.startSession(
          currentChatId,
          msg.agent || chat.agent,
          msg.workDir,
          (data) => {
            // Stream output tới tất cả client trong room (chỉ broadcast, KHÔNG lưu DB)
            // Status messages như "[KAgent] Sẵn sàng" không phải AI response — không lưu
            broadcast(currentChatId, { type: 'output', data });
          },
          (exitCode) => {
            broadcast(currentChatId, { type: 'exit', exitCode });
            broadcast(currentChatId, { type: 'status', status: 'stopped' });
          }
        );

        if (result.ok) {
          broadcast(currentChatId, { type: 'status', status: 'running', pid: result.pid });
          broadcast(currentChatId, { type: 'output', data: `\r\n\x1b[32m[KAgent] Đã khởi động ${chat.agent} (PID: ${result.pid})\x1b[0m\r\n` });
        } else {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
        }
        break;
      }

      // ── Start interactive process (AGS-style) ──
      case 'start_interactive': {
        if (!currentChatId) return;
        const result = runner.startInteractiveProcess(
          currentChatId,
          (data) => broadcast(currentChatId, { type: 'output', data }),
          (code) => {
            broadcast(currentChatId, { type: 'exit', exitCode: code });
            broadcast(currentChatId, { type: 'status', status: 'stopped' });
          }
        );
        if (result.ok) {
          broadcast(currentChatId, { type: 'status', status: 'running', pid: result.pid, interactive: true });
        } else if (result.notInstalled) {
          broadcast(currentChatId, { type: 'agent_not_installed', ...result.agentInfo });
        } else {
          ws.send(JSON.stringify({ type: 'error', message: result.error }));
        }
        break;
      }

      // ── Gửi input tới CLI ──
      case 'input': {
        if (!currentChatId) return;
        const sent = runner.sendInput(currentChatId, msg.data);
        if (!sent) ws.send(JSON.stringify({ type: 'error', message: 'Session chưa khởi động' }));

        // Lưu prompt vào history (chỉ khi là text thường, không phải key đặc biệt)
        if (msg.data && msg.data.trim() && msg.data !== '\r' && msg.data !== '\n' && msg.data.length > 2) {
          db.addPromptHistory(uuidv4(), currentChatId, msg.data.trim());
        }
        break;
      }

      // ── Set working directory ──
      case 'setWorkDir': {
        if (!currentChatId || !msg.path) return;
        const s = runner.getSession(currentChatId);
        if (s) s.workDir = msg.path;
        broadcast(currentChatId, { type: 'output', data: `\x1b[36m[KAgent] 📁 Working dir: ${msg.path}\x1b[0m\r\n` });
        break;
      }

      // ── Stop agent ──
      case 'stop': {
        if (!currentChatId) return;
        runner.killSession(currentChatId);
        broadcast(currentChatId, { type: 'status', status: 'stopped' });
        broadcast(currentChatId, { type: 'output', data: '\r\n\x1b[31m[KAgent] Đã dừng agent\x1b[0m\r\n' });
        break;
      }

      // ── Resize terminal ──
      case 'resize': {
        if (currentChatId) runner.resizeSession(currentChatId, msg.cols, msg.rows);
        break;
      }

      // ── Send prompt (text → claude --print) ──
      case 'prompt': {
        if (!currentChatId) return;
        const text = msg.text?.trim() || '';
        // Trước đây CHỈ nhận ảnh (msg.images) — giờ nhận file bất kỳ (msg.files), phân biệt
        // ảnh/tài liệu bằng chính mime trong data URL, không cần client báo trước loại gì.
        // Giữ đọc cả 2 key (files mới, images cũ) để không vỡ nếu client/server lệch bản
        // trong lúc auto-update.
        const files = msg.files || msg.images || []; // [{dataUrl, name}]
        if (!text && !files.length) return;

        // Tự tạo session nếu chưa có — trước đây bắt buộc phải gửi 'start' trước 'prompt'
        // (runner.sendPromptToAgent() chỉ chạy khi đã có session), nếu không sẽ ÂM THẦM
        // không làm gì cả (không lỗi, không log). Với agent kiểu --print (không phải Live/
        // PTY), việc "khởi động" chỉ là ghi lại agentId/workDir — không tốn kém gì để tự
        // làm ở đây, nên bỏ hẳn yêu cầu người dùng phải bấm "Khởi động"/"Live" trước khi
        // gõ tin nhắn đầu tiên (và sau khi 1 tin nhắn xong, tiến trình --print thoát là
        // bình thường — vẫn gõ tiếp được ngay vì session này không mất, xem log giải thích
        // ở setStatus() phía client).
        if (!runner.getSession(currentChatId)) {
          const chatForStart = db.getChatById(currentChatId) || { agent: msg.agent || 'claude' };
          runner.startSession(
            currentChatId,
            msg.agent || chatForStart.agent,
            msg.workDir,
            (data) => broadcast(currentChatId, { type: 'output', data }),
            (exitCode) => {
              broadcast(currentChatId, { type: 'exit', exitCode });
              broadcast(currentChatId, { type: 'status', status: 'stopped' });
            }
          );
        }

        // Lưu file paste/upload vào temp — ảnh thì giữ nguyên đường cũ (truyền base64 qua
        // stdin cho claude, ảnh Content block), tài liệu khác (pdf/docx/xlsx/txt/code...) thì
        // TRÍCH XUẤT TEXT NGAY Ở SERVER rồi nhét thẳng vào prompt dạng text — không dựa vào
        // agent tự dùng tool đọc file (bị chặn ở chế độ "safe"/--print không skip permissions,
        // và các agent khác ngoài claude còn không có khái niệm tool đọc file khi chạy 1 lần),
        // nên cách này hoạt động NHẤT QUÁN cho MỌI agent/chế độ.
        const os = require('os');
        const { extractFileText } = require('./file-extract');
        const imagePaths = [];
        const fileBlocks = []; // text đã trích, nhét vào prompt
        const fileNotes = [];  // tên file kèm trạng thái, hiện cho người dùng biết đã xử lý gì
        for (const f of files) {
          const isImage = /^data:image\//.test(f.dataUrl || '');
          const m = (f.dataUrl || '').match(/^data:[^;]+;base64,(.+)$/s);
          if (!m) { console.error(`[KAgent] File "${f.name}" không đúng định dạng data URL`); continue; }
          const b64 = m[1];
          const origExt = path.extname(f.name || '') || (isImage ? '.png' : '');
          const tmpPath = path.join(os.tmpdir(), `kagent_file_${Date.now()}_${imagePaths.length + fileBlocks.length + fileNotes.length}${origExt}`);
          try { fs.writeFileSync(tmpPath, Buffer.from(b64, 'base64')); }
          catch (e) { console.error(`[KAgent] Lỗi lưu file "${f.name}": ${e.message}`); continue; }

          if (isImage) {
            imagePaths.push(tmpPath);
            console.log(`[KAgent] Ảnh: ${tmpPath} (${Math.round(b64.length * 3 / 4 / 1024)}KB)`);
          } else {
            const r = await extractFileText(tmpPath, f.name);
            if (r.ok) {
              fileBlocks.push(`--- Nội dung file "${f.name}" ---\n${r.text}\n--- Hết file "${f.name}" ---`);
              fileNotes.push(`✅ ${f.name}`);
            } else {
              fileNotes.push(`⚠️ ${f.name} (${r.reason})`);
              broadcast(currentChatId, { type: 'output', data: `\x1b[33m[KAgent] ⚠ Không đọc được "${f.name}": ${r.reason}\x1b[0m\r\n` });
            }
            try { fs.unlinkSync(tmpPath); } catch {} // đã trích xong text, không cần giữ file nữa
          }
        }
        if (files.length > 0 && imagePaths.length === 0 && fileBlocks.length === 0 && fileNotes.every(n => n.startsWith('⚠️'))) {
          broadcast(currentChatId, { type: 'output', data: `\x1b[31m[KAgent] ⚠ Không xử lý được file nào đính kèm\x1b[0m\r\n` });
        }

        // Hiển thị prompt của user
        const attachSuffix = [
          imagePaths.length ? `+${imagePaths.length} ảnh` : '',
          fileNotes.length ? `+${fileNotes.length} file (${fileNotes.join(', ')})` : '',
        ].filter(Boolean).join(', ');
        const displayText = text || `(${files.length} file đính kèm)`;
        broadcast(currentChatId, { type: 'output', data: `\x1b[35m[Bạn]\x1b[0m ${displayText}${attachSuffix ? ` [${attachSuffix}]` : ''}\r\n` });

        // Lưu DB local — SINH ID Ở ĐÂY rồi dùng lại cho relay bên dưới, để 2 kho lưu
        // (file cục bộ + Cloudflare D1) trùng ID của CÙNG 1 tin nhắn logic. Trước đây
        // mỗi bên tự sinh ID riêng (uuidv4 cục bộ khác crypto.randomUUID() bên relay) —
        // nút Xóa gọi API theo ID chỉ xóa được ĐÚNG 1 trong 2 kho, kho còn lại vẫn giữ
        // bản gốc và làm tin nhắn "sống lại" mỗi khi mở lại chat / đăng nhập lại.
        let userMsgId = null;
        if (text) {
          userMsgId = uuidv4();
          db.addMessage(userMsgId, currentChatId, 'user', text);
          db.addPromptHistory(uuidv4(), currentChatId, text);
        }
        db.touchChat(currentChatId);

        // Báo ngay ID cho client để gắn vào bong bóng vừa hiện (optimistic UI) — không
        // cần đợi relay xong vì local đã ghi xong ngay tại đây rồi.
        if (userMsgId) ws.send(JSON.stringify({ type: 'user_msg_id', id: userMsgId }));

        // Lấy thông tin chat để sync relay
        const chatInfo = db.getChatById ? db.getChatById(currentChatId) : null;
        const chatName = chatInfo?.name || 'KAgent Chat';
        const chatAgent = chatInfo?.agent || 'claude';
        const relayUserId = msg.relayUserId || null; // client gửi kèm nếu có

        // Sync user message lên relay (async, không block) — dùng ĐÚNG userMsgId ở trên
        relayEnsureChat(currentChatId, chatName, chatAgent, relayUserId).then(() =>
          relaySyncMessage(currentChatId, 'user', text, userMsgId)
        );

        // Áp dụng prefix/suffix từ prompt-config
        const pcfg = readPromptCfg();
        let finalText = text;
        if (pcfg.prefixEnabled !== false && pcfg.prefix) finalText = pcfg.prefix + finalText;
        if (pcfg.suffixEnabled !== false && pcfg.suffix) finalText = finalText + pcfg.suffix;

        // Nhét nội dung file đã trích xuất vào PROMPT GỬI AGENT (không phải vào `text` đã lưu
        // DB/relay ở trên) — giống hệt cách ảnh chỉ gửi kèm cho lượt này chứ không phình vào
        // tin nhắn đã lưu. Đặt SAU prefix/suffix để không bị prefix/suffix của người dùng chèn
        // giữa câu hỏi và nội dung file.
        if (fileBlocks.length) {
          finalText = `${finalText}\n\n${fileBlocks.join('\n\n')}`;
        }

        // Cập nhật token từ message nếu có
        if (msg.relayToken) clientRelayToken = msg.relayToken;
        // Lấy active modules + lịch sử relay + summary + memory để build system prompt
        Promise.all([
          getRelayModules(clientRelayToken),
          relayGetHistory(currentChatId, 10), // 10 tin nhắn raw gần nhất
          relayGetSummary(currentChatId),     // Phase 3: tóm tắt phiên trước
          relayGetMemory(relayUserId),        // Phase 4: memory cá nhân của user
        ]).then(([relayMods, relayHistory, relaySummary, relayMemory]) => {
          // Xác định agent để build systemPrompt phù hợp
          const currentSession = runner.getSession(currentChatId);
          const sessionAgentId = currentSession?.agentId || (db.getChatById ? db.getChatById(currentChatId)?.agent : null) || 'claude';
          const isClaudeAgent = sessionAgentId === 'claude';

          let systemParts = [];

          // Kim Tiêm modules: mặc định CHỈ inject cho claude (có tool ecosystem phù hợp) —
          // agent khác (gemini, codex, opencode...) nhận Kim Tiêm dễ tự spawn subagent/tool
          // theo nội dung module → treo, vì chúng không đi qua wrapper <kagent_context>
          // read-only bên dưới với model đủ mạnh để tôn trọng ranh giới "chỉ đọc".
          // Ngoại lệ: AntiGravity (isClaudeAgent === false nhưng agentId === 'antigravity')
          // được BẬT THEO YÊU CẦU — dùng model Gemini đủ tôn trọng chỉ dẫn "chỉ đọc, không
          // tự hành động" ở agent-runner.js, và module hiện có (định dạng câu trả lời) chỉ
          // là hướng dẫn trình bày, không yêu cầu gọi tool nào nên an toàn.
          const allowKimTiem = isClaudeAgent || sessionAgentId === 'antigravity';
          if (relayMods.length > 0) {
            if (allowKimTiem) {
              const modText = relayMods.map(m => m.system_prompt?.trim()).filter(Boolean).join('\n\n---\n\n');
              if (modText) systemParts.push(modText);
            }
            broadcast(currentChatId, { type: 'output', data: `\x1b[36m[KAgent] 💉 Đã nạp ${relayMods.length} Kim Tiêm module(s)\x1b[0m\r\n` });
          }

          // Phase 4: Cloud Memory — inject cho MỌI agent (chỉ là data, không phải instructions)
          const memEntries = Object.entries(relayMemory || {});
          if (memEntries.length > 0) {
            const memText = memEntries.map(([k, v]) => `- ${k}: ${v.value}`).join('\n');
            systemParts.push(`[Bộ nhớ cá nhân (${memEntries.length} mục):]\n${memText}`);
            broadcast(currentChatId, { type: 'output', data: `\x1b[36m[KAgent] 🧠 Đã nạp ${memEntries.length} memory\x1b[0m\r\n` });
          }

          // Phase 3: Tóm tắt phiên trước — inject cho MỌI agent
          if (relaySummary && relaySummary.summary) {
            systemParts.push(`[Tóm tắt lịch sử cuộc hội thoại này (${relaySummary.msg_count || '?'} tin nhắn trước đó):]\n${relaySummary.summary}`);
            broadcast(currentChatId, { type: 'output', data: `\x1b[35m[KAgent] 📜 Đã tải lịch sử ${relaySummary.msg_count || '?'} tin nhắn\x1b[0m\r\n` });
          }

          // Raw history gần nhất — inject cho MỌI agent
          const historyMsgs = relayHistory.filter(m => m.role === 'user' || m.role === 'assistant');
          if (historyMsgs.length > 1) {
            const historyText = historyMsgs.slice(0, -1)
              .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
              .join('\n\n');
            systemParts.push(`[${historyMsgs.length - 1} tin nhắn gần nhất:]\n${historyText}`);
          }

          const systemPrompt = systemParts.join('\n\n===\n\n') || undefined;

          // Gửi tới agent
          const agentMode = msg.agentMode || 'safe'; // 'safe' | 'auto'
          const selectedModel = msg.model || null;
          const selectedThinking = msg.thinking || null;
          // Nếu client gửi workDir thì cập nhật session
          if (msg.workDir) {
            const s = runner.getSession(currentChatId);
            if (s) s.workDir = msg.workDir;
          }
          let agentBuffer = '';
          const taskStartTime = Date.now();
          runner.sendPromptToAgent(
            currentChatId,
            finalText,
            (data) => {
              // Detect auth error từ agent-runner
              if (data && data.includes('__KAGENT_AUTH_ERROR__')) {
                const m = data.match(/__KAGENT_AUTH_ERROR__(.+?)__END__/s);
                if (m) {
                  try {
                    const info = JSON.parse(m[1]);
                    broadcast(currentChatId, { type: 'auth_error', info });
                  } catch {}
                }
                return; // không broadcast text thô
              }
              broadcast(currentChatId, { type: 'output', data });
              agentBuffer += data;
            },
            async (code, fullOutput) => {
              const taskDuration = Date.now() - taskStartTime;
              const rawResponse = (fullOutput || agentBuffer).trim();
              // Lọc bỏ ANSI escape codes và KAgent status messages trước khi lưu
              const responseText = rawResponse
                .replace(/\x1b\[[0-9;]*m/g, '')  // strip ANSI color codes
                .replace(/\[KAgent\][^\n]*/g, '')  // strip [KAgent] status lines
                .replace(/^[╭╰─]+.*$/gm, '')       // strip box drawing lines
                .replace(/\r\n/g, '\n')
                .trim();
              if (responseText && responseText.length > 5) {
                // Cùng 1 ID cho cả local db lẫn relay (xem giải thích ở nhánh 'user' phía trên)
                const assistantMsgId = uuidv4();
                db.addMessage(assistantMsgId, currentChatId, 'assistant', responseText);
                // Gửi event riêng để client render markdown đẹp — kèm ID để nút Xóa dùng
                broadcast(currentChatId, { type: 'ai_response', text: responseText, id: assistantMsgId });
                // Sync AI response lên relay → thiết bị khác thấy được, dùng ĐÚNG ID trên
                await relaySyncMessage(currentChatId, 'assistant', responseText, assistantMsgId);
                // Phase 3: Kiểm tra có cần auto-summarize không (mỗi 20 messages).
                // Đếm thật từ relay (D1), KHÔNG dùng biến RAM — server restart (rất hay xảy ra
                // sau mỗi lần release) sẽ không làm lệch mốc 20/40/60... nữa.
                const SUMMARY_EVERY = 20;
                relayGetMessageCount(currentChatId).then(count => {
                  if (count > 0 && count % SUMMARY_EVERY === 0) {
                    autoSummarizeChat(currentChatId, relayHistory, responseText, clientRelayToken, sessionAgentId).catch(() => {});
                  }
                }).catch(() => {});

                // Lark notification nếu task kéo dài > 60 giây
                if (taskDuration > 60000) {
                  const chatName = (db.getChatById ? db.getChatById(currentChatId) : null)?.name || 'KAgent';
                  const mins = Math.round(taskDuration / 60000 * 10) / 10;
                  const preview = responseText.slice(0, 200).replace(/\n/g, ' ');
                  const larkMsg = `✅ KAgent hoàn thành task sau ${mins} phút\n📋 Chat: ${chatName}\n💬 Kết quả: ${preview}${responseText.length > 200 ? '...' : ''}`;
                  const s = runner.getSession(currentChatId);
                  const wd = s?.workDir || process.cwd();
                  // Gửi Lark DM qua claude --print
                  require('cross-spawn').spawn('claude', [
                    '--print',
                    `Dùng lark-mcp để gửi tin nhắn Direct Message đến tôi (kairjx1@gmail.com hoặc tìm chat "kairjx1") với nội dung sau (không thay đổi): "${larkMsg.replace(/"/g, '\\"')}"`,
                    '--dangerously-skip-permissions',
                    '--output-format', 'text',
                  ], { cwd: wd, stdio: 'ignore', windowsHide: true });
                }
              }

              // Dọn dẹp temp image files
              for (const p of imagePaths) { try { fs.unlinkSync(p); } catch {} }

              // Báo cho client biết tiến trình ĐÃ THOÁT — trước đây thiếu 2 dòng này nên
              // sau mỗi lần gửi tin nhắn (case 'prompt'), trạng thái "Đang chạy" phía client
              // (badge nhấp nháy, dot sidebar) bị kẹt mãi dù agent đã trả lời xong từ lâu.
              broadcast(currentChatId, { type: 'exit', exitCode: code });
              broadcast(currentChatId, { type: 'status', status: 'stopped' });
            },
            systemPrompt,
            agentMode,
            imagePaths,
            selectedModel,
            selectedThinking,
            // onNotInstalled: báo về client hiện install modal
            (info) => broadcast(currentChatId, { type: 'agent_not_installed', ...info })
          );
        });
        break;
      }
    }
    } catch (err) {
      console.error('[KAgent] Lỗi xử lý WS message (đã chặn, không sập server):', msg && msg.type, err && (err.stack || err.message || err));
      try { ws.send(JSON.stringify({ type: 'error', message: 'Lỗi xử lý yêu cầu phía server, thử lại giúp mình.' })); } catch {}
    }
  });

  ws.on('close', () => {
    if (currentChatId && chatClients.has(currentChatId)) {
      chatClients.get(currentChatId).delete(ws);
    }
  });
});

// ─── Native folder picker (cross-platform) ───────────────────────────────────
app.post('/api/pick-folder', (req, res) => {
  const { current } = req.body || {};
  const platform = require('os').platform();

  if (platform === 'darwin') {
    // macOS: dùng osascript để mở folder picker
    const defaultPath = (current && !current.includes('C:\\') ? current : require('os').homedir()).replace(/"/g, '\\"');
    const script = `choose folder with prompt "Chọn thư mục làm việc cho KAgent" default location "${defaultPath}"`;
    const proc = require('child_process').spawn('osascript', ['-e', `return POSIX path of (${script})`]);
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', (code) => {
      const picked = out.trim().replace(/\/$/, '');
      if (code === 0 && picked) return res.json({ path: picked });
      // fallback: trả về null để frontend dùng prompt()
      res.json({ path: null, error: err.trim() || 'cancelled' });
    });
    proc.on('error', () => res.json({ path: null, error: 'osascript not available' }));
  } else if (platform === 'win32') {
    const init = (current && !current.includes('~') ? current : 'C:\\').replace(/'/g, "''");
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Chon thu muc lam viec cho KAgent'
$d.SelectedPath = '${init}'
$d.ShowNewFolderButton = $true
$d.RootFolder = [System.Environment+SpecialFolder]::MyComputer
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
`.trim();
    // Bỏ -NonInteractive để GUI dialog hiện được
    const proc = require('child_process').spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: false });
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.on('close', () => res.json({ path: out.trim() || null }));
    proc.on('error', () => res.json({ path: null }));
  } else {
    // Linux: fallback — trả null (không có native dialog)
    res.json({ path: null });
  }
});

// ─── Bé KAgent — public endpoint (không cần auth) ───────────────────────────
const { spawn } = require('cross-spawn');
const BK_SYSTEM = 'Bạn là Bé KAgent — trợ lý AI thông minh, thân thiện của KAgent (KSCL Vietnam). Trả lời ngắn gọn, súc tích bằng tiếng Việt. Giúp người dùng về code, KAgent, AI tools và mọi câu hỏi. Đừng dùng markdown quá nhiều — hãy tự nhiên như đang chat.';

app.post('/api/bekagent', async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Thiếu message' });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const proc = spawn('claude', ['--print', message, '--output-format', 'text', '--append-system-prompt', BK_SYSTEM], {
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  proc.stdout.on('data', d => res.write(d));
  proc.stderr.on('data', () => {});
  proc.on('exit', () => res.end());
  proc.on('error', () => { res.write('⚠ Không chạy được Claude CLI.'); res.end(); });
});

// ─── Auto-update (UI từ Cloudflare Pages) ────────────────────────────────────
// BUG THẬT phát hiện khi test trước release: trước đây thiếu "/kagent" trong path này
// khiến MỌI request auto-update (check-update, agents-config sync, do-update) nhận về
// HTML fallback của SPA thay vì file thật — auto-update ở server.js chưa từng hoạt động
// đúng. launcher.js dùng đúng path "/kagent/..." từ đầu nên không bị lỗi này.
const UPDATE_BASE = 'https://kscl-sakuko.pages.dev/kagent';
// Bỏ BOM (﻿) nếu có trước khi JSON.parse — version.json do release.ps1 ghi bằng
// .NET Encoding.UTF8 mặc định kèm BOM, JSON.parse gốc không tự strip như trình duyệt.
function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
const UPDATE_FILES = ['index.html', 'admin.html', 'agents.html', 'version.json']; // các file cần sync

// QUAN TRỌNG: dùng module `https` gốc thay vì fetch() (experimental ở Node 18) cho
// mọi cuộc gọi liên quan tới auto-update. Đã phát hiện thật trong test trước khi
// release: fetch() bên trong file .exe đóng gói bằng pkg nhận về HTML thay vì JSON
// khi gọi tới kscl-sakuko.pages.dev (dù curl/Invoke-WebRequest và fetch() gọi tới
// domain khác — kagent-relay.workers.dev — vẫn chạy bình thường). Https module gốc
// ổn định hơn trong môi trường pkg snapshot, tránh lặp lại lỗi âm thầm này.
// BUG THẬT (xem giải thích đầy đủ ở bản sao cùng tên trong launcher.js): Location của redirect
// 308 từ Cloudflare Pages là đường dẫn TƯƠNG ĐỐI, gọi lại https.get() thẳng với chuỗi đó ném
// "Invalid URL". Fix: resolve qua `new URL(loc, baseUrl)` trước khi gọi lại.
function httpsGetText(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(url, { headers: { 'User-Agent': 'KAgent-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const target = new URL(res.headers.location, url).toString();
        return httpsGetText(target, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
function httpsGetBuffer(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(url, { headers: { 'User-Agent': 'KAgent-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const target = new URL(res.headers.location, url).toString();
        return httpsGetBuffer(target, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Auto-download agents-config.json từ Cloudflare khi khởi động (chỉ khi chạy exe)
async function syncAgentsConfig() {
  if (!process.pkg) return; // dev mode: dùng file local
  try {
    const exeDir = path.dirname(process.execPath);
    const dest = path.join(exeDir, 'agents-config.json');
    const text = stripBom(await httpsGetText(`${UPDATE_BASE}/agents-config.json?t=${Date.now()}`));
    JSON.parse(text); // validate JSON trước khi ghi
    fs.writeFileSync(dest, text, 'utf8');
    console.log('[KAgent] agents-config.json synced from Cloudflare');
  } catch (e) { console.warn('[KAgent] agents-config sync failed:', e.message); }
}
syncAgentsConfig();

// Đọc version từ local version.json (đã được update) thay vì hardcode
function readCurrentVersion() {
  try {
    const text = fs.readFileSync(path.join(PUBLIC_DIR, 'version.json'), 'utf8').replace(/^﻿/, '');
    return JSON.parse(text).version || '0.0.0';
  } catch (e) { console.warn('[KAgent] readCurrentVersion lỗi (BOM/JSON hỏng?):', e.message); return '0.0.0'; }
}
let CURRENT_VERSION = readCurrentVersion();

// BUG NGHIÊM TRỌNG đã tìm ra (báo qua ảnh chụp thật — máy chạy exe .exe rất cũ, KHÔNG BAO GIỜ
// thấy lại banner cập nhật dù rõ ràng đang lệch nhiều bản): `launcher.js` tải index.html/
// admin.html/... và version.json ĐỘC LẬP nhau. Trên 1 exe cũ (còn bug tải HTML qua Cloudflare
// Pages), MỌI file HTML lỗi/rơi về bundle, nhưng version.json vẫn MỘT MÌNH tải thành công —
// tự ghi local trùng luôn với online NGAY TRONG CÙNG 1 LẦN KHỞI ĐỘNG, trước khi checkForUpdate()
// kịp chạy. Vá launcher.js (không viết đè version.json trừ khi mọi file HTML cũng tải được
// thật) chỉ cứu được các bản exe MỚI SAU NÀY — exe đã build sẵn với bug này thì code cũ đó vẫn
// y nguyên, không tự vá được chính nó. Cần thêm 1 lớp phòng vệ độc lập: `version.json` ĐÓNG GÓI
// SẴN TRONG EXE (bundled, phần snapshot pkg — không ai ghi đè được lúc runtime) luôn phản ánh
// ĐÚNG mã nguồn thật sự đang chạy, dù local version.json (file rời, có thể bị hỏng/tự đồng bộ
// sai) nói gì đi nữa. So online với CẢ HAI, banner hiện khi lệch với BẤT KỲ cái nào — máy nào
// lỡ bị lệch local cũng không thể "trốn" banner nữa vì bundled không đời nào tự bị sửa.
function readBundledVersion() {
  try {
    const text = fs.readFileSync(path.join(__dirname, 'public', 'version.json'), 'utf8').replace(/^﻿/, '');
    return JSON.parse(text).version || '0.0.0';
  } catch { return '0.0.0'; }
}
const BUNDLED_VERSION = readBundledVersion();

function semverGt(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i]||0) > (pb[i]||0)) return true; if ((pa[i]||0) < (pb[i]||0)) return false; }
  return false;
}

let updateState = { available: false, latestVersion: null };

async function checkForUpdate() {
  try {
    CURRENT_VERSION = readCurrentVersion(); // re-read mỗi lần check (có thể đã được update)
    const text = stripBom(await httpsGetText(`${UPDATE_BASE}/version.json?t=${Date.now()}`));
    const data = JSON.parse(text);
    const behindLocal = data.version && semverGt(data.version, CURRENT_VERSION);
    const behindBundled = data.version && semverGt(data.version, BUNDLED_VERSION);
    if (behindLocal || behindBundled) {
      updateState = { available: true, latestVersion: data.version };
      console.log(`[KAgent] Update available: local=${CURRENT_VERSION} bundled=${BUNDLED_VERSION} → ${data.version}`);
    } else {
      updateState = { available: false, latestVersion: data.version };
    }
  } catch (e) { console.error('[KAgent] checkForUpdate lỗi:', e && (e.cause || e.message || e)); }
}

// Check khi khởi động + mỗi 30 phút.
// QUAN TRỌNG: hoãn lần check ĐẦU TIÊN vài giây — launcher.js tải/giải nén public/
// (index.html, version.json...) từ Cloudflare BẤT ĐỒNG BỘ song song lúc khởi động,
// KHÔNG chờ xong mới require server.js. Nếu check chạy ngay lập tức, có thể đọc
// trúng version.json CŨ (chưa kịp tải xong) → khóa cứng updateState sai (nghĩ có
// bản mới hơn chính bản đang chạy) TỚI 30 PHÚT SAU mới tự sửa — đã xảy ra thật
// trên máy người dùng (bấm cập nhật lặp lại vô ích vì luôn "trúng" race này lúc
// khởi động lại). 8s đủ dư cho vài file JSON/HTML nhỏ tải xong trong mọi trường hợp.
setTimeout(checkForUpdate, 8000);
setInterval(checkForUpdate, 30 * 60 * 1000);

app.get('/api/check-update', (req, res) => {
  res.json({ ...updateState, currentVersion: CURRENT_VERSION });
});

// ── Full self-update: tải .exe mới từ R2, tự thay thế + khởi động lại app ────
// Khác /api/do-update (chỉ vá HTML) — endpoint này thay luôn file .exe, áp dụng
// khi bản mới có thay đổi TRONG server.js/agent-runner.js/launcher.js (đã đóng
// gói cứng vào exe, HTML-only update không chạm tới được).
// Bucket "kagent-releases" trên Cloudflare R2 (public dev URL, zero egress fee).
const R2_EXE_URL = process.env.KAGENT_EXE_URL || 'https://pub-5448a728d23842bf89e82e5b317b4728.r2.dev/kagent.exe';

// ── Nạp lại core NGAY TRONG TIẾN TRÌNH — KHÔNG cần thay file .exe/khởi động lại app ──────────
// Thay thế cho phần lớn trường hợp trước đây phải dùng `/api/do-full-update` (chỉ còn cần dùng
// khi CHÍNH launcher.js đổi — hiếm). Xem giải thích kiến trúc đầy đủ ở launcher.js's
// CORE_DIR/CORE_FILES/global.__kagentReloadCore — đã tự test xác nhận: file nạp từ đường dẫn
// NGOÀI snapshot pkg vẫn require() được các gói npm bình thường, và xoá `require.cache` rồi
// require() lại đọc đúng nội dung MỚI trên đĩa — người dùng học từ AGS (không kill cmd, không
// tải file .exe mới, chỉ tự thay "core" ngay trong tiến trình đang chạy).
app.post('/api/do-core-update', async (req, res) => {
  const coreDir = process.env.KAGENT_CORE_DIR;
  if (typeof global.__kagentReloadCore !== 'function' || !coreDir) {
    return res.json({ ok: false, msg: 'Bản KAgent này chưa hỗ trợ nạp lại core — cần cập nhật .exe một lần (dùng "Cập nhật đầy đủ") để có cơ chế mới này.' });
  }
  try {
    const CORE_FILES = ['server.js', 'agent-runner.js', 'db.js', 'file-extract.js', 'setup-check.js'];
    console.log('[KAgent] Đang tải core mới từ Cloudflare...');
    for (const f of CORE_FILES) {
      const buf = await httpsGetBuffer(`${UPDATE_BASE}/core/${f}?t=${Date.now()}`, 15000);
      if (!buf || buf.length < 10) throw new Error(`File core/${f} tải về rỗng/lỗi — huỷ để an toàn`);
      fs.writeFileSync(path.join(coreDir, f), buf);
    }
    // QUAN TRỌNG: cũng phải cập nhật version.json — nếu không, `CURRENT_VERSION` (đọc lại từ
    // file này ngay khi module server.js được require() lại) vẫn là bản CŨ, khiến
    // `checkForUpdate()` cứ liên tục báo "có bản cập nhật" dù core đã mới, banner hiện lại
    // vô tận không bao giờ biến mất được.
    try {
      const verBuf = await httpsGetBuffer(`${UPDATE_BASE}/version.json?t=${Date.now()}`, 10000);
      fs.writeFileSync(path.join(PUBLIC_DIR, 'version.json'), verBuf);
    } catch (e) {
      console.error('[KAgent] ⚠ Tải version.json mới thất bại (core vẫn nạp lại bình thường, nhưng banner có thể hiện lại):', e.message);
    }
    console.log('[KAgent] Đã tải xong core mới, chuẩn bị nạp lại...');
    res.json({ ok: true, msg: 'Đang nạp lại core...' });
    // Đợi 1 nhịp ngắn để response kịp gửi về client trước khi tắt server hiện tại.
    setTimeout(() => {
      global.__kagentReloadCore().catch(e => {
        console.error('[KAgent] Lỗi nạp lại core:', e.message);
      });
    }, 300);
  } catch (e) {
    console.error('[KAgent] do-core-update lỗi:', e.message);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

app.post('/api/do-full-update', async (req, res) => {
  if (!process.pkg) return res.json({ ok: false, msg: 'Chỉ update được khi chạy từ KAgent.exe' });
  if (!R2_EXE_URL) return res.json({ ok: false, msg: 'Chưa cấu hình nơi tải .exe mới' });
  try {
    const exePath = process.execPath;
    const exeDir = path.dirname(exePath);
    const newExePath = path.join(exeDir, 'kagent-new.exe');
    const oldExePath = path.join(exeDir, 'kagent.exe.old');

    console.log('[KAgent] Đang tải KAgent.exe mới từ', R2_EXE_URL);
    const buf = await httpsGetBuffer(`${R2_EXE_URL}?t=${Date.now()}`);
    if (buf.length < 1024 * 1024) throw new Error('File tải về quá nhỏ, có thể lỗi — huỷ update để an toàn');
    fs.writeFileSync(newExePath, buf);
    console.log('[KAgent] Đã tải xong .exe mới, chuẩn bị thay thế...');

    // THIẾT KẾ LẠI (học trực tiếp từ AGS — đối chiếu file ags.exe/ags.exe.old thật + log thật
    // của nó, theo yêu cầu người dùng) sau 3 vòng vá liên tiếp đều thất bại thật (test đầu-cuối
    // xác nhận từng lần, không đoán):
    //
    // 1) Windows CHO PHÉP đổi tên (rename) 1 file .exe ĐANG CHẠY — tiến trình không hề bị ảnh
    //    hưởng (đã test: server vẫn trả lời HTTP ngay sau rename). Dùng cách này thay vì đợi
    //    tiến trình thoát rồi Move-Item đè lên (cách cũ, sinh ra race condition "chưa kịp nhả
    //    khoá file" đã gây lỗi thật) — loại bỏ HẲN việc phải đợi.
    // 2) BUG GỐC RỄ quan trọng nhất tìm được: 1 file .exe đóng gói bằng `pkg` KHÔNG THỂ tự
    //    spawn thẳng MỘT BẢN SAO CỦA CHÍNH NÓ qua `child_process.spawn()` — pkg's bootstrap
    //    (`pkg/prelude/bootstrap.js`) luôn crash ngay khi khởi động với "TypeError:
    //    String.prototype.startsWith called on null or undefined" trong `Module._resolveFilename`.
    //    Đã tái hiện bằng 1 route debug tối giản (spawn thẳng, không đụng gì tới rename/cổng) —
    //    LUÔN crash y hệt, xác nhận đây là giới hạn CỦA CHÍNH pkg, không liên quan gì code
    //    KAgent tự viết, không sửa được bằng cách chỉnh env hay tham số spawn. Vòng vá trước
    //    (bỏ hẳn PowerShell, spawn thẳng từ Node) chính là do TƯỞNG NHẦM "PowerShell không cần
    //    thiết" — thật ra PowerShell.exe (không phải file pkg) chính là thứ NÉ ĐƯỢC lỗi này,
    //    vì bản thân nó không đụng tới bootstrap của pkg. Quay lại dùng PowerShell làm cầu nối
    //    cho ĐÚNG bước cuối (mở lại app) — nhưng giờ ĐƠN GIẢN HƠN HẲN bản gốc: không cần
    //    Wait-Process/Move-Item nữa (đã xử lý xong ở bước 1 và bước đóng cổng bên dưới), script
    //    chỉ còn đúng 1 lệnh Start-Process — giảm hẳn diện tích có thể viết sai cú pháp.
    try { fs.unlinkSync(oldExePath); } catch {} // dọn bản .old từ lần cập nhật trước (nếu còn)
    fs.renameSync(exePath, oldExePath);   // đổi tên bản ĐANG CHẠY ra chỗ khác — không cần đợi gì
    fs.renameSync(newExePath, exePath);   // đặt bản mới vào đúng tên gốc — tên đã rảnh, không xung đột
    console.log('[KAgent] Đã đổi file .exe xong (rename tức thì, không cần đợi khoá) — chuẩn bị khởi động lại...');

    res.json({ ok: true, msg: 'Đang khởi động lại để cập nhật...' });

    // Đợi 1 nhịp ngắn để response kịp gửi hẳn về client, rồi đóng cổng đang lắng nghe TRƯỚC khi
    // relaunch — để tiến trình mới (do PowerShell mở) bind lại cổng cũ được ngay, không cần
    // "đợi PID cha thoát" (server.close() đã giải phóng cổng ngay lập tức, không phải chờ tới
    // khi cả process thoát hẳn).
    setTimeout(() => {
      server.close(() => console.log('[KAgent] Đã đóng cổng cũ.'));
      const ps = `Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -WindowStyle Minimized`;
      require('cross-spawn').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
        cwd: exeDir, detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
      setTimeout(() => process.exit(0), 300);
    }, 500);
  } catch (e) {
    console.error('[KAgent] do-full-update lỗi:', e.message);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

app.post('/api/do-update', async (req, res) => {
  // Chỉ cho phép update khi chạy từ exe (pkg), không cho update khi dev để tránh overwrite source
  if (!process.pkg) return res.json({ ok: false, msg: 'Chỉ update được khi chạy từ KAgent.exe' });
  if (!updateState.available) return res.json({ ok: false, msg: 'Không có update' });
  try {
    const results = [];
    for (const file of UPDATE_FILES) {
      try {
        const content = await httpsGetText(`${UPDATE_BASE}/${file}?t=${Date.now()}`);
        const dest = path.join(PUBLIC_DIR, file);
        fs.writeFileSync(dest, content, 'utf8');
        results.push({ file, ok: true });
      } catch { results.push({ file, ok: false }); }
    }
    CURRENT_VERSION = readCurrentVersion(); // cập nhật lại sau khi download
    updateState.available = false;
    res.json({ ok: true, results, newVersion: CURRENT_VERSION });
  } catch (e) {
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────
// BUG THẬT đã tìm ra (test đầu-cuối thật cho luồng tự cập nhật mới — spawn() tiến trình con trả
// về PID hợp lệ, không báo lỗi gì, nhưng tiến trình con đó lại biến mất ngay sau đó): trước đây
// `server.listen(PORT, ...)` KHÔNG hề có `server.on('error', ...)` — nếu cổng cũ (do tiến trình
// CHA vừa gọi `server.close()`) chưa kịp giải phóng hẳn ở tầng OS (có thể trễ vài trăm ms tuỳ
// tải máy), lệnh `listen()` của tiến trình CON ném lỗi EADDRINUSE dưới dạng sự kiện 'error' trên
// chính `server` — không ai lắng nghe thì Node coi là uncaught, và vì tiến trình con khởi động
// với `stdio:'ignore'` (để không hiện cửa sổ) nên hoàn toàn không có dấu vết gì hiện ra — tiến
// trình lặng lẽ thoát ngay sau khi sinh ra, đúng hiện tượng "spawn ra PID nhưng PID đó biến mất
// liền" tái hiện được thật. Fix: bắt lỗi 'error', nếu là EADDRINUSE thì THỬ LẠI listen() sau
// 400ms (tối đa 10 lần ≈ 4s — thừa đủ cho OS nhả cổng), các lỗi khác thì log rõ ràng ra
// update-debug.log (nếu tồn tại) để còn có dấu vết chẩn đoán thay vì biến mất trong im lặng.
let listenAttempts = 0;
function startListening() {
  listenAttempts++;
  server.listen(PORT);
}
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenAttempts < 10) {
    console.error(`[KAgent] Cổng ${PORT} còn đang bận (lần ${listenAttempts}), thử lại sau 400ms...`);
    setTimeout(startListening, 400);
  } else {
    console.error('[KAgent] Không thể lắng nghe cổng:', err.message);
  }
});
server.on('listening', () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║   KAgent đang chạy tại             ║`);
  console.log(`║   http://localhost:${PORT}           ║`);
  console.log(`╚════════════════════════════════════╝\n`);
});
startListening();

// ── Xuất `shutdown()` cho launcher.js gọi khi nạp lại core (xem `/api/do-core-update` +
// launcher.js's global.__kagentReloadCore) — dọn dẹp sạch trước khi module này bị require()
// lại: giết mọi agent process con đang chạy (không để orphan), đóng mọi kết nối WebSocket đang
// mở (client tự động reconnect qua cơ chế đã có sẵn ở index.html, không cần code gì thêm), rồi
// đóng cổng đang lắng nghe. Có failsafe timeout — `server.close()` sẽ KHÔNG bao giờ gọi callback
// nếu có kết nối HTTP keep-alive nào đó không chịu đóng, treo vô thời hạn nếu không có mốc này.
module.exports = {
  shutdown: () => new Promise((resolve) => {
    console.log('[KAgent] Đang dọn dẹp trước khi nạp lại core...');
    try { runner.killAllSessions(); } catch (e) { console.error('[KAgent] Lỗi killAllSessions:', e.message); }
    try { wss.clients.forEach((c) => { try { c.close(1012, 'Đang nạp lại core, tự kết nối lại sau giây lát'); } catch {} }); } catch {}
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    server.close(finish);
    setTimeout(finish, 3000);
  }),
};
