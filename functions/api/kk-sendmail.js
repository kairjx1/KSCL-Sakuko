const LARK = 'https://open.larksuite.com';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), { status: 405, headers: CORS });

  try {
    const { fromEmail, toList, ccList, subject, bodyHtml, attachB64, attachName, userToken } = await request.json();

    if (!userToken) throw new Error('Chưa xác thực Lark Mail. Vui lòng bấm "Đăng nhập Lark" trong form soạn mail.');
    if (!fromEmail) throw new Error('Vui lòng nhập địa chỉ email người gửi');
    if (!toList || toList.length === 0) throw new Error('Vui lòng nhập địa chỉ email người nhận');

    const mailboxId = fromEmail;

    // Step 1: Create message draft
    const msgPayload = {
      subject,
      body: { content: bodyHtml, content_type: 'html' },
      to: toList.map(a => ({ mail_address: a.trim() })).filter(x => x.mail_address),
    };
    if (ccList && ccList.length > 0) {
      msgPayload.cc = ccList.map(a => ({ mail_address: a.trim() })).filter(x => x.mail_address);
    }

    const msgR = await fetch(`${LARK}/open-apis/mail/v1/user_mailboxes/${encodeURIComponent(mailboxId)}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(msgPayload)
    });
    const msgJ = await msgR.json();
    if (msgJ.code !== 0) throw new Error('Tạo mail thất bại: ' + (msgJ.msg || `code ${msgJ.code}`));

    const messageId = msgJ.data.message.message_id;

    // Step 2: Upload attachment (if provided)
    if (attachB64 && attachName) {
      const binary = Uint8Array.from(atob(attachB64), c => c.charCodeAt(0));
      const form = new FormData();
      form.append('file', new Blob([binary], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }), attachName);

      const attR = await fetch(`${LARK}/open-apis/mail/v1/user_mailboxes/${encodeURIComponent(mailboxId)}/messages/${messageId}/attachments`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${userToken}` },
        body: form
      });
      const attJ = await attR.json();
      if (attJ.code !== 0) console.warn('Attachment warning:', attJ.msg || attJ.code);
    }

    // Step 3: Send
    const sendR = await fetch(`${LARK}/open-apis/mail/v1/user_mailboxes/${encodeURIComponent(mailboxId)}/messages/${messageId}/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const sendJ = await sendR.json();
    if (sendJ.code !== 0) throw new Error('Gửi mail thất bại: ' + (sendJ.msg || `code ${sendJ.code}`));

    return new Response(JSON.stringify({ ok: true }), { headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
  }
}
