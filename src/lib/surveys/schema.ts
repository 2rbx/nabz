import { z } from "zod";
import { SEVERITIES } from "./constants";
import { checkInvariants } from "./invariants";

/**
 * A survey definition describes one versioned questionnaire and how its answers become indices.
 * It is deliberately a closed vocabulary: five question types, two scoring rules, one weighted
 * composite, and four QA rule kinds. No expressions, no plugins. Anything new is a schema change.
 *
 * Definitions live in code (reviewed and tested), are mirrored into the `surveys` table, and freeze
 * the first time a call or batch uses them. After that, any change is a new version.
 */

export const Key = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, "lower_snake_case, 2–40 characters");

export const Text = z.strictObject({
  en: z.string().min(1),
  hinglish: z.string().min(1),
});
export type Text = z.infer<typeof Text>;

const Score = z.number().int().min(0).max(100);

const Severity = z.enum(SEVERITIES);

/** How the voice agent's extractor should capture an answer. */
const Extraction = z.strictObject({
  /** Extraction name. Defaults to the question key. */
  name: Key.optional(),
  /** Instruction for the extractor. Must tell it to leave the field empty when not answered. */
  instruction: z.string().min(20),
  /** Optional per-option guidance for pre-defined answers (option value → condition text). */
  optionHints: z.record(z.string(), z.string().min(1)).optional(),
});

const questionBase = {
  key: Key,
  label: Text,
  /** What the agent asks. */
  ask: Text,
  /** Set when this answer is collected inside another question's turn (e.g. a count after a trend). */
  askedWith: Key.optional(),
  extraction: Extraction,
};

export const Question = z.discriminatedUnion("type", [
  /** up / same / down. Neutral: same. */
  z.strictObject({ ...questionBase, type: z.literal("trend") }),
  /** high / normal / low. Neutral: normal. */
  z.strictObject({ ...questionBase, type: z.literal("level") }),
  z.strictObject({
    ...questionBase,
    type: z.literal("number"),
    min: z.number(),
    max: z.number(),
    integer: z.boolean(),
    unit: z.enum(["count", "days", "percent", "rupees"]),
  }),
  z.strictObject({
    ...questionBase,
    type: z.literal("choice"),
    options: z.array(z.strictObject({ value: Key, label: Text })).min(2),
    neutral: Key.optional(),
  }),
  z.strictObject({ ...questionBase, type: z.literal("text"), maxLength: z.number().int().positive() }),
]);
export type Question = z.infer<typeof Question>;

/** How an indicator turns one answer into a 0–100 score (50 = no change / normal). */
export const ScoringRule = z.discriminatedUnion("kind", [
  /** Maps each option of a trend / level / choice question to a score. */
  z.strictObject({ kind: z.literal("map"), question: Key, scores: z.record(z.string(), Score) }),
  /**
   * Compares a number with the same dealer's answer in the previous survey week.
   * "rose" means 100·(now − prev) > tolerancePct·prev; "fell" is the mirror; otherwise "within".
   */
  z.strictObject({
    kind: z.literal("momentum"),
    question: Key,
    tolerancePct: z.number().int().min(0).max(100),
    score: z.strictObject({ rose: Score, within: Score, fell: Score }),
  }),
]);
export type ScoringRule = z.infer<typeof ScoringRule>;

export const QaRule = z.discriminatedUnion("kind", [
  /** Flags a combination of answers, e.g. enquiries down while bookings up. */
  z.strictObject({
    kind: z.literal("combination"),
    code: Key,
    severity: Severity,
    when: z.array(z.strictObject({ question: Key, equals: Key })).min(2),
  }),
  /** Flags a dealer who gave the neutral answer to every listed question. */
  z.strictObject({
    kind: z.literal("all_neutral"),
    code: Key,
    severity: Severity,
    questions: z.array(Key).min(2),
  }),
  /** Week 2+: flags a trend answer that contradicts the change in the same dealer's number. */
  z.strictObject({
    kind: z.literal("trend_vs_number_change"),
    code: Key,
    severity: Severity,
    trend: Key,
    number: Key,
    tolerancePct: z.number().int().min(0).max(100),
  }),
  /** Week 2+: flags a number that changed by more than `factor` times versus the previous week. */
  z.strictObject({
    kind: z.literal("number_jump"),
    code: Key,
    severity: Severity,
    question: Key,
    factor: z.number().gt(1),
  }),
]);
export type QaRule = z.infer<typeof QaRule>;

export const Indicator = z.strictObject({
  key: Key,
  label: Text,
  description: Text,
  rule: ScoringRule,
  /** Which end is good news, so pages colour it correctly (discount pressure: high is bad). */
  goodWhen: z.enum(["high", "low"]),
});
export type Indicator = z.infer<typeof Indicator>;

export const Dimension = z.strictObject({
  key: Key,
  label: Text,
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("attribute"), attribute: Key }),
    z.strictObject({ kind: z.literal("geo"), field: z.enum(["state", "region", "city_tier"]) }),
  ]),
});
export type Dimension = z.infer<typeof Dimension>;

export const Cut = z.strictObject({
  key: Key,
  label: Text,
  /** Dimensions crossed by this cut. Empty = the national total. At most two (e.g. brand × state). */
  dims: z.array(Key).max(2),
  /** Weeks pooled per value: 1 = this week, 2 = this week plus last (each dealer's latest call). */
  poolWeeks: z.union([z.literal(1), z.literal(2)]),
  /** Below this many dealers, values are shown with a low-n warning. */
  lowNBelow: z.number().int().min(2).nullable(),
  /** Below this many dealers, values are not shown at all (privacy and reliability). */
  suppressBelow: z.number().int().min(2).nullable(),
});
export type Cut = z.infer<typeof Cut>;

export const SurveyDefinitionBase = z.strictObject({
  schemaVersion: z.literal(1),
  slug: Key,
  version: z.number().int().min(1),
  sector: Key,
  kind: z.enum(["pulse", "custom"]),
  cadence: z.literal("weekly"),
  title: Text,
  questions: z.array(Question).min(1),
  /** Wording for the platform-owned extractions. */
  operational: z.strictObject({
    outcome: z.strictObject({ extraction: Extraction }),
    callbackTime: z.strictObject({ extraction: Extraction }),
  }),
  indicators: z.array(Indicator).min(1),
  composite: z.strictObject({
    key: Key,
    label: Text,
    /** A dealer needs at least this many components to get a composite score. */
    minComponents: z.number().int().min(1),
    components: z
      .array(
        z.strictObject({
          indicator: Key,
          /** Integer percentages that sum to exactly 100 (no floating-point drift). */
          weightPct: z.number().int().positive(),
          /** Score as 100 − x inside the composite (e.g. more discounting = weaker demand). */
          invert: z.boolean(),
        }),
      )
      .min(1),
  }),
  dimensions: z.array(Dimension),
  cuts: z.array(Cut).min(1),
  qa: z.strictObject({
    minDurationSec: z.number().int().positive(),
    minConfidence: z.number().min(0).max(1),
    /** Index answers needed for a call to count (and for derived status "partial"). */
    minAnsweredForUsable: z.number().int().min(1),
    rules: z.array(QaRule),
  }),
});

export const SurveyDefinition = SurveyDefinitionBase.superRefine(checkInvariants);

export type SurveyDefinition = z.infer<typeof SurveyDefinition>;
export type SurveyDefinitionInput = z.input<typeof SurveyDefinition>;
