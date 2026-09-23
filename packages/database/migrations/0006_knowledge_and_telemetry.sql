CREATE TYPE "public"."document_type" AS ENUM('RUNBOOK', 'POSTMORTEM', 'ARCHITECTURE', 'TROUBLESHOOTING', 'GENERAL');--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"version" text NOT NULL,
	"commit_sha" text,
	"status" text DEFAULT 'SUCCEEDED' NOT NULL,
	"change_summary" text,
	"deployed_by" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "deployments_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"heading_path" text,
	"content" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_chunks_version_index_key" UNIQUE("document_version_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ingestion_status" text DEFAULT 'PENDING' NOT NULL,
	"ingestion_error" text,
	"indexed_at" timestamp with time zone,
	CONSTRAINT "document_versions_doc_no_key" UNIQUE("document_id","version_no"),
	CONSTRAINT "document_versions_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"type" "document_type" DEFAULT 'GENERAL' NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"service_id" uuid,
	"current_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "log_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "metric_points" (
	"org_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"value" double precision NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "metric_points_pkey" UNIQUE("service_id","metric","ts")
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_fk" FOREIGN KEY ("org_id","service_id") REFERENCES "public"."services"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_version_fk" FOREIGN KEY ("org_id","document_version_id") REFERENCES "public"."document_versions"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_fk" FOREIGN KEY ("org_id","document_id") REFERENCES "public"."documents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_service_fk" FOREIGN KEY ("org_id","service_id") REFERENCES "public"."services"("org_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_entries" ADD CONSTRAINT "log_entries_service_fk" FOREIGN KEY ("org_id","service_id") REFERENCES "public"."services"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_points" ADD CONSTRAINT "metric_points_service_fk" FOREIGN KEY ("org_id","service_id") REFERENCES "public"."services"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deployments_service_time_idx" ON "deployments" USING btree ("org_id","service_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_org_type_idx" ON "documents" USING btree ("org_id","type","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_tags_idx" ON "documents" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "log_entries_service_time_idx" ON "log_entries" USING btree ("org_id","service_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "log_entries_ts_brin_idx" ON "log_entries" USING brin ("ts");