/**
 * CF Pages Function: GET /api/lark-tonam
 * Env vars: LARK_APP_ID, LARK_APP_SECRET
 */
const LARK      = 'https://open.larksuite.com';
const APP_TOKEN = 'Fvh5bAoZ5arkBWsNmvPl3eIIgKh';
const REV_TOKEN = 'IRsfbMZQJaN9XPslfr1lTCT7gki';
const REV_TABLE = 'tblerJGG1X3ky80Y';
const CORS      = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Content-Type':'application/json' };

const STORE_NAMES = {
  'S1001':'SKK Đội Cấn','S1002':'SKK Linh Đàm','S1004':'SKK Mandarin C1',
  'S1005':'SKK Thái Hà','S1006':'SKK Trần Đăng Ninh','S1007':'SKK Nguyễn Du',
  'S1008':'SKK Hàng Bông','S1011':'SKK Văn Phú','S1015':'SKK Hàm Nghi',
  'S1018':'SKK Nguyễn Tuân','S1020':'SKK Đỗ Quang','S1021':'SKK Ngoại Giao Đoàn',
  'S1022':'SKK Trần Duy Hưng','S1023':'SKK Nguyễn Văn Lộc','S1025':'SKK T6 Time City',
  'S1026':'SKK Ecohome 3','S1027':'SKK Green Bay','S1030':'SKK Xuân La',
  'S1035':'SKK Nguyễn Khuyến','S1036':'SKK Sài Đồng','S1037':'SKK Bạch Mai',
  'S1038':'SKK Vũ Phạm Hàm','S2201':'SKK Bắc Ninh',
};

function txt(v){if(!v)return'';if(typeof v==='string')return v;if(Array.isArray(v))return v[0]?.text??'';return'';}
function lkp(v){if(!v)return'';if(v?.value&&Array.isArray(v.value))return String(v.value[0]||'');if(typeof v==='string')return v;return'';}
function fml(v){if(!v)return'';if(Array.isArray(v))return v[0]?.text??'';if(v?.value&&Array.isArray(v.value))return v.value[0]?.text??'';if(typeof v==='string')return v;return'';}

async function getToken(id,secret){
  const r=await fetch(`${LARK}/open-apis/auth/v3/tenant_access_token/internal`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({app_id:id,app_secret:secret})
  });
  const j=await r.json();
  if(j.code!==0)throw new Error('Auth: '+j.msg);
  return j.tenant_access_token;
}

const KNOWN_VIEWS={T01:'vewHqzX1XZ',T02:'vewvgrFCBc',T03:'vewqDpKLSv',T04:'vewuBDjb0W',T05:'vewHlcgIvH',T06:'vewbbA2pp3',T07:'vewPC4mQFY'};
async function getViewId(token,month,tableId){
  if(KNOWN_VIEWS[month])return KNOWN_VIEWS[month];
  try{
    const r=await fetch(`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/views`,{headers:{Authorization:'Bearer '+token}});
    const j=await r.json();
    const vs=j.data?.items||[];
    const kv=vs.find(v=>{const n=(v.view_name||'').toLowerCase();return n.includes('kiểm soát')||n.includes('kscl')||n.includes('tồn âm');});
    return (kv||vs[0])?.view_id||null;
  }catch(e){return null;}
}
async function fetchAllFrom(token,appToken,tableId,viewId){
  const all=[];let pt='',more=true;
  while(more){
    let url=`${LARK}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500`;
    if(viewId)url+='&view_id='+encodeURIComponent(viewId);
    if(pt)url+='&page_token='+encodeURIComponent(pt);
    const r=await fetch(url,{headers:{Authorization:'Bearer '+token}});
    const j=await r.json();
    if(j.code!==0)throw new Error('Bitable: '+j.msg+' ('+j.code+')');
    all.push(...(j.data?.items||[]));
    const newPt=j.data?.page_token||'';
    more=!!j.data?.has_more&&newPt!==pt&&all.length<50000;
    pt=newPt;
  }
  return all;
}

async function discoverTables(token){
  const r=await fetch(`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`,{
    headers:{Authorization:'Bearer '+token}
  });
  const j=await r.json();
  if(j.code!==0)throw new Error('Bitable: '+j.msg+' ('+j.code+')');
  globalThis.__tblNames=(j.data?.items||[]).length+' bảng: '+(j.data?.items||[]).slice(0,8).map(t=>t.name).join(' | ');
  const tables=[];
  for(const t of j.data?.items||[]){
    const name=t.name||'';
    const isTonAm=name.toLowerCase().includes('tồn âm')||name.toLowerCase().includes('ton am');
    if(!isTonAm)continue;
    // Loại bỏ bảng năm cũ (.25, .24, .23... hoặc 2020-2025)
    const isPrevYear=/\.(2[0-5])\b|202[0-5]/.test(name);
    if(isPrevYear)continue;
    const m=name.match(/tháng\s*0?(\d+)/i);
    if(!m)continue;
    const n=parseInt(m[1]);if(n<1||n>12)continue;
    tables.push({month:`T${String(n).padStart(2,'0')}`,tableId:t.table_id});
  }
  return tables.sort((a,b)=>a.month.localeCompare(b.month));
}

