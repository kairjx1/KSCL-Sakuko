/**
 * CF Pages Function: POST /api/set-agent-config
 * Set agent config in Firebase via bot endpoint.
 * Env vars: FIREBASE_SECRET, BOT_SERVER_URL
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: CORS });

  const SECRET = env.FIREBASE_SECRET || '';
  const BOT_URL = (env.BOT_SERVER_URL || 'https://lark-bot-server.onrender.com').replace(/\/$/, '');

  if (!SECRET) return new Response(JSON.stringify({ ok: false, error: 'FIREBASE_SECRET chưa cấu hình' }), { status: 500, headers: CORS });

  let body = {};
  try { body = await request.json(); } catch (_) {}

  try {
    const r = await fetch(`${BOT_URL}/internal/set-agent-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': SECRET
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const j = await r.json();
    return new Response(JSON.stringify(j), { status: r.status, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
