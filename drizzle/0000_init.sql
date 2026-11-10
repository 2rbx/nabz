CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survey_id" uuid NOT NULL,
	"language" text NOT NULL,
	"label" text NOT NULL,
	"agent_ref" text NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"config_sha256" text NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"synced_by" text NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "agent_versions_agent_version_uq" UNIQUE("agent_ref","version"),
	CONSTRAINT "agent_versions_sha_ck" CHECK ("agent_versions"."config_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_versions_language_ck" CHECK ("agent_versions"."language" in ('en', 'hi', 'bn', 'mr', 'te', 'ta', 'gu', 'kn', 'or', 'ml', 'pa', 'as'))
);
--> statement-breakpoint
CREATE TABLE "geo_cities" (
	"code" text PRIMARY KEY NOT NULL,
	"state_code" text NOT NULL,
	"name" text NOT NULL,
	"tier" smallint NOT NULL,
	"tier_source" text NOT NULL,
	CONSTRAINT "geo_cities_state_name_uq" UNIQUE("state_code","name"),
	CONSTRAINT "geo_cities_tier_ck" CHECK ("geo_cities"."tier" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "geo_regions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_states" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"region_code" text NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "geo_states_code_ck" CHECK ("geo_states"."code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "sectors" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"sort_order" integer NOT NULL,
	"nouns" jsonb NOT NULL,
	"config_sha256" text NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sectors_slug_ck" CHECK ("sectors"."slug" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "sectors_status_ck" CHECK ("sectors"."status" in ('live', 'planned')),
	CONSTRAINT "sectors_sha_ck" CHECK ("sectors"."config_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sector_slug" text NOT NULL,
	"slug" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"schema_version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_sha256" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"frozen_at" timestamp with time zone,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "surveys_slug_version_uq" UNIQUE("slug","version"),
	CONSTRAINT "surveys_version_ck" CHECK ("surveys"."version" > 0),
	CONSTRAINT "surveys_kind_ck" CHECK ("surveys"."kind" in ('pulse', 'custom')),
	CONSTRAINT "surveys_status_ck" CHECK ("surveys"."status" in ('active', 'retired')),
	CONSTRAINT "surveys_sha_ck" CHECK ("surveys"."definition_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "dealers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sector_slug" text NOT NULL,
	"business_name" text NOT NULL,
	"contact_name" text,
	"contact_role" text,
	"phone_e164" text NOT NULL,
	"city_code" text NOT NULL,
	"language" text DEFAULT 'hi' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealers_phone_format_ck" CHECK ("dealers"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "dealers_attributes_ck" CHECK (jsonb_typeof("dealers"."attributes") = 'object'),
	CONSTRAINT "dealers_language_ck" CHECK ("dealers"."language" in ('en', 'hi', 'bn', 'mr', 'te', 'ta', 'gu', 'kn', 'or', 'ml', 'pa', 'as'))
);
--> statement-breakpoint
CREATE TABLE "answer_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_overrides_reason_ck" CHECK (length(trim("answer_overrides"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "batch_members" (
	"batch_id" uuid NOT NULL,
	"dealer_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_members_pk" PRIMARY KEY("batch_id","dealer_id"),
	CONSTRAINT "batch_members_dealer_uq" UNIQUE("dealer_id")
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sector_slug" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batches_name_ck" CHECK (length(trim("batches"."name")) between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "call_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"question_key" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_flags_call_code_q_uq" UNIQUE NULLS NOT DISTINCT("call_id","code","question_key"),
	CONSTRAINT "call_flags_severity_ck" CHECK ("call_flags"."severity" in ('hold', 'warn', 'info', 'exclude'))
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" text NOT NULL,
	"set_recipient_id" uuid NOT NULL,
	"dealer_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"agent_version_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"week_start" date NOT NULL,
	"execution_status" text NOT NULL,
	"status_rank" smallint NOT NULL,
	"derived_status" text NOT NULL,
	"outcome" text,
	"answered_by_voicemail" boolean,
	"initiated_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_s" numeric(8, 1),
	"cost_cents" numeric(12, 4),
	"cost_breakdown" jsonb,
	"hangup_by" text,
	"hangup_reason" text,
	"error_message" text,
	"transcript" text,
	"extracted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"answered_count" smallint DEFAULT 0 NOT NULL,
	"callback_time_text" text,
	"extraction_source" text,
	"reextracted_data" jsonb,
	"reextracted_at" timestamp with time zone,
	"qa_state" text DEFAULT 'pending' NOT NULL,
	"qa_reviewed_at" timestamp with time zone,
	"qa_reviewed_by" text,
	"qa_note" text,
	"raw_execution" jsonb,
	"execution_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_execution_id_uq" UNIQUE("execution_id"),
	CONSTRAINT "calls_derived_status_ck" CHECK ("calls"."derived_status" in ('queued', 'in_progress', 'completed', 'partial', 'refused', 'callback', 'wrong_number', 'no_answer', 'busy', 'failed', 'voicemail', 'error')),
	CONSTRAINT "calls_outcome_ck" CHECK ("calls"."outcome" is null or "calls"."outcome" in ('completed', 'partial', 'refused', 'callback', 'wrong_number')),
	CONSTRAINT "calls_qa_state_ck" CHECK ("calls"."qa_state" in ('pending', 'auto_ok', 'needs_review', 'approved', 'excluded')),
	CONSTRAINT "calls_extraction_source_ck" CHECK ("calls"."extraction_source" is null or "calls"."extraction_source" in ('agent', 'reextract')),
	CONSTRAINT "calls_week_ck" CHECK (extract(isodow from "calls"."week_start") = 1),
	CONSTRAINT "calls_attempt_ck" CHECK ("calls"."attempt" >= 1),
	CONSTRAINT "calls_answered_count_ck" CHECK ("calls"."answered_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dialer_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"set_id" uuid,
	"recipient_count" integer NOT NULL,
	"allowed" boolean NOT NULL,
	"refusal_code" text,
	"refusal_detail" text,
	"estimated_cost_cents" numeric(12, 4) DEFAULT 0 NOT NULL,
	"http_status" integer,
	"execution_ref" text,
	"actor" text NOT NULL,
	CONSTRAINT "dialer_log_action_ck" CHECK ("dialer_log"."action" in ('call', 'test_call')),
	CONSTRAINT "dialer_log_refusal_ck" CHECK ("dialer_log"."allowed" = ("dialer_log"."refusal_code" is null))
);
--> statement-breakpoint
CREATE TABLE "execution_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execution_id" text,
	"execution_status" text,
	"payload" jsonb,
	"processed_at" timestamp with time zone,
	"result" text,
	"error" text,
	"call_id" uuid,
	CONSTRAINT "execution_events_result_ck" CHECK ("execution_events"."result" is null or "execution_events"."result" in ('ingested', 'stale', 'unlinked', 'rejected', 'error'))
);
--> statement-breakpoint
CREATE TABLE "set_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"dealer_id" uuid NOT NULL,
	"call_ref" uuid DEFAULT gen_random_uuid() NOT NULL,
	"included" boolean NOT NULL,
	"exclusion_reason" text,
	"dial_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "set_recipients_call_ref_uq" UNIQUE("call_ref"),
	CONSTRAINT "set_recipients_set_dealer_uq" UNIQUE("set_id","dealer_id"),
	CONSTRAINT "set_recipients_exclusion_ck" CHECK (("set_recipients"."included" = ("set_recipients"."exclusion_reason" is null)) and ("set_recipients"."exclusion_reason" is null or "set_recipients"."exclusion_reason" in ('not_allowlisted', 'no_agent')))
);
--> statement-breakpoint
CREATE TABLE "sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid,
	"survey_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stop_reason" text,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"estimated_cost_cents" numeric(12, 4) DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sets_status_ck" CHECK ("sets"."status" in ('running', 'completed', 'stopped')),
	CONSTRAINT "sets_week_ck" CHECK (extract(isodow from "sets"."week_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"meta" jsonb,
	CONSTRAINT "audit_log_action_ck" CHECK ("audit_log"."action" ~ '^[a-z_]+\.[a-z_]+$')
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_cities" ADD CONSTRAINT "geo_cities_state_code_geo_states_code_fk" FOREIGN KEY ("state_code") REFERENCES "public"."geo_states"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_states" ADD CONSTRAINT "geo_states_region_code_geo_regions_code_fk" FOREIGN KEY ("region_code") REFERENCES "public"."geo_regions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_sector_slug_sectors_slug_fk" FOREIGN KEY ("sector_slug") REFERENCES "public"."sectors"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_sector_slug_sectors_slug_fk" FOREIGN KEY ("sector_slug") REFERENCES "public"."sectors"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealers" ADD CONSTRAINT "dealers_city_code_geo_cities_code_fk" FOREIGN KEY ("city_code") REFERENCES "public"."geo_cities"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_overrides" ADD CONSTRAINT "answer_overrides_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_members" ADD CONSTRAINT "batch_members_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_members" ADD CONSTRAINT "batch_members_dealer_id_dealers_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."dealers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_sector_slug_sectors_slug_fk" FOREIGN KEY ("sector_slug") REFERENCES "public"."sectors"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_flags" ADD CONSTRAINT "call_flags_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_set_recipient_id_set_recipients_id_fk" FOREIGN KEY ("set_recipient_id") REFERENCES "public"."set_recipients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_dealer_id_dealers_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."dealers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_set_id_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialer_log" ADD CONSTRAINT "dialer_log_set_id_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_recipients" ADD CONSTRAINT "set_recipients_set_id_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "set_recipients" ADD CONSTRAINT "set_recipients_dealer_id_dealers_id_fk" FOREIGN KEY ("dealer_id") REFERENCES "public"."dealers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_current_uq" ON "agent_versions" USING btree ("survey_id","language") WHERE "agent_versions"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "dealers_sector_idx" ON "dealers" USING btree ("sector_slug");--> statement-breakpoint
CREATE INDEX "dealers_city_idx" ON "dealers" USING btree ("city_code");--> statement-breakpoint
CREATE INDEX "answer_overrides_call_q_idx" ON "answer_overrides" USING btree ("call_id","question_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "batches_name_uq" ON "batches" USING btree (lower("name")) WHERE "batches"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "calls_survey_week_idx" ON "calls" USING btree ("survey_id","week_start");--> statement-breakpoint
CREATE INDEX "calls_dealer_week_idx" ON "calls" USING btree ("dealer_id","week_start");--> statement-breakpoint
CREATE INDEX "calls_set_idx" ON "calls" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "calls_needs_review_idx" ON "calls" USING btree ("qa_state") WHERE "calls"."qa_state" = 'needs_review';--> statement-breakpoint
CREATE INDEX "calls_created_idx" ON "calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "dialer_log_at_idx" ON "dialer_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "execution_events_execution_idx" ON "execution_events" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "execution_events_received_idx" ON "execution_events" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sets_batch_idx" ON "sets" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at" DESC NULLS LAST);