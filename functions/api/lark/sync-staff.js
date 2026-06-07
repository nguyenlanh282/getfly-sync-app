/**
 * POST /api/lark/sync-staff — Đồng bộ nhân sự từ Lark Base
 */
const LARK_BASE_URL = 'https://open.larksuite.com/open-apis';

export async function onRequestPost({ env }) {
  try {
    const appId     = env.LARK_APP_ID;
    const appSecret = env.LARK_APP_SECRET;
    const baseToken = env.LARK_BASE_TOKEN || 'YLqhbpd2Na4GdSsu3ROj7lEipjg';
    const tableId   = env.LARK_TABLE_ID   || 'tbl2YTr4qPnv4RfZ';

    if (!appId || !appSecret) {
      return Response.json({ success: false, error: 'Chưa cấu hình LARK_APP_ID / LARK_APP_SECRET' }, { status: 500 });
    }

    // 1. Lấy access token
    const tokenRes = await fetch(`${LARK_BASE_URL}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) {
      return Response.json({ success: false, error: 'Lỗi xác thực Lark: ' + tokenData.msg }, { status: 500 });
    }
    const accessToken = tokenData.tenant_access_token;

    // 2. Lấy danh sách nhân sự từ Lark Base
    let allRecords = [];
    let pageToken = '';
    let hasMore = true;

    while (hasMore) {
      const url = `${LARK_BASE_URL}/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await res.json();
      if (data.code !== 0) {
        return Response.json({ success: false, error: 'Lỗi đọc Lark Base: ' + data.msg }, { status: 500 });
      }
      allRecords = allRecords.concat(data.data.items || []);
      hasMore = data.data.has_more;
      pageToken = data.data.page_token || '';
    }

    // 3. Parse dữ liệu
    const staff = [];
    for (const record of allRecords) {
      const f = record.fields;
      const name  = (f['HỌ VÀ TÊN'] || '').trim();
      const role  = (f['GHI CHÚ'] || '').trim();

      // Email field có thể là object {link, text} hoặc string
      let email = '';
      const emailField = f['ĐỊA CHỈ EMAIL'];
      if (typeof emailField === 'object' && emailField?.text) {
        email = emailField.text.trim().toLowerCase();
      } else if (typeof emailField === 'string') {
        email = emailField.trim().toLowerCase();
      }

      if (name && email && email.includes('@')) {
        staff.push({ name, email, role });
      }
    }

    if (!staff.length) {
      return Response.json({ success: false, error: 'Không tìm thấy nhân sự hợp lệ trong Lark Base' }, { status: 400 });
    }

    // 4. Upsert vào D1
    const stmts = [env.DB.prepare('UPDATE staff SET is_active = 0')];
    for (const s of staff) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO staff (name, email, role, is_active)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(email) DO UPDATE SET
             name = excluded.name,
             role = excluded.role,
             is_active = 1`
        ).bind(s.name, s.email, s.role)
      );
    }
    await env.DB.batch(stmts);

    return Response.json({ success: true, count: staff.length, staff });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
