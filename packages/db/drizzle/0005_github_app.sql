CREATE TYPE "public"."pr_check_mode" AS ENUM('off', 'comment', 'strict');--> statement-breakpoint
CREATE TABLE "installation_repos" (
	"installation_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	CONSTRAINT "installation_repos_installation_id_repo_full_name_pk" PRIMARY KEY("installation_id","repo_full_name")
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"installer_github_id" bigint NOT NULL,
	"user_id" uuid,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "pr_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"author_login" text NOT NULL,
	"author_is_agent" boolean DEFAULT false NOT NULL,
	"agent_name" text,
	"added_vars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removed_vars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"renamed_vars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"undeclared_vars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"committed_env_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_hits" integer DEFAULT 0 NOT NULL,
	"conclusion" text NOT NULL,
	"comment_id" bigint,
	"check_run_id" bigint,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_checks_conclusion_check" CHECK ("pr_checks"."conclusion" in ('neutral', 'success', 'failure'))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "pr_check_mode" "pr_check_mode" DEFAULT 'comment' NOT NULL;--> statement-breakpoint
ALTER TABLE "installation_repos" ADD CONSTRAINT "installation_repos_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_checks" ADD CONSTRAINT "pr_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_checks" ADD CONSTRAINT "pr_checks_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installation_repos_repo_idx" ON "installation_repos" USING btree (lower("repo_full_name"));--> statement-breakpoint
CREATE INDEX "installations_installer_idx" ON "installations" USING btree ("installer_github_id");--> statement-breakpoint
CREATE INDEX "installations_user_idx" ON "installations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_checks_head_uq" ON "pr_checks" USING btree ("project_id","pr_number","head_sha");--> statement-breakpoint
CREATE INDEX "pr_checks_project_created_idx" ON "pr_checks" USING btree ("project_id","created_at");