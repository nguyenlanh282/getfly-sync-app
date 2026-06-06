const express = require('express');
const multer  = require('multer');
const xlsx    = require('xlsx');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app      = express();
const PORT     = 3000;
const CFG_FILE = path.join(__dirname, 'config.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Upload vào RAM
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.xlsx', '.xls', '.csv'].includes(ext) ? cb(null, true) : cb(new Error('Chỉ hỗ trợ .xlsx .xls .csv'));
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

let parsedData  = [];
let syncClients = [];

// ============================================================
// HELPER: Đọc / ghi config.json
// ============================================================
function loadConfig() {
  try {
    if (fs.existsSync(CFG_FILE)) return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  } catch {}
  return {};
}
function saveConfig(data) {
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// ============================================================
// API: Lấy config đã lưu
// ============================================================
app.get('/config', (req, res) => {
  const cfg = loadConfig();
  // Che bớt API key khi trả về (chỉ hiện 6 ký tự đầu)
  const masked = cfg.apiKey ? cfg.apiKey.slice(0, 6) + '••••••••••••' : '';
  res.json({ domain: cfg.domain || '', apiKeyMasked: masked, hasSaved: !!cfg.apiKey });
});

// ============================================================
// API: Lưu config
// ============================================================
app.post('/config', (req, res) => {
  const { domain, apiKey } = req.body;
  if (!domain || !apiKey) return res.status(400).json({ error: 'Thiếu thông tin' });
  const existing = loadConfig();
  saveConfig({ ...existing, domain, apiKey, savedAt: new Date().toISOString() });
  res.json({ success: true });
});

// ============================================================
// HELPER: Chuyển ngày Excel serial → YYYY-MM-DD
// ============================================================
function excelSerialToDate(serial) {
  if (!serial || isNaN(serial)) return null;
  // Excel epoch: 1 Jan 1900 = 1, nhưng có bug ngày 29/02/1900 giả
  const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ============================================================
// HELPER: Chuẩn hóa chuỗi ngày DD/M/YYYY hoặc D/M/YYYY → YYYY-MM-DD
// ============================================================
function normalizeDate(val) {
  if (!val) return '';
  const s = String(val).trim();

  // Nếu là số → Excel serial
  if (/^\d{4,6}$/.test(s) && Number(s) > 1000) {
    return excelSerialToDate(Number(s)) || s;
  }

  // D/M/YYYY hoặc DD/MM/YYYY
  const m1 = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m1) {
    const [, d, m, y] = m1;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Đã đúng YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  return s;
}

// ============================================================
// HELPER: Tìm dòng header thực sự trong sheet
//         (dòng có ít nhất 3 ô không rỗng và không phải tiêu đề chung)
// ============================================================
function detectHeaderRow(rawRows) {
  const KNOWN_HEADERS = [
    'id','mã','họ tên','họ và tên','giới tính','năm sinh','ngày sinh',
    'điện thoại','địa chỉ','tỉnh','quận','phường','cơ sở','email',
    'ngày tạo','nghề nghiệp','người giới thiệu'
  ];

  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const row = rawRows[i].map(c => String(c).toLowerCase().trim());
    const matches = row.filter(c => KNOWN_HEADERS.some(h => c.includes(h)));
    if (matches.length >= 3) return i;
  }
  return 0; // fallback: dòng đầu tiên
}

// ============================================================
// SSE — stream tiến trình về browser
// ============================================================
app.get('/sync-stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const client = { res, id: Date.now() };
  syncClients.push(client);
  req.on('close', () => { syncClients = syncClients.filter(c => c.id !== client.id); });
});

function broadcast(data) {
  syncClients.forEach(c => c.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

// ============================================================
// TEST CONNECTION — tự động lưu nếu thành công
// ============================================================
app.post('/test-connection', async (req, res) => {
  const { domain, apiKey } = req.body;
  if (!domain || !apiKey) return res.status(400).json({ error: 'Thiếu Domain hoặc API Key' });
  try {
    const r = await axios.get(`https://${domain}/api/v6/accounts?limit=1`, {
      headers: { 'X-API-KEY': apiKey }, timeout: 8000
    });
    // Lưu config khi kết nối thành công
    saveConfig({ domain, apiKey, savedAt: new Date().toISOString() });
    res.json({ success: true, status: r.status, savedAt: new Date().toISOString() });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    const status = err.response?.status;
    res.json({ success: false, error: msg, httpStatus: status });
  }
});

// ============================================================
// UPLOAD & PARSE FILE
// ============================================================
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Không có file được upload' });

    const wb    = xlsx.read(req.file.buffer, { type: 'buffer' });
    const wsName = wb.SheetNames[0];
    const ws    = wb.Sheets[wsName];

    // Đọc thô toàn bộ (mảng 2 chiều)
    const raw = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!raw.length) return res.status(400).json({ error: 'File trống' });

    // Tìm dòng header
    const headerRowIdx = detectHeaderRow(raw);
    const headerRow    = raw[headerRowIdx].map(h => String(h).trim());

    // Loại bỏ cột hoàn toàn trống trong header
    const colIndices = headerRow
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h !== '');

    const headers = colIndices.map(({ h }) => h);

    // Parse dữ liệu từ dòng sau header
    const dataRows = raw.slice(headerRowIdx + 1).filter(row =>
      row.some(cell => cell !== '' && cell !== null && cell !== undefined)
    );

    parsedData = dataRows.map(row => {
      const obj = {};
      colIndices.forEach(({ h, i }) => { obj[h] = row[i] ?? ''; });
      return obj;
    });

    if (!parsedData.length) return res.status(400).json({ error: 'Không có dữ liệu sau header' });

    // Preview 5 dòng đầu
    const preview = parsedData.slice(0, 5).map(row => {
      const r = { ...row };
      // Hiển thị ngày đẹp hơn trong preview
      headers.forEach(h => {
        if (/ngày|date/i.test(h) && r[h]) r[h] = normalizeDate(r[h]) || r[h];
      });
      return r;
    });

    res.json({
      success: true,
      total: parsedData.length,
      headers,
      preview,
      sheetName: wsName,
      headerRowFound: headerRowIdx + 1  // 1-based
    });

  } catch (err) {
    res.status(500).json({ error: 'Lỗi đọc file: ' + err.message });
  }
});

