// agent-runner.js — dùng claude --print mode (và các CLI agent khác)
// KAgent là giao diện, bên dưới gọi thẳng CLI tool
// Kim Tiêm inject system prompt qua --system flag

const { spawn } = require('cross-spawn');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const sessions = new Map(); // chatId → session state

// ── Load agent config từ file (không hardcode — update file là xong) ──────────
function loadAgentsConfig() {
  const configPaths = [
    path.join(process.cwd(), 'agents-config.json'),
    path.join(path.dirname(process.execPath || ''), 'agents-config.json'),
    path.join(__dirname, 'agents-config.json'),
  ];
  for (const p of configPaths) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).agents || {};
    } catch {}
  }
  // Fallback tối thiểu nếu không có file
  return {
    claude: { name: 'Claude Code', cmd: 'claude', color: '#a78bfa', installCmd: 'npm install -g @anthropic-ai/claude-code', desc: 'Anthropic Claude' },
    shell:  { name: 'Shell', cmd: 'auto', color: '#94a3b8', desc: 'Shell' },
  };
}

let _agentsConfig = loadAgentsConfig();

// Resolve cmd đặc biệt và altPath
function resolveAgentCmd(cfg) {
  if (cfg.cmd === 'auto') return os.platform() === 'win32' ? 'cmd.exe' : 'bash';
  // Thử altPath theo platform
  const altPathTpl = (cfg.altPath || {})[os.platform()];
  if (altPathTpl) {
    const altPath = altPathTpl
      .replace(/%APPDATA%/g, process.env.APPDATA || '')
      .replace(/%LOCALAPPDATA%/g, process.env.LOCALAPPDATA || '')
      .replace(/%HOME%/g, os.homedir());
    // path.resolve() để xử lý ".." trong đường dẫn
    const resolvedPath = path.resolve(altPath);
    if (fs.existsSync(resolvedPath)) return resolvedPath;
  }
  return cfg.cmd;
}

// Build args từ template: '{prompt}' → actual prompt
function buildArgs(tpl, prompt) {
  return (tpl || []).map(a => a === '{prompt}' ? prompt : a).filter(a => a !== '');
}

// ── Auth error detect — từ config file, không hardcode ───────────────────────
function detectAuthError(agentId, output) {
  if (!output) return null;
  _agentsConfig = loadAgentsConfig(); // reload để lấy config mới nhất
  const cfg = _agentsConfig[agentId];
  if (!cfg || !cfg.authErrorPatterns || !cfg.authGuide) return null;
  const matched = cfg.authErrorPatterns.some(p => output.toLowerCase().includes(p.toLowerCase()));
  if (!matched) return null;
  // Trả tên agent THUẦN (cfg.name, vd "AntiGravity") — trước đây trả cả cfg.authGuide.title
  // (vốn đã là câu đầy đủ "AntiGravity chưa đăng nhập"), rồi showAuthError() ở client lại
  // tự thêm " chưa đăng nhập" vào sau info.agent → hiện ra "AntiGravity chưa đăng nhập
  // chưa đăng nhập" lặp từ.
  return { agent: cfg.name || agentId, steps: cfg.authGuide.steps };
}

