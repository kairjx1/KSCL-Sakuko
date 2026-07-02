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
    const { UPLOADS_BUCKET, R2_PUBLIC_URL } = context.env;
    if (!UPLOADS_BUCKET) return json({ ok: false, error: 'Chưa bind R2 bucket (UPLOADS_BUCKET) trong Cloudflare Pages Settings' }, 400);

    const formData = await context.request.formData();
    const file = formData.get('file');
    const fileName = formData.get('name') || (file && file.name) || 'upload';
    if (!file) return json({ ok: false, error: 'Không có file trong request' }, 400);

    const key = `bienbans/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._\-À-ɏḀ-ỿ]/g, '_')}`;
    const fileBuffer = await file.arrayBuffer();

    await UPLOADS_BUCKET.put(key, fileBuffer, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' }
    });

    const baseUrl = (R2_PUBLIC_URL || '').replace(/\/$/, '');
    const viewUrl = baseUrl ? `${baseUrl}/${key}` : `r2://${key}`;

    return json({ ok: true, fileId: key, viewUrl, url: viewUrl });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
