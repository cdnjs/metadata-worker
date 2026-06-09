-- Shadow comparison drift table.
-- One row per path that disagreed with metadata.speedcdnjs.com.
-- Once a path is recorded, it is never re-compared until the row is deleted.

CREATE TABLE IF NOT EXISTS shadow_mismatches (
  path           TEXT PRIMARY KEY,
  endpoint_type  TEXT NOT NULL,        -- packages | package | aggregated | versions | version | sris
  status_new     INTEGER NOT NULL,     -- status from new KV-backed worker
  status_old     INTEGER NOT NULL,     -- status from metadata.speedcdnjs.com
  diff_kind      TEXT NOT NULL,        -- status | body | missing_new | missing_old
  first_seen     INTEGER NOT NULL      -- unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_endpoint_type ON shadow_mismatches(endpoint_type);
CREATE INDEX IF NOT EXISTS idx_diff_kind ON shadow_mismatches(diff_kind);
