/**
 * Cloudflare Pages Function — POST /api/login
 * Body: { email, password }
 * → Xác thực thông tin đăng nhập, tạo session cookie 8h
 */

const COOKIE_NAME = 'gs_auth';
const SESSION_HOURS = 8;

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { email = '', password = '' } = body;

    // Đọc credentials từ env hoặc fallback default
    const validEmail    = (env.ADMIN_EMAIL    || 'admin@hamec.com.vn').trim().toLowerCase();
    const validPassword = (env.ADMIN_PASSWORD || 'Hamec@6868!');

    // Chống brute-force: delay nhỏ
    await sleep(300);

    if (email.trim().toLowerCase() !== validEmail || password !== validPassword) {
      return Response.json(
        { success: false, error: 'Email hoặc mật khẩu không đúng' },
        { status: 401 }
      );
    }

    // Tạo token
    const secret = env.SESSION_SECRET || 'hamec-getfly-2024-secret';
    const maxAge = SESSION_HOURS * 3600; // giây
    const token  = await createToken(secret, maxAge);

    return Response.json({ success: true }, {
      headers: {
        'Set-Cookie': [
          `${COOKIE_NAME}=${token}`,
          'HttpOnly',
          'Secure',
          'SameSite=Strict',
          'Path=/',
          `Max-Age=${maxAge}`,
        ].join('; ')
      }
    });

  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ── Helpers ─────────────────────────────────────────────────

async function createToken(secret, maxAgeSec) {
  const payload = { exp: Date.now() + maxAgeSec * 1000 };
  const data    = btoa(JSON.stringify(payload));
  const sig     = await hmacSign(secret, data);
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