function checkCommand(cmd) {
  if (!cmd || cmd === 'auto') return true;
  // Nếu là đường dẫn đầy đủ (có \ hoặc /), kiểm tra trực tiếp fs.existsSync
  if (cmd.includes('\\') || (cmd.includes('/') && cmd.startsWith('/'))) {
    return fs.existsSync(cmd);
  }
  try {
    const findCmd = os.platform() === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(findCmd, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function getAvailableAgents() {
  _agentsConfig = loadAgentsConfig();
  return Object.entries(_agentsConfig).map(([id, a]) => ({
    id, name: a.name, color: a.color, icon: a.icon,
    installed: checkCommand(resolveAgentCmd(a)),
    installCmd: a.installCmd, installUrl: a.installUrl, desc: a.desc,
  }));
}

// ── Khởi tạo session ──────────────────────────────────────────────────────────
function startSession(chatId, agentId, workDir, onData, onExit) {
  sessions.set(chatId, {
    agentId,
    workDir: workDir || process.cwd(),
    onData, onExit,
    isFirst: true,
    running: false,
    currentProc: null,
  });

  const agentName = (_agentsConfig[agentId] || _agentsConfig['claude'] || {}).name || agentId;
  onData(`\r\n\x1b[32m[KAgent] Sẵn sàng — ${agentName}\x1b[0m\r\n`);
  onData(`\x1b[36m[KAgent] Nhập prompt và nhấn Enter để gửi...\x1b[0m\r\n\r\n`);
  return { ok: true, pid: null };
}

// ── Interactive Mode: spawn 1 lần, giữ stdin open (như AGS) ─────────────────
function startInteractiveProcess(chatId, onData, onExit) {
  const s = sessions.get(chatId);
  if (!s) return { ok: false, error: 'Chưa có session' };

  _agentsConfig = loadAgentsConfig();
  const agentCfg = _agentsConfig[s.agentId] || _agentsConfig['claude'] || {};
  const agent = { ...agentCfg, name: agentCfg.name || s.agentId, cmd: resolveAgentCmd(agentCfg) };

  if (s.agentId !== 'shell') {
    const cliExists = checkCommand(agent.cmd);
    if (!cliExists) {
      onData(`\x1b[31m[KAgent] ⚠ ${agent.name} CLI chưa cài.\x1b[0m\r\n`);
      if (agent.installCmd) onData(`\x1b[33m💡 Cài: ${agent.installCmd}\x1b[0m\r\n`);
      return { ok: false, error: 'CLI not installed', notInstalled: true, agentInfo: {
        agentId: s.agentId, agentName: agent.name, cmd: agent.cmd,
        installCmd: agent.installCmd || null, installUrl: agent.installUrl || null
      }};
    }
  }

  // Args cho interactive mode: dùng interactiveArgs nếu có, không thì spawn không args
  const interactiveArgs = agentCfg.interactiveArgs || [];

  // Environment giả lập terminal
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    FORCE_COLOR: '3',
    COLORTERM: 'truecolor',
    NO_COLOR: undefined,
  };

  const cmdArr = agent.cmd === 'cmd.exe'
    ? ['cmd.exe', ['/K'], s.workDir]
    : agent.cmd.endsWith('bash') || agent.cmd === 'bash'
      ? ['bash', ['--norc', '-i'], s.workDir]
      : [agent.cmd, interactiveArgs, s.workDir];

  const proc = spawn(cmdArr[0], cmdArr[1], {
    cwd: cmdArr[2],
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: false,
    shell: false,
  });

  if (!proc.pid) {
    return { ok: false, error: `Không thể khởi động ${agent.cmd}` };
  }

  s.interactiveProc = proc;
  s.interactiveMode = true;
  s.running = true;

  proc.stdout.on('data', d => onData(d.toString()));
  proc.stderr.on('data', d => onData(d.toString()));
  proc.on('close', (code) => {
    s.interactiveProc = null;
    s.interactiveMode = false;
    s.running = false;
    onExit(code);
  });
  proc.on('error', (err) => {
    onData(`\x1b[31m[KAgent] Lỗi: ${err.message}\x1b[0m\r\n`);
  });

  onData(`\r\n\x1b[32m[KAgent] ▶ ${agent.name} đang chạy (PID: ${proc.pid})\x1b[0m\r\n`);
  onData(`\x1b[36m[KAgent] Gõ trực tiếp bên dưới...\x1b[0m\r\n\r\n`);

  return { ok: true, pid: proc.pid };
}

// ── Gửi prompt → spawn CLI ────────────────────────────────────────────────────
function sendPromptToAgent(chatId, promptText, onData, onExit, systemPrompt, agentMode = 'safe', imagePaths = [], selectedModel = null, selectedThinking = null, onNotInstalled = null) {
  const s = sessions.get(chatId);
  if (!s) return false;
  if (s.running) {
    onData('\r\n\x1b[33m[KAgent] Đang xử lý, vui lòng chờ...\x1b[0m\r\n');
    return false;
  }

  _agentsConfig = loadAgentsConfig();
  // QUAN TRỌNG: phân biệt "agentId không có trong agents-config.json" (KAgent chưa hỗ trợ
  // chạy loại này — vd cursor/kiro/grok chỉ có ở danh sách hiển thị AGENT_DEFS phía client,
  // chưa từng có cmd/args backend) với "có cấu hình nhưng chưa cài CLI". Trước đây cả 2
  // trường hợp đều rơi vào `|| _agentsConfig['claude']` — nghĩa là chọn 1 agent KAgent
  // chưa hỗ trợ sẽ ÂM THẦM chạy Claude thay thế nếu máy có cài claude, khiến người dùng
  // tưởng nhầm agent kia đang hoạt động.
  const knownCfg = _agentsConfig[s.agentId];
  if (!knownCfg && s.agentId !== 'shell') {
    onData(`\x1b[31m[KAgent] ⚠ KAgent chưa hỗ trợ chạy agent "${s.agentId}" (chưa có cấu hình lệnh).\x1b[0m\r\n`);
    onData(`\x1b[36m→ Hãy chọn Claude Code, Gemini CLI, OpenCode, Codex CLI hoặc AntiGravity.\x1b[0m\r\n\r\n`);
    s.running = false;
    if (onNotInstalled) onNotInstalled({
      agentId: s.agentId,
      agentName: s.agentId,
      cmd: null,
      installCmd: null,
      installUrl: null,
      unsupported: true,
    });
    return true;
  }
  const agentCfg = knownCfg || _agentsConfig['claude'] || {};
  let agent = { ...agentCfg, name: agentCfg.name || s.agentId, cmd: resolveAgentCmd(agentCfg) };
  s.running = true;

  // ── Kiểm tra CLI có trong PATH chưa ──
  if (s.agentId !== 'shell') {
    const cliExists = checkCommand(agent.cmd);
    if (!cliExists) {
      onData(`\x1b[31m[KAgent] ⚠ ${agent.name} CLI "${agent.cmd}" chưa cài trên máy này.\x1b[0m\r\n`);
      if (agent.installCmd) onData(`\x1b[33m💡 Cài: ${agent.installCmd}\x1b[0m\r\n`);
      else if (agent.installUrl) onData(`\x1b[33m💡 Tải về: ${agent.installUrl}\x1b[0m\r\n`);
      onData(`\x1b[36m→ Hãy chọn agent khác (Claude Code luôn hoạt động)\x1b[0m\r\n\r\n`);
      s.running = false;
      // Thông báo về client để hiện install modal
      if (onNotInstalled) onNotInstalled({
        agentId: s.agentId,
        agentName: agent.name,
        cmd: agent.cmd,
        installCmd: agent.installCmd || null,
        installUrl: agent.installUrl || null
      });
      return true;
    }
  }

  // BUG THẬT đã tìm ra (báo qua ảnh chụp — người dùng thấy khung "..." của AntiGravity đứng hình
  // vĩnh viễn, KHÔNG có tiến trình agy.exe nào chạy thật, dù `getSessionStatus()` đã vá đúng và
  // báo status "running" — nghĩa là `s.running = true` ở trên đã chạy nhưng code phía dưới KHÔNG
  // BAO GIỜ chạy tới `spawn()`/gắn xong listener `proc.on('exit')`/`proc.on('error')`): toàn bộ
  // phần build args + inject Kim Tiêm + spawn + gắn listener bên dưới KHÔNG có try/catch bao
  // ngoài — hàm này được gọi ĐỒNG BỘ (không await) từ 1 `.then()` callback ở server.js, nên bất
  // kỳ lỗi ném ra ở BẤT KỲ đâu trong khối này (vd model không tồn tại, config agent thiếu field,
  // lỗi build args...) sẽ biến thành unhandled rejection (bị lớp `process.on('unhandledRejection')`
  // mới thêm chặn không cho sập server — nhưng KHÔNG tự reset `s.running`/gọi `onExit`), để lại
  // session bị KẸT "running" mãi mãi giống hệt bug cũ, chỉ khác nguyên nhân. Bọc toàn bộ phần còn
  // lại của hàm trong try/catch, catch thì dọn dẹp trạng thái + báo lỗi thật về client thay vì
  // treo âm thầm.
  try {

  // ── RULE CHUNG KAGENT: Inject Kim Tiêm + Memory + History cho MỌI agent ──
  // Claude → ghi vào CLAUDE.md (persistent, không bị giới hạn command line)
  // Tất cả agent khác → prepend vào promptText
  let claudeMdPath = null;
  let prevClaudeMdContent = null;
  if (systemPrompt && s.agentId === 'claude') {
    // Claude: ghi CLAUDE.md trong workDir
    try {
      const claudeDir = path.join(s.workDir, '.claude');
      if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
      claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) prevClaudeMdContent = fs.readFileSync(claudeMdPath, 'utf8');
      const kagentBlock = `\n<!-- KAgent System Context (auto-generated, không chỉnh tay) -->\n${systemPrompt}\n<!-- /KAgent System Context -->\n`;
      const baseContent = (prevClaudeMdContent || '').replace(/\n<!-- KAgent System Context[\s\S]*?<!-- \/KAgent System Context -->\n/g, '');
      fs.writeFileSync(claudeMdPath, baseContent + kagentBlock, 'utf8');
    } catch (e) { claudeMdPath = null; }
  }
  // Các agent khác (không phải claude, không phải shell): inject context vào đầu prompt
  // Dùng XML tag để agent hiểu đây là context đọc thôi, KHÔNG spawn tool/subagent
  if (systemPrompt && s.agentId !== 'claude' && s.agentId !== 'shell') {
    promptText = `<kagent_context>
IMPORTANT: This section is READ-ONLY background context. Do NOT use any tools, spawn subagents, search files, or take any actions based on this section. Just read it silently and use it to answer the user question below.

${systemPrompt}
</kagent_context>

${promptText}`;
  }

  let cmd, args;

  // Đọc base64 từ imagePaths (đã lưu temp file ở server.js) để gửi qua stdin
  // Cách đúng: dùng --input-format stream-json, pipe JSON message vào stdin
  // Điều này tránh hoàn toàn vấn đề Read tool + base64 dump ra terminal
  let stdinData = null; // JSON string gửi vào stdin (nếu có ảnh)

  // ── Shell: đặc biệt, chạy thẳng lệnh ──
  if (s.agentId === 'shell') {
    cmd = os.platform() === 'win32' ? 'cmd.exe' : 'bash';
    args = os.platform() === 'win32' ? ['/c', promptText] : ['-c', promptText];
  }
  // ── Claude: dùng stream-json + hỗ trợ ảnh native ──
  else if (s.agentId === 'claude') {
    let finalPrompt = promptText;
    const hasImages = imagePaths && imagePaths.length > 0;
    let stdinIsStreamJson = false;
    if (hasImages) {
      try {
        const contentBlocks = [];
        if (promptText) contentBlocks.push({ type: 'text', text: promptText });
        for (const imgPath of imagePaths) {
          try {
            const imgBuf = fs.readFileSync(imgPath);
            const b64 = imgBuf.toString('base64');
            const ext = path.extname(imgPath).slice(1).toLowerCase();
            const mediaType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
            contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } });
          } catch {}
        }
        if (contentBlocks.length > 0) {
          stdinData = JSON.stringify({ type: 'user', message: { role: 'user', content: contentBlocks } }) + '\n';
          stdinIsStreamJson = true;
          finalPrompt = '';
        }
      } catch {
        const imgNote = imagePaths.map((p, i) => `- Ảnh ${i + 1}: ${p}`).join('\n');
        finalPrompt = `${promptText}\n\n[Ảnh đính kèm — hãy dùng Read tool đọc:]\n${imgNote}`;
      }
    }
    // BUG THẬT đã tìm ra (báo qua tính năng đính kèm file — file trích xuất ra rất nhiều dòng,
    // Claude trả lời kiểu "bạn chưa đính kèm gì" dù nội dung RÕ RÀNG có trong prompt gửi đi):
    // finalPrompt truyền qua ARGV (`[finalPrompt, ...]`/`['--print', finalPrompt, ...]`) —
    // "claude" trên Windows resolve ra file `.cmd` wrapper, phải chạy qua `cmd.exe`, mà cmd.exe
    // KHÔNG xử lý được newline nhúng trong 1 tham số dòng lệnh (cắt cụt tại dòng đầu tiên, coi
    // phần sau là lệnh khác) — claude CHỈ NHẬN ĐƯỢC DÒNG ĐẦU của prompt, mất sạch phần còn lại,
    // nhưng vẫn "chạy thành công" (không lỗi gì) nên rất khó nhận ra. Bug này tồn tại từ trước,
    // chỉ chưa lộ vì tin nhắn người dùng gõ tay thường ngắn/1 dòng — tính năng đính kèm file
    // (luôn nhiều dòng) làm lộ ra ngay. Đã sửa & test y hệt cho hàm tóm tắt riêng
    // (runPrintLLM trong server.js) — giờ áp dụng luôn cho ĐÚNG luồng chat chính: khi không có
    // ảnh (không cần stream-json), đưa prompt qua STDIN dạng text thuần thay vì argv.
    if (!stdinData && finalPrompt) {
      stdinData = finalPrompt;
      finalPrompt = '';
    }
    if (agentMode === 'auto') {
      args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
      if (stdinIsStreamJson) args.push('--input-format', 'stream-json');
      else if (!stdinData) args.unshift(finalPrompt); // không có prompt lẫn ảnh — giữ hành vi cũ, không nên xảy ra thực tế
      if (!s.isFirst) args.push('--continue');
      onData(`\x1b[33m[KAgent] ⚡ Agentic mode — Claude sẽ tự thực hiện mà không hỏi lại\x1b[0m\r\n`);
    } else {
      args = ['--print', '--output-format', 'text'];
      if (stdinIsStreamJson) args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
      else if (!stdinData) args = ['--print', finalPrompt, '--output-format', 'text']; // không có gì để gửi qua stdin — giữ hành vi cũ
      if (!s.isFirst) args.push('--continue');
    }
    // Model + thinking level
    const modelId = selectedModel || agentCfg.defaultModel;
    if (modelId && agentCfg.modelFlag) args.push(agentCfg.modelFlag, modelId);
    const thinkingId = selectedThinking || agentCfg.defaultThinking;
    const thinkingEntry = (agentCfg.thinkingLevels || []).find(t => t.id === thinkingId);
    if (thinkingEntry?.extraArgs) args.push(...thinkingEntry.extraArgs);
    cmd = agent.cmd;
  }
  // ── Các agent khác: đọc args từ config ──
  else {
    cmd = agent.cmd;
    const argTpl = agentMode === 'auto' ? (agentCfg.autoArgs || agentCfg.safeArgs) : agentCfg.safeArgs;
    args = buildArgs(argTpl, promptText);
    const modelId = selectedModel || agentCfg.defaultModel;
    if (modelId && agentCfg.modelFlag) args.push(agentCfg.modelFlag, modelId);
    const thinkingId = selectedThinking || agentCfg.defaultThinking;
    const thinkingEntry = (agentCfg.thinkingLevels || []).find(t => t.id === thinkingId);
    if (thinkingEntry?.extraArgs) args.push(...thinkingEntry.extraArgs);
    if (agentMode === 'auto') onData(`\x1b[33m[KAgent] ⚡ Agentic mode\x1b[0m\r\n`);
  }

  const modelId2 = selectedModel || agentCfg.defaultModel;
  const modelEntry2 = (agentCfg.models || []).find(m => m.id === modelId2);
  const thinkingId2 = selectedThinking || agentCfg.defaultThinking;
  const modelLabel = (modelEntry2?.name || modelId2 || '') + (thinkingId2 && thinkingId2 !== 'none' ? ` · ${thinkingId2.charAt(0).toUpperCase()+thinkingId2.slice(1)}` : '');
  onData(`\x1b[34m╭─ ${agent.name}${modelLabel ? ` [${modelLabel}]` : ''} đang xử lý...\x1b[0m\r\n`);

  const proc = spawn(cmd, args, {
    cwd: s.workDir,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'], // stdin pipe nếu có ảnh
    windowsHide: true,
  });

  s.currentProc = proc;

  // Nếu có ảnh → gửi JSON message vào stdin rồi đóng
  if (stdinData && proc.stdin) {
    proc.stdin.write(stdinData, 'utf8');
    proc.stdin.end();
  }
  let outputBuffer = '';
  let lineBuffer = '';
  // Mỗi khi thấy user turn → reset buffer, chỉ giữ response của turn CUỐI cùng
  // Đúng cho cả lần đầu (no --continue) và các lần sau (--continue replay nhiều turns)
  let seenUserTurn = false;

  // ── Timeout 5 phút KHÔNG CÓ OUTPUT (idle) — tránh process bị treo vô hạn ────
  // KHÔNG kill all claude processes (sẽ kill cả Claude Code của dev)
  // Chỉ kill đúng process con này (proc.pid)
  // Trước đây là timeout TUYỆT ĐỐI cho cả tiến trình (5 phút kể từ lúc bắt đầu) —
  // giết oan các task agentic dài nhưng vẫn đang ra output đều đặn (sửa nhiều file,
  // model "high" suy nghĩ lâu). Giờ mỗi lần có stdout/stderr mới thì reset lại đồng
  // hồ — chỉ kill khi THẬT SỰ im lặng 5 phút liền (đúng kiểu hang như bug "root
  // agent idle; waiting for background task" trước đây), task dài nhưng còn sống
  // thì chạy bao lâu cũng được.
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 phút không có output nào
  let timeoutHandle;
  function resetIdleTimeout() {
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => {
      if (s.running && s.currentProc === proc) {
        onData(`\r\n\x1b[31m[KAgent] ⏱ Không có phản hồi trong 5 phút — tự động dừng tiến trình...\x1b[0m\r\n`);
        try { proc.kill('SIGTERM'); } catch {}
        // Force kill sau 3 giây nếu vẫn còn
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
        }, 3000);
      }
    }, IDLE_TIMEOUT_MS);
  }
  resetIdleTimeout();

  // ── Kiểm tra chuỗi có phải base64 binary không (ảnh, file nhị phân) ──
  function isBase64Binary(str) {
    if (!str || str.length < 80) return false;
    // Base64 không có khoảng trắng, không có ký tự tiếng Việt, mật độ >92%
    if (/\s/.test(str)) return false; // có whitespace → không phải base64 thuần
    const b64Chars = (str.match(/[A-Za-z0-9+/=]/g) || []).length;
    return b64Chars / str.length > 0.92;
  }

  // ── Parse stream-json (claude agentic) hoặc text thường ──
  function handleLine(line) {
    if (!line.trim()) return;
    // Thử parse JSON event từ stream-json
    try {
      const ev = JSON.parse(line);
      // User turn events — reset buffer mỗi lần thấy user để chỉ giữ response SAU user turn cuối
      if (ev.type === 'user') {
        seenUserTurn = true;
        outputBuffer = ''; // RESET: chỉ giữ response của turn mới nhất

        // Nếu có tool_result trong content → hiện kết quả tool đã chạy
        const content = ev.message?.content || [];
        for (const block of content) {
          if (block.type === 'tool_result') {
            // Lọc image content (base64) — không dump ra terminal
            const contentArr = Array.isArray(block.content) ? block.content : [{ type: 'text', text: block.content }];
            for (const c of contentArr) {
              // Bỏ qua image block (base64 ảnh từ Read tool)
              if (c.type === 'image' || c.type === 'image_url') continue;
              if (c.source?.type === 'base64') continue; // image với source.data
              const txt = typeof c === 'string' ? c : (c.text || '');
              if (!txt.trim() || isBase64Binary(txt)) continue; // bỏ qua base64 thuần
              const preview = txt.length > 2000 ? txt.slice(0, 2000) + '\n...(truncated)' : txt;
              onData(`\x1b[90m${preview}\x1b[0m\r\n`);
            }
          }
        }
        return;
      }
      // assistant text — chỉ accumulate sau khi thấy user turn để tránh lặp từ --continue
      if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) {
            // Filter base64 thuần (ảnh bị encode thành text trong assistant response)
            if (isBase64Binary(block.text.trim())) continue;
            onData(block.text);
            if (seenUserTurn) outputBuffer += block.text;
          } else if (block.type === 'tool_use') {
            // Ẩn input của Read tool nếu chứa path ảnh (tránh hiện base64)
            const inp = JSON.stringify(block.input || {}).slice(0, 120);
            onData(`\r\n\x1b[33m[Tool: ${block.name}] ${inp}\x1b[0m\r\n`);
          }
        }
      } else if (ev.type === 'result') {
        if (ev.result) { onData('\r\n' + ev.result); if (seenUserTurn && !outputBuffer.includes(ev.result)) outputBuffer += ev.result; }
      } else if (ev.type === 'system' && ev.subtype === 'init') {
        // bỏ qua init event
      }
    } catch {
      // Không phải JSON → output thường, nhưng filter base64 binary
      if (isBase64Binary(line.trim())) return; // bỏ qua dòng base64 thuần (ảnh dump ra)
      onData(line + '\r\n');
      outputBuffer += line + '\n';
    }
  }

  // Rút gọn tham số của 1 lệnh agy vừa gọi thành 1 dòng dễ đọc — ưu tiên field hay gặp
  // nhất (đường dẫn file, câu lệnh, từ khoá tìm...), còn lại thì in thô cả object.
  function summarizeAgyTool(name, params) {
    const p = params || {};
    const path = p.AbsolutePath || p.TargetFile || p.DirectoryPath || p.SearchDirectory || p.SearchPath;
    if (p.CommandLine) return `${name}: ${p.CommandLine}`.slice(0, 160);
    if (p.Pattern && path) return `${name}: "${p.Pattern}" trong ${path}`.slice(0, 160);
    if (p.Query && path) return `${name}: "${p.Query}" trong ${path}`.slice(0, 160);
    if (path) return `${name}: ${path}`.slice(0, 160);
    if (p.Url) return `${name}: ${p.Url}`.slice(0, 160);
    const rest = Object.keys(p).length ? JSON.stringify(p).slice(0, 120) : '';
    return `${name}${rest ? ': ' + rest : ''}`;
  }

  // ── Parse agy stream-json format (khác claude: dùng event/step_update thay type/assistant) ──
  function handleAgyLine(line) {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line);
      if (ev.event === 'step_update' && ev.step_update) {
        const su = ev.step_update;
        if (su.step_type === 'agent_response' && su.text_delta) {
          onData(su.text_delta);
          outputBuffer += su.text_delta;
        } else if (su.step_type === 'tool') {
          // agy dùng step_type:"tool" thật sự (đã kiểm bằng cách bắt trực tiếp luồng
          // stream-json thô) — code cũ tìm "tool_call" nên KHÔNG BAO GIỜ khớp, mọi lệnh
          // agy chạy (tìm file, đọc file, sửa file, chạy PowerShell...) từ trước tới giờ
          // đều bị nuốt âm thầm, người dùng chỉ thấy 3 chấm đứng im dù nó đang làm việc.
          const name = su.tool_name || 'tool';
          if (su.state === 'ACTIVE') {
            onData(`\r\n\x1b[33m▸ ${summarizeAgyTool(name, su.tool_info?.parameters)}\x1b[0m\r\n`);
          } else if (su.state === 'DONE') {
            const dur = typeof su.duration_seconds === 'number' ? ` (${su.duration_seconds.toFixed(1)}s)` : '';
            onData(`\x1b[32m  ✓ xong${dur}\x1b[0m\r\n`);
          } else if (su.state === 'ERROR') {
            const errMsg = su.tool_info?.error?.message || 'lỗi không rõ';
            onData(`\x1b[31m  ✗ lỗi: ${errMsg}\x1b[0m\r\n`);
          }
        }
      } else if (ev.event === 'result') {
        // Final result — đã stream xong qua text_delta ở trên, không cần thêm gì
      } else if (ev.event === 'init') {
        // bỏ qua init
      }
    } catch {
      if (isBase64Binary(line.trim())) return;
      onData(line + '\r\n');
      outputBuffer += line + '\n';
    }
  }

  // stream-json output khi: claude auto mode, claude safe mode có ảnh, hoặc agy
  const useAgyParse = agentCfg.streamJson === 'agy';
  const useJsonParse = (!useAgyParse && s.agentId === 'claude' && (agentMode === 'auto' || !!stdinData));

  proc.stdout.on('data', d => {
    resetIdleTimeout(); // còn ra output → còn sống, hoãn giờ hẹn kill
    const txt = d.toString();
    // Dùng lineBuffer cho cả 2 mode để tránh base64 bị split giữa các chunks
    lineBuffer += txt;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop(); // phần cuối chưa có '\n' → giữ lại

    if (useAgyParse) {
      // agy stream-json format
      for (const line of lines) handleAgyLine(line);
      return;
    }
    if (!useJsonParse) {
      // Safe/print mode — output từng dòng, filter base64 binary
      for (const line of lines) {
        if (isBase64Binary(line.trim())) continue;
        onData(line + '\n');
        outputBuffer += line + '\n';
      }
      return;
    }
    // Agentic mode — parse claude stream-json line by line
    for (const line of lines) handleLine(line);
  });

  let stderrBuffer = '';
  proc.stderr.on('data', d => {
    resetIdleTimeout(); // còn ra output (kể cả stderr) → còn sống, hoãn giờ hẹn kill
    const txt = d.toString();
    stderrBuffer += txt;
    if (txt.includes('no stdin data') || txt.includes('redirect stdin')) return;
    if (txt.includes('Using model') || txt.includes('ExperimentalWarning')) return;
    onData(`\x1b[31m${txt}\x1b[0m`);
  });

  proc.on('exit', (code) => {
    clearTimeout(timeoutHandle); // Hủy timeout nếu process tự thoát bình thường
    if (lineBuffer.trim()) handleLine(lineBuffer);
    lineBuffer = '';
    s.running = false;
    s.isFirst = false;
    s.currentProc = null;

    // Dọn dẹp .claude/CLAUDE.md sau khi claude chạy xong
    if (claudeMdPath) {
      try {
        if (prevClaudeMdContent !== null) {
          // Khôi phục nội dung user cũ (bỏ phần KAgent inject)
          const cleaned = prevClaudeMdContent.replace(/\n<!-- KAgent System Context[\s\S]*?<!-- \/KAgent System Context -->\n/g, '');
          fs.writeFileSync(claudeMdPath, cleaned, 'utf8');
        } else {
          fs.unlinkSync(claudeMdPath);
        }
      } catch {}
    }

    // Detect lỗi auth — hiện hướng dẫn đăng nhập (check cả stdout lẫn stderr)
    const fullOut = outputBuffer + (lineBuffer || '') + (stderrBuffer || '');
    const authErr = detectAuthError(s.agentId, fullOut);
    if (authErr) {
      onData(`\x1b[0m\n__KAGENT_AUTH_ERROR__${JSON.stringify(authErr)}__END__\n`);
    } else {
      onData(`\r\n\x1b[36m╰─ Xong\x1b[0m\r\n\r\n`);
      if (code !== 0 && code !== null) {
        onData(`\x1b[33m[KAgent] Thoát code ${code}\x1b[0m\r\n`);
      }
    }
    // Trả về output buffer cho relay sync
    if (onExit) onExit(code, outputBuffer);
  });

  proc.on('error', (err) => {
    clearTimeout(timeoutHandle);
    s.running = false;
    s.currentProc = null;
    onData(`\r\n\x1b[31m[Lỗi] Không thể chạy "${cmd}": ${err.message}\x1b[0m\r\n`);
    if (agent.installCmd) onData(`\x1b[33m💡 Cài: ${agent.installCmd}\x1b[0m\r\n`);
    else if (agent.installUrl) onData(`\x1b[33m💡 Tải: ${agent.installUrl}\x1b[0m\r\n`);
    if (onExit) onExit(1, '');
  });

  } catch (e) {
    // Xem giải thích đầy đủ ở try{} phía trên — đây là lưới an toàn cuối: bất kỳ lỗi nào xảy ra
    // TRƯỚC KHI proc.on('exit')/proc.on('error') được gắn xong đều rơi vào đây thay vì treo
    // session mãi mãi ở trạng thái "running" giả.
    s.running = false;
    s.currentProc = null;
    onData(`\r\n\x1b[31m[Lỗi] Không khởi động được ${s.agentId}: ${e.message}\x1b[0m\r\n`);
    if (onExit) onExit(1, '');
  }

  return true;
}

