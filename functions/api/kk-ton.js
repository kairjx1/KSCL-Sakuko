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

async function searchRecords(token, bodyExtra = {}) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_TON}/records/search?page_size=500`;
  const base = { field_names: ['barcode', 'ma_hang', 'ten_sp', 'kho', 'ton_he_thong', 'don_gia', 'nganh', 'dvt'] };
  let items = [], pageToken = null;
  do {
    const reqUrl = pageToken ? url + '&page_token=' + pageToken : url;
    const r = await fetch(reqUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, ...bodyExtra })
    });
    const j = await r.json();
    items = items.concat(j.data?.items || []);
    pageToken = j.data?.has_more ? j.data.page_token : null;
  } while (pageToken);
  return items;
}

async function searchByKho(token, kho) {
  const filter = { filter: { conjunction: 'and', conditions: [{ field_name: 'kho', operator: 'is', value: [kho] }] } };
  const items = await searchRecords(token, filter);
  // Nếu không tìm thấy theo kho exact, thử contains (partial match)
  if (items.length === 0) {
    const fuzzy = { filter: { conjunction: 'and', conditions: [{ field_name: 'kho', operator: 'contains', value: [kho.split(/[\s-]/)[0]] }] } };
    return searchRecords(token, fuzzy);
  }
  return items;
}

async function parallelChunks(items, size, fn, concurrency = 4) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  let results = [];
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);
    const res = await Promise.all(batch.map(fn));
    results = results.concat(res);
  }
  return results;
}

async function batchDelete(token, recordIds) {
  await parallelChunks(recordIds, 500, async chunk => {
    await fetch(`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_TON}/records/batch_delete`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: chunk })
    });
  });
}

async function batchCreate(token, fieldsList) {
  const results = await parallelChunks(fieldsList, 500, async chunk => {
    const r = await fetch(`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_TON}/records/batch_create`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: chunk.map(f => ({ fields: f })) })
    });
    const j = await r.json();
    return j.code === 0 ? j.data?.records?.length || 0 : 0;
  });
  return results.reduce((a, b) => a + b, 0);
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const token = await getToken(env);
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const kho = url.searchParams.get('kho');
      if (!kho) return new Response(JSON.stringify({ ok: false, error: 'Cần tham số kho' }), { headers: CORS });
      // kho=* → trả về tất cả (fallback khi không tìm được theo tên kho)
      const items = kho === '*' ? await searchRecords(token) : await searchByKho(token, kho);
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

        // Lấy danh sách record cũ (chưa xóa)
        const existing = await searchByKho(token, kho);

        // Tạo mới trước
        const fieldsList = items.map(it => ({
          barcode: it.barcode || '',
          ma_hang: it.ma_hang || '',
          ten_sp: it.ten_sp || '',
          kho,
          ton_he_thong: it.ton_he_thong || 0,
          don_gia: it.don_gia || 0,
          nganh: it.nganh || '',
          dvt: it.dvt || 'PSC'
        }));
        const created = await batchCreate(token, fieldsList);
        if (created === 0 && items.length > 0) {
          return new Response(JSON.stringify({ ok: false, error: 'Tạo mới thất bại, dữ liệu cũ giữ nguyên' }), { headers: CORS });
        }

        // Xóa cũ sau khi tạo thành công
        await batchDelete(token, existing.map(i => i.record_id));
        return new Response(JSON.stringify({ ok: true, deleted: existing.length, created }), { headers: CORS });
      }

      return new Response(JSON.stringify({ ok: false, error: 'Unknown action' }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
