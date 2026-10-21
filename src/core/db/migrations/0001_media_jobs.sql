CREATE TYPE "public"."media_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "media_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"media_id" uuid NOT NULL,
	"status" "media_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_jobs_media_idx" ON "media_jobs" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "media_jobs_queued_idx" ON "media_jobs" USING btree ("run_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "media_jobs_running_idx" ON "media_jobs" USING btree ("locked_until") WHERE status = 'running';--> statement-breakpoint
INSERT INTO "media_jobs" ("media_id") SELECT "id" FROM "media" WHERE "kind" = 'video' AND "processing_status" = 'uploaded' ON CONFLICT DO NOTHING;
