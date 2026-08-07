/**
 * CF Pages Function: GET /lark-sync
 * Env vars: LARK_APP_ID, LARK_APP_SECRET
 */
const LARK      = 'https://open.larksuite.com';
const APP_TOKEN = 'AGGAbC9BPaioxas1VW8lV6tOg7g';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

function getNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v?.value != null) { const n = Array.isArray(v.value) ? v.value[0] : v.value; return n != null ? Number(n) : null; }
  if (typeof v === 'string') { const n = Number(v); return isNaN(n) ? null : n; }
  return null;
}
function getTxt(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0]?.text ?? String(v[0] ?? '');
  if (v?.value != null) return String(Array.isArray(v.value) ? (v.value[0]?.text ?? v.value[0] ?? '') : v.value);
  return '';
}
function getArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : (x?.text ?? String(x ?? '')));
  if (typeof v === 'string') return [v];
  return [];
}

const DK_FAIL   = new Set(['Sai phạm','Không đạt','CGT','Fail','fail','Có sai phạm']);
const CTKM_FAIL = new Set(['Không tặng khách','Không đạt','CGT','Sai phạm','Fail','Có lỗi','Không tặng','Không tặng KH']);

async function getToken(id, secret) {
  const r = await fetch(`${LARK}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: id, app_secret: secret })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('Auth lỗi: ' + j.msg + ' (' + j.code + ')');
  return j.tenant_access_token;
}

async function fetchAll(token, tblId, fields) {
  let all = [], pt = '', more = true;
  while (more) {
    const body = { field_names: fields, page_size: 200 };
    if (pt) body.page_token = pt;
    const r = await fetch(`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tblId}/records/search`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error('Bitable: ' + j.msg);
    all = all.concat(j.data?.items || []);
    more = !!j.data?.has_more;
    pt = j.data?.page_token || '';
  }
  return all;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const APP_ID     = env.LARK_APP_ID     || 'cli_aaa0cdd424b81eed';
  const APP_SECRET = env.LARK_APP_SECRET || '';
  if (!APP_SECRET) return new Response(JSON.stringify({ ok: false, error: 'LARK_APP_SECRET chưa cấu hình' }), { status: 500, headers: CORS });
  try {
    const token = await getToken(APP_ID, APP_SECRET);
    const [dkRecs, ctkmRecs] = await Promise.all([
      fetchAll(token, 'tblU0OlbMShM5ooe', ['Ngày kiểm tra','Tên Siêu thị','Kết quả check cam','Lỗi vi phạm','Tháng','Năm','Giải trình lý do']),
      fetchAll(token, 'tblQxeGxroYYFpY6', ['Thời gian','Tên Siêu thị','Kết quả','Tháng','Năm'])
    ]);

    const agg = {};
    const slot = (y, m) => {
      const k = `${y}/${m}`;
      if (!agg[k]) agg[k] = {
        y, m,
        dk:{ total:0, sp:0, dgt:0, cgt:0, loiVPs:{}, stDetails:{} },
        ctkm:{ total:0, sp:0, cgt:0, loiVPs:{}, stDetails:{} }
      };
      return agg[k];
    };

    for (const r of dkRecs) {
      const f = r.fields;
      const y = getNum(f['Năm']); const m = getNum(f['Tháng']);
      if (!y || y < 2020 || !m) continue;
      const s = slot(y, m); s.dk.total++;
      const stName = getTxt(f['Tên Siêu thị']).trim() || 'Chưa xác định';
      if (!s.dk.stDetails[stName]) s.dk.stDetails[stName] = { total:0, cgt:0, loiVPs:{} };
      s.dk.stDetails[stName].total++;
      const kq = getTxt(f['Kết quả check cam'] ?? f['Kết quả']).trim();
      if (DK_FAIL.has(kq)) {
        s.dk.sp++;
        const gt = f['Giải trình lý do'];
        const hasGT = Array.isArray(gt) ? gt.length > 0 : !!getTxt(gt);
        if (hasGT) s.dk.dgt++; else {
          s.dk.cgt++;
          s.dk.stDetails[stName].cgt++;
        }
        for (const l of getArr(f['Lỗi vi phạm'])) {
          const lk = l.trim(); if (lk) {
            s.dk.loiVPs[lk] = (s.dk.loiVPs[lk]||0)+1;
            s.dk.stDetails[stName].loiVPs[lk] = (s.dk.stDetails[stName].loiVPs[lk]||0)+1;
          }
        }
      }
    }

    for (const r of ctkmRecs) {
      const f = r.fields;
      const y = getNum(f['Năm']); const m = getNum(f['Tháng']);
      if (!y || y < 2020 || !m) continue;
      const s = slot(y, m); s.ctkm.total++;
      const stName = getTxt(f['Tên Siêu thị']).trim() || 'Chưa xác định';
      if (!s.ctkm.stDetails[stName]) s.ctkm.stDetails[stName] = { total:0, cgt:0 };
      s.ctkm.stDetails[stName].total++;
      const kq = getTxt(f['Kết quả']).trim();
      if (CTKM_FAIL.has(kq)) {
        s.ctkm.sp++; s.ctkm.cgt++;
        s.ctkm.stDetails[stName].cgt++;
        if (kq) s.ctkm.loiVPs[kq] = (s.ctkm.loiVPs[kq]||0)+1;
      }
    }

    return new Response(JSON.stringify({ ok: true, data: agg, counts: { dk: dkRecs.length, ctkm: ctkmRecs.length } }), { headers: { ...CORS, 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
