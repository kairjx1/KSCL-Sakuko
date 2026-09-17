// Pure JSON storage — không cần native modules
const fs = require('fs');
const path = require('path');
const os = require('os');

// DATA_DIR: khi pkg exe → thư mục cạnh exe; khi dev → kagent/data
const DATA_DIR = process.env.KAGENT_DATA_DIR
  ? process.env.KAGENT_DATA_DIR
  : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readFile(name) {
  const p = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function writeFile(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2));
}

function now() { return Date.now(); }

// Seed default project
let _projects = readFile('projects');
if (!_projects.length) {
  _projects = [{ id: 'default', name: 'Project mặc định', path: process.cwd(), created_at: now() }];
  writeFile('projects', _projects);
}

module.exports = {
  // Projects
  // userId: lọc theo người đang đăng nhập (relayUser.id/open_id) — tránh 2 người dùng
  // CHUNG 1 máy KAgent (PC dùng chung phòng ban) nhìn thấy/sửa/xóa project-chat của
  // nhau. Project cũ chưa có user_id (tạo trước khi vá lỗi này) coi là "chung", vẫn
  // hiện cho tất cả để không mất dữ liệu cũ; project MỚI luôn gắn đúng chủ sở hữu.
  // Không truyền userId (chế độ Local chưa đăng nhập Lark) → trả về tất cả như cũ.
  getProjects(userId) {
    const list = readFile('projects');
    if (!userId) return list;
    return list.filter(p => !p.user_id || p.user_id === userId);
  },
  createProject(id, name, p, extra = {}) {
    const list = readFile('projects');
    list.unshift({ id, name, path: p || '', workDir: extra.workDir || '', promptPrefix: extra.promptPrefix || '', promptSuffix: extra.promptSuffix || '', user_id: extra.userId || null, created_at: now() });
    writeFile('projects', list);
  },
  updateProject(id, fields) {
    const list = readFile('projects');
    const idx = list.findIndex(p => p.id === id);
    if (idx >= 0) { list[idx] = { ...list[idx], ...fields }; writeFile('projects', list); return list[idx]; }
    return null;
  },
  deleteProject(id) {
    let list = readFile('projects');
    list = list.filter(p => p.id !== id);
    writeFile('projects', list);
    // Xóa luôn chats thuộc project
    let chats = readFile('chats');
    chats = chats.filter(c => c.project_id !== id);
    writeFile('chats', chats);
  },

  // Chats
  getChats(projectId, userId) {
    let list = readFile('chats').filter(c => c.project_id === projectId);
    if (userId) list = list.filter(c => !c.user_id || c.user_id === userId);
    return list.sort((a, b) => b.updated_at - a.updated_at);
  },
  getChatById(id) { return readFile('chats').find(c => c.id === id) || null; },
  createChat(id, projectId, name, agent, userId) {
    const list = readFile('chats');
    list.push({ id, project_id: projectId, name, agent: agent || 'claude', user_id: userId || null, created_at: now(), updated_at: now() });
    writeFile('chats', list);
  },
  updateChatName(id, name) {
    const list = readFile('chats');
    const c = list.find(x => x.id === id);
    if (c) { c.name = name; c.updated_at = now(); writeFile('chats', list); }
  },
  deleteChat(id) {
    writeFile('chats', readFile('chats').filter(c => c.id !== id));
    writeFile('messages', readFile('messages').filter(m => m.chat_id !== id));
  },
  touchChat(id) {
    const list = readFile('chats');
    const c = list.find(x => x.id === id);
    if (c) { c.updated_at = now(); writeFile('chats', list); }
  },

  // Messages
  getMessages(chatId) {
    return readFile('messages').filter(m => m.chat_id === chatId)
      .sort((a, b) => a.created_at - b.created_at);
  },
  addMessage(id, chatId, role, content) {
    const list = readFile('messages');
    list.push({ id, chat_id: chatId, role, content, created_at: now() });
    // Giữ tối đa 500 messages mỗi chat
    writeFile('messages', list.slice(-2000));
  },
  deleteMessage(id) {
    const list = readFile('messages');
    const next = list.filter(m => m.id !== id);
    writeFile('messages', next);
    return next.length !== list.length; // true nếu thực sự có xóa
  },

  // Prompt history
  getPromptHistory(limit = 50) {
    const map = new Map();
    readFile('prompt_history').reverse().forEach(p => {
      if (!map.has(p.content)) map.set(p.content, p);
    });
    return Array.from(map.values()).slice(0, limit);
  },
  addPromptHistory(id, chatId, content) {
    const list = readFile('prompt_history');
    list.push({ id, chat_id: chatId, content, created_at: now() });
    writeFile('prompt_history', list.slice(-500));
  },

  // Modules
  getModules() { return readFile('modules').filter(m => m.enabled); },
  getAllModules() { return readFile('modules'); },
  createModule(id, name, description, system_prompt) {
    const list = readFile('modules');
    list.push({ id, name, description, system_prompt, enabled: true, created_at: now() });
    writeFile('modules', list);
  },
  toggleModule(id, enabled) {
    const list = readFile('modules');
    const m = list.find(x => x.id === id);
    if (m) { m.enabled = enabled; writeFile('modules', list); }
  },
  deleteModule(id) {
    writeFile('modules', readFile('modules').filter(m => m.id !== id));
  },
};
