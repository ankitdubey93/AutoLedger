-- 006_platform_organization_tax_ids.sql
-- Phase 3.8 — platform, organization tax and business registration numbers.
-- See docs/schema.md and docs/roadmap.md#phase-38-as-delivered.
--
-- Idempotent (IF NOT EXISTS), and the runner applies the file inside a single
-- transaction with PostgreSQL's transactional DDL, so a failure anywhere below
-- leaves the database untouched.

-- Both nullable, no default, no backfill: an organization that has not
-- entered a tax or business number has not entered one, and an empty string
-- would be a lie. No CHECK on format — identifier formats differ per
-- jurisdiction and a regex here would reject valid input.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tax_number TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS business_number TEXT;
