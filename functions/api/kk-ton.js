const LARK = 'https://open.larksuite.com';
const APP_TOKEN = 'ESp9bqKtraHZqzsb1f0lTWKSgQg';
const TABLE_TON = 'tblVXEcBdIE3PfNE';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

async function getToken(env) {
  const id = env.LARK_APP_ID || 'cli_aaa0cdd424b81eed';
  const secret = env.LARK_APP_SECRET;
  const r = await fetch(`${LARK}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: id, app_secret: secret })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('Auth: ' + j.msg);
  return j.tenant_access_token;
}

function extractText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(s => typeof s === 'object' ? s.text || '' : String(s)).join('');
  if (typeof val === 'object' && val.text) return val.text;
  return String(val);
}

async function searchByKho(token, kho) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_TON}/records/search?page_size=500`;
  const filter = { filter: { conjunction: 'and', conditions: [{ field_name: 'kho', operator: 'is', value: [kho] }] } };
  let items = [], pageToken = null;
  do {
    const reqUrl = pageToken ? url + '&page_token=' + pageToken : url;
    const r = await fetch(reqUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ field_names: ['barcode', 'ma_hang', 'ten_sp', 'kho', 'ton_he_thong', 'don_gia', 'nganh', 'dvt'], ...filter })
    });
    const j = await r.json();
    items = items.concat(j.data?.items || []);
    pageToken = j.data?.has_more ? j.data.page_token : null;
  } while (pageToken);
  return items;
}

async function deleteRecord(token, recordId) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_TON}/records/${recordId}`;
  await fetch(url, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
}

async function createRecord(token, fields) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_TON}/records`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return r.json();
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const token = await getToken(env);
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const kho = url.searchParams.get('kho');
      if (!kho) return new Response(JSON.stringify({ ok: false, error: 'Cần tham số kho' }), { headers: CORS });
      const items = await searchByKho(token, kho);
      const result = items.map(i => ({
        barcode: extractText(i.fields.barcode),
        ma_hang: extractText(i.fields.ma_hang),
        ten_sp: extractText(i.fields.ten_sp),
        kho: extractText(i.fields.kho),
        ton_he_thong: i.fields.ton_he_thong || 0,
        don_gia: i.fields.don_gia || 0,
        nganh: extractText(i.fields.nganh),
        dvt: extractText(i.fields.dvt)
      }));
      return new Response(JSON.stringify({ ok: true, items: result }), { headers: CORS });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const { action } = body;

      if (action === 'import') {
        const { kho, items } = body;
        if (!kho || !items?.length) return new Response(JSON.stringify({ ok: false, error: 'Cần kho và items' }), { headers: CORS });

        // Xóa tồn cũ của kho này
        const existing = await searchByKho(token, kho);
        for (const item of existing) await deleteRecord(token, item.record_id);

        // Tạo mới toàn bộ
        let created = 0;
        for (const it of items) {
          const resp = await createRecord(token, {
            barcode: it.barcode || '',
            ma_hang: it.ma_hang || '',
            ten_sp: it.ten_sp || '',
            kho,
            ton_he_thong: it.ton_he_thong || 0,
            don_gia: it.don_gia || 0,
            nganh: it.nganh || '',
            dvt: it.dvt || 'PSC'
          });
          if (resp.code === 0) created++;
        }
        return new Response(JSON.stringify({ ok: true, deleted: existing.length, created }), { headers: CORS });
      }

      return new Response(JSON.stringify({ ok: false, error: 'Unknown action' }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
