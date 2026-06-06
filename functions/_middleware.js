/**
 * Cloudflare Pages Middleware — Bảo vệ toàn bộ app bằng cookie session
 * Public paths: /login, /api/login
 * Protected: mọi đường dẫn còn lại (kể cả /api/*)
 */

const COOKIE_NAME  = 'gs_auth';
const PUBLIC_PATHS = ['/login', '/api/login'];

export async function onRequest({ request, next, env }) {
  const url  = new URL(request.url);
  const path = url.pathname;

  // Cho qua các path công khai
  if (PUBLIC_PATHS.includes(path)) return next();

  // Đọc cookie session
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token   = cookies[COOKIE_NAME];
  const secret  = env.SESSION_SECRET || 'hamec-getfly-2024-secret';

  if (token && await verifyToken(token, secret)) {
    return next(); // Hợp lệ → cho qua
  }

  // API call → trả 401 JSON (tránh redirect vòng lặp)
  if (path.startsWith('/api/')) {
    return Response.json({ success: false, error: 'Phiên đăng nhập hết hạn' }, { status: 401 });
  }

  // Trang HTML → redirect về /login
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', path);
  return Response.redirect(loginUrl.toString(), 302);
}

// ── Helpers ─────────────────────────────────────────────────

function parseCookies(str) {
  const out = {};
  str.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

async function verifyToken(token, secret) {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const data = token.slice(0, dot);
    const sig  = token.slice(dot + 1);

    const expected = await hmacSign(secret, data);
    if (!timingSafeEqual(expected, sig)) return false;

    const { exp } = JSON.parse(atob(data));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

// So sánh an toàn (chống timing attack)
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
