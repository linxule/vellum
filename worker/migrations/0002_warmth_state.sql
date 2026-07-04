-- Move human warmth persistence from KV to D1 so witness events do not consume KV writes.

CREATE TABLE warmth_state (
  family        TEXT PRIMARY KEY,
  score         REAL NOT NULL DEFAULT 0,
  pending       REAL NOT NULL DEFAULT 0,
  last_updated  INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO warmth_state (family, score, pending, last_updated) VALUES
  ('attention', 0, 0, 0),
  ('silence', 0, 0, 0),
  ('space', 0, 0, 0),
  ('ephemeral', 0, 0, 0),
  ('memory', 0, 0, 0),
  ('light', 0, 0, 0);
