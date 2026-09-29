CREATE TABLE "endpoint_daily_stats" (
	"endpoint_id" uuid NOT NULL,
	"day" date NOT NULL,
	"checks" integer NOT NULL,
	"ok" integer NOT NULL,
	CONSTRAINT "endpoint_daily_stats_endpoint_id_day_pk" PRIMARY KEY("endpoint_id","day"),
	CONSTRAINT "endpoint_daily_stats_counts_check" CHECK ("endpoint_daily_stats"."ok" between 0 and "endpoint_daily_stats"."checks")
);
--> statement-breakpoint
CREATE TABLE "scan_variables" (
	"scan_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"var_name" text NOT NULL,
	"defined_in" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "scan_variables_scan_id_scope_var_name_pk" PRIMARY KEY("scan_id","scope","var_name")
);
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "name" varchar(60);--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deploy_notes" text;--> statement-breakpoint
ALTER TABLE "endpoint_daily_stats" ADD CONSTRAINT "endpoint_daily_stats_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_variables" ADD CONSTRAINT "scan_variables_scan_id_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_name_check" CHECK ("endpoints"."name" is null or char_length(btrim("endpoints"."name")) > 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deploy_notes_length_check" CHECK (char_length("projects"."deploy_notes") <= 20000);