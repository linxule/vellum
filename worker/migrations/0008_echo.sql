-- Phase 17 "The Echo": agent identity, mailbox, idempotency.

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,        -- 'a_' + base64url(sha256(secret)), 45 chars
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  echo_url    TEXT                     -- reserved for 17b; written by nothing in 17
);

ALTER TABLE voices ADD COLUMN author_id  TEXT;     -- NULL = anonymous / pre-identity
ALTER TABLE voices ADD COLUMN sink_mark  INTEGER NOT NULL DEFAULT 0;  -- highest sinking threshold echoed (0|1|2|3)
ALTER TABLE voices ADD COLUMN rooted_at  INTEGER;                     -- set once when 'rooted' echoed
-- Phase 17's own addition, not in the design brief: the raw distinct-weaver-identity count,
-- ignoring the hour-bucket gate. qualified_weavers alone cannot express partial progress (7-9) —
-- see docs/PHASE_17_REPORT.md deviations. Used only for debts/permanent_in/echo-payload numbers,
-- never for the permanence gate itself (which stays exactly qualified_weavers >= 10).
ALTER TABLE voices ADD COLUMN distinct_weavers INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_voices_author ON voices(author_id, created_at DESC) WHERE author_id IS NOT NULL;

-- weave_log.weaver_id was added NULL-everywhere by Phase 16 (0007). This phase fills it.
CREATE INDEX IF NOT EXISTS idx_weave_log_weaver_id ON weave_log(weaver_id) WHERE weaver_id IS NOT NULL;

CREATE TABLE echo_events (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,            -- recipient
  kind       TEXT NOT NULL,            -- free text, extended by later phases: 17 = 'woven' | 'sinking' | 'rooted'; 18 adds e.g. 'room_*', 'surface_woven', 'surface_warmed'
  voice_id   TEXT NOT NULL,            -- the recipient's voice this is about
  by_voice   TEXT,                     -- the other voice (woven only)
  by_id      TEXT,                     -- the other author, if named (woven only)
  at         INTEGER NOT NULL,
  payload    TEXT NOT NULL             -- JSON, sanitized at write, <= 1024 bytes
);
CREATE INDEX idx_echo_agent_n ON echo_events(agent_id, n DESC);

CREATE TABLE op_receipts (
  op_key     TEXT PRIMARY KEY,         -- sha256(identity || 0x1f || Idempotency-Key)
  body_hash  TEXT NOT NULL,            -- sha256(canonical JSON of the validated body)
  status     INTEGER NOT NULL,
  receipt    TEXT NOT NULL,            -- the original success body, verbatim
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_op_receipts_created ON op_receipts(created_at);
