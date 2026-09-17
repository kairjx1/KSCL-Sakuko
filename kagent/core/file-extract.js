// file-extract.js — trích xuất nội dung dạng text từ các loại file người dùng đính kèm trong
// chat, để nhét thẳng vào prompt (hoạt động với MỌI agent, không phụ thuộc agent đó có tool đọc
// file hay không, hay chế độ "safe" có cho phép agent tự dùng tool không).
//
// Thiết kế: KHÔNG dựa vào agent tự đọc file bằng tool riêng của nó (Claude Code's Read tool bị
// chặn ở chế độ "safe"/--print không có --dangerously-skip-permissions, các agent khác thậm chí
// không có khái niệm "tool đọc file" khi chạy --print một lần) — trích sẵn nội dung server-side
// rồi đưa thẳng vào prompt dạng text, đảm bảo hoạt động nhất quán cho MỌI agent/chế độ.

const fs = require('fs');
const path = require('path');

const MAX_EXTRACT_CHARS = 60000; // ~15k token — đủ cho hầu hết tài liệu, tránh phình prompt quá lớn

function truncateNote(text, label) {
  if (text.length <= MAX_EXTRACT_CHARS) return text;
  return text.slice(0, MAX_EXTRACT_CHARS) + `\n\n[... đã cắt bớt, "${label}" dài hơn giới hạn ${MAX_EXTRACT_CHARS.toLocaleString()} ký tự ...]`;
}

// Các đuôi file coi là text thuần — đọc trực tiếp UTF-8, không cần thư viện riêng.
const PLAIN_TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yml', '.yaml',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.bash', '.ps1', '.bat', '.html', '.htm',
  '.css', '.scss', '.less', '.vue', '.svelte', '.ini', '.cfg', '.conf', '.env', '.log', '.toml',
  '.gitignore', '.dockerfile',
]);

async function extractPdf(buf) {
  // BUG THẬT đã tìm ra (chỉ lộ qua exe đóng gói, không lộ lúc test bằng node thường): pdf-parse
  // v2 dùng pdfjs-dist bản mới cần `DOMMatrix` (API trình duyệt, không có sẵn trong Node/pkg) —
  // ném "DOMMatrix is not defined" ngay khi trích PDF trong exe đã đóng gói dù chạy hoàn toàn
  // bình thường qua `node`. Hạ về pdf-parse v1.1.1 (API hàm gọi thẳng, dùng bản pdf.js cũ hơn
  // không cần DOMMatrix cho việc trích text thuần) — đã test lại qua đúng exe thật, hết lỗi.
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buf);
  return data.text || '';
}

async function extractDocx(buf) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value || '';
}

async function extractPptx(filePath) {
  // node-pptx-parser nhận ĐƯỜNG DẪN file (không phải buffer) — khác các hàm trích khác ở trên.
  const PptxParser = require('node-pptx-parser').default;
  const parser = new PptxParser(filePath);
  const slides = await parser.extractText(); // [{ id, text: string[] }]
  return slides.map(s => `--- Slide ${s.id} ---\n${(s.text || []).join('\n')}`).join('\n\n');
}

function extractXlsx(buf) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim()) parts.push(`--- Sheet "${sheetName}" ---\n${csv}`);
  }
  return parts.join('\n\n');
}

// Trả về { ok, text, reason } — KHÔNG BAO GIỜ throw, luôn có phản hồi rõ ràng để prompt biết
// chuyện gì đã xảy ra (đọc được hay không), tránh im lặng bỏ qua file người dùng gửi.
async function extractFileText(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  try {
    const buf = fs.readFileSync(filePath);
    if (ext === '.pdf') {
      const text = await extractPdf(buf);
      if (!text.trim()) return { ok: false, reason: 'PDF không có text (có thể là ảnh scan) — không trích xuất được nội dung' };
      return { ok: true, text: truncateNote(text, originalName) };
    }
    if (ext === '.docx') {
      const text = await extractDocx(buf);
      if (!text.trim()) return { ok: false, reason: 'File Word không có text trích xuất được (có thể chỉ chứa ảnh/đối tượng nhúng)' };
      return { ok: true, text: truncateNote(text, originalName) };
    }
    if (ext === '.doc') {
      return { ok: false, reason: 'Định dạng .doc cũ chưa hỗ trợ — hãy lưu lại thành .docx rồi gửi lại' };
    }
    if (ext === '.pptx') {
      const text = await extractPptx(filePath);
      if (!text.trim()) return { ok: false, reason: 'File PowerPoint không có text trích xuất được (có thể chỉ chứa ảnh)' };
      return { ok: true, text: truncateNote(text, originalName) };
    }
    if (ext === '.ppt') {
      return { ok: false, reason: 'Định dạng .ppt cũ chưa hỗ trợ — hãy lưu lại thành .pptx rồi gửi lại' };
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const text = extractXlsx(buf);
      if (!text.trim()) return { ok: false, reason: 'File Excel rỗng hoặc không đọc được sheet nào' };
      return { ok: true, text: truncateNote(text, originalName) };
    }
    if (PLAIN_TEXT_EXT.has(ext) || !ext) {
      const text = buf.toString('utf8');
      return { ok: true, text: truncateNote(text, originalName) };
    }
    // Đuôi lạ — thử đoán xem có phải text không (không chứa byte NUL trong 1KB đầu là dấu hiệu khá tin cậy)
    const sample = buf.slice(0, 1024);
    if (!sample.includes(0)) {
      return { ok: true, text: truncateNote(buf.toString('utf8'), originalName) };
    }
    return { ok: false, reason: `Định dạng "${ext}" chưa hỗ trợ đọc nội dung (chỉ biết tên file: ${originalName}, ${(buf.length/1024).toFixed(1)}KB)` };
  } catch (e) {
    return { ok: false, reason: `Lỗi đọc file: ${e.message}` };
  }
}

module.exports = { extractFileText, PLAIN_TEXT_EXT, MAX_EXTRACT_CHARS };
