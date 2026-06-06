/**
 * Cloudflare Pages Function — D1 Database
 * GET    /api/connections/:id  → Lấy chi tiết (bao gồm api_key thật)
 * PUT    /api/connections/:id  → Cập nhật
 * DELETE /api/connections/:id  → Xoá
 */

// ── GET: lấy chi tiết 1 connection (có api_key thật) ──────
export async function onRequestGet({ params, env }) {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM connections WHERE id = ?`
    ).bind(params.id).first();

    if (!row) return Response.json({ success: false, error: 'Không tìm thấy' }, { status: 404 });

    return Response.json({ success: true, data: row });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ── PUT: cập nhật connection ──────────────────────────────
export async function onRequestPut({ params, request, env }) {
  try {
    const body = await request.json();
    const { name, domain, api_key, is_default, is_active, last_status, last_tested, note } = body;

    // Kiểm tra tồn tại
    const existing = await env.DB.prepare(`SELECT id FROM connections WHERE id = ?`).bind(params.id).first();
    if (!existing) return Response.json({ success: false, error: 'Không tìm thấy' }, { status: 404 });

    // Nếu set default → bỏ default khác
    if (is_default) {
      await env.DB.prepare(`UPDATE connections SET is_default = 0 WHERE id != ?`).bind(params.id).run();
    }

    // Build dynamic SET clause
    const sets   = [];
    const values = [];

    if (name        !== undefined) { sets.push(`name = ?`);         values.push(name.trim()); }
    if (domain      !== undefined) { sets.push(`domain = ?`);       values.push(domain.trim().replace(/^https?:\/\//i,'')); }
    if (api_key     !== undefined) { sets.push(`api_key = ?`);      values.push(api_key.trim()); }
    if (is_default  !== undefined) { sets.push(`is_default = ?`);   values.push(is_default ? 1 : 0); }
    if (is_active   !== undefined) { sets.push(`is_active = ?`);    values.push(is_active ? 1 : 0); }
    if (last_status !== undefined) { sets.push(`last_status = ?`);  values.push(last_status); }
    if (last_tested !== undefined) { sets.push(`last_tested = ?`);  values.push(last_tested); }
    if (note        !== undefined) { sets.push(`note = ?`);         values.push((note||'').trim()); }

    sets.push(`updated_at = datetime('now','localtime')`);
    values.push(params.id);

    await env.DB.prepare(
      `UPDATE connections SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

// ── DELETE: xoá connection ────────────────────────────────
export async function onRequestDelete({ params, env }) {
  try {
    const row = await env.DB.prepare(`SELECT id FROM connections WHERE id = ?`).bind(params.id).first();
    if (!row) return Response.json({ success: false, error: 'Không tìm thấy' }, { status: 404 });

    await env.DB.prepare(`DELETE FROM connections WHERE id = ?`).bind(params.id).run();
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
