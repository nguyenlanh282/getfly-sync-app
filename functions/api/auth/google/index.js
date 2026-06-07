/**
 * GET /api/auth/google — Redirect sang Google OAuth
 */
export async function onRequestGet({ request, env }) {
  const clientId = env.GOOGLE_CLIENT_ID;

  if (!clientId) {
    return new Response('Chưa cấu hình GOOGLE_CLIENT_ID', { status: 500 });
  }

  // Tự phát hiện callback URL từ request
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/google/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'email profile',
    access_type: 'online',
    prompt: 'select_account',
  });

  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}
