/**
 * POST /api/lark/sync-staff — Đồng bộ nhân sự từ Lark Base (manual / auto từ frontend)
 * GET  /api/lark/sync-staff?key=xxx — Cho cron trigger bên ngoài gọi (mỗi 30 phút)
 */
const LARK_BASE_URL = 'https://open.larksuite.com/open-apis';

// ── Core sync logic ──
async function doSync(env) {
  const appId     = env.LARK_APP_ID;
  const appSecret = env.LARK_APP_SECRET;
  const baseToken = env.LARK_BASE_TOKEN || 'YLqhbpd2Na4GdSsu3ROj7lEipjg';
  const tableId   = env.LARK_TABLE_ID   || 'tbl2YTr4qPnv4RfZ';

  if (!appId || !appSecret) {
    return { success: false, error: 'Chưa cấu hình LARK_APP_ID / LARK_APP_SECRET' };
  }

  // 1. Lấy access token
  const tokenRes = await fetch(`${LARK_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const tokenData = await tokenRes.json();
  if (tokenData.code !== 0) {
    return { success: false, error: 'Lỗi xác thực Lark: ' + tokenData.msg };
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
      return { success: false, error: 'Lỗi đọc Lark Base: ' + data.msg };
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
    return { success: false, error: 'Không tìm thấy nhân sự hợp lệ trong Lark Base' };
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

  // 5. Lưu thời gian sync cuối
  stmts.push(
    env.DB.prepare(
      `INSERT INTO settings (key, value) VALUES ('last_lark_sync', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(new Date().toISOString())
  );

  await env.DB.batch(stmts);

  return { success: true, count: staff.length, staff };
}

// ── POST: gọi từ frontend (đã auth qua middleware) ──
export async function onRequestPost({ env }) {
  try {
    const result = await doSync(env);
    const status = result.success ? 200 : (result.error?.includes('Chưa cấu hình') ? 500 : 400);
    return Response.json(result, { status });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ── GET: cho cron/webhook bên ngoài gọi (cần CRON_SECRET) ──
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || '';
    const cronSecret = env.CRON_SECRET || '';

    // Phải có CRON_SECRET và key khớp
    if (!cronSecret || key !== cronSecret) {
      return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const result = await doSync(env);
    return Response.json(result, { status: result.success ? 200 : 500 });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
