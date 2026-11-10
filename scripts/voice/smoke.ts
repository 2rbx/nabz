/**
 * One tiny real call to each service, to prove the keys work and to measure what they cost:
 * Timbre says a short Hindi phrase, Prisma transcribes that same audio, Haiku answers one short line.
 * A fraction of a credit and well under a cent, all counted by the budget guard.
 *
 *   pnpm voice:smoke
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { loadLocalEnv, runScript } from "../db/_env";
import { voiceFromEnv } from "../../src/lib/voice/runtime";

runScript(async () => {
  loadLocalEnv();
  const voice = voiceFromEnv();
  if (!voice) throw new Error("GNANI_API_KEY and CLAUDE_API_KEY must both be set in .env");
  const before = voice.budget.state();

  const phrase = "नमस्ते, इस हफ्ते enquiries कैसी रहीं?";
  const spoken = await voice.gnani.tts({ text: phrase, language: "hi-IN", container: "wav", sampleRate: 16000 });
  mkdirSync(".voice-cache", { recursive: true });
  writeFileSync(".voice-cache/smoke.wav", spoken.audio);
  console.log(`TTS ok: ${spoken.audio.length} bytes (${spoken.contentType})`);

  // 16 kHz mono 16-bit WAV: 32,000 bytes a second, less the 44-byte header.
  const durationS = Math.max(1, (spoken.audio.length - 44) / 32000);
  const heard = await voice.gnani.stt(spoken.audio, "smoke.wav", durationS, { languageCode: "hi-IN" });
  console.log(`STT ok (${durationS.toFixed(1)} s): "${heard.transcript}" [${heard.detectedLanguage ?? "?"}]`);

  const line = await voice.claude.reply("Reply with one short Hindi sentence, in Devanagari.", [
    { role: "user", content: "इस हफ्ते enquiries बढ़ीं।" },
  ]);
  console.log(`Claude ok: "${line}"`);

  const after = voice.budget.state();
  console.log(
    `\nSpent this run: ${(after.gnaniCredits - before.gnaniCredits).toFixed(3)} Gnani credits (estimate, padded 25%), ` +
      `$${(after.claudeUsd - before.claudeUsd).toFixed(5)} Claude.`,
  );
  console.log(`Totals: ${after.gnaniCredits.toFixed(2)} / 4000 credits, $${after.claudeUsd.toFixed(4)} / $9.`);
  console.log("Check the Gnani dashboard now: the real drop in credits is the true cost of this run.");
});
