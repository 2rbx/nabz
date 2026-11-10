import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, smallint, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { CALL_LANGUAGE_CODES, type CallLanguage } from "../../reference/languages";
import type { SurveyDefinition } from "../../surveys/schema";
import { createdAt, inList, pk, SHA256_HEX, tstz } from "./_shared";

/** Sectors mirrored from src/lib/sectors (code is the source of truth; `pnpm db:sync` writes these). */
export const sectors = pgTable(
  "sectors",
  {
    slug: text("slug").primaryKey(),
    name: text("name").notNull(),
    status: text("status").$type<"live" | "planned">().notNull(),
    sortOrder: integer("sort_order").notNull(),
    nouns: jsonb("nouns").$type<{ one: string; other: string }>().notNull(),
    configSha256: text("config_sha256").notNull(),
    syncedAt: tstz("synced_at").notNull(),
  },
  (t) => [
    check("sectors_slug_ck", sql`${t.slug} ~ '^[a-z][a-z0-9_]*$'`),
    check("sectors_status_ck", inList(t.status, ["live", "planned"])),
    check("sectors_sha_ck", sql`${t.configSha256} ~ ${SHA256_HEX}`),
  ],
);

export const geoRegions = pgTable("geo_regions", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const geoStates = pgTable(
  "geo_states",
  {
    /** ISO 3166-2:IN subdivision code, e.g. "UP". */
    code: text("code").primaryKey(),
    name: text("name").notNull(),
    shortName: text("short_name").notNull(),
    regionCode: text("region_code")
      .notNull()
      .references(() => geoRegions.code),
    sortOrder: integer("sort_order").notNull(),
  },
  (t) => [check("geo_states_code_ck", sql`${t.code} ~ '^[A-Z]{2}$'`)],
);

export const geoCities = pgTable(
  "geo_cities",
  {
    code: text("code").primaryKey(),
    stateCode: text("state_code")
      .notNull()
      .references(() => geoStates.code),
    name: text("name").notNull(),
    tier: smallint("tier").$type<1 | 2 | 3>().notNull(),
    tierSource: text("tier_source").notNull(),
  },
  (t) => [
    check("geo_cities_tier_ck", sql`${t.tier} between 1 and 3`),
    unique("geo_cities_state_name_uq").on(t.stateCode, t.name),
  ],
);

/**
 * Survey definitions, one row per version, mirrored from src/lib/surveys. `frozen_at` is set when a
 * batch or call first uses a version; from then on a trigger (0001_guards) makes the definition
 * immutable, so every stored answer can always be re-scored with exactly the rules it was asked under.
 */
export const surveys = pgTable(
  "surveys",
  {
    id: pk(),
    sectorSlug: text("sector_slug")
      .notNull()
      .references(() => sectors.slug),
    slug: text("slug").notNull(),
    version: integer("version").notNull(),
    kind: text("kind").$type<"pulse" | "custom">().notNull(),
    title: text("title").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    definition: jsonb("definition").$type<SurveyDefinition>().notNull(),
    definitionSha256: text("definition_sha256").notNull(),
    status: text("status").$type<"active" | "retired">().notNull().default("active"),
    frozenAt: tstz("frozen_at"),
    syncedAt: tstz("synced_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("surveys_slug_version_uq").on(t.slug, t.version),
    check("surveys_version_ck", sql`${t.version} > 0`),
    check("surveys_kind_ck", inList(t.kind, ["pulse", "custom"])),
    check("surveys_status_ck", inList(t.status, ["active", "retired"])),
    check("surveys_sha_ck", sql`${t.definitionSha256} ~ ${SHA256_HEX}`),
  ],
);

/**
 * Each configuration of a voice agent, per survey and language (`pnpm agents:sync` writes these
 * from src/lib/calls/agents.ts). Calls record the version they used. A changed agent, or a
 * new agent for a language, is a new row; the one it replaces is retired, never deleted.
 */
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: pk(),
    surveyId: uuid("survey_id")
      .notNull()
      .references(() => surveys.id),
    /** The language this agent speaks: one of CALL_LANGUAGES (src/lib/reference/languages.ts). */
    language: text("language").$type<CallLanguage>().notNull(),
    /** The call-lab version that built the agent, e.g. "hi04". */
    label: text("label").notNull(),
    agentRef: text("agent_ref").notNull(),
    version: integer("version").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    configSha256: text("config_sha256").notNull(),
    syncedAt: tstz("synced_at").notNull(),
    syncedBy: text("synced_by").notNull(),
    retiredAt: tstz("retired_at"),
  },
  (t) => [
    unique("agent_versions_agent_version_uq").on(t.agentRef, t.version),
    // At most one current agent per survey and language: the one new calls use.
    uniqueIndex("agent_versions_current_uq")
      .on(t.surveyId, t.language)
      .where(sql`${t.retiredAt} is null`),
    check("agent_versions_sha_ck", sql`${t.configSha256} ~ ${SHA256_HEX}`),
    check("agent_versions_language_ck", inList(t.language, CALL_LANGUAGE_CODES)),
  ],
);
