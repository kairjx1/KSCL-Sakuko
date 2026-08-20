/**
 * CF Pages Function: GET /api/lark-chat-members?chat_id=oc_xxx
 * Trả về danh sách thành viên nhóm Lark (open_id + name)
 * Env vars: LARK_APP_ID, LARK_APP_SECRET
 */
const LARK = 'https://open.larksuite.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

async function getToken(id, secret) {
  const r = await fetch(`${LARK}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: id, app_secret: secret })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('Auth lỗi: ' + j.msg);
  return j.tenant_access_token;
}

async function getChatMembers(token, chatId) {
  const members = [];
  let pageToken = '';
  while (true) {
    let url = `${LARK}/open-apis/im/v1/chats/${chatId}/members?page_size=100&member_id_type=open_id`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (j.code !== 0) throw new Error('Chat members lỗi: ' + j.msg);
    const items = j.data?.items || [];
    members.push(...items.map(m => ({
      open_id: m.member_id,
      name: m.name || '',
      tenant_key: m.tenant_key || ''
    })));
    if (!j.data?.has_more) break;
    pageToken = j.data.page_token || '';
  }
  return members;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const APP_ID     = env.LARK_APP_ID     || 'cli_aaa0cdd424b81eed';
  const APP_SECRET = env.LARK_APP_SECRET || '';
  if (!APP_SECRET) return new Response(JSON.stringify({ ok: false, error: 'LARK_APP_SECRET chưa cấu hình' }), { status: 500, headers: CORS });

  const url = new URL(request.url);
  const chatId = url.searchParams.get('chat_id') || '';
  if (!chatId) return new Response(JSON.stringify({ ok: false, error: 'Thiếu chat_id' }), { status: 400, headers: CORS });

  try {
    const token = await getToken(APP_ID, APP_SECRET);
    const members = await getChatMembers(token, chatId);
    return new Response(JSON.stringify({ ok: true, members }), { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