// ============================================================
// SYNC — đẩy từng dòng lên Getfly
// ============================================================
app.post('/sync', async (req, res) => {
  const { apiKey, domain, mode, mapping } = req.body;

  if (!apiKey || !domain)   return res.status(400).json({ error: 'Thiếu API Key hoặc Domain' });
  if (!parsedData.length)   return res.status(400).json({ error: 'Chưa upload file' });

  res.json({ success: true, message: 'Bắt đầu đồng bộ...' });

  const baseURL = `https://${domain}/api/v6.1/account`;
  const reqHeaders = { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' };

  const ARRAY_FIELDS = ['account_type_names', 'account_source_names', 'industry_names'];
  const DATE_FIELDS  = ['birthday', 'last_contact_birthdate'];

  let success = 0, failed = 0;
  const errors = [];
  const total  = parsedData.length;

  broadcast({ type: 'start', total });

  for (let i = 0; i < total; i++) {
    const row     = parsedData[i];
    const payload = {};

    for (const [getflyField, fileCol] of Object.entries(mapping)) {
      if (!fileCol) continue;
      const raw = row[fileCol];
      if (raw === '' || raw === null || raw === undefined) continue;
      const val = String(raw).trim();
      if (!val) continue;

      if (ARRAY_FIELDS.includes(getflyField)) {
        payload[getflyField] = val.split(',').map(s => s.trim()).filter(Boolean);
      } else if (DATE_FIELDS.includes(getflyField)) {
        payload[getflyField] = normalizeDate(val);
      } else {
        payload[getflyField] = val;
      }
    }

    // Bỏ qua dòng rỗng
    if (!Object.keys(payload).length) {
      broadcast({ type: 'progress', index: i+1, total, success, failed, status: 'skip', row: `Dòng ${i+1} (rỗng)` });
      continue;
    }

    try {
      if (mode === 'update') {
        if (!payload.account_code) throw new Error('Thiếu Mã KH (account_code) để cập nhật');
        payload.current_account_code = payload.account_code;
        await axios.put(baseURL, payload, { headers: reqHeaders, timeout: 10000 });
      } else {
        await axios.post(baseURL, payload, { headers: reqHeaders, timeout: 10000 });
      }

      success++;
      broadcast({ type: 'progress', index: i+1, total, success, failed,
        status: 'success', row: payload.account_name || payload.account_code || `Dòng ${i+1}` });

    } catch (err) {
      failed++;
      const errMsg = err.response?.data?.message || err.response?.data?.error || err.message;
      errors.push({ row: i+1, name: payload.account_name || `Dòng ${i+1}`, error: errMsg });
      broadcast({ type: 'progress', index: i+1, total, success, failed,
        status: 'error', row: payload.account_name || `Dòng ${i+1}`, error: errMsg });
    }

    // Tránh rate limit Getfly
    await new Promise(r => setTimeout(r, 200));
  }

  broadcast({ type: 'done', total, success, failed, errors });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n✅ Getfly Sync đang chạy: http://localhost:${PORT}\n`);
});
