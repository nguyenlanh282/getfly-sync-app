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

      // Bước 0: Tìm khách hàng đã tồn tại theo SĐT hoặc Mã KH
      const existing = await findExisting(base, headers, payload);

      if (existing) {
        // Đã tồn tại → lấy dữ liệu cũ, merge chỉ các trường mới/thiếu
        const merged = mergePayload(existing.data, payload);
        merged.current_account_code = existing.account_code;

        const putRes = await safeFetch(url, 'PUT', headers, merged);

        if (putRes.ok) {
          return Response.json({
            ok: true, status: putRes.status,
            data: putRes.data, action: 'updated',
            matchedBy: existing.matchedBy,
            fieldsUpdated: Object.keys(merged).filter(k => k !== 'current_account_code').length
          });
        }

        return Response.json({
          ok: false, status: putRes.status, data: putRes.data,
          action: 'failed',
          errorDetail: humanError(putRes.data, putRes.status),
          note: `Tìm thấy KH (${existing.matchedBy}: ${existing.account_code}) nhưng PUT thất bại`
        });
      }

      // Bước 1: Không tìm thấy → Thử POST (tạo mới)
      const postRes = await safeFetch(url, 'POST', headers, payload);

      if (postRes.ok) {
        return Response.json({
          ok: true, status: postRes.status,
          data: postRes.data, action: 'created'
        });
      }

      // Bước 2: POST lỗi trùng mã (soft-deleted) → restore + PUT
      const postBody = JSON.stringify(postRes.data).toLowerCase();
      const isDup = postRes.status === 409
        || postBody.includes('already exists')
        || postBody.includes('tồn tại')
        || postBody.includes('đã tồn tại')
        || postBody.includes('duplicate')
        || postBody.includes('đã có');

      if (isDup && payload.account_code) {
        const restoreRes = await safeFetch(
          `${base}/api/v6.1/account/restore`,
          'POST', headers,
          { account_code: payload.account_code }
        );

        const putPayload = mergePayload({}, payload);
        putPayload.current_account_code = payload.account_code;
        const putRes = await safeFetch(url, 'PUT', headers, putPayload);

        if (putRes.ok) {
          return Response.json({
            ok: true, status: putRes.status,
            data: putRes.data, action: 'restored_and_updated',
            restoreOk: restoreRes.ok
          });
        }

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

// ── Helper: tìm khách hàng đã tồn tại theo SĐT hoặc Mã KH ──
async function findExisting(base, headers, payload) {
  const searchUrl = `${base}/api/v6.1/account`;

  // Tìm theo SĐT
  if (payload.phone_office) {
    const phone = payload.phone_office.replace(/\D/g, '');
    if (phone) {
      try {
        const res = await safeFetch(`${searchUrl}?filter[phone]=${encodeURIComponent(phone)}&limit=1`, 'GET', headers);
        const list = res.data?.data || res.data?.results || (Array.isArray(res.data) ? res.data : []);
        if (list.length && list[0].account_code) {
          return { account_code: list[0].account_code, matchedBy: 'phone', data: list[0] };
        }
      } catch {}
    }
  }

  // Tìm theo Mã KH
  if (payload.account_code) {
    try {
      const res = await safeFetch(`${searchUrl}?filter[account_code]=${encodeURIComponent(payload.account_code)}&limit=1`, 'GET', headers);
      const list = res.data?.data || res.data?.results || (Array.isArray(res.data) ? res.data : []);
      if (list.length && list[0].account_code) {
        return { account_code: list[0].account_code, matchedBy: 'account_code', data: list[0] };
      }
    } catch {}
  }

  return null;
}

// ── Helper: merge dữ liệu mới vào dữ liệu cũ ──
// - Trường cũ trống + mới có giá trị → dùng giá trị mới (bổ sung thiếu)
// - Trường cũ có + mới có giá trị → dùng giá trị mới (cập nhật)
// - Trường mới trống → bỏ qua, giữ nguyên dữ liệu cũ
function mergePayload(oldData, newPayload) {
  const merged = {};
  for (const [key, val] of Object.entries(newPayload)) {
    if (val === null || val === undefined || val === '') continue;
    merged[key] = val;
  }
  return merged;
}

// ── Helper: fetch an toàn, luôn trả { ok, status, data } ──
async function safeFetch(url, method, headers, body) {
  const opts = { method, headers, signal: AbortSignal.timeout(10000) };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
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
