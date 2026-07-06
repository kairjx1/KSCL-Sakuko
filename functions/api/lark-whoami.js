/** GET /api/lark-whoami — trả tên bot app đang dùng để đồng bộ (debug quyền) */
const LARK='https://open.larksuite.com';
const CORS={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
export async function onRequest({request,env}){
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:CORS});
  try{
    const APP_ID=env.LARK_APP_ID||'cli_aaa0cdd424b81eed';
    const r=await fetch(`${LARK}/open-apis/auth/v3/tenant_access_token/internal`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({app_id:APP_ID,app_secret:env.LARK_APP_SECRET||''})
    });
    const j=await r.json();
    if(j.code!==0)throw new Error('Auth: '+j.msg);
    const b=await fetch(`${LARK}/open-apis/bot/v3/info`,{headers:{Authorization:'Bearer '+j.tenant_access_token}});
    const bi=await b.json();
    return new Response(JSON.stringify({app_id:APP_ID,bot_name:bi.bot?.app_name||bi.bot?.name||null,activate:bi.bot?.activate_status,raw:bi.code}),{headers:CORS});
  }catch(e){
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:CORS});
  }
}
