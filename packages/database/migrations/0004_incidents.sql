CREATE TYPE "public"."actor_type" AS ENUM('USER', 'AI', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('SEV1', 'SEV2', 'SEV3', 'SEV4');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('INVESTIGATING', 'IDENTIFIED', 'MITIGATING', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_type" "actor_type" DEFAULT 'USER' NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_counters" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"actor_type" "actor_type" DEFAULT 'USER' NOT NULL,
	"actor_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_services" (
	"org_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	CONSTRAINT "incident_services_pkey" UNIQUE("incident_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"severity" "incident_severity" DEFAULT 'SEV3' NOT NULL,
	"status" "incident_status" DEFAULT 'INVESTIGATING' NOT NULL,
	"created_by" uuid NOT NULL,
	"assigned_to" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "incidents_org_number_key" UNIQUE("org_id","number"),
	CONSTRAINT "incidents_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "incident_counters" ADD CONSTRAINT "incident_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_fk" FOREIGN KEY ("org_id","incident_id") REFERENCES "public"."incidents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_services" ADD CONSTRAINT "incident_services_incident_fk" FOREIGN KEY ("org_id","incident_id") REFERENCES "public"."incidents"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_services" ADD CONSTRAINT "incident_services_service_fk" FOREIGN KEY ("org_id","service_id") REFERENCES "public"."services"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incident_events_incident_idx" ON "incident_events" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incident_services_service_idx" ON "incident_services" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "incidents_org_status_idx" ON "incidents" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_org_severity_idx" ON "incidents" USING btree ("org_id","severity","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_assigned_open_idx" ON "incidents" USING btree ("org_id","assigned_to") WHERE status NOT IN ('RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("created_at") WHERE published_at IS NULL;