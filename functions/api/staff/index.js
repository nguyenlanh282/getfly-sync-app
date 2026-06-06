/**
 * GET  /api/staff — Lấy danh sách nhân sự
 * POST /api/staff — Lưu danh sách nhân sự (thay thế toàn bộ)
 */

export async function onRequestGet({ env }) {
  try {
    const rows = await env.DB.prepare(
      'SELECT id, name, email, role, is_active FROM staff WHERE is_active = 1 ORDER BY role, name'
    ).all();
    return Response.json({ success: true, data: rows.results });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { staff } = await request.json();
    if (!Array.isArray(staff) || !staff.length) {
      return Response.json({ success: false, error: 'Danh sách nhân sự trống' }, { status: 400 });
    }

    const stmts = [];

    // Soft-delete tất cả nhân sự cũ
    stmts.push(env.DB.prepare('UPDATE staff SET is_active = 0'));

    // Upsert từng nhân sự
    for (const s of staff) {
      if (!s.name || !s.email) continue;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO staff (name, email, role, is_active)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(email) DO UPDATE SET
             name = excluded.name,
             role = excluded.role,
             is_active = 1`
        ).bind(s.name.trim(), s.email.trim().toLowerCase(), (s.role || '').trim())
      );
    }

    await env.DB.batch(stmts);

    const count = await env.DB.prepare('SELECT COUNT(*) as cnt FROM staff WHERE is_active = 1').first();
    return Response.json({ success: true, count: count.cnt });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
