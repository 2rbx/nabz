import { z } from "zod";
import { CALLING_LIMITS, CALLING_MODES, type CallingScope } from "./calling-policy";
import { normalisePhone } from "./domain/phone";

/**
 * The only module that reads process.env (enforced by ESLint). Everything is validated up front,
 * and every safety-relevant setting defaults to the safe value.
 */

const bool = z
  .enum(["true", "false"], { message: 'must be exactly "true" or "false"' })
  .default("false")
  .transform((v) => v === "true");

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), { message: "must be a postgres:// connection string" });

/** Comma-separated phone numbers, as E.164. One bad entry stops startup rather than being ignored. */
const phoneList = z
  .string()
  .default("")
  .transform((value, ctx) => {
    const numbers: string[] = [];
    for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
      const phone = normalisePhone(entry);
      if (phone) numbers.push(phone.e164);
      else ctx.addIssue({ code: "custom", message: "contains something that isn't a valid Indian phone number" });
    }
    return numbers;
  });

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    DATABASE_URL: postgresUrl,

    /** testing: only ALLOWED_NUMBERS can be added or called. production: any valid number. */
    NABZ_MODE: z.enum(CALLING_MODES).default("testing"),
    ALLOWED_NUMBERS: phoneList,

    /** Kill switch for every outbound call. Off unless explicitly "true". */
    CALLING_ENABLED: bool,
    BOLNA_DAILY_SPEND_CAP_USD: z.coerce.number().positive().max(CALLING_LIMITS.maxDailySpendUsd).default(10),

    BOLNA_API_KEY: z.string().min(1).optional(),

    /** The Gnani voice agent (Prisma speech to text, Timbre text to speech) and the Claude brain behind it. */
    GNANI_API_KEY: z.string().min(1).optional(),
    CLAUDE_API_KEY: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.CALLING_ENABLED && !env.BOLNA_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["BOLNA_API_KEY"],
        message: "required when CALLING_ENABLED=true",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Just the voice agent's keys, so it runs without a database. */
export const VoiceEnvSchema = z.object({
  GNANI_API_KEY: z.string().min(1).optional(),
  CLAUDE_API_KEY: z.string().min(1).optional(),
});

export function voiceEnv(source: Record<string, string | undefined> = process.env) {
  return VoiceEnvSchema.parse(Object.fromEntries(Object.entries(source).filter(([, v]) => v)));
}

/** Parses an environment object. Exported for tests; the app uses env(). */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Treat empty strings as unset, so "FOO=" in a .env file falls back to the safe default.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** The validated configuration. Parsed lazily so that importing this module never throws. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Who can be called, from NABZ_MODE and ALLOWED_NUMBERS. */
export function callingScope(): CallingScope {
  const config = env();
  return { mode: config.NABZ_MODE, allowedNumbers: config.ALLOWED_NUMBERS };
}
