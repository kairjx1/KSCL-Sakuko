/**
 * CF Pages Function: GET /api/lark-xuathuy
 * Env vars: LARK_APP_ID, LARK_APP_SECRET
 * Base "Xử lý xuất hủy" → cache {ts, data:{year:{Txx:agg}}, revenue:{year:{Txx:dt}}}
 */
const LARK      = 'https://open.larksuite.com';
const APP_TOKEN = 'OIpKbJZPwaGdnrsfUa2lchK4gZg';
const TABLE_ID  = 'tblgzrbzVv0QWpKT';
const VIEW_ID   = 'vewt9EgxEg';
const REV_TOKEN = 'IRsfbMZQJaN9XPslfr1lTCT7gki';
const REV_TABLE = 'tblerJGG1X3ky80Y';
const CORS      = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Content-Type':'application/json' };

function txt(v){
  if(v==null)return'';
  if(typeof v==='string')return v.trim();
  if(typeof v==='number')return String(v);
  if(Array.isArray(v))return (v[0]?.text??v[0]??'').toString().trim();
  return'';
}
function num(v){
  if(v==null)return 0;
  if(typeof v==='number')return v;
  if(typeof v==='string')return parseFloat(v)||0;
  if(Array.isArray(v))return parseFloat(v[0]?.text??v[0])||0;
  return 0;
}

async function getToken(id,secret){
  const r=await fetch(`${LARK}/open-apis/auth/v3/tenant_access_token/internal`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({app_id:id,app_secret:secret})
  });
  const j=await r.json();
  if(j.code!==0)throw new Error('Auth: '+j.msg);
  return j.tenant_access_token;
}
async function getUserToken(id,secret,refreshToken){
  const r=await fetch(`${LARK}/open-apis/authen/v1/refresh_access_token`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({grant_type:'refresh_token',refresh_token:refreshToken,app_id:id,app_secret:secret})
  });
  const j=await r.json();
  if(j.code!==0)throw new Error('UserAuth: '+j.msg+' ('+j.code+')');
  return j.data?.access_token||j.access_token;
}

// GET records with view_id (view filter applies on GET, not /search)
async function fetchAll(token){
  const all=[];let pt='',more=true;
  while(more){
    let url=`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500&view_id=${VIEW_ID}`;
    if(pt)url+='&page_token='+encodeURIComponent(pt);
    const r=await fetch(url,{headers:{Authorization:'Bearer '+token}});
    const j=await r.json();
    if(j.code!==0)throw new Error('Bitable: '+j.msg);
    const batch=j.data?.items||[];
    all.push(...batch);
    const newPt=j.data?.page_token||'';
    more=!!j.data?.has_more&&newPt!==pt&&all.length<20000; // guard token-cycling bug
    pt=newPt;
  }
  return all;
}

async function fetchRevenue(token){
  const revenue={},revenueCVS={};
  const r=await fetch(`${LARK}/open-apis/bitable/v1/apps/${REV_TOKEN}/tables/${REV_TABLE}/records?page_size=50`,{
    headers:{Authorization:'Bearer '+token}
  });
  const j=await r.json();
  for(const rec of j.data?.items||[]){
    const f=rec.fields||{};
    const y=String(num(f['Năm'])||2026);
    const t=num(f['Tháng']);
    if(t>=1&&t<=12){
      const mk=`T${String(t).padStart(2,'0')}`;
      if(!revenue[y])revenue[y]={};
      if(!revenueCVS[y])revenueCVS[y]={};
      revenue[y][mk]=num(f['Doanh thu']);
      revenueCVS[y][mk]=num(f['Doanh thu CVS']);
    }
  }
  return {revenue,revenueCVS};
}

// ═══ CVS xuất hủy ═══
const CVS_APP='EKq5bGdLaa26lmsIKOCln3jGg0c';
const CVS_TABLE='tblfWKMonJYhi2TZ';
const CVS_VIEW='vewwXPAOEf';
const CVS_ST_TABLE='tblduggsJ4Aab2GG';

