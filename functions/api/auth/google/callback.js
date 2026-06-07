/**
 * GET /api/auth/google/callback — Xử lý callback từ Google OAuth
 * 1. Đổi code → token
 * 2. Lấy user info (email, name)
 * 3. Kiểm tra email có trong bảng staff
 * 4. Tạo session cookie
 */

const COOKIE_NAME    = 'gs_auth';
const SESSION_HOURS  = 8;
const SUPER_ADMINS   = ['it.nguyenlanh@gmail.com'];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return redirectLogin(url.origin, 'Không nhận được mã xác thực từ Google');
  }

  const clientId     = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return redirectLogin(url.origin, 'Chưa cấu hình Google OAuth. Liên hệ quản trị viên.');
  }
  const redirectUri  = `${url.origin}/api/auth/google/callback`;

  try {
    // 1. Đổi code → access_token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return redirectLogin(url.origin, 'Lỗi xác thực Google: ' + (tokenData.error_description || tokenData.error || 'unknown'));
    }

    // 2. Lấy thông tin user
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();
    const email = (user.email || '').trim().toLowerCase();
    const name  = user.name || email;

    if (!email) {
      return redirectLogin(url.origin, 'Không lấy được email từ Google');
    }

    // 3. Đồng bộ staff từ Lark → D1 trước khi kiểm tra quyền
    await syncLarkStaff(env);

    // 4. Kiểm tra email: Super Admin luôn được vào, staff cần có trong bảng
    const isSuperAdmin = SUPER_ADMINS.includes(email);
    const staff = await env.DB.prepare(
      'SELECT id, name, email, role FROM staff WHERE email = ? AND is_active = 1'
    ).bind(email).first();

    if (!staff && !isSuperAdmin) {
      return redirectLogin(url.origin, `Email ${email} không có quyền truy cập. Liên hệ quản trị viên.`);
    }

    // Super Admin chưa có trong staff → tự thêm vào
    if (!staff && isSuperAdmin) {
      await env.DB.prepare(
        `INSERT INTO staff (name, email, role, is_active) VALUES (?, ?, 'Super Admin', 1)
         ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = 'Super Admin', is_active = 1`
      ).bind(name, email).run();
    }

    // 4. Tạo session cookie (lưu cả email + name + role)
    const displayName = staff?.name || name;
    const userRole = isSuperAdmin ? 'super_admin' : (staff?.role || 'staff');
    const secret = env.SESSION_SECRET || 'hamec-getfly-2024-secret';
    const maxAge = SESSION_HOURS * 3600;
    const token  = await createToken(secret, maxAge, { email, name: displayName, role: userRole });

    // Redirect về trang chính
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': [
          `${COOKIE_NAME}=${token}`,
          'HttpOnly',
          'Secure',
          'SameSite=Lax',
          'Path=/',
          `Max-Age=${maxAge}`,
        ].join('; ')
      }
    });

  } catch (e) {
    return redirectLogin(url.origin, 'Lỗi hệ thống: ' + e.message);
  }
}

// ── Helpers ──

function redirectLogin(origin, error) {
  const loginUrl = new URL('/login', origin);
  loginUrl.searchParams.set('error', error);
  return Response.redirect(loginUrl.toString(), 302);
}

async function createToken(secret, maxAgeSec, userData) {
  const payload = {
    exp: Date.now() + maxAgeSec * 1000,
    ...userData
  };
  const data = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const sig  = await hmacSign(secret, data);
  return `${data}.${sig}`;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

// ── Đồng bộ Lark → D1 mỗi khi login ──
const LARK_BASE_URL = 'https://open.larksuite.com/open-apis';

async function syncLarkStaff(env) {
  try {
    const appId     = env.LARK_APP_ID;
    const appSecret = env.LARK_APP_SECRET;
    const baseToken = env.LARK_BASE_TOKEN || 'YLqhbpd2Na4GdSsu3ROj7lEipjg';
    const tableId   = env.LARK_TABLE_ID   || 'tbl2YTr4qPnv4RfZ';

    if (!appId || !appSecret) return; // Chưa cấu hình → bỏ qua

    // Lấy tenant access token
    const tokenRes = await fetch(`${LARK_BASE_URL}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) return;

    // Lấy records
    let allRecords = [];
    let pageToken = '';
    let hasMore = true;
    while (hasMore) {
      const url = `${LARK_BASE_URL}/bitable/v1/apps/${baseToken}/tables/${tableId}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${tokenData.tenant_access_token}` } });
      const data = await res.json();
      if (data.code !== 0) return;
      allRecords = allRecords.concat(data.data.items || []);
      hasMore = data.data.has_more;
      pageToken = data.data.page_token || '';
    }

    // Parse + upsert
    const stmts = [env.DB.prepare('UPDATE staff SET is_active = 0')];
    for (const record of allRecords) {
      const f = record.fields;
      const name  = (f['HỌ VÀ TÊN'] || '').trim();
      const role  = (f['GHI CHÚ'] || '').trim();
      let email = '';
      const ef = f['ĐỊA CHỈ EMAIL'];
      if (typeof ef === 'object' && ef?.text) email = ef.text.trim().toLowerCase();
      else if (typeof ef === 'string') email = ef.trim().toLowerCase();

      if (name && email && email.includes('@')) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO staff (name, email, role, is_active) VALUES (?, ?, ?, 1)
             ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, is_active = 1`
          ).bind(name, email, role)
        );
      }
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES ('last_lark_sync', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(new Date().toISOString())
    );
    await env.DB.batch(stmts);
  } catch {
    // Lỗi sync không chặn login
  }
}
