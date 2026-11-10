import { LEVEL_VALUES, TREND_VALUES } from "../domain/constants";
import type { Question, SurveyDefinition } from "./schema";

/** Option values for a trend, level or choice question; null for number and text questions. */
export function optionValues(q: Question): readonly string[] | null {
  switch (q.type) {
    case "trend":
      return TREND_VALUES;
    case "level":
      return LEVEL_VALUES;
    case "choice":
      return q.options.map((o) => o.value);
    default:
      return null;
  }
}

/** The neutral ("no change" / "normal") answer of a question, if it has one. */
export function neutralValue(q: Question): string | null {
  switch (q.type) {
    case "trend":
      return "same";
    case "level":
      return "normal";
    case "choice":
      return q.neutral ?? null;
    default:
      return null;
  }
}

/** Questions whose answers feed an indicator. A call is "completed" when all of them are answered. */
export function indexQuestionKeys(def: Pick<SurveyDefinition, "indicators">): string[] {
  return [...new Set(def.indicators.map((i) => i.rule.question))];
}

/** The extraction name for a question (defaults to its key). */
export function extractionName(q: Question): string {
  return q.extraction.name ?? q.key;
}
