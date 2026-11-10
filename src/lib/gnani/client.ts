import type { Budget } from "../voice/budget";

/**
 * The only code that talks to Gnani (ESLint enforces it). Prisma (speech to text) and Timbre (text to
 * speech) over their REST endpoints. Every request first asks the budget guard, so the credit cap can't
 * be passed, and is charged to it once the answer arrives.
 *
 * Gnani allows one active request per account at a time (its 429 says so), so requests here are queued.
 * Kept free of `server-only` and env reads: callers pass the key in.
 */

const BASE_URL = "https://api.vachana.ai";

export class GnaniError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GnaniError";
  }
}

export type SttOptions = {
  /** hi-IN, en-IN, … or indic-auto (Prisma v3.0 only). */
  languageCode: string;
  model?: "prisma-v2.5" | "prisma-v3.0";
  /** v3.0: "codemix" keeps Hinglish readable. */
  format?: "verbatim" | "transcribe" | "codemix" | "transliterate";
};

export type SttResult = {
  transcript: string;
  detectedLanguage: string | null;
  model: string;
  requestId: string | null;
};

export type TtsOptions = {
  text: string;
  voice?: string;
  model?: "timbre-v2.5" | "timbre-v3.0";
  /** hi-IN, en-IN, hi-en (Hinglish), … */
  language?: string;
  speed?: number;
  /** wav (default), mp3 or ogg. Smaller files mean a faster page. */
  container?: "wav" | "mp3" | "ogg";
  sampleRate?: number;
};

export type TtsResult = { audio: Uint8Array; contentType: string };

export type GnaniClientOptions = {
  apiKey: string;
  budget: Budget;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const RETRY_DELAYS_MS = [700, 1500, 3000];

export function createGnaniClient(options: GnaniClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let queue: Promise<unknown> = Promise.resolve();

  /** One request at a time. A 429 ("only 1 active request") is retried; nothing else is. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  }

  async function send(path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { ...init.headers, "X-API-Key-ID": options.apiKey },
      });
      if (response.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          // Not JSON: keep the text.
        }
        throw new GnaniError(response.status, `Gnani ${path} → ${response.status}: ${text.slice(0, 300)}`, body);
      }
      return response;
    }
  }

  return {
    /**
     * Transcribes one recording (30 seconds at most per request). `durationS` is the recording's length,
     * used to check and then charge the budget: pass the real duration.
     */
    stt(audio: Uint8Array, filename: string, durationS: number, opts: SttOptions): Promise<SttResult> {
      return enqueue(async () => {
        options.budget.ensureStt(durationS);
        const form = new FormData();
        form.append("audio_file", new Blob([audio as BlobPart]), filename);
        form.append("language_code", opts.languageCode);
        form.append("model", opts.model ?? "prisma-v3.0");
        if (opts.format) form.append("format", opts.format);
        const response = await send("/stt/v3", { method: "POST", body: form });
        const json = (await response.json()) as {
          success?: boolean;
          transcript?: string;
          detected_language_code?: string;
          model?: string;
          request_id?: string;
        };
        options.budget.chargeStt(durationS);
        if (json.success === false) throw new GnaniError(200, "Gnani STT reported failure", json);
        return {
          transcript: (json.transcript ?? "").trim(),
          detectedLanguage: json.detected_language_code ?? null,
          model: json.model ?? opts.model ?? "prisma-v3.0",
          requestId: json.request_id ?? null,
        };
      });
    },

    /** Speaks `text`. Charged per character. */
    tts(opts: TtsOptions): Promise<TtsResult> {
      return enqueue(async () => {
        const chars = [...opts.text].length;
        options.budget.ensureTts(chars);
        const container = opts.container ?? "mp3";
        const response = await send("/api/v1/tts/inference", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: opts.text,
            voice: opts.voice ?? "Nalini",
            model: opts.model ?? "timbre-v2.5",
            language: opts.language ?? "hi-IN",
            speed: opts.speed ?? 1.0,
            audio_config: {
              sample_rate: opts.sampleRate ?? 24000,
              num_channels: 1,
              sample_width: 2,
              encoding: "linear_pcm",
              container,
            },
          }),
        });
        const audio = new Uint8Array(await response.arrayBuffer());
        options.budget.chargeTts(chars);
        return { audio, contentType: response.headers.get("content-type") ?? `audio/${container}` };
      });
    },
  };
}

export type GnaniClient = ReturnType<typeof createGnaniClient>;
