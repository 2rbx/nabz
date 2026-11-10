import { describe, expect, it } from "vitest";
import { addNoise, dealerFacts, dealerPersonaPrompt, rng } from "./persona";

describe("dealer facts", () => {
  it("are the same for the same dealer and week, and differ between weeks", () => {
    expect(dealerFacts("d1", "2026-11-09", 0.5)).toEqual(dealerFacts("d1", "2026-11-09", 0.5));
    const weeks = new Set(["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"].map((w) => JSON.stringify(dealerFacts("d1", w, 0.5))));
    expect(weeks.size).toBeGreaterThan(1);
  });

  it("lean with the market: strong cells have more 'up' and thinner stock than weak ones", () => {
    const sample = (tilt: number) =>
      Array.from({ length: 300 }, (_, i) => dealerFacts(`dealer-${i}`, "2026-11-09", tilt, 0));
    const share = (rows: ReturnType<typeof sample>, v: string) => rows.filter((r) => r.enquiries_trend === v).length / rows.length;
    const strong = sample(0.9);
    const weak = sample(-0.9);
    expect(share(strong, "up")).toBeGreaterThan(share(weak, "up") + 0.3);
    const mean = (rows: typeof strong) => rows.reduce((n, r) => n + (r.stock_days ?? 0), 0) / rows.length;
    expect(mean(strong)).toBeLessThan(mean(weak));
  });

  it("keeps values in range and leaves some answers unknown", () => {
    const rows = Array.from({ length: 400 }, (_, i) => dealerFacts(`x${i}`, "2026-11-09", 0, 0.25));
    for (const r of rows) {
      if (r.stock_days !== null) expect(r.stock_days).toBeGreaterThanOrEqual(6);
      if (r.bookings_week !== null) expect(r.bookings_week).toBeGreaterThanOrEqual(3);
    }
    const unknown = rows.filter((r) => r.stock_days === null).length / rows.length;
    expect(unknown).toBeGreaterThan(0.15);
    expect(unknown).toBeLessThan(0.35);
  });
});

describe("persona prompt", () => {
  it("states the facts, and tells the dealer when to say they don't know", () => {
    const prompt = dealerPersonaPrompt(
      { enquiries_trend: "up", bookings_trend: null, bookings_week: 25, stock_days: 45, discount_trend: "down", loan_rejections: "low" },
      { businessName: "Demo Motors", city: "Lucknow" },
    );
    expect(prompt).toContain("about 45 days");
    expect(prompt).toContain("about 25");
    expect(prompt).toMatch(/Bookings compared with last week: you do NOT know this/);
  });
});

describe("addNoise", () => {
  const wav = (samples: number[]) => {
    const out = new Uint8Array(44 + samples.length * 2);
    const v = new DataView(out.buffer);
    [..."RIFF"].forEach((c, i) => (out[i] = c.charCodeAt(0)));
    [..."WAVEfmt "].forEach((c, i) => (out[8 + i] = c.charCodeAt(0)));
    v.setUint32(16, 16, true);
    [..."data"].forEach((c, i) => (out[36 + i] = c.charCodeAt(0)));
    v.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
    return out;
  };

  it("changes the samples, never the header, and returns a copy", () => {
    const input = wav(Array(200).fill(1000));
    const noisy = addNoise(input, 0.05, rng("n"));
    expect([...noisy.slice(0, 44)]).toEqual([...input.slice(0, 44)]);
    expect([...noisy.slice(44)]).not.toEqual([...input.slice(44)]);
    expect(input[44]).toBe(1000 & 0xff);
  });

  it("adds nothing at level zero", () => {
    const input = wav([5, -5, 100]);
    expect([...addNoise(input, 0, rng("z"))]).toEqual([...input]);
  });
});
