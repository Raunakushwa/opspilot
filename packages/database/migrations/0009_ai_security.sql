-- Tenant policies for the AI tables. Investigations, their telemetry and the
-- actions they propose are tenant data like any other.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_runs','ai_llm_calls','ai_tool_calls','ai_action_proposals']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())',
      t || '_tenant_isolation', t);
  END LOOP;
END
$$;
