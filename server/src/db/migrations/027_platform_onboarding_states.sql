-- 027_platform_onboarding_states.sql
-- Phase 9a — platform onboarding & data migration. See
-- docs/roadmap.md#phase-9-planned-scope.
--
-- One row per (org_id, app_slug), holding a resumable, skippable wizard's
-- state. Every app that acquires a setup wizard gets skip-and-resume for
-- free, and the suite-level checklist reads across all of them with one
-- query. A `'platform'` sentinel app_slug covers the suite-level wizard
-- itself, alongside every real app slug.
--
-- app_slug carries NO `REFERENCES` and no enumerated CHECK, because the slug
-- list lives in config/apps.ts and is validated by `isOnboardingSlug` in the
-- service — the identical call migration 017 made for audit_logs.app_slug.
--
-- draft is UNTRUSTED JSON: it is never spread into a query, never used to
-- pick a column, and is re-parsed through the target app's own zod schema at
-- completion time. It is bound as a single JSONB parameter everywhere it is
-- written.

CREATE TABLE IF NOT EXISTS onboarding_states (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_slug      TEXT NOT NULL CHECK (length(btrim(app_slug)) > 0 AND length(app_slug) <= 40),
  status        TEXT NOT NULL DEFAULT 'NOT_STARTED'
                CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'SKIPPED', 'COMPLETED')),
  current_step  TEXT CHECK (current_step IS NULL OR length(current_step) <= 60),
  draft         JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at  TIMESTAMPTZ,
  skipped_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ux_onboarding_states_org_app UNIQUE (org_id, app_slug),
  CONSTRAINT chk_onboarding_draft_object CHECK (jsonb_typeof(draft) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_onboarding_states_org ON onboarding_states (org_id);

CREATE OR REPLACE TRIGGER trg_onboarding_states_updated_at
  BEFORE UPDATE ON onboarding_states
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_onboarding_states_audit
  AFTER INSERT OR UPDATE OR DELETE ON onboarding_states
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');
