/**
 * Cloudflare Pages Function — POST /api/logout
 * Xoá session cookie → đăng xuất
 */
export async function onRequestPost() {
  return Response.json({ success: true }, {
    headers: {
      'Set-Cookie': 'gs_auth=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'
    }
  });
}
