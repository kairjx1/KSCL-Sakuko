const LARK = 'https://open.larksuite.com';
const APP_TOKEN = 'ESp9bqKtraHZqzsb1f0lTWKSgQg';
const TABLE_CATALOG = 'tbl0aLt9gX3knGyW';

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

function extractSelect(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(v => typeof v === 'object' ? (v.text || v.value || '') : String(v)).join(', ');
  if (typeof val === 'object') return val.text || val.value || '';
  return String(val);
}

async function fetchAllCatalog(token) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_CATALOG}/records/search?page_size=500`;
  let items = [], pageToken = null;
  do {
    const reqUrl = pageToken ? url + '&page_token=' + pageToken : url;
    const r = await fetch(reqUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ field_names: ['ma_hang', 'ten_sp', 'barcode', 'nganh', 'nhom', 'loai', 'gia_ban_le', 'block', 'kenh_mua', 'trang_thai_kd'] })
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error('Lark: ' + (j.msg || j.code));
    items = items.concat(j.data?.items || []);
    pageToken = j.data?.has_more ? j.data.page_token : null;
  } while (pageToken);
  return items;
}

function formatItem(item) {
  const f = item.fields || {};
  return {
    record_id: item.record_id,
    ma_hang: extractText(f.ma_hang),
    ten_sp: extractText(f.ten_sp),
    barcode: extractText(f.barcode),
    nganh: extractSelect(f.nganh),
    nhom: extractText(f.nhom),
    loai: extractText(f.loai),
    gia_ban_le: f.gia_ban_le || 0,
    block: extractSelect(f.block),
    kenh_mua: extractText(f.kenh_mua),
    trang_thai_kd: extractText(f.trang_thai_kd)
  };
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
    await fetch(`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_CATALOG}/records/batch_delete`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: chunk })
    });
  });
}

async function batchCreate(token, fieldsList) {
  const results = await parallelChunks(fieldsList, 500, async chunk => {
    const r = await fetch(`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_CATALOG}/records/batch_create`, {
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

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const q = (url.searchParams.get('q') || '').trim();

      if (q) {
        // Tìm kiếm nhanh theo từ khoá — không paginate hết
        const searchUrl = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_CATALOG}/records/search?page_size=50`;
        const body = {
          field_names: ['ma_hang', 'ten_sp', 'barcode', 'nganh', 'gia_ban_le'],
          filter: {
            conjunction: 'or',
            conditions: [
              { field_name: 'ten_sp', operator: 'contains', value: [q] },
              { field_name: 'ma_hang', operator: 'contains', value: [q] },
              { field_name: 'barcode', operator: 'contains', value: [q] }
            ]
          }
        };
        const r = await fetch(searchUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const j = await r.json();
        if (j.code !== 0) throw new Error('Lark: ' + (j.msg || j.code));
        const result = (j.data?.items || []).map(formatItem);
        return new Response(JSON.stringify({ ok: true, items: result, total: result.length }), { headers: CORS });
      }

      // Không có q → trả về toàn bộ (dùng cho đồng bộ offline, chấp nhận chậm)
      const items = await fetchAllCatalog(token);
      const result = items.map(formatItem);
      return new Response(JSON.stringify({ ok: true, items: result, total: result.length }), { headers: CORS });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const { action, items } = body;

      if (action === 'import') {
        if (!items?.length) return new Response(JSON.stringify({ ok: false, error: 'Cần items' }), { headers: CORS });

        // Lấy record cũ
        const existing = await fetchAllCatalog(token);

        // Tạo mới trước
        const fieldsList = items.map(it => ({
          ma_hang: it.ma_hang || '',
          ten_sp: it.ten_sp || '',
          barcode: it.barcode || '',
          nganh: it.nganh || '',
          nhom: it.nhom || '',
          loai: it.loai || '',
          gia_ban_le: it.gia_ban_le || 0,
          block: it.block || '',
          kenh_mua: it.kenh_mua || '',
          trang_thai_kd: it.trang_thai_kd || ''
        }));
        const created = await batchCreate(token, fieldsList);
        if (created === 0 && items.length > 0) {
          return new Response(JSON.stringify({ ok: false, error: 'Tạo mới thất bại' }), { headers: CORS });
        }

        // Xóa cũ sau
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
