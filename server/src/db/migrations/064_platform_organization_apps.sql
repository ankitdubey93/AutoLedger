-- 064_platform_organization_apps.sql
-- Phase 27 — choosing apps at sign-up, managing them in Account. See
-- docs/roadmap.md#phase-27-as-delivered.
--
-- One row per app an organization has enabled; no row means not enabled.
-- The client's app chooser shows only enabled apps. This is visibility, not
-- access control — an app's own routes do not consult this table.
--
-- app_slug carries NO `REFERENCES` and no enumerated CHECK, because the slug
-- list lives in config/apps.ts and is validated by the service — the same
-- call migrations 017 (audit_logs) and 027 (onboarding_states) made.
--
-- Rows are inserted or deleted, never updated (a replace of the whole set
-- deletes the apps dropped and inserts the apps added), so there is no
-- updated_at. enabled_by is nullable only because the backfill below has no
-- actor; every row the service writes sets it.
--
-- Backfill: organizations that existed before this phase keep seeing every
-- app, and their suite-level ('platform') onboarding step — which the new
-- app picker completes — is marked COMPLETED so nobody is sent to it.

CREATE TABLE IF NOT EXISTS organization_apps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_slug    TEXT NOT NULL CHECK (length(btrim(app_slug)) > 0 AND length(app_slug) <= 40),
  enabled_by  UUID REFERENCES users(id) ON DELETE RESTRICT,
  enabled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_organization_apps_org_app UNIQUE (org_id, app_slug)
);

CREATE INDEX IF NOT EXISTS idx_organization_apps_org ON organization_apps (org_id);
CREATE INDEX IF NOT EXISTS idx_organization_apps_enabled_by ON organization_apps (enabled_by);

CREATE OR REPLACE TRIGGER trg_organization_apps_audit
  AFTER INSERT OR UPDATE OR DELETE ON organization_apps
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');

-- Backfill: organizations that existed before this phase keep seeing every app.
-- The slug list is a snapshot of config/apps.ts at 2026-09-22.
INSERT INTO organization_apps (org_id, app_slug)
SELECT o.id, s.slug
  FROM organizations o
 CROSS JOIN (VALUES ('ledger-core'), ('taxguard'), ('ap-flow'), ('fpa-engine'),
                    ('unitecon'), ('boarddeck'), ('forecaster')) AS s(slug)
ON CONFLICT (org_id, app_slug) DO NOTHING;

INSERT INTO onboarding_states (org_id, app_slug, status, completed_at)
SELECT o.id, 'platform', 'COMPLETED', now() FROM organizations o
ON CONFLICT (org_id, app_slug) DO NOTHING;
