/**
 * GET /api/me — Lấy thông tin user đang đăng nhập từ cookie
 */
const COOKIE_NAME = 'gs_auth';

export async function onRequestGet({ request, env }) {
  try {
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    const token = cookies[COOKIE_NAME];
    if (!token) return Response.json({ success: false });

    const dot = token.lastIndexOf('.');
    if (dot < 0) return Response.json({ success: false });

    const data = token.slice(0, dot);
    const payload = JSON.parse(decodeURIComponent(escape(atob(data))));

    return Response.json({
      success: true,
      user: {
        email: payload.email || '',
        name: payload.name || '',
        role: payload.role || ''
      }
    });
  } catch {
    return Response.json({ success: false });
  }
}

function parseCookies(str) {
  const out = {};
  str.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  });
  return out;
}
