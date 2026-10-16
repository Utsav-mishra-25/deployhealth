CREATE TABLE "account_deletions" (
	"github_id" bigint NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletions_github_id_deleted_at_pk" PRIMARY KEY("github_id","deleted_at")
);
--> statement-breakpoint
CREATE INDEX "account_deletions_deleted_at_idx" ON "account_deletions" USING btree ("deleted_at");