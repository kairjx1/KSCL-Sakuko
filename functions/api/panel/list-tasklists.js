/**
 * CF Pages Function: GET /api/panel/list-tasklists
 * Proxy lấy danh sách Lark Tasklists.
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

  try {
    const r = await fetch(`${BOT_URL}/api/panel/list-tasklists`, {
      headers: { 'X-Panel-Secret': SECRET },
      signal: AbortSignal.timeout(10000)
    });
    const j = await r.json();
    return new Response(JSON.stringify(j), { status: r.status, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
