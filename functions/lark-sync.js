const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS });
}

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

    // Fetch all records (paginated)
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
      fetchAll('tblU0OlbMShM5ooe', ['Ngày kiểm tra', 'Tên Siêu thị', 'Kết quả check cam', 'Lỗi vi phạm', 'Tháng', 'Năm', 'Giải trình lý do']),
      fetchAll('tblQxeGxroYYFpY6', ['Thời gian', 'Tên Siêu thị', 'Kết quả', 'Tháng', 'Năm'])
    ]);

    // Aggregate by year/month
    const agg = {};
    const slot = (y, m) => {
      const k = `${y}/${m}`;
      if (!agg[k]) agg[k] = { y, m, dk: { total: 0, sp: 0, dgt: 0, cgt: 0, loiVPs: {} }, ctkm: { total: 0, sp: 0, cgt: 0, loiVPs: {} } };
      return agg[k];
    };
    for (const r of dkRecs) {
      const f = r.fields, y = f['Năm']?.value?.[0], m = f['Tháng'];
      if (!y || y === 1899 || !m) continue;
      const s = slot(y, m); s.dk.total++;
      if (f['Kết quả check cam'] === 'Sai phạm') {
        s.dk.sp++;
        const hasGT = Array.isArray(f['Giải trình lý do']) && f['Giải trình lý do'].length > 0;
        if (hasGT) s.dk.dgt++; else s.dk.cgt++;
        for (const l of (Array.isArray(f['Lỗi vi phạm']) ? f['Lỗi vi phạm'] : [])) s.dk.loiVPs[l] = (s.dk.loiVPs[l] || 0) + 1;
      }
    }
    for (const r of ctkmRecs) {
      const f = r.fields, y = f['Năm']?.value?.[0], m = f['Tháng'];
      if (!y || y === 1899 || !m || !f['Kết quả']) continue;
      const s = slot(y, m); s.ctkm.total++;
      if (f['Kết quả'] === 'Không tặng khách') { s.ctkm.sp++; s.ctkm.cgt++; s.ctkm.loiVPs['Không tặng khách'] = (s.ctkm.loiVPs['Không tặng khách'] || 0) + 1; }
    }

    return json({ ok: true, data: agg, counts: { dk: dkRecs.length, ctkm: ctkmRecs.length } });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
