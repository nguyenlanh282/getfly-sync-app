/**
 * Cloudflare Pages Function — POST /api/proxy
 *
 * UPSERT flow (đã test thực tế với Getfly API):
 *   1. GET account_code → nếu tìm thấy → PUT (update, ghi đè)
 *   2. POST → tạo mới
 *   3. Nếu trùng (400 + "không cho phép trùng") → restore + PUT
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
    const clean   = stripEmpty(payload);

    // ── UPSERT ───────────────────────────────────────────────
    if (method === 'UPSERT') {

      // Bước 0: Nếu có account_code, GET xem đã tồn tại chưa
      if (clean.account_code) {
        const getRes = await safeFetch(
          `${url}?account_code=${encodeURIComponent(clean.account_code)}&fields=account_code,account_name`,
          'GET', headers
        );

        // 200 = tìm thấy → PUT cập nhật (ghi đè)
        if (getRes.ok && getRes.data?.account_code) {
          return await doPut(url, headers, clean, clean.account_code);
        }
        // 404 = chưa có → tiếp tục tạo mới
      }

      // Bước 1: POST tạo mới
      const postRes = await safeFetch(url, 'POST', headers, clean);

      if (postRes.ok) {
        return respond(true, postRes, 'created');
      }

      // Bước 2: Lỗi trùng → restore + PUT
      if (isDuplicate(postRes) && clean.account_code) {
        // Restore bản ghi đã soft-delete (nếu có)
        await safeFetch(`${base}/api/v6.1/account/restore`, 'POST', headers,
          { account_code: clean.account_code });

        return await doPut(url, headers, clean, clean.account_code);
      }

      // Lỗi khác
      return respond(false, postRes, 'POST', clean);
    }

    // ── POST / PUT thông thường ──────────────────────────────
    const httpMethod = method === 'PUT' ? 'PUT' : 'POST';

    if (httpMethod === 'PUT') {
      const code = clean.current_account_code || clean.account_code;
      return await doPut(url, headers, clean, code);
    }

    const res = await safeFetch(url, 'POST', headers, clean);
    return respond(res.ok, res, res.ok ? 'created' : 'POST', clean);

  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.message.includes('timeout');
    return Response.json({
      ok: false, action: 'failed',
      errorDetail: isTimeout ? 'Getfly không phản hồi (timeout > 10s)' : e.message,
      debug: { step: 'exception', error: e.message }
    }, { status: 500 });
  }
}

// ── PUT cập nhật — ghi đè tất cả field có giá trị ──
async function doPut(url, headers, data, accountCode) {
  const putData = { ...data, current_account_code: accountCode };
  const res = await safeFetch(url, 'PUT', headers, putData);
  return respond(res.ok, res, res.ok ? 'updated' : 'PUT', putData);
}

// ── Kiểm tra lỗi trùng (đã test: Getfly trả 400 + "không cho phép trùng") ──
function isDuplicate(res) {
  if (res.status === 409) return true;
  const body = JSON.stringify(res.data).toLowerCase();
  return body.includes('trùng')
    || body.includes('already exists')
    || body.includes('tồn tại')
    || body.includes('đã tồn tại')
    || body.includes('duplicate')
    || body.includes('đã có');
}

// ── Response helper ──
function respond(ok, res, actionOrStep, sent) {
  if (ok) {
    return Response.json({ ok: true, status: res.status, data: res.data, action: actionOrStep });
  }
  return Response.json({
    ok: false, status: res.status, action: 'failed',
    errorDetail: humanError(res.data, res.status),
    debug: { step: actionOrStep, sent, raw: res.data }
  });
}

// ── Lọc trường trống ──
function stripEmpty(data) {
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
  // Extract errors object from Getfly
  if (data?.errors) {
    const msgs = [];
    for (const [field, msg] of Object.entries(data.errors)) {
      const txt = Array.isArray(msg) ? msg.join(', ') : msg;
      msgs.push(`${field}: ${txt}`);
    }
    if (msgs.length) return msgs.join(' | ');
  }

  const msg = data?.message || data?.error || data?.msg;
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
  return map[status] || `HTTP ${status}`;
}
