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
    const { GOOGLE_SA_KEY, DRIVE_FOLDER_ID } = context.env;
    if (!GOOGLE_SA_KEY) return json({ ok: false, error: 'Thiếu GOOGLE_SA_KEY trong Cloudflare Environment Variables' }, 400);
    if (!DRIVE_FOLDER_ID) return json({ ok: false, error: 'Thiếu DRIVE_FOLDER_ID trong Cloudflare Environment Variables' }, 400);

    const sa = JSON.parse(GOOGLE_SA_KEY);
    const accessToken = await getGoogleToken(sa);

    const formData = await context.request.formData();
    const file = formData.get('file');
    const fileName = formData.get('name') || (file && file.name) || 'upload';
    if (!file) return json({ ok: false, error: 'Không có file trong request' }, 400);

    const fileBuffer = await file.arrayBuffer();
    const mimeType = file.type || 'application/octet-stream';

    // Multipart upload: metadata + content in a single POST
    const boundary = 'boundary' + Date.now();
    const meta = JSON.stringify({ name: fileName, parents: [DRIVE_FOLDER_ID] });
    const before = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const after = `\r\n--${boundary}--`;

    const beforeBytes = new TextEncoder().encode(before);
    const fileBytes = new Uint8Array(fileBuffer);
    const afterBytes = new TextEncoder().encode(after);
    const body = new Uint8Array(beforeBytes.length + fileBytes.length + afterBytes.length);
    body.set(beforeBytes, 0);
    body.set(fileBytes, beforeBytes.length);
    body.set(afterBytes, beforeBytes.length + fileBytes.length);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': `multipart/related; boundary="${boundary}"`
        },
        body
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Upload Drive thất bại: HTTP ${uploadRes.status} — ${errText.slice(0, 300)}`);
    }

    const created = await uploadRes.json();
    if (!created.id) throw new Error('Drive không trả về file ID: ' + JSON.stringify(created));

    // Make file publicly readable — non-fatal
    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${created.id}/permissions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      });
    } catch (_) { /* best-effort */ }

    return json({
      ok: true,
      fileId: created.id,
      viewUrl: `https://drive.google.com/file/d/${created.id}/view`,
      url: `https://drive.google.com/uc?export=download&id=${created.id}`
    });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function getGoogleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = obj => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  });

  const sigInput = `${header}.${payload}`;
  const pemKey = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----\n?/, '')
    .replace(/\n?-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');

  const derKey = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', derKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${sigInput}.${sigB64}`
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Google auth thất bại: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
