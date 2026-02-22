DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS chats;

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context_template TEXT,
  instruct_mode TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_session_id ON messages(session_id);
