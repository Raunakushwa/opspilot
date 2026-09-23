-- Tenant policies for the knowledge and telemetry tables, plus full-text
-- search columns used by the keyword half of hybrid retrieval.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents','document_versions','document_chunks','deployments','metric_points','log_entries']
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

-- Generated columns keep the search vector in step with the text; a trigger
-- could drift if an UPDATE ever bypassed it.
ALTER TABLE incidents
  ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;
--> statement-breakpoint
CREATE INDEX incidents_search_idx ON incidents USING gin (search_tsv);
--> statement-breakpoint

ALTER TABLE log_entries
  ADD COLUMN message_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(message, ''))) STORED;
--> statement-breakpoint
CREATE INDEX log_entries_message_idx ON log_entries USING gin (message_tsv);
