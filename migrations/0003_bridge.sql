-- P3.5: Bridge sync state, one row per external sink (notion, google-docs).
-- hash = snapshot hash last written successfully; the sink is skipped while it matches.
CREATE TABLE bridge_state (
  sink        TEXT PRIMARY KEY,
  hash        TEXT,
  synced_at   TEXT,        -- last successful write
  checked_at  TEXT,        -- last run (written or skipped)
  last_error  TEXT         -- NULL after a successful run
);
