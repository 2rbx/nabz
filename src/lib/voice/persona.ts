/**
 * Synthetic dealers for the demo. Each one has a known "ground truth" for the six survey questions, so a
 * role-played call can be checked against what the dealer was told to say. Pure and deterministic: the
 * same dealer and week always get the same truth.
 *
 * Everything here is made up. No real dealer, number or recording is involved.
 */

export type Truth = {
  enquiries_trend: "up" | "same" | "down";
  bookings_trend: "up" | "same" | "down";
  bookings_week: number;
  stock_days: number;
  discount_trend: "up" | "same" | "down";
  loan_rejections: "high" | "normal" | "low";
};

/** null = this dealer genuinely doesn't know (the call should record "didn't know", not a guess). */
export type DealerFacts = { [K in keyof Truth]: Truth[K] | null };

/** A small seeded random generator (mulberry32). */
export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353) << 13 | h >>> 19;
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function pickTrend(r: number, pUp: number, pDown: number): "up" | "same" | "down" {
  const up = clamp(pUp, 0.05, 0.9);
  const down = clamp(pDown, 0.05, 0.9);
  return r < up ? "up" : r < up + down ? "down" : "same";
}

/**
 * What one dealer will say in one week. `tilt` runs from -1 (a weak market for this brand and state) to
 * +1 (a strong one): strong demand means more enquiries and bookings, thinner stock, fewer discounts,
 * fewer loan rejections.
 */
export function dealerFacts(dealerKey: string, week: string, tilt: number, unknownRate = 0.08): DealerFacts {
  const r = rng(`${dealerKey}|${week}`);
  const truth: Truth = {
    enquiries_trend: pickTrend(r(), 0.33 + 0.35 * tilt, 0.33 - 0.35 * tilt),
    bookings_trend: pickTrend(r(), 0.33 + 0.35 * tilt, 0.33 - 0.35 * tilt),
    bookings_week: Math.max(3, Math.round(18 + 14 * r() + 10 * tilt)),
    stock_days: Math.round(clamp(32 - 12 * tilt + (r() - 0.5) * 18, 6, 90)),
    discount_trend: pickTrend(r(), 0.33 - 0.25 * tilt, 0.33 + 0.25 * tilt),
    loan_rejections: (() => {
      const x = r();
      const high = clamp(0.25 - 0.2 * tilt, 0.05, 0.6);
      const low = clamp(0.25 + 0.2 * tilt, 0.05, 0.6);
      return x < high ? "high" : x < high + low ? "low" : "normal";
    })(),
  };
  const facts: DealerFacts = { ...truth };
  for (const key of Object.keys(truth) as (keyof Truth)[]) {
    if (r() < unknownRate) (facts as Record<string, unknown>)[key] = null;
  }
  return facts;
}

const TREND_WORDS = { up: "went up (badhi)", same: "stayed about the same (utni hi)", down: "went down (kam hui)" };
const DISCOUNT_WORDS = { up: "going up (badh rahe hain)", same: "about the same (utne hi)", down: "coming down (kam ho rahe hain)" };
const LOAN_WORDS = {
  high: "more than last month (zyada reject ho rahe hain)",
  normal: "about the same as last month (utne hi)",
  low: "fewer than last month (kam reject ho rahe hain)",
};

/** The system prompt for the role-played dealer. */
export function dealerPersonaPrompt(f: DealerFacts, d: { businessName: string; city: string }): string {
  const know = (v: unknown, text: string) => (v === null ? "you do NOT know this, say so (for example 'pata nahi')" : text);
  return `You are the owner of ${d.businessName}, a two-wheeler or car showroom in ${d.city}, India, answering a short phone survey from an automated assistant. Speak Hinglish (Hindi in Latin letters), like a busy shopkeeper: one short sentence, at most 12 words, no punctuation fuss.

Answer ONLY the question just asked, using these facts about your showroom this week. Never invent anything else.
- Enquiries compared with last week: ${know(f.enquiries_trend, `they ${f.enquiries_trend ? TREND_WORDS[f.enquiries_trend] : ""}`)}.
- Bookings compared with last week: ${know(f.bookings_trend, `they ${f.bookings_trend ? TREND_WORDS[f.bookings_trend] : ""}`)}.
- Bookings this week, roughly: ${know(f.bookings_week, `about ${f.bookings_week}`)}.
- How many days your stock will last at today's selling pace: ${know(f.stock_days, `about ${f.stock_days} days`)}.
- Discounts and offers compared with last week: ${know(f.discount_trend, `they are ${f.discount_trend ? DISCOUNT_WORDS[f.discount_trend] : ""}`)}.
- Customers' loan rejections compared with last month: ${know(f.loan_rejections, `${f.loan_rejections ? LOAN_WORDS[f.loan_rejections] : ""}`)}.

If the assistant asks to confirm who you are or if you have two minutes, say yes. If it says goodbye, reply "theek hai, dhanyavaad". If a bookings question also asks for a number, you may give both. Do not ask questions back.`;
}

/**
 * Adds hiss to a 16-bit PCM WAV, like a bad phone line. `level` is the noise peak as a fraction of full
 * scale (0.03 is audible but speech survives). Returns a new array; the header is left alone.
 */
export function addNoise(wav: Uint8Array, level: number, random: () => number): Uint8Array {
  const out = new Uint8Array(wav);
  let dataAt = -1;
  for (let i = 12; i + 8 <= out.length; ) {
    const id = String.fromCharCode(out[i]!, out[i + 1]!, out[i + 2]!, out[i + 3]!);
    const size = new DataView(out.buffer, out.byteOffset + i + 4, 4).getUint32(0, true);
    if (id === "data") {
      dataAt = i + 8;
      break;
    }
    i += 8 + size + (size % 2);
  }
  if (dataAt < 0) return out;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let p = dataAt; p + 2 <= out.length; p += 2) {
    const noisy = view.getInt16(p, true) + (random() * 2 - 1) * level * 32767;
    view.setInt16(p, clamp(Math.round(noisy), -32768, 32767), true);
  }
  return out;
}