async function cvsOptionMap(token){
  const map={};
  const r=await fetch(`${LARK}/open-apis/bitable/v1/apps/${CVS_APP}/tables/${CVS_ST_TABLE}/fields?page_size=100`,{
    headers:{Authorization:'Bearer '+token}
  });
  const j=await r.json();
  for(const fl of j.data?.items||[]){
    for(const o of fl.property?.options||[])map[o.id]=o.name;
  }
  return map;
}
function optTxt(v,map){
  if(Array.isArray(v))return v.map(x=>map[x]||x).join(', ');
  if(typeof v==='string')return map[v]||v;
  return'';
}

async function fetchAllCVS(token){
  const all=[];let pt='',more=true;
  while(more){
    let url=`${LARK}/open-apis/bitable/v1/apps/${CVS_APP}/tables/${CVS_TABLE}/records?page_size=500`;
    if(pt)url+='&page_token='+encodeURIComponent(pt);
    const r=await fetch(url,{headers:{Authorization:'Bearer '+token}});
    const j=await r.json();
    if(j.code!==0)throw new Error('Bitable CVS: '+j.msg);
    all.push(...(j.data?.items||[]));
    const newPt=j.data?.page_token||'';
    more=!!j.data?.has_more&&newPt!==pt&&all.length<20000;
    pt=newPt;
  }
  return all;
}

function aggregateCVS(records,optMap){
  const cvs={};
  for(const rec of records){
    const f=rec.fields||{};
    const year=num(f['Năm'])||new Date(num(f['Ngày'])||Date.now()).getFullYear();
    const thang=num(f['Tháng']);
    if(!thang||thang<1||thang>12)continue;
    const mKey=`T${String(thang).padStart(2,'0')}`,yKey=String(year);
    if(!cvs[yKey])cvs[yKey]={};
    if(!cvs[yKey][mKey])cvs[yKey][mKey]={total:0,qty:0,value:0,stores:{},items:{},tinhTrang:{},tinhTrangValue:{}};
    const agg=cvs[yKey][mKey];
    const st=optTxt(f['Mã Siêu thị'],optMap)||'?';
    const stTen=optTxt(f['Tên ST'],optMap)||st;
    const maHang=txt(f['Mã hàng']);
    const tenSp=txt(f['Tên hàng']);
    const qty=num(f['Số lượng']);
    const value=num(f['Giá trị']);
    const loai=txt(f['Loại'])||txt(f['Loại hàng']);
    agg.total++;agg.qty+=qty;agg.value+=value;
    if(!agg.stores[st])agg.stores[st]={ten:stTen,count:0,qty:0,value:0};
    agg.stores[st].count++;agg.stores[st].qty+=qty;agg.stores[st].value+=value;
    if(maHang){
      if(!agg.items[maHang])agg.items[maHang]={ten:tenSp,count:0,qty:0,value:0};
      agg.items[maHang].count++;agg.items[maHang].qty+=qty;agg.items[maHang].value+=value;
    }
    if(loai){
      agg.tinhTrang[loai]=(agg.tinhTrang[loai]||0)+1;
      agg.tinhTrangValue[loai]=(agg.tinhTrangValue[loai]||0)+value;
    }
  }
  for(const y of Object.keys(cvs)){
    for(const m of Object.keys(cvs[y])){
      const agg=cvs[y][m];
      agg.value=Math.round(agg.value);
      agg.qty=Math.round(agg.qty*10)/10;
      agg.stores=Object.entries(agg.stores).sort((a,b)=>b[1].value-a[1].value)
        .map(([ma,v])=>({ma,ten:v.ten,count:v.count,qty:Math.round(v.qty),value:Math.round(v.value)}));
      agg.items=Object.entries(agg.items).sort((a,b)=>b[1].value-a[1].value).slice(0,100)
        .map(([ma,v])=>({ma,ten:v.ten,count:v.count,qty:Math.round(v.qty),value:Math.round(v.value)}));
      for(const k of Object.keys(agg.tinhTrangValue))agg.tinhTrangValue[k]=Math.round(agg.tinhTrangValue[k]);
    }
  }
  return cvs;
}

