CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"contact_email" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "next_check_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "alert_webhook_url" text;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_user_slug_uq" ON "clients" USING btree ("user_id","slug");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_one_open_per_endpoint" ON "alerts" USING btree ("endpoint_id") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "checks_checked_at_brin" ON "checks" USING brin ("checked_at");--> statement-breakpoint
CREATE INDEX "endpoints_project_idx" ON "endpoints" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "endpoints_due_idx" ON "endpoints" USING btree ("next_check_at") WHERE "endpoints"."enabled";--> statement-breakpoint
CREATE INDEX "projects_client_idx" ON "projects" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_method_check" CHECK ("endpoints"."method" in ('GET', 'HEAD'));--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_interval_check" CHECK ("endpoints"."interval_seconds" in (60, 300, 900));--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_expected_status_check" CHECK ("endpoints"."expected_status" between 100 and 599);