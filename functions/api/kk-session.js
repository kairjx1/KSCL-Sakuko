const LARK = 'https://open.larksuite.com';
const APP_TOKEN = 'ESp9bqKtraHZqzsb1f0lTWKSgQg';
const TABLE_DOT = 'tblHULQOhmPLQLIv';
const TABLE_KV = 'tblxEAOmeQUVS2Y3';

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

async function searchTable(token, tableId, filter, fields) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search?page_size=500`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ field_names: fields, ...(filter || {}) })
  });
  return r.json();
}

async function createRecord(token, tableId, fields) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`;
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
      const action = url.searchParams.get('action') || 'list';
      const ma_dot = url.searchParams.get('ma_dot');

      if (action === 'khu_vuc') {
        const resp = await searchTable(token, TABLE_KV, null, ['ma_khu_vuc', 'ten_khu_vuc', 'kho', 'mo_ta']);
        const items = (resp.data?.items || []).map(i => ({
          id: i.record_id,
          ma_khu_vuc: extractText(i.fields.ma_khu_vuc),
          ten_khu_vuc: extractText(i.fields.ten_khu_vuc),
          kho: extractText(i.fields.kho),
          mo_ta: extractText(i.fields.mo_ta)
        }));
        return new Response(JSON.stringify({ ok: true, items }), { headers: CORS });
      }

      if (action === 'get' && ma_dot) {
        const filter = { filter: { conjunction: 'and', conditions: [{ field_name: 'ma_dot', operator: 'is', value: [ma_dot] }] } };
        const resp = await searchTable(token, TABLE_DOT, filter, ['ma_dot', 'ten_dot', 'thang', 'nam', 'ngay_bat_dau', 'trang_thai', 'kho', 'nguoi_tao']);
        const items = resp.data?.items || [];
        if (!items.length) return new Response(JSON.stringify({ ok: false, error: 'Không tìm thấy đợt kiểm kê' }), { headers: CORS });
        const f = items[0].fields;
        return new Response(JSON.stringify({
          ok: true,
          dot: {
            id: items[0].record_id,
            ma_dot: extractText(f.ma_dot),
            ten_dot: extractText(f.ten_dot),
            thang: f.thang, nam: f.nam,
            trang_thai: extractText(f.trang_thai),
            kho: extractText(f.kho),
            nguoi_tao: extractText(f.nguoi_tao)
          }
        }), { headers: CORS });
      }

      const resp = await searchTable(token, TABLE_DOT, null, ['ma_dot', 'ten_dot', 'thang', 'nam', 'trang_thai', 'kho', 'nguoi_tao']);
      const items = (resp.data?.items || []).map(i => ({
        id: i.record_id,
        ma_dot: extractText(i.fields.ma_dot),
        ten_dot: extractText(i.fields.ten_dot),
        thang: i.fields.thang, nam: i.fields.nam,
        trang_thai: extractText(i.fields.trang_thai),
        kho: extractText(i.fields.kho)
      }));
      return new Response(JSON.stringify({ ok: true, items }), { headers: CORS });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const { action } = body;

      if (action === 'create_dot') {
        const now = new Date();
        const ma_dot = `KK${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const fields = {
          ma_dot: body.ma_dot || ma_dot,
          ten_dot: body.ten_dot || `Kiểm kê tháng ${now.getMonth() + 1}/${now.getFullYear()}`,
          thang: body.thang || now.getMonth() + 1,
          nam: body.nam || now.getFullYear(),
          trang_thai: 'Chuẩn bị',
          kho: body.kho || 'KHO TỔNG',
          nguoi_tao: body.nguoi_tao || ''
        };
        if (body.ngay_bat_dau) fields.ngay_bat_dau = body.ngay_bat_dau;
        const resp = await createRecord(token, TABLE_DOT, fields);
        if (resp.code !== 0) throw new Error(resp.msg);
        return new Response(JSON.stringify({ ok: true, ma_dot: fields.ma_dot, record_id: resp.data.record.record_id }), { headers: CORS });
      }

      if (action === 'create_khu_vuc') {
        const fields = {
          ma_khu_vuc: body.ma_khu_vuc,
          ten_khu_vuc: body.ten_khu_vuc,
          kho: body.kho || '',
          mo_ta: body.mo_ta || ''
        };
        const resp = await createRecord(token, TABLE_KV, fields);
        if (resp.code !== 0) throw new Error(resp.msg);
        return new Response(JSON.stringify({ ok: true, record_id: resp.data.record.record_id }), { headers: CORS });
      }

      return new Response(JSON.stringify({ ok: false, error: 'Unknown action' }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
