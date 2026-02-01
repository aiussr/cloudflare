CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text TEXT NOT NULL,
  category TEXT NOT NULL,
  sentiment REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