function aggregate(records){
  const data={};
  for(const rec of records){
    const f=rec.fields||{};
    const year=num(f['Năm'])||new Date(num(f['NGÀY GỬI XUẤT HỦY'])||Date.now()).getFullYear();
    const thang=num(f['Tháng']);
    if(!thang||thang<1||thang>12)continue;
    const mKey=`T${String(thang).padStart(2,'0')}`, yKey=String(year);
    if(!data[yKey])data[yKey]={};
    if(!data[yKey][mKey])data[yKey][mKey]={total:0,qty:0,value:0,stores:{},items:{},tinhTrang:{},tinhTrangValue:{}};
    const agg=data[yKey][mKey];

    const st=txt(f['ST']);
    const maSt=txt(f['Mã ST']);
    const stTen=maSt.includes('_')?maSt.split('_').slice(1).join('_'):maSt;
    const maHang=txt(f['MÃ HÀNG']);
    const tenSp=txt(f['TÊN SP']);
    const qty=num(f['SỐ LƯỢNG HỦY']);
    const value=num(f['THÀNH TIỀN']);
    const tt=txt(f['TÌNH TRẠNG HÀNG HÓA']);

    agg.total++;agg.qty+=qty;agg.value+=value;
    const sk=st||'?';
    if(!agg.stores[sk])agg.stores[sk]={ten:stTen||sk,count:0,qty:0,value:0};
    agg.stores[sk].count++;agg.stores[sk].qty+=qty;agg.stores[sk].value+=value;
    if(maHang){
      if(!agg.items[maHang])agg.items[maHang]={ten:tenSp,count:0,qty:0,value:0};
      agg.items[maHang].count++;agg.items[maHang].qty+=qty;agg.items[maHang].value+=value;
    }
    if(tt){
      agg.tinhTrang[tt]=(agg.tinhTrang[tt]||0)+1;
      agg.tinhTrangValue[tt]=(agg.tinhTrangValue[tt]||0)+value;
    }
  }
  for(const y of Object.keys(data)){
    for(const m of Object.keys(data[y])){
      const agg=data[y][m];
      agg.value=Math.round(agg.value);
      agg.stores=Object.entries(agg.stores).sort((a,b)=>b[1].value-a[1].value)
        .map(([ma,v])=>({ma,ten:v.ten,count:v.count,qty:Math.round(v.qty),value:Math.round(v.value)}));
      agg.items=Object.entries(agg.items).sort((a,b)=>b[1].value-a[1].value).slice(0,100)
        .map(([ma,v])=>({ma,ten:v.ten,count:v.count,qty:Math.round(v.qty),value:Math.round(v.value)}));
      for(const k of Object.keys(agg.tinhTrangValue))agg.tinhTrangValue[k]=Math.round(agg.tinhTrangValue[k]);
    }
  }
  return data;
}

const CACHE_MAX_AGE_MS = 23 * 60 * 60 * 1000; // 23 giờ — GitHub Action cập nhật 2h SA

export async function onRequest(context){
  const {request,env}=context;
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});

  const url=new URL(request.url);
  const forceRefresh=url.searchParams.get('refresh')==='1';

  // 1. Thử đọc từ cache tĩnh trước (nhanh, không timeout)
  if(!forceRefresh){
    try{
      const origin=url.origin;
      const cacheRes=await fetch(`${origin}/xuathuy-cache.json`,{cf:{cacheTtl:300}});
      if(cacheRes.ok){
        const cached=await cacheRes.json();
        // Nếu cache còn mới (< 23h) → trả về ngay
        if(cached.ts && Date.now()-cached.ts < CACHE_MAX_AGE_MS){
          return new Response(JSON.stringify(cached),{status:200,headers:{...CORS,'X-Cache':'HIT'}});
        }
      }
    }catch(_){}
  }

  // 2. Cache cũ hoặc ?refresh=1 → fetch mới từ Lark (chạy background nếu có thể)
  try{
    const APP_ID=env.LARK_APP_ID||'cli_aaa0cdd424b81eed';
    const APP_SECRET=env.LARK_APP_SECRET||'';
    const REFRESH_TOKEN=env.LARK_REFRESH_TOKEN||'';
    const userTokenFromHeader=request.headers.get('X-Lark-Token')||'';
    if(!APP_SECRET&&!userTokenFromHeader)throw new Error('LARK_APP_SECRET chưa cấu hình');
    const token=userTokenFromHeader
      ||(REFRESH_TOKEN?await getUserToken(APP_ID,APP_SECRET,REFRESH_TOKEN):await getToken(APP_ID,APP_SECRET));
    // CVS bitable luôn dùng bot token (user token có thể không có quyền đọc CVS)
    const botToken=APP_SECRET?await getToken(APP_ID,APP_SECRET):token;
    const [records,revs,optMap,cvsRecords]=await Promise.all([
      fetchAll(token),fetchRevenue(token),cvsOptionMap(botToken),fetchAllCVS(botToken)
    ]);
    const data=aggregate(records);
    const cvs=aggregateCVS(cvsRecords,optMap);
    const hasData=Object.keys(data).length>0;
    const hasCVS=Object.keys(cvs).length>0;
    // Nếu cả 2 đều rỗng (bot token không đọc được bitable) → dùng static cache + ts mới
    if(!hasData&&!hasCVS){
      try{
        const origin=new URL(request.url).origin;
        const sc=await fetch(`${origin}/xuathuy-cache.json`,{signal:AbortSignal.timeout(5000)});
        if(sc.ok){const sj=await sc.json();if(sj.data&&Object.keys(sj.data).length){return new Response(JSON.stringify({...sj,ts:Date.now(),_src:'static'}),{status:200,headers:{...CORS,'X-Cache':'STATIC'}});}}
      }catch(_){}
      // Static cache cũng rỗng → báo lỗi để browser dùng GitHub cache
      return new Response(JSON.stringify({ok:false,error:'Bot token không đọc được bitable và không có static cache'}),{status:500,headers:CORS});
    }
    // Nếu chỉ CVS rỗng → lấy CVS từ static cache
    let cvsFinal=cvs,revCVSFinal=revs.revenueCVS;
    if(hasData&&!hasCVS){
      try{
        const origin=new URL(request.url).origin;
        const sc=await fetch(`${origin}/xuathuy-cache.json`,{signal:AbortSignal.timeout(5000)});
        if(sc.ok){const sj=await sc.json();if(sj.cvs&&Object.keys(sj.cvs).length){cvsFinal=sj.cvs;if(sj.revenueCVS)revCVSFinal=sj.revenueCVS;}}
      }catch(_){}
    }
    const cache={ts:Date.now(),data,revenue:revs.revenue,cvs:cvsFinal,revenueCVS:revCVSFinal};
    return new Response(JSON.stringify(cache),{status:200,headers:{...CORS,'X-Cache':'MISS'}});
  }catch(e){
    // 3. Fetch mới thất bại → trả cache cũ dù hết hạn, báo stale
    try{
      const origin=new URL(request.url).origin;
      const cacheRes=await fetch(`${origin}/xuathuy-cache.json`);
      if(cacheRes.ok){
        const cached=await cacheRes.json();
        cached._stale=true; cached._error=e.message;
        return new Response(JSON.stringify(cached),{status:200,headers:{...CORS,'X-Cache':'STALE'}});
      }
    }catch(_){}
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:CORS});
  }
}
