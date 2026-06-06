/**
 * Cloudflare Pages Function — POST /api/proxy
 *
 * UPSERT flow (xử lý soft-delete của Getfly):
 *   1. POST  → Thử tạo mới
 *   2. Nếu "account_code already exists" (soft-deleted trong Getfly)
 *      → POST /api/v6.1/account/restore  (khôi phục bản ghi đã xoá)
 *      → PUT  /api/v6.1/account          (cập nhật với dữ liệu mới)
 *   3. Lỗi khác → trả ngay lỗi gốc
 */
export async function onRequestPost(context) {
  try {
    const { apiKey, domain, method, payload } = await context.request.json();

    if (!apiKey || !domain || !payload) {
      return Response.json({ ok: false, error: 'Thiếu tham số bắt buộc' }, { status: 400 });
    }

    const base    = `https://${domain}`;
    const url     = `${base}/api/v6.1/account`;
    const headers = { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' };

    // ── UPSERT ───────────────────────────────────────────────
    if (method === 'UPSERT') {

      // Bước 1: Thử POST (tạo mới)
      const postRes = await safeFetch(url, 'POST', headers, payload);

      if (postRes.ok) {
        return Response.json({
          ok: true, status: postRes.status,
          data: postRes.data, action: 'created'
        });
      }

      // Bước 2: Kiểm tra lỗi trùng mã (soft-deleted)
      //   Chỉ 409 hoặc message chứa từ khoá duplicate
      //   KHÔNG dùng 422 (đó là lỗi validation khác)
      const postBody = JSON.stringify(postRes.data).toLowerCase();
      const isDup = postRes.status === 409
        || postBody.includes('already exists')
        || postBody.includes('tồn tại')
        || postBody.includes('đã tồn tại')
        || postBody.includes('duplicate')
        || postBody.includes('đã có');

      if (isDup && payload.account_code) {
        // Bước 3: Restore bản ghi soft-deleted
        const restoreRes = await safeFetch(
          `${base}/api/v6.1/account/restore`,
          'POST', headers,
          { account_code: payload.account_code }
        );

        // Bước 4: PUT để cập nhật dữ liệu mới
        const putPayload = { ...payload, current_account_code: payload.account_code };
        const putRes     = await safeFetch(url, 'PUT', headers, putPayload);

        if (putRes.ok) {
          return Response.json({
            ok: true, status: putRes.status,
            data: putRes.data, action: 'restored_and_updated',
            restoreOk: restoreRes.ok
          });
        }

        // Cả restore + PUT đều thất bại
        return Response.json({
          ok: false, status: putRes.status, data: putRes.data,
          action: 'failed',
          errorDetail: humanError(putRes.data, putRes.status),
          note: `POST: "${humanError(postRes.data, postRes.status)}" → Restore: ${restoreRes.ok ? 'OK' : 'thất bại'} → PUT: thất bại`
        });
      }

      // Lỗi POST không phải trùng mã → trả thẳng lỗi gốc
      return Response.json({
        ok: false, status: postRes.status, data: postRes.data,
        action: 'failed',
        errorDetail: humanError(postRes.data, postRes.status)
      });
    }

    // ── POST / PUT thông thường ──────────────────────────────
    const httpMethod = method === 'PUT' ? 'PUT' : 'POST';
    const res        = await safeFetch(url, httpMethod, headers, payload);

    return Response.json({
      ok: res.ok, status: res.status, data: res.data,
      action: res.ok ? (httpMethod === 'PUT' ? 'updated' : 'created') : 'failed',
      errorDetail: res.ok ? null : humanError(res.data, res.status)
    });

  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.message.includes('timeout');
    return Response.json({
      ok: false, action: 'failed', error: e.message,
      errorDetail: isTimeout ? 'Getfly không phản hồi (timeout > 10s)' : e.message
    }, { status: 500 });
  }
}

// ── Helper: fetch an toàn, luôn trả { ok, status, data } ──
async function safeFetch(url, method, headers, body) {
  const res = await fetch(url, {
    method, headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000)
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

// ── Helper: thông báo lỗi tiếng Việt ────────────────────
function humanError(data, status) {
  const fromGetfly = data?.message || data?.error || data?.msg
    || (data?.errors ? Object.values(data.errors).flat().join(' | ') : null);
  if (fromGetfly) return fromGetfly;

  const map = {
    400: 'Dữ liệu không hợp lệ — kiểm tra các trường bắt buộc',
    401: 'API Key không hợp lệ hoặc đã hết hạn',
    403: 'Không có quyền thực hiện thao tác này',
    404: 'Bản ghi không tồn tại trong Getfly',
    409: 'Mã khách hàng đã tồn tại trong hệ thống',
    422: 'Dữ liệu sai định dạng — kiểm tra ngày sinh, SĐT, tên loại KH, tên cơ sở...',
    429: 'Quá nhiều request — hệ thống tự thử lại sau vài giây',
    500: 'Lỗi máy chủ Getfly — thử lại sau',
  };
  return map[status] || `Lỗi không xác định (HTTP ${status})`;
}
