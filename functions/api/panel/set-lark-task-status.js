/**
 * CF Pages Function: POST /api/panel/set-lark-task-status
 * Đồng bộ trạng thái hoàn thành / mở lại từ portal lên Lark Task (2 chiều).
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: CORS });

  const SECRET = env.LARK_APP_SECRET || '';
  const BOT_URL = (env.BOT_SERVER_URL || 'https://lark-bot-vhi3.onrender.com').replace(/\/$/, '');

  let body = {};
  try { body = await request.json(); } catch (_) {}

  try {
    const r = await fetch(`${BOT_URL}/api/panel/set-lark-task-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Panel-Secret': SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const j = await r.json();
    return new Response(JSON.stringify(j), { status: r.status, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
