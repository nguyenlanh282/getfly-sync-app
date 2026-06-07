/**
 * GET /api/lark/sync-status — Trạng thái đồng bộ Lark gần nhất
 */
export async function onRequestGet({ env }) {
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM settings WHERE key = 'last_lark_sync'`
    ).first();

    return Response.json({
      success: true,
      last_sync: row?.value || null
    });
  } catch (e) {
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
