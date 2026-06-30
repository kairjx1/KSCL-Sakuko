/**
 * CF Pages Function: /api/lark-date
 * Proxy Lark Bitable → JSON (avoids CORS from browser)
 * Env vars needed in Cloudflare Pages:
 *   LARK_APP_ID     = cli_aaa0cdd424b81eed
 *   LARK_APP_SECRET = <your app secret from Lark console>
 */
const LARK = 'https://open.larksuite.com';
const BITABLE = 'UovdbGVvNaJsmrsBHM2lPgkogHe';
const TABLES = {
  stores:  'tbl3lzO5w4cujQNR',  // Base 1: cumulative per store
  detail:  'tbl6WUAU40sXbdde',  // Base 2: monthly detail per store
  monthly: 'tblzIFsZXkyv7EKd',  // Base 3: monthly aggregate
};

const hdrs = (t) => ({
  headers: {
    'Authorization': `Bearer ${t}`,
    'Content-Type': 'application/json',
  }
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

async function fetchAll(token, tableId) {
  const records = [];
  let pageToken = null;
  let page = 0;
  do {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const r = await fetch(
      `${LARK}/open-apis/bitable/v1/apps/${BITABLE}/tables/${tableId}/records/search`,
      { method: 'POST', ...hdrs(token), body: JSON.stringify(body) }
    );
    const d = await r.json();
    if (d.code !== 0) throw new Error(`Bitable error ${d.code}: ${d.msg}`);
    (d.data?.items || []).forEach(item => records.push(item.fields));
    pageToken = d.data?.has_more ? d.data.page_token : null;
    page++;
  } while (pageToken && page < 10);
  return records;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const APP_ID     = env.LARK_APP_ID     || 'cli_aaa0cdd424b81eed';
  const APP_SECRET = env.LARK_APP_SECRET || '';

  if (!APP_SECRET) {
    return new Response(JSON.stringify({
      ok: false, error: 'LARK_APP_SECRET chưa được cấu hình trong Cloudflare Pages → Settings → Environment Variables'
    }), { status: 500, headers: cors });
  }

  try {
    // 1. Get tenant_access_token
    const tRes = await fetch(`${LARK}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const tData = await tRes.json();
    if (tData.code !== 0) throw new Error(`Auth error ${tData.code}: ${tData.msg}`);
    const token = tData.tenant_access_token;

    // 2. Fetch all 3 tables in parallel
    const [stores, detail, monthly] = await Promise.all([
      fetchAll(token, TABLES.stores),
      fetchAll(token, TABLES.detail),
      fetchAll(token, TABLES.monthly),
    ]);

    return new Response(JSON.stringify({ ok: true, stores, detail, monthly, ts: Date.now() }), {
      headers: { ...cors, 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: cors,
    });
  }
}
