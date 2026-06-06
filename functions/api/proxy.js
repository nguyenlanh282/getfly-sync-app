/**
 * Cloudflare Pages Function — POST /api/proxy
 *
 * UPSERT flow:
 *   1. POST → tạo mới
 *   2. Nếu trùng → restore + PUT (update)
 *   3. Nếu lỗi có account_manager_username → retry không có field đó
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
      const clean = mergePayload(payload);

      // Bước 1: POST (tạo mới)
      let res = await safeFetch(url, 'POST', headers, clean);

      if (res.ok) {
        return ok(res, 'created');
      }

      // Bước 2: Lỗi trùng mã → restore + PUT
      if (isDuplicate(res)) {
        const code = payload.account_code;
        if (code) {
          await safeFetch(`${base}/api/v6.1/account/restore`, 'POST', headers, { account_code: code });

          const putData = { ...clean, current_account_code: code };
          res = await safeFetch(url, 'PUT', headers, putData);

          if (res.ok) {
            return ok(res, 'updated');
          }

          // PUT lỗi → thử bỏ account_manager_username
          const retry = await retryWithoutManager(url, 'PUT', headers, putData);
          if (retry) return retry;

          return fail(res, 'restore+PUT', putData);
        }
      }

      // Bước 3: POST lỗi khác → thử bỏ account_manager_username
      const retry = await retryWithoutManager(url, 'POST', headers, clean);
      if (retry) return retry;

      return fail(res, 'POST', clean);
    }

    // ── POST / PUT thông thường ──────────────────────────────
    const httpMethod = method === 'PUT' ? 'PUT' : 'POST';
    const clean = mergePayload(payload);
    const res = await safeFetch(url, httpMethod, headers, clean);

    if (res.ok) {
      return ok(res, httpMethod === 'PUT' ? 'updated' : 'created');
    }

    const retry = await retryWithoutManager(url, httpMethod, headers, clean);
    if (retry) return retry;

    return fail(res, httpMethod, clean);

  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.message.includes('timeout');
    return Response.json({
      ok: false, action: 'failed',
      errorDetail: isTimeout ? 'Getfly không phản hồi (timeout > 10s)' : e.message,
      debug: { step: 'exception', error: e.message }
    }, { status: 500 });
  }
}

// ── Retry không có account_manager_username ──
async function retryWithoutManager(url, method, headers, data) {
  if (!data.account_manager_username) return null;

  const without = { ...data };
  delete without.account_manager_username;
  const res = await safeFetch(url, method, headers, without);

  if (res.ok) {
    return Response.json({
      ok: true, status: res.status, data: res.data,
      action: method === 'PUT' ? 'updated' : 'created',
      warning: `Đã lưu KH nhưng không gán được người phụ trách (${data.account_manager_username}). Kiểm tra email này có tồn tại trong Getfly không.`
    });
  }
  return null;
}

// ── Kiểm tra lỗi trùng mã ──
function isDuplicate(res) {
  if (res.status === 409) return true;
  const body = JSON.stringify(res.data).toLowerCase();
  return body.includes('already exists')
    || body.includes('tồn tại')
    || body.includes('đã tồn tại')
    || body.includes('duplicate')
    || body.includes('đã có');
}

// ── Response helpers ──
function ok(res, action) {
  return Response.json({ ok: true, status: res.status, data: res.data, action });
}

function fail(res, step, sent) {
  return Response.json({
    ok: false, status: res.status, action: 'failed',
    errorDetail: humanError(res.data, res.status),
    debug: { step, sent, raw: res.data }
  });
}

// ── Lọc payload: bỏ trường trống ──
function mergePayload(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

// ── Fetch an toàn ──
async function safeFetch(url, method, headers, body) {
  const opts = { method, headers, signal: AbortSignal.timeout(10000) };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data };
}

// ── Thông báo lỗi ──
function humanError(data, status) {
  const msg = data?.message || data?.error || data?.msg
    || (data?.errors ? Object.values(data.errors).flat().join(' | ') : null);
  if (msg) return msg;

  const map = {
    400: 'Dữ liệu không hợp lệ',
    401: 'API Key không hợp lệ hoặc hết hạn',
    403: 'Không có quyền',
    404: 'Bản ghi không tồn tại',
    409: 'Mã KH đã tồn tại',
    422: 'Dữ liệu sai định dạng',
    429: 'Quá nhiều request',
    500: 'Lỗi máy chủ Getfly',
  };
  return map[status] || `HTTP ${status}: ${JSON.stringify(data).substring(0, 200)}`;
}
