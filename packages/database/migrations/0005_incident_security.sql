-- Tenant policies for the incident tables, and the audit log's immutability.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incidents','incident_services','incident_events','audit_logs','outbox_events','incident_counters']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- The audit trail is evidence. Privileges alone would still let a future
-- migration (or a compromised owner session) rewrite it, so a trigger refuses
-- UPDATE and DELETE outright; only INSERT and SELECT remain meaningful.
CREATE OR REPLACE FUNCTION audit_logs_are_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_are_append_only();
--> statement-breakpoint

REVOKE UPDATE, DELETE ON audit_logs FROM app_rw;
