/**
 * CF Pages Function: GET /api/lark-bbkk
 * Env vars: LARK_APP_ID, LARK_APP_SECRET
 */
const LARK    = 'https://open.larksuite.com';
const APP_TOKEN = 'IRsfbMZQJaN9XPslfr1lTCT7gki';
const TABLES  = { t1:'tblz3d34MtNmpd9s', t2:'tblfuteyWA6P1LZ3', t4:'tblerJGG1X3ky80Y' };
const CORS    = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,OPTIONS','Content-Type':'application/json' };

function num(v){
  if(v==null)return 0;
  if(typeof v==='number')return v;
  if(typeof v==='string'){const n=parseFloat(v);return isNaN(n)?0:n;}
  if(v?.value!=null){const x=Array.isArray(v.value)?v.value[0]:v.value;return x!=null?Number(x):0;}
  return 0;
}
function txt(v){
  if(!v)return'';
  if(typeof v==='string')return v;
  if(Array.isArray(v))return v[0]?.text??'';
  return'';
}
function numStr(v){const n=parseFloat(String(v??'').replace(/[^0-9.-]/g,''));return isNaN(n)?0:Math.round(n);}

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
    let url=`${LARK}/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500`;
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

function processT1(items){
  return items.filter(r=>r.fields&&(r.fields['Mã kho']||r.fields['Tên ST'])).map(r=>{
    const f=r.fields;
    const loaiArr=f['Loại kiểm kê'];
    const ma=typeof f['Mã kho']==='string'?f['Mã kho']:txt(f['Mã kho']);
    const bb=f['Biên Bản Kiểm Kê'];
    const ten=bb?(Array.isArray(bb)?bb.map(x=>x.text??'').join(''):(typeof bb==='string'?bb:'')).split('\n')[0].trim():'';
    return{
      id:r.record_id,ten,ma,
      tenST:txt(f['Tên ST']),
      loai:Array.isArray(loaiArr)?loaiArr[0]:'',
      thang:parseInt(f['Tháng']||'0',10),
      nam:parseInt(f['Năm']||'2026',10),
      ngay:f['Ngày kiểm kê']||0,
      clPlus:numStr(f['Chênh lệch +']),
      clMinus:numStr(f['Chênh lệch -']),
      denBu:Math.abs(numStr(f['Đền bù'])),
      congtyHT:Math.abs(numStr(f['Công ty hỗ trợ'])),
      noiDung:txt(f['Nội dung , đề xuất']),
    };
  });
}

function processT2(items){
  return items.map(r=>{
    const f=r.fields;
    const quyHT=Math.round(num(f['Quỹ hỗ trợ tổng']));
    const htTong=Math.abs(Math.round(num(f['∑ Số tiền hỗ trợ tổng'])));
    const stDen=Math.abs(Math.round(num(f['∑ Số tiền ST đền'])));
    return{ma:typeof f['Mã kho']==='string'?f['Mã kho']:txt(f['Mã kho']),
      ten:txt(f['ST'])||txt(f['Tên ST']),
      nam:parseInt(f['Năm']||'2026',10),
      quyHT,tongDT:Math.round(num(f['Tổng doanh thu'])),
      htTong,stDen,conLai:quyHT-htTong};
  }).filter(r=>r.ma);
}

function processT4(items){
  return items.filter(r=>num(r.fields?.['Doanh thu'])>0).map(r=>({
    thang:r.fields['Tháng']||'',
    nam:parseInt(txt(r.fields['Năm'])||'2026',10),
    dt:Math.round(num(r.fields['Doanh thu']))
  })).sort((a,b)=>parseInt(a.thang)-parseInt(b.thang));
}

export async function onRequest({request,env}){
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
  const APP_ID=env.LARK_APP_ID||'cli_aaa0cdd424b81eed';
  const APP_SECRET=env.LARK_APP_SECRET||'';
  if(!APP_SECRET)return new Response(JSON.stringify({ok:false,error:'LARK_APP_SECRET chưa cấu hình'}),{status:500,headers:CORS});
  try{
    const token=await getToken(APP_ID,APP_SECRET);
    const [raw1,raw2,raw4]=await Promise.all([fetchAll(token,TABLES.t1),fetchAll(token,TABLES.t2),fetchAll(token,TABLES.t4)]);
    const t1=processT1(raw1),t2=processT2(raw2),t4=processT4(raw4);
    return new Response(JSON.stringify({ok:true,t1,t2,t4,ts:Date.now()}),{headers:{...CORS,'Cache-Control':'no-store'}});
  }catch(e){
    return new Response(JSON.stringify({ok:false,error:e.message}),{status:500,headers:CORS});
  }
}
