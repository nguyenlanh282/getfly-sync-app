/**
 * Cloudflare Pages Function
 * POST /api/test-connection
 * Body: { domain, apiKey, connectionId? }
 * - Kiểm tra kết nối Getfly
 * - Nếu có connectionId → cập nhật last_status + last_tested vào D1
 */
export async function onRequestPost({ request, env }) {
  try {
    const { apiKey, domain, connectionId } = await request.json();

    if (!apiKey || !domain) {
      return Response.json({ success: false, error: 'Thiếu Domain hoặc API Key' }, { status: 400 });
    }

    const cleanDomain = domain.trim().replace(/^https?:\/\//i, '');

    let success = false;
    let httpStatus = null;
    let errorMsg = null;

    try {
      const res = await fetch(`https://${cleanDomain}/api/v6/accounts?limit=1`, {
        headers: { 'X-API-KEY': apiKey },
        signal: AbortSignal.timeout(8000)
      });

      httpStatus = res.status;
      success = res.ok;

      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch {}
        errorMsg = data.message || data.error || `HTTP ${res.status}`;
      }
    } catch (fetchErr) {
      errorMsg = fetchErr.message;
    }

    // Cập nhật trạng thái vào D1 nếu có connectionId
    if (connectionId && env.DB) {
      try {
        await env.DB.prepare(
          `UPDATE connections
           SET last_status = ?, last_tested = datetime('now','localtime'), updated_at = datetime('now','localtime')
           WHERE id = ?`
        ).bind(success ? 'ok' : 'fail', connectionId).run();
      } catch {}
    }

    if (success) {
      return Response.json({ success: true, status: httpStatus });
    }

    return Response.json({
      success: false,
      error: errorMsg || 'Kết nối thất bại',
      httpStatus
    });

  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
