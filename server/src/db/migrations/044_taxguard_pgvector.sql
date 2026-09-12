-- 044_taxguard_pgvector.sql
-- Phase 16 — TaxGuard AI: the pgvector extension. See docs/roadmap.md#phase-16.
--
-- Its own migration, ahead of 045's tables, because an extension is a
-- database-wide object rather than a schema change and because a failure here
-- must name the missing extension rather than a confusing "type vector does
-- not exist" on a CREATE TABLE.
--
-- REQUIRES docker-compose.yml to run pgvector/pgvector:pg16. The stock
-- postgres:16 image does not ship this extension and this file will fail
-- against it — that is deliberate and the error is the signal.

CREATE EXTENSION IF NOT EXISTS vector;
