-- Database foundations: extensions and the application privilege model.
--
-- Two kinds of database principal:
--   * the migrator (whoever runs this file) owns every table. Table owners
--     bypass Row-Level Security, so the running application must never
--     connect as the migrator.
--   * app_rw is a NOLOGIN role holding data-manipulation privileges only
--     (no DDL, no RLS bypass). Infrastructure (docker init script locally,
--     Terraform in AWS) creates the application's LOGIN user as a member of
--     app_rw, which keeps passwords out of migrations.

-- Case-insensitive text for email addresses (unique regardless of case).
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint

-- Only the migrator may create objects in the public schema (already the
-- default on PostgreSQL 15+, stated explicitly for older or modified clusters).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_rw;
--> statement-breakpoint

-- Tables and sequences created by future migrations become usable by app_rw
-- automatically. Tables needing stricter rules (e.g. append-only audit logs)
-- revoke privileges explicitly in their own migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
