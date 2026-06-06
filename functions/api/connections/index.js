/**
 * Cloudflare Pages Function — D1 Database
 * GET  /api/connections   → Lấy tất cả kết nối
 * POST /api/connections   → Tạo kết nối mới
 */

// ── GET: danh sách tất cả connections ──────────────────────
export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name, domain,
              substr(api_key,1,6) || '••••••••••••' AS api_key_masked,
              is_default, is_active, last_status, last_tested, note, created_at, updated_at
       FROM connections
       ORDER BY is_default DESC, updated_at DESC`
    ).all();

    return Response.json({ success: true, data: results });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ── POST: tạo kết nối mới ──────────────────────────────────
export async function onRequestPost({ request, env }) {
  try {
    const { name, domain, api_key, is_default, note } = await request.json();

    if (!name || !domain || !api_key) {
      return Response.json({ success: false, error: 'Thiếu name, domain hoặc api_key' }, { status: 400 });
    }

    // Nếu set default → bỏ default của các connections khác
    if (is_default) {
      await env.DB.prepare(`UPDATE connections SET is_default = 0`).run();
    }

    const result = await env.DB.prepare(
      `INSERT INTO connections (name, domain, api_key, is_default, note, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
       RETURNING id`
    ).bind(
      name.trim(),
      domain.trim().replace(/^https?:\/\//i, ''),
      api_key.trim(),
      is_default ? 1 : 0,
      (note || '').trim()
    ).first();

    return Response.json({ success: true, id: result.id }, { status: 201 });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
