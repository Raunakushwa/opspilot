-- Row-level security: the second of three tenant-isolation layers
-- (ADR-009). The first is path scoping plus repository functions that require
-- an organization id; the third is composite foreign keys.
--
-- Every policy compares org_id to `app.current_org_id`, a per-transaction
-- setting applied by withTenant(). current_setting(..., true) returns NULL when
-- the setting is absent, and `org_id = NULL` is NULL, so the default is deny:
-- a query that forgets to establish tenant context returns no rows rather than
-- every tenant's rows.
--
-- FORCE is required because the table owner (the migrator) would otherwise
-- bypass its own policies, which would make them untestable.

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_org_id', true), '')::uuid
$$;
--> statement-breakpoint

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teams_tenant_isolation ON teams
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY team_members_tenant_isolation ON team_members
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY projects_tenant_isolation ON projects
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE services FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY services_tenant_isolation ON services
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- organizations, users and sessions are deliberately not covered:
--   * organizations is the tenant root; a user's visible organizations come
--     from memberships, which is policy-protected.
--   * users and sessions are global. Authentication happens before any
--     organization is known, so a tenant policy could not be satisfied at
--     login. Access to another user's row goes through a membership join in
--     the API, and sessions are only ever read by token hash.
COMMENT ON TABLE users IS 'Global (not tenant-scoped): authentication precedes organization context. Access via memberships in the API layer.';
--> statement-breakpoint
COMMENT ON TABLE sessions IS 'Global (not tenant-scoped): looked up by token hash during authentication.';
