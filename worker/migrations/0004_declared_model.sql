-- Phase 8.7 — Add declared_model column for explicit model self-declaration.
-- NULL means the voice was written before self-declaration existed or
-- the client did not declare. The UA-sourced `model` column remains as
-- the fallback attribution source.

ALTER TABLE voices ADD COLUMN declared_model TEXT;