function aggregate(records){
  const agg={total:0,qh:0,ch:0,totalValue:0,stores:{},lyDo:{},lyDoValue:{},nganh:{},nganhValue:{}};
  for(const rec of records){
    const f=rec.fields||{};
    const ma=txt(f['Mã Kho']);
    const ten=lkp(f['Tên ST'])||txt(f['Tên ST']);
    const ng=txt(f['Ngành']);
    // Lý do: hỗ trợ cả Text (T01-T06) và MultiSelect (T07+)
    const lyRaw=f['Lý do'];
    const lyArr=Array.isArray(lyRaw)?lyRaw.map(x=>typeof x==='string'?x:(x?.text||'')).filter(Boolean)
      :(typeof lyRaw==='string'&&lyRaw?[lyRaw]:txt(lyRaw)?[txt(lyRaw)]:[]);
    const qh=fml(f['ST quá hạn']);
    const price=parseFloat(f['Giá bán lẻ'])||0;
    const qty=Math.abs(parseFloat(f['Tồn dự kiến POS*'])||1);
    const value=price*qty;
    agg.total++;agg.totalValue+=value;
    if(qh==='quá hạn')agg.qh++;else if(qh==='cận hạn')agg.ch++;
    const k=ma||'?';const storeName=STORE_NAMES[ma]||ten||ma;
    if(!agg.stores[k])agg.stores[k]={ten:storeName,count:0,qh:0,ch:0,value:0};
    agg.stores[k].count++;agg.stores[k].value+=value;
    if(qh==='quá hạn')agg.stores[k].qh++;else if(qh==='cận hạn')agg.stores[k].ch++;
    for(const ly of lyArr){agg.lyDo[ly]=(agg.lyDo[ly]||0)+1;agg.lyDoValue[ly]=(agg.lyDoValue[ly]||0)+value;}
    if(ng){agg.nganh[ng]=(agg.nganh[ng]||0)+1;agg.nganhValue[ng]=(agg.nganhValue[ng]||0)+value;}
  }
  agg.stores=Object.entries(agg.stores).sort((a,b)=>b[1].count-a[1].count).slice(0,25)
    .map(([ma,v])=>({ma,ten:v.ten,count:v.count,qh:v.qh,ch:v.ch,value:Math.round(v.value)}));
  agg.totalValue=Math.round(agg.totalValue);
  return agg;
}

export async function onRequest({request,env}){
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
  const APP_ID=env.LARK_APP_ID||'cli_aaa0cdd424b81eed';
  const APP_SECRET=env.LARK_APP_SECRET||'';
  if(!APP_SECRET)return new Response(JSON.stringify({ok:false,error:'LARK_APP_SECRET chưa cấu hình'}),{status:500,headers:CORS});
  try{
    const token=await getToken(APP_ID,APP_SECRET);
    const tables=await discoverTables(token);
    if(!tables.length){
      const all=(j2=>j2)(null);
      throw new Error('Không tìm thấy bảng tồn âm 2026 — bot thấy '+(globalThis.__tblNames||'0 bảng'));
    }
    const months={};
    await Promise.all(tables.map(async({month,tableId})=>{
      try{
        const viewId=await getViewId(token,month,tableId);
        const records=await fetchAllFrom(token,APP_TOKEN,tableId,viewId);
        if(records.length)months[month]=aggregate(records);
      }catch(e){console.error(month,e.message);}
    }));
    // Revenue
    const revRecs=await fetchAllFrom(token,REV_TOKEN,REV_TABLE);
    const revenue={};
    for(const rec of revRecs){
      const f=rec.fields||{};const thang=f['Tháng'];const dt=f['Doanh thu'];
      if(!thang)continue;
      const n=parseInt(typeof thang==='string'?thang:txt(thang));
      const val=typeof dt==='number'?dt:(dt?.value?.[0]||0);
      if(n>=1&&n<=12)revenue[`T${String(n).padStart(2,'0')}`]=val;
    }
    return new Response(JSON.stringify({ok:true,months,revenue,ts:Date.now()}),{headers:{...CORS,'Cache-Control':'no-store'}});
  }catch(e){
    return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:CORS});
  }
}
