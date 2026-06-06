-- Bảng lưu danh sách nhân sự phân công
CREATE TABLE IF NOT EXISTS staff (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  email       TEXT    NOT NULL UNIQUE,
  role        TEXT    DEFAULT '',
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Bảng lưu cài đặt key-value
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT    DEFAULT '',
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
