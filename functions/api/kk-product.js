const LARK = 'https://open.larksuite.com';
const APP_TOKEN = 'ESp9bqKtraHZqzsb1f0lTWKSgQg';
const TABLE_DMHH = 'tbl0aLt9gX3knGyW';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
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

async function searchRecords(token, filter, pageSize = 100) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_DMHH}/records/search?page_size=${pageSize}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      field_names: ['ma_hang', 'ten_sp', 'barcode', 'nganh', 'nhom', 'loai', 'gia_ban_le', 'block'],
      ...filter
    })
  });
  return r.json();
}

function extractText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(s => typeof s === 'object' ? s.text || '' : String(s)).join('');
  if (typeof val === 'object' && val.text) return val.text;
  return String(val);
}

function formatRecord(item) {
  const f = item.fields || {};
  return {
    id: item.record_id,
    ma_hang: extractText(f.ma_hang),
    ten_sp: extractText(f.ten_sp),
    barcode: extractText(f.barcode),
    nganh: extractText(f.nganh),
    nhom: extractText(f.nhom),
    loai: extractText(f.loai),
    gia_ban_le: f.gia_ban_le || 0,
    block: extractText(f.block)
  };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const url = new URL(request.url);
    const barcode = url.searchParams.get('barcode');
    const ma_hang = url.searchParams.get('ma_hang');
    const q = url.searchParams.get('q');

    if (!barcode && !ma_hang && !q) {
      return new Response(JSON.stringify({ ok: false, error: 'Cần tham số: barcode, ma_hang, hoặc q' }), { headers: CORS });
    }

    const token = await getToken(env);
    let filter;

    if (barcode) {
      filter = { filter: { conjunction: 'and', conditions: [{ field_name: 'barcode', operator: 'is', value: [barcode] }] } };
    } else if (ma_hang) {
      filter = { filter: { conjunction: 'and', conditions: [{ field_name: 'ma_hang', operator: 'is', value: [ma_hang] }] } };
    } else {
      filter = { filter: { conjunction: 'or', conditions: [
        { field_name: 'barcode', operator: 'is', value: [q] },
        { field_name: 'ma_hang', operator: 'is', value: [q] },
        { field_name: 'ten_sp', operator: 'contains', value: [q] }
      ] } };
    }

    const resp = await searchRecords(token, filter);
    const items = (resp.data?.items || []).map(formatRecord);

    return new Response(JSON.stringify({ ok: true, items, total: items.length }), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