function sendInput(chatId, data) {
  const s = sessions.get(chatId);
  if (!s) return false;

  // Interactive mode: ghi thẳng vào stdin của process
  if (s.interactiveProc && s.interactiveMode) {
    if (data === '\x03') {
      try { s.interactiveProc.kill('SIGINT'); } catch {}
    } else {
      try { s.interactiveProc.stdin.write(data); } catch {}
    }
    return true;
  }

  // Non-interactive: chỉ handle Ctrl+C
  if (data === '\x03' && s.currentProc) {
    try { s.currentProc.kill('SIGTERM'); } catch {}
    s.running = false;
  }
  return true;
}

function killSession(chatId) {
  const s = sessions.get(chatId);
  if (!s) return;
  if (s.currentProc) { try { s.currentProc.kill(); } catch {} }
  sessions.delete(chatId);
}

// BUG THẬT đã tìm ra (báo qua ảnh chụp — người dùng thấy khung "..." của AntiGravity đứng
// hình vĩnh viễn dù không có tiến trình `agy.exe` nào thật sự chạy trên máy, xác nhận bằng
// tasklist + GET /api/sessions cho pid:null): hàm này trước đây trả "running" chỉ vì session
// OBJECT tồn tại trong Map — mà session được tạo 1 LẦN DUY NHẤT khi bấm gửi tin đầu tiên của
// 1 chat (case 'start'/'prompt' ở server.js) và ở lại trong Map MÃI MÃI (chỉ mất khi restart
// server hoặc gọi killSession) — HOÀN TOÀN không phản ánh việc CLI con (`s.currentProc`) có
// đang thật sự chạy hay không. Hậu quả: mỗi khi client join lại chat (mở lại trang, WS tự
// reconnect sau 1 lần rớt mạng/crash...), server LUÔN báo status "running" cho bất kỳ chat
// nào đã từng gửi tin, dù request trước đó đã xong từ lâu (hoặc đã treo/lỗi) — client chỉ xoá
// khung "..." khi nhận đúng status "stopped" (xem case 'status' ở index.html), nên nếu 1 lần
// treo/crash xảy ra ĐÚNG lúc đang gửi (khung "..." vừa hiện lên), nó bị KẸT HIỂN THỊ VĨNH VIỄN
// qua mọi lần reconnect sau đó — trông y hệt "AI vẫn đang chạy" dù thực ra không làm gì cả.
function getSessionStatus(chatId) {
  const s = sessions.get(chatId);
  if (!s) return 'stopped';
  return (s.running || s.interactiveMode) ? 'running' : 'stopped';
}

