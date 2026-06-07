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

    // 3. Kiểm tra email có trong bảng staff
    const staff = await env.DB.prepare(
      'SELECT id, name, email, role FROM staff WHERE email = ? AND is_active = 1'
    ).bind(email).first();

    if (!staff) {
      return redirectLogin(url.origin, `Email ${email} không có quyền truy cập. Liên hệ quản trị viên.`);
    }

    // 4. Tạo session cookie (lưu cả email + name + role)
    const userRole = SUPER_ADMINS.includes(email) ? 'super_admin' : (staff.role || 'staff');
    const secret = env.SESSION_SECRET || 'hamec-getfly-2024-secret';
    const maxAge = SESSION_HOURS * 3600;
    const token  = await createToken(secret, maxAge, { email, name: staff.name, role: userRole });

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
