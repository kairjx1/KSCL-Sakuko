const LARK = 'https://open.larksuite.com';
const APP_TOKEN = 'ESp9bqKtraHZqzsb1f0lTWKSgQg';
const TABLE_KK = 'tblL26TiyysoMQrI';

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

async function batchCreate(token, records) {
  const results = [];
  for (const rec of records) {
    const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_KK}/records`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(rec)
    });
    const j = await r.json();
    if (j.code !== 0) return j;
    results.push(j);
  }
  return { code: 0, data: { records: results } };
}

async function searchRecords(token, filter, pageToken) {
  let url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_KK}/records/search?page_size=500`;
  if (pageToken) url += `&page_token=${pageToken}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      field_names: ['ma_dot', 'ma_hang', 'barcode', 'ten_sp', 'dvt', 'nganh', 'khu_vuc', 'ton_he_thong', 'so_luong_dem_l1', 'so_luong_dem_l2', 'so_luong_dem_l3', 'chenh_lech', 'don_gia', 'gia_tri_chenh_lech', 'nguoi_dem', 'ghi_chu', 'lan_dem'],
      ...filter
    })
  });
  return r.json();
}

async function updateRecord(token, recordId, fields) {
  const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_KK}/records/${recordId}`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  return r.json();
}

function formatRecord(item) {
  const f = item.fields || {};
  return {
    id: item.record_id,
    ma_dot: extractText(f.ma_dot),
    ma_hang: extractText(f.ma_hang),
    barcode: extractText(f.barcode),
    ten_sp: extractText(f.ten_sp),
    dvt: extractText(f.dvt),
    nganh: extractText(f.nganh),
    khu_vuc: extractText(f.khu_vuc),
    ton_he_thong: f.ton_he_thong || 0,
    so_luong_dem_l1: f.so_luong_dem_l1 || 0,
    so_luong_dem_l2: f.so_luong_dem_l2 || 0,
    so_luong_dem_l3: f.so_luong_dem_l3 || 0,
    chenh_lech: f.chenh_lech || 0,
    don_gia: f.don_gia || 0,
    gia_tri_chenh_lech: f.gia_tri_chenh_lech || 0,
    nguoi_dem: extractText(f.nguoi_dem),
    ghi_chu: extractText(f.ghi_chu),
    lan_dem: f.lan_dem || 1
  };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const token = await getToken(env);

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const ma_dot = url.searchParams.get('ma_dot');
      if (!ma_dot) return new Response(JSON.stringify({ ok: false, error: 'Cần tham số ma_dot' }), { headers: CORS });

      const filter = { filter: { conjunction: 'and', conditions: [{ field_name: 'ma_dot', operator: 'is', value: [ma_dot] }] } };

      let allItems = [];
      let pageToken = null;
      do {
        const resp = await searchRecords(token, filter, pageToken);
        const items = (resp.data?.items || []).map(formatRecord);
        allItems = allItems.concat(items);
        pageToken = resp.data?.has_more ? resp.data.page_token : null;
      } while (pageToken);

      return new Response(JSON.stringify({ ok: true, items: allItems, total: allItems.length }), { headers: CORS });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const { action } = body;

      if (action === 'sync') {
        const { records } = body;
        if (!records || !records.length) return new Response(JSON.stringify({ ok: false, error: 'No records' }), { headers: CORS });

        const maDot = records[0].ma_dot;
        let existingMap = {};
        try {
          const filter = { filter: { conjunction: 'and', conditions: [{ field_name: 'ma_dot', operator: 'is', value: [maDot] }] } };
          let pageToken = null;
          do {
            const resp = await searchRecords(token, filter, pageToken);
            for (const item of (resp.data?.items || [])) {
              const f = item.fields || {};
              const key = extractText(f.barcode) + '::' + extractText(f.khu_vuc);
              existingMap[key] = { record_id: item.record_id, so_luong: f.so_luong_dem_l1 || 0 };
            }
            pageToken = resp.data?.has_more ? resp.data.page_token : null;
          } while (pageToken);
        } catch {}

        let totalCreated = 0, totalUpdated = 0;
        const createdRecords = [];
        for (const r of records) {
          const key = (r.barcode || '') + '::' + (r.khu_vuc || '');
          const existing = existingMap[key];
          if (existing) {
            const resp = await updateRecord(token, existing.record_id, { so_luong_dem_l1: r.so_luong || 0, nguoi_dem: r.nguoi_dem || '', ghi_chu: r.ghi_chu || '' });
            if (resp.code === 0) { totalUpdated++; createdRecords.push({ barcode: r.barcode, ma_hang: r.ma_hang, record_id: existing.record_id }); }
          } else {
            const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_KK}/records`;
            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: {
                ma_dot: r.ma_dot, ma_hang: r.ma_hang, barcode: r.barcode || '', ten_sp: r.ten_sp || '',
                dvt: r.dvt || 'PSC', nganh: r.nganh || '', khu_vuc: r.khu_vuc || '',
                ton_he_thong: r.ton_he_thong || 0, so_luong_dem_l1: r.so_luong || 0,
                don_gia: r.don_gia || 0, nguoi_dem: r.nguoi_dem || '', ghi_chu: r.ghi_chu || '', lan_dem: r.lan_dem || 1
              }})
            });
            const j = await resp.json();
            if (j.code === 0) {
              totalCreated++;
              const rid = j.data?.record?.record_id;
              if (rid) createdRecords.push({ barcode: r.barcode, ma_hang: r.ma_hang, record_id: rid });
              existingMap[key] = { record_id: rid, so_luong: r.so_luong || 0 };
            }
          }
        }

        return new Response(JSON.stringify({ ok: true, created: totalCreated, updated: totalUpdated, records: createdRecords }), { headers: CORS });
      }

      if (action === 'update') {
        const { record_id, fields } = body;
        if (!record_id) return new Response(JSON.stringify({ ok: false, error: 'Cần record_id' }), { headers: CORS });
        const resp = await updateRecord(token, record_id, fields);
        if (resp.code !== 0) throw new Error(resp.msg);
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      }

      if (action === 'delete') {
        const { record_id } = body;
        if (!record_id) return new Response(JSON.stringify({ ok: false, error: 'Cần record_id' }), { headers: CORS });
        const url = `${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_KK}/records/${record_id}`;
        const r = await fetch(url, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const resp = await r.json();
        if (resp.code !== 0) throw new Error(resp.msg);
        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      }

      return new Response(JSON.stringify({ ok: false, error: 'Unknown action' }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