function getAllSessions() {
  return Array.from(sessions.entries()).map(([chatId, s]) => ({
    chatId, agentId: s.agentId, pid: s.currentProc?.pid || null,
    // Client (panel "Agent hiện tại", "Nhiệm vụ gần đây") cần biết chat nào đang chạy thật — cùng
    // định nghĩa với getSessionStatus(): đang xử lý 1 lượt (print mode) hoặc đang ở chế độ live.
    running: !!(s.running || s.interactiveMode),
  }));
}

function resizeSession() {}

function getSession(chatId) { return sessions.get(chatId) || null; }

function resolveAgentCmdPublic(agentId) {
  _agentsConfig = loadAgentsConfig();
  const cfg = _agentsConfig[agentId];
  if (!cfg) return null;
  return resolveAgentCmd(cfg);
}

// Lấy nguyên config của 1 agent (safeArgs, streamJson...) — dùng bởi server.js/runPrintLLM
// để gọi CLI agent với ĐÚNG cú pháp riêng của từng agent (mỗi agent 1 kiểu flag khác nhau,
// hardcode chung 1 bộ flag như claude cho mọi agent sẽ làm agent khác lỗi ngay lập tức).
function getAgentConfigPublic(agentId) {
  _agentsConfig = loadAgentsConfig();
  return _agentsConfig[agentId] || null;
}

