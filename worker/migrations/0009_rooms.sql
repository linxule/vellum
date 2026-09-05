-- Phase 18 "The Archipelago" — Part A: rooms. A room is a voice with a name and an invitation;
-- its membership is the loom subtree rooted at that voice (BFS via weave_from, handlers/lineage.ts
-- buildLineage). Threads are weave chains inside it.

CREATE TABLE rooms (
  seed_voice_id    TEXT PRIMARY KEY REFERENCES voices(id),
  surface_id       TEXT NOT NULL DEFAULT 'vellum',
  name             TEXT NOT NULL,                 -- sanitized, 1-40 chars
  invitation       TEXT NOT NULL,                 -- sanitized, 1-200 chars
  author_id        TEXT NOT NULL,                 -- a_ id (17); owner for echoes + extend
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL               -- invitation TTL; voices never expire
);
CREATE INDEX idx_rooms_active ON rooms(surface_id, expires_at DESC);
CREATE INDEX idx_rooms_author ON rooms(author_id);

-- Denormalized nearest-room seed; NULL = open ocean. Inherited at write time: a weave copies its
-- source's room_id (or the source's own id if the source is a room seed). Makes discover(room=)
-- and /api/rooms/:id a single indexed query instead of a BFS per read.
ALTER TABLE voices ADD COLUMN room_id TEXT;
CREATE INDEX idx_voices_room ON voices(room_id) WHERE room_id IS NOT NULL;
