// Kiểm tra các CLI agent đã cài chưa
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function checkCommand(cmd) {
  try {
    const findCmd = os.platform() === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    execSync(findCmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Kiểm tra app Windows đã cài qua path phổ biến
function checkAppPath(...paths) {
  return paths.some(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

function checkNodeVersion() {
  const v = process.version; // e.g. "v20.11.0"
  const major = parseInt(v.slice(1));
  return { version: v, major, recommended: major >= 18 && major <= 22 };
}

function getSystemInfo() {
  return {
    node: checkNodeVersion(),
    agents: {
      claude:      { name: 'Claude Code',     cmd: 'claude',   installed: checkCommand('claude'),                          installUrl: 'https://claude.ai/download',                        installCmd: 'npm install -g @anthropic-ai/claude-code' },
      opencode:    { name: 'OpenCode',        cmd: 'opencode',
        installed: checkCommand('opencode') ||
          checkAppPath(path.join(os.homedir(), 'AppData/Roaming/ags/bin/opencode.exe')),
        installUrl: 'https://opencode.ai', installCmd: 'npm install -g opencode-ai',
        agsBinPath: path.join(os.homedir(), 'AppData/Roaming/ags/bin/opencode.exe') },
      antigravity: { name: 'AntiGravity',     cmd: 'agy',
        installed: checkCommand('agy') || checkCommand('ag') ||
          checkAppPath(
            path.join(os.homedir(), 'AppData/Local/Programs/Antigravity/Antigravity.exe'),
            '/Applications/Antigravity.app'
          ),
        installUrl: 'https://antigravity.google/product/antigravity-cli', installCmd: null, guiOnly: !checkCommand('agy') },
      codex:       { name: 'Codex CLI',       cmd: 'codex',    installed: checkCommand('codex'),                           installUrl: 'https://github.com/openai/codex',                   installCmd: 'npm install -g @openai/codex' },
      cursor:      { name: 'Cursor',          cmd: 'cursor',
        installed: checkCommand('cursor') || checkAppPath(
          path.join(os.homedir(), 'AppData/Local/Programs/cursor/Cursor.exe'),
          path.join(os.homedir(), 'AppData/Local/cursor/app/Cursor.exe'),
          '/Applications/Cursor.app'
        ),
        installUrl: 'https://cursor.sh', installCmd: null,
        guiOnly: !checkCommand('cursor') },
      kiro:        { name: 'KIRO',            cmd: 'kiro',
        installed: checkCommand('kiro') || checkAppPath(
          path.join(os.homedir(), 'AppData/Local/Programs/Kiro/Kiro.exe'),
          '/Applications/Kiro.app'
        ),
        installUrl: 'https://kiro.dev', installCmd: null,
        guiOnly: !checkCommand('kiro') },
      grok:        { name: 'Grok',            cmd: 'grok',     installed: checkCommand('grok'),                            installUrl: 'https://x.ai/grok',                                 installCmd: null },
      gemini:      { name: 'Gemini CLI',      cmd: 'gemini',   installed: checkCommand('gemini'),                          installUrl: 'https://github.com/google-gemini/gemini-cli',       installCmd: 'npm install -g @google/gemini-cli' },
      shell:       { name: 'Shell',           cmd: 'cmd',      installed: true,                                            installUrl: null,                                                installCmd: null },
    }
  };
}

module.exports = { getSystemInfo, checkCommand };
