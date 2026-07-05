/**
 * CF Pages Function: GET /api/lark-date
 * Env vars: LARK_APP_ID, LARK_APP_SECRET
 */
const LARK      = 'https://open.larksuite.com';
const APP_TOKEN = 'Gxgcwfo3Qihm6HkB9o9lNB9zgyg';
const TABLES    = { stores:'tbl3lzO5w4cujQNR', detail:'tbl6WUAU40sXbdde', monthly:'tblzIFsZXkyv7EKd' };
const CORS      = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Content-Type':'application/json' };

const STORE_NAMES = {
  S1001:'Đội Cấn',S1002:'Linh Đàm',S1004:'Mandarin',S1005:'Thái Hà',
  S1006:'Trần Đăng Ninh',S1007:'Nguyễn Du',S1008:'Hàng Bông',S1011:'Văn Phú',
  S1015:'Hàm Nghi',S1018:'Nguyễn Tuân',S1020:'Đỗ Quang',S1021:'Ngoại Giao Đoàn',
  S1022:'Trần Duy Hưng',S1023:'Nguyễn Văn Lộc',S1025:'T6 Timecity',
  S1026:'Ecohome 3',S1027:'Green Bay',S1030:'Xuân La',S1035:'Nguyễn Khuyến',
  S1036:'Sài Đồng',S1037:'Bạch Mai',S1038:'Vũ Phạm Hàm',S2201:'Bắc Ninh',
};

function num(v){
  if(v==null)return 0;
  if(typeof v==='number')return v;
  if(typeof v==='string'){const n=parseFloat(v);return isNaN(n)?0:n;}
  if(v?.value!=null){const x=Array.isArray(v.value)?v.value[0]:v.value;return x!=null?Number(x):0;}
  return 0;
}
function txt(v){if(!v)return'';if(typeof v==='string')return v;if(Array.isArray(v))return v[0]?.text??'';return'';}

async function getToken(id,secret){
  const r=await fetch(`${LARK}/open-apis/auth/v3/tenant_access_token/internal`,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({app_id:id,app_secret:secret})
  });
  const j=await r.json();
  if(j.code!==0)throw new Error('Auth: '+j.msg);
  return j.tenant_access_token;
}

async function fetchAll(token,tableId){
  const all=[];let pt='',more=true;
  while(more){
    const body={page_size:200};if(pt)body.page_token=pt;
    const r=await fetch(`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search`,{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    const j=await r.json();
    if(j.code!==0)throw new Error('Bitable: '+j.msg);
    all.push(...(j.data?.items||[]));
    more=!!j.data?.has_more;pt=j.data?.page_token||'';
  }
  return all;
}

export async function onRequest({request,env}){
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
  const APP_ID=env.LARK_APP_ID||'cli_aaa0cdd424b81eed';
  const APP_SECRET=env.LARK_APP_SECRET||'';
  if(!APP_SECRET)return new Response(JSON.stringify({ok:false,error:'LARK_APP_SECRET chưa cấu hình'}),{status:500,headers:CORS});
  try{
    const token=await getToken(APP_ID,APP_SECRET);
    const [b3,b2,b1]=await Promise.all([
      fetchAll(token,TABLES.monthly),
      fetchAll(token,TABLES.detail),
      fetchAll(token,TABLES.stores),
    ]);
    const yr='2026';
    // Còn lại by month từ detail
    const conlaiByMonth={};
    for(const rec of b2){
      const f=rec.fields;
      const y=txt(f['Năm']||'');if(y&&y!==yr)continue;
      const m=txt(f['Tháng']).padStart(2,'0');if(!m||m==='00')continue;
      conlaiByMonth['T'+m]=(conlaiByMonth['T'+m]||0)+num(f['Tồn kho dự kiến']);
    }
    const monthly=b3
      .filter(rec=>{const y=txt(rec.fields['Năm']||'');return!y||y===yr;})
      .map(rec=>{
        const f=rec.fields;
        const m=txt(f['Tháng']).padStart(2,'0');if(!m||m==='00')return null;
        const t='T'+m;
        const dt=num(f['Doanh thu']),gv=num(f['Giá vốn']),tv=num(f['Thu về']),huy=num(f['Hủy']);
        const conlai=conlaiByMonth[t]||num(f['Còn lại theo mã DG'])||0;
        const dinhmuc=Math.round(num(f['Định mức tối đa']));
        const cp=gv-tv;
        if(dt===0&&gv===0)return null;
        return{t,dt,gv,tv,huy,cp,dinhmuc,conlai};
      })
      .filter(Boolean).sort((a,b)=>a.t.localeCompare(b.t));
    const stores=b1
      .filter(rec=>{const y=txt(rec.fields['Năm']||'');return!y||y===yr;})
      .map(rec=>{
        const f=rec.fields;
        const m=txt(f['Mã kho']);
        const dt=num(f['Doanh thu']);
        const cp=Math.round(num(f['Chi phí đổi code']));
        const tl=+num(f['Tỷ lệ đổi code/DT']).toFixed(6);
        const cb=f['Cảnh báo(0.21%)']?1:0;
        const s=STORE_NAMES[m]||m;
        return{s,m,dt,cp,tl,cb};
      })
      .sort((a,b)=>a.m.localeCompare(b.m));
    return new Response(JSON.stringify({ok:true,monthly,stores,ts:Date.now()}),{headers:{...CORS,'Cache-Control':'no-store'}});
  }catch(e){
    return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:CORS});
  }
}
