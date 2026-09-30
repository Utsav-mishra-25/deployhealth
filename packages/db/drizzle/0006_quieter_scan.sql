ALTER TABLE "scan_variables" ADD COLUMN "optional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "env_scopes" jsonb;