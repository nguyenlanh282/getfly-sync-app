/**
 * GET  /api/settings?keys=key1,key2 — Lấy cài đặt theo keys
 * POST /api/settings — Lưu nhiều cài đặt { settings: {key: value, ...} }
 */

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const keys = (url.searchParams.get('keys') || '').split(',').filter(Boolean);
    if (!keys.length) {
      const all = await env.DB.prepare('SELECT key, value FROM settings').all();
      return Response.json({ success: true, data: Object.fromEntries(all.results.map(r => [r.key, r.value])) });
    }
    const placeholders = keys.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`).bind(...keys).all();
    return Response.json({ success: true, data: Object.fromEntries(rows.results.map(r => [r.key, r.value])) });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const { settings } = await request.json();
    if (!settings || typeof settings !== 'object') {
      return Response.json({ success: false, error: 'Thiếu dữ liệu settings' }, { status: 400 });
    }
    const stmts = [];
    for (const [key, value] of Object.entries(settings)) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).bind(key, String(value))
      );
    }
    await env.DB.batch(stmts);
    return Response.json({ success: true });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
