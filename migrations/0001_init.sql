-- Memory Hub initial schema

CREATE TABLE memories (
  id          TEXT PRIMARY KEY,                -- ULID
  content     TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('profile','preference','project','decision','knowledge','todo')),
  tags        TEXT NOT NULL DEFAULT '[]',      -- JSON array
  source      TEXT NOT NULL DEFAULT 'unknown', -- client that wrote it
  importance  INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_memories_category ON memories(category) WHERE deleted_at IS NULL;
CREATE INDEX idx_memories_updated  ON memories(updated_at) WHERE deleted_at IS NULL;

CREATE TABLE profile (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Trigram FTS: works for Korean without a morphological analyzer (substring match).
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, tags,
  content='memories', content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id  TEXT,
  action     TEXT NOT NULL,   -- create | update | forget | profile_set
  source     TEXT NOT NULL,
  diff       TEXT,            -- JSON
  at         TEXT NOT NULL
);
