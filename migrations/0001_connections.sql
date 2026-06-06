-- Bảng lưu thông tin kết nối Getfly
CREATE TABLE IF NOT EXISTS connections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,             -- Tên gợi nhớ (vd: "Phòng khám CS1")
  domain      TEXT    NOT NULL,             -- Domain Getfly (vd: abc.getflycrm.com)
  api_key     TEXT    NOT NULL,             -- API Key Getfly
  is_default  INTEGER NOT NULL DEFAULT 0,  -- 1 = kết nối mặc định
  is_active   INTEGER NOT NULL DEFAULT 1,  -- 1 = đang hoạt động
  last_status TEXT    DEFAULT 'unknown',   -- ok | fail | unknown
  last_tested TEXT,                         -- ISO datetime lần cuối test
  note        TEXT    DEFAULT '',           -- Ghi chú thêm
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Seed dữ liệu mẫu
INSERT INTO connections (name, domain, api_key, is_default, note)
VALUES (
  'Phòng khám mẫu (chưa cấu hình)',
  'tencongty.getflycrm.com',
  'YOUR_API_KEY_HERE',
  1,
  'Xoá dòng này và thêm kết nối thật của bạn'
);
