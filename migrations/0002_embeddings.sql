-- P2: track which memories have an up-to-date vector in Vectorize.
-- NULL = needs (re-)embedding; the scheduled backfill picks these up.
ALTER TABLE memories ADD COLUMN embedded_at TEXT;
CREATE INDEX idx_memories_unembedded ON memories(updated_at) WHERE deleted_at IS NULL AND embedded_at IS NULL;
