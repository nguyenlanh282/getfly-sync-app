/**
 * Cloudflare Pages Function — POST /api/proxy
 *
 * UPSERT flow:
 *   0. Tìm KH theo SĐT / Mã KH → nếu có → PUT (update chỉ trường mới)
 *   1. POST  → Thử tạo mới
 *   2. Nếu trùng mã (soft-deleted) → restore → PUT
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

      // Bước 0: Tìm khách hàng đã tồn tại
      const existing = await findExisting(base, headers, payload);

      if (existing) {
        const merged = mergePayload(existing.data, payload);
        merged.current_account_code = existing.account_code;

        const putRes = await safeFetch(url, 'PUT', headers, merged);

        if (putRes.ok) {
          return Response.json({
            ok: true, status: putRes.status,
            data: putRes.data, action: 'updated',
            matchedBy: existing.matchedBy
          });
        }

        return Response.json({
          ok: false, status: putRes.status,
          action: 'failed',
          errorDetail: humanError(putRes.data, putRes.status),
          debug: { step: 'PUT after find', matchedBy: existing.matchedBy, code: existing.account_code, sent: merged, raw: putRes.data }
        });
      }

      // Bước 1: Không tìm thấy → POST (tạo mới)
      const cleanPayload = mergePayload({}, payload);
      const postRes = await safeFetch(url, 'POST', headers, cleanPayload);

      if (postRes.ok) {
        return Response.json({
          ok: true, status: postRes.status,
          data: postRes.data, action: 'created'
        });
      }

      // Bước 2: POST lỗi trùng mã → restore + PUT
      const postBody = JSON.stringify(postRes.data).toLowerCase();
      const isDup = postRes.status === 409
        || postBody.includes('already exists')
        || postBody.includes('tồn tại')
        || postBody.includes('đã tồn tại')
        || postBody.includes('duplicate')
        || postBody.includes('đã có');

      if (isDup && payload.account_code) {
        await safeFetch(`${base}/api/v6.1/account/restore`, 'POST', headers, { account_code: payload.account_code });

        const putPayload = mergePayload({}, payload);
        putPayload.current_account_code = payload.account_code;
        const putRes = await safeFetch(url, 'PUT', headers, putPayload);

        if (putRes.ok) {
          return Response.json({
            ok: true, status: putRes.status,
            data: putRes.data, action: 'restored_and_updated'
          });
        }

        return Response.json({
          ok: false, status: putRes.status,
          action: 'failed',
          errorDetail: humanError(putRes.data, putRes.status),
          debug: { step: 'restore+PUT', sent: putPayload, raw: putRes.data }
        });
      }

      // POST lỗi khác → trả chi tiết
      return Response.json({
        ok: false, status: postRes.status,
        action: 'failed',
        errorDetail: humanError(postRes.data, postRes.status),
        debug: { step: 'POST create', sent: cleanPayload, raw: postRes.data }
      });
    }

    // ── POST / PUT thông thường ──────────────────────────────
    const httpMethod = method === 'PUT' ? 'PUT' : 'POST';
    const res = await safeFetch(url, httpMethod, headers, payload);

    if (res.ok) {
      return Response.json({
        ok: true, status: res.status, data: res.data,
        action: httpMethod === 'PUT' ? 'updated' : 'created'
      });
    }

    return Response.json({
      ok: false, status: res.status,
      action: 'failed',
      errorDetail: humanError(res.data, res.status),
      debug: { step: httpMethod, sent: payload, raw: res.data }
    });

  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.message.includes('timeout');
    return Response.json({
      ok: false, action: 'failed',
      errorDetail: isTimeout ? 'Getfly không phản hồi (timeout > 10s)' : e.message,
      debug: { step: 'exception', error: e.message }
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
        const list = extractList(res.data);
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
      const list = extractList(res.data);
      if (list.length && list[0].account_code) {
        return { account_code: list[0].account_code, matchedBy: 'account_code', data: list[0] };
      }
    } catch {}
  }

  return null;
}

// ── Helper: extract list từ nhiều format response Getfly ──
function extractList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.items)) return data.items;
  if (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)) return [data.data];
  return [];
}

// ── Helper: merge dữ liệu — chỉ gửi trường có giá trị ──
function mergePayload(oldData, newPayload) {
  const merged = {};
  for (const [key, val] of Object.entries(newPayload)) {
    if (val === null || val === undefined || val === '') continue;
    merged[key] = val;
  }
  return merged;
}

// ── Helper: fetch an toàn ──
async function safeFetch(url, method, headers, body) {
  const opts = { method, headers, signal: AbortSignal.timeout(10000) };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

// ── Helper: thông báo lỗi tiếng Việt ──
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
    422: 'Dữ liệu sai định dạng — kiểm tra ngày sinh, SĐT, tên loại KH...',
    429: 'Quá nhiều request — thử lại sau vài giây',
    500: 'Lỗi máy chủ Getfly — thử lại sau',
  };
  return map[status] || `HTTP ${status}: ${JSON.stringify(data).substring(0, 200)}`;
}
