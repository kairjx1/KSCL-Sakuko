const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

// Robust field parsers — Lark returns different shapes for number/lookup/formula/text fields
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

export async function onRequestPost(context) {
  try {
    const { secret } = await context.request.json();
    if (!secret) return json({ ok: false, error: 'Missing app_secret' }, 400);

    // Get app_access_token
    const authR = await fetch('https://open.larksuite.com/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: 'cli_aaa0cdd424b81eed', app_secret: secret })
    });
    const authJ = await authR.json();
    if (authJ.code !== 0) return json({ ok: false, error: 'Auth lỗi: ' + authJ.msg + ' (' + authJ.code + ')' }, 400);
    const aat = authJ.app_access_token;

    const appToken = 'AGGAbC9BPaioxas1VW8lV6tOg7g';
    const fetchAll = async (tblId, fields) => {
      let all = [], pt = '', more = true;
      while (more) {
        const body = { field_names: fields, page_size: 200 };
        if (pt) body.page_token = pt;
        const r = await fetch(`https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tblId}/records/search`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + aat, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const j = await r.json();
        if (j.code !== 0) throw new Error('Bitable: ' + j.msg);
        all = all.concat(j.data?.items || []);
        more = !!j.data?.has_more;
        pt = j.data?.page_token || '';
      }
      return all;
    };

    const [dkRecs, ctkmRecs] = await Promise.all([
      fetchAll('tblU0OlbMShM5ooe', ['Ngày kiểm tra','Tên Siêu thị','Kết quả check cam','Kết quả','Lỗi vi phạm','Tháng','Năm','Giải trình lý do']),
      fetchAll('tblQxeGxroYYFpY6', ['Thời gian','Tên Siêu thị','Kết quả','Tháng','Năm'])
    ]);

    const agg = {};
    const slot = (y, m) => {
      const k = `${y}/${m}`;
      if (!agg[k]) agg[k] = { y, m, dk:{ total:0, sp:0, dgt:0, cgt:0, loiVPs:{} }, ctkm:{ total:0, sp:0, cgt:0, loiVPs:{} } };
      return agg[k];
    };

    for (const r of dkRecs) {
      const f = r.fields;
      const y = getNum(f['Năm']); const m = getNum(f['Tháng']);
      if (!y || y < 2020 || !m) continue;
      const s = slot(y, m); s.dk.total++;
      const kq = getTxt(f['Kết quả check cam'] ?? f['Kết quả']).trim();
      if (DK_FAIL.has(kq)) {
        s.dk.sp++;
        const gt = f['Giải trình lý do'];
        const hasGT = Array.isArray(gt) ? gt.length > 0 : !!getTxt(gt);
        if (hasGT) s.dk.dgt++; else s.dk.cgt++;
        for (const l of getArr(f['Lỗi vi phạm'])) {
          const lk = l.trim(); if (lk) s.dk.loiVPs[lk] = (s.dk.loiVPs[lk]||0)+1;
        }
      }
    }

    for (const r of ctkmRecs) {
      const f = r.fields;
      const y = getNum(f['Năm']); const m = getNum(f['Tháng']);
      if (!y || y < 2020 || !m) continue;
      const s = slot(y, m); s.ctkm.total++;
      const kq = getTxt(f['Kết quả']).trim();
      if (CTKM_FAIL.has(kq)) {
        s.ctkm.sp++; s.ctkm.cgt++;
        if (kq) s.ctkm.loiVPs[kq] = (s.ctkm.loiVPs[kq]||0)+1;
      }
    }

    return json({ ok: true, data: agg, counts: { dk: dkRecs.length, ctkm: ctkmRecs.length } });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