// ── Kill tất cả process con khi KAgent tắt (tránh orphan process) ────────────
function killAllSessions() {
  for (const [chatId, s] of sessions.entries()) {
    if (s.currentProc) {
      try { s.currentProc.kill('SIGTERM'); } catch {}
      try { s.currentProc.kill('SIGKILL'); } catch {}
    }
  }
}

// BUG THẬT tiềm ẩn đã tìm ra khi thiết kế cơ chế "nạp lại core ngay trong tiến trình" (xem
// launcher.js's global.__kagentReloadCore): file này giờ có thể bị require() lại NHIỀU LẦN
// trong đời 1 tiến trình (mỗi lần nạp bản core mới) sau khi xoá `require.cache`. Nếu đăng ký
// `process.on(...)` như bình thường ở đây, MỖI LẦN require lại sẽ chạy code module-level này
// lần nữa, CHỒNG THÊM 3 listener mới trên `process` mà không ai gỡ listener cũ — rò rỉ dần qua
// mỗi lần nạp lại core, tới lần thứ 11 Node sẽ cảnh báo "MaxListenersExceededWarning" và về sau
// mỗi lần thoát tiến trình thật sẽ gọi killAllSessions() của TẤT CẢ các bản cũ chồng lên nhau.
// Fix: chỉ đăng ký listener 1 LẦN DUY NHẤT cho cả vòng đời tiến trình (đánh dấu qua biến global,
// sống sót qua mọi lần require lại), và luôn trỏ tới bản `killAllSessions` MỚI NHẤT qua
// `global.__kagentCurrentRunner` (cập nhật lại mỗi lần module này được nạp).
global.__kagentCurrentRunner = { killAllSessions };
if (!global.__kagentExitHooksRegistered) {
  global.__kagentExitHooksRegistered = true;
  const callLatestKillAll = () => { try { global.__kagentCurrentRunner.killAllSessions(); } catch {} };
  process.on('exit',    callLatestKillAll);
  process.on('SIGINT',  () => { callLatestKillAll(); process.exit(0); });
  process.on('SIGTERM', () => { callLatestKillAll(); process.exit(0); });
}

module.exports = {
  startSession, startInteractiveProcess, sendInput, sendPromptToAgent, resizeSession,
  killSession, getSessionStatus, getAllSessions, getAvailableAgents, getSession,
  resolveAgentCmdPublic, getAgentConfigPublic, buildArgs, killAllSessions,
};
