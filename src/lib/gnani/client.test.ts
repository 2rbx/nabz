import { describe, expect, it, vi } from "vitest";
import { BudgetExceeded, createBudget, EMPTY_BUDGET, memoryStore } from "../voice/budget";
import { createGnaniClient, GnaniError } from "./client";

const noSleep = async () => {};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Gnani client", () => {
  it("transcribes with the key header and charges the credit budget", async () => {
    const store = memoryStore();
    const fetchMock = vi.fn(async () =>
      json({ success: true, request_id: "r1", transcript: "  ek hafta ka stock  ", model: "prisma-v3.0", detected_language_code: "hi-IN" }),
    );
    const client = createGnaniClient({ apiKey: "k", budget: createBudget(store), fetch: fetchMock as never, sleep: noSleep });

    const result = await client.stt(new Uint8Array([1, 2, 3]), "a.wav", 12, { languageCode: "hi-IN" });

    expect(result).toMatchObject({ transcript: "ek hafta ka stock", detectedLanguage: "hi-IN", requestId: "r1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.vachana.ai/stt/v3");
    expect((init.headers as Record<string, string>)["X-API-Key-ID"]).toBe("k");
    expect(store.current.sttSeconds).toBe(12);
    expect(store.current.gnaniCredits).toBeGreaterThan(0);
  });

  it("speaks text and charges per character", async () => {
    const store = memoryStore();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([9, 9]), { headers: { "content-type": "audio/mpeg" } }));
    const client = createGnaniClient({ apiKey: "k", budget: createBudget(store), fetch: fetchMock as never, sleep: noSleep });

    const result = await client.tts({ text: "नमस्ते", language: "hi-IN" });

    expect([...result.audio]).toEqual([9, 9]);
    expect(result.contentType).toBe("audio/mpeg");
    expect(store.current.ttsChars).toBe(6);
    const body = JSON.parse(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string));
    expect(body).toMatchObject({ model: "timbre-v2.5", voice: "Nalini", language: "hi-IN" });
  });

  it("refuses without sending when the credit cap would be passed", async () => {
    const store = memoryStore({ ...EMPTY_BUDGET, gnaniCredits: 3999.9 });
    const fetchMock = vi.fn();
    const client = createGnaniClient({ apiKey: "k", budget: createBudget(store), fetch: fetchMock as never, sleep: noSleep });

    await expect(client.tts({ text: "x".repeat(500) })).rejects.toBeInstanceOf(BudgetExceeded);
    await expect(client.stt(new Uint8Array(), "a.wav", 60, { languageCode: "hi-IN" })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a 429, then gives up on other errors without charging", async () => {
    const store = memoryStore();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ detail: { error_code: "RATE_LIMITED" } }, 429))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])))
      .mockResolvedValueOnce(json({ success: false, message: "bad voice" }, 400));
    const client = createGnaniClient({ apiKey: "k", budget: createBudget(store), fetch: fetchMock as never, sleep: noSleep });

    await client.tts({ text: "ek" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const before = store.current.ttsChars;
    await expect(client.tts({ text: "do" })).rejects.toBeInstanceOf(GnaniError);
    expect(store.current.ttsChars).toBe(before);
  });

  it("runs one request at a time", async () => {
    let active = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Response(new Uint8Array([1]));
    });
    const client = createGnaniClient({ apiKey: "k", budget: createBudget(memoryStore()), fetch: fetchMock as never, sleep: noSleep });
    await Promise.all([client.tts({ text: "a" }), client.tts({ text: "b" }), client.tts({ text: "c" })]);
    expect(peak).toBe(1);
  });
});
