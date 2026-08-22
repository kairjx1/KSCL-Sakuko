const LARK = 'https://open.larksuite.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

async function getAppToken(env) {
  const id = env.LARK_APP_ID || 'cli_aaa0cdd424b81eed';
  const secret = env.LARK_APP_SECRET;
  const r = await fetch(`${LARK}/open-apis/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: id, app_secret: secret })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error('App auth: ' + j.msg);
  return j.app_access_token;
}

async function getUserToken(appToken, code) {
  const r = await fetch(`${LARK}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${appToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code })
  });
  return r.json();
}

async function getUserInfo(userToken) {
  const r = await fetch(`${LARK}/open-apis/authen/v1/user_info`, {
    headers: { 'Authorization': `Bearer ${userToken}` }
  });
  return r.json();
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      const action = url.searchParams.get('action');

      if (action === 'login_url') {
        const appId = env.LARK_APP_ID || 'cli_aaa0cdd424b81eed';
        const redirect = url.searchParams.get('redirect') || `${url.origin}/portal.html`;
        const state = url.searchParams.get('state') || 'portal';
        const loginUrl = `${LARK}/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&state=${encodeURIComponent(state)}`;
        return new Response(JSON.stringify({ ok: true, url: loginUrl }), { headers: CORS });
      }

      if (action === 'mail_auth_url') {
        const appId = env.LARK_APP_ID || 'cli_aaa0cdd424b81eed';
        const redirect = url.searchParams.get('redirect') || `${url.origin}/kiem-ke.html`;
        const loginUrl = `${LARK}/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&state=mailauth`;
        return new Response(JSON.stringify({ ok: true, url: loginUrl }), { headers: CORS });
      }

      if (action === 'callback') {
        const code = url.searchParams.get('code');
        if (!code) return new Response(JSON.stringify({ ok: false, error: 'Missing code' }), { headers: CORS });

        const appToken = await getAppToken(env);
        const tokenResp = await getUserToken(appToken, code);
        if (tokenResp.code !== 0) throw new Error(tokenResp.msg || 'Token exchange failed');

        const userToken = tokenResp.data.access_token;
        const refreshToken = tokenResp.data.refresh_token || '';
        const expiresIn = tokenResp.data.expires_in || 7200; // seconds
        const infoResp = await getUserInfo(userToken);
        if (infoResp.code !== 0) throw new Error(infoResp.msg || 'User info failed');

        const u = infoResp.data;
        return new Response(JSON.stringify({
          ok: true,
          access_token: userToken,
          refresh_token: refreshToken,
          expires_in: expiresIn,
          token_ts: Date.now(),
          user: {
            open_id: u.open_id,
            name: u.name,
            email: u.enterprise_email || u.email || '',
            avatar: u.avatar_url || '',
            tenant_key: u.tenant_key || ''
          }
        }), { headers: CORS });
      }

      return new Response(JSON.stringify({ ok: false, error: 'Unknown action' }), { headers: CORS });
    }

    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
