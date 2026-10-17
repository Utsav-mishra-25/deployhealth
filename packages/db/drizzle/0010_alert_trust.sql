ALTER TABLE "alerts" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "consecutive_ok" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_resolution_check" CHECK ("alerts"."resolution" is null or "alerts"."resolution" in ('recovered', 'paused'));