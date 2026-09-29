CREATE TABLE "check_hosts" (
	"hostname" text PRIMARY KEY NOT NULL,
	"next_slot_at" timestamp with time zone NOT NULL
);
