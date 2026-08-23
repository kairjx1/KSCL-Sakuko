/**
 * CF Pages Function: GET /api/panel/find-user?name=xxx
 * Proxy tìm kiếm thành viên Lark theo tên.
 * Env vars: LARK_APP_SECRET, BOT_SERVER_URL
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const SECRET = env.LARK_APP_SECRET || '';
  const BOT_URL = (env.BOT_SERVER_URL || 'https://lark-bot-vhi3.onrender.com').replace(/\/$/, '');

  const url = new URL(request.url);
  const name = url.searchParams.get('name') || url.searchParams.get('q') || '';
  const chatId = url.searchParams.get('chat_id') || '';

  // Build query string — forward all relevant params to bot
  const qs = new URLSearchParams();
  if (name) qs.set('name', name);
  if (chatId) qs.set('chat_id', chatId);

  try {
    const r = await fetch(`${BOT_URL}/api/panel/find-user?${qs.toString()}`, {
      headers: { 'X-Panel-Secret': SECRET },
      signal: AbortSignal.timeout(10000)
    });
    const j = await r.json();
    return new Response(JSON.stringify(j), { status: r.status, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
