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
    const { GITHUB_TOKEN } = context.env;
    if (!GITHUB_TOKEN) return json({ ok: false, error: 'Thiếu GITHUB_TOKEN trong Cloudflare Environment Variables' }, 400);

    const formData = await context.request.formData();
    const file = formData.get('file');
    const fileName = formData.get('name') || (file && file.name) || 'upload';
    if (!file) return json({ ok: false, error: 'Không có file trong request' }, 400);

    const fileBuffer = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(fileBuffer)));

    const safeName = `${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._\-]/g, '_')}`;
    const path = `uploads/${safeName}`;
    const owner = 'kairjx1';
    const repo = 'KSCL-Sakuko';

    const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + GITHUB_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': 'KSCL-Sakuko-Upload'
      },
      body: JSON.stringify({ message: `upload: ${fileName}`, content: base64 })
    });

    if (!ghRes.ok) {
      const err = await ghRes.json();
      throw new Error('GitHub upload thất bại: ' + (err.message || ghRes.status));
    }

    const viewUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`;
    return json({ ok: true, viewUrl, url: viewUrl });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
