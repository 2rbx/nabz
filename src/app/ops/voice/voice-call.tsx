"use client";

import { useRef, useState, useTransition } from "react";
import { Button, CardHeader, filterPillClass, inputClass, Panel, Pill } from "@/components/ui";
import { type CallResult, dealerTurn, type SpendView, startCall, type TurnState } from "./actions";

type Turn = { role: "agent" | "dealer"; text: string };

/** A recording longer than this is cut off: Gnani's speech-to-text takes 30 seconds at most per request. */
const MAX_RECORDING_S = 15;

/** Decodes a recording and re-encodes it as 16 kHz mono 16-bit WAV, which Prisma reads. */
async function blobToWavBase64(blob: Blob): Promise<string> {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
  const length = Math.ceil(decoded.duration * 16000);
  const offline = new OfflineAudioContext(1, length, 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const samples = (await offline.startRendering()).getChannelData(0);

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));

  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const STATUS_LABEL: Record<string, string> = {
  answered: "Answered",
  dont_know: "Didn't know",
  declined: "Declined",
  not_asked: "Not asked",
  unclear: "Unclear",
};

export function VoiceCall({ initialSpend }: { initialSpend: SpendView }) {
  const [language, setLanguage] = useState<"hi" | "en">("hi");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [spend, setSpend] = useState<SpendView>(initialSpend);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [recording, setRecording] = useState(false);
  const [pending, startTransition] = useTransition();
  const beganAt = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = (state: TurnState) => {
    if (state.spend) setSpend(state.spend);
    if (!state.ok) return setError(state.message);
    setError(null);
    setTurns(state.turns);
    setEnded(state.ended);
    setResult(state.result);
    if (state.audio) void new Audio(`data:audio/mpeg;base64,${state.audio}`).play().catch(() => undefined);
  };

  const begin = () =>
    startTransition(async () => {
      beganAt.current = Date.now();
      setStarted(true);
      setEnded(false);
      setResult(null);
      setTurns([]);
      apply(await startCall(language));
    });

  const send = (payload: { text?: string; audioWavBase64?: string }) =>
    startTransition(async () => {
      const elapsedS = Math.round((Date.now() - beganAt.current) / 1000);
      apply(await dealerTurn({ language, turns, elapsedS, ...payload }));
    });

  const sendTyped = () => {
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    send({ text });
  };

  const toggleRecording = async () => {
    if (recording) return recorder.current?.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream);
      recorder.current = rec;
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        if (stopTimer.current) clearTimeout(stopTimer.current);
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        try {
          send({ audioWavBase64: await blobToWavBase64(new Blob(chunks)) });
        } catch {
          setError("Couldn't read that recording. Try again, or type the reply.");
        }
      };
      rec.start();
      setRecording(true);
      stopTimer.current = setTimeout(() => rec.stop(), MAX_RECORDING_S * 1000);
    } catch {
      setError("The microphone isn't available. Allow it in the browser, or type the reply.");
    }
  };

  const busy = pending || recording;

  return (
    <div className="grid gap-6">
      <Panel>
        <CardHeader
          title="Simulated dealer call"
          description="You play the dealer. The agent speaks with Gnani Timbre, hears you with Gnani Prisma, and Claude runs the conversation. Nothing is dialled."
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="accent">Claude ${spend.claudeUsd.toFixed(3)} / $9</Pill>
              <Pill tone="accent">Gnani {spend.gnaniCredits.toFixed(1)} / 4000 credits</Pill>
            </div>
          }
        />

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {(["hi", "en"] as const).map((l) => (
            <button
              key={l}
              type="button"
              disabled={started && !ended}
              className={`${filterPillClass(language === l)} disabled:opacity-40`}
              onClick={() => setLanguage(l)}
            >
              {l === "hi" ? "Hindi" : "English"}
            </button>
          ))}
          <Button onClick={begin} disabled={pending || (started && !ended)}>
            {started && !ended ? "Call in progress" : started ? "Start another call" : "Start call"}
          </Button>
        </div>

        {error && <p className="mt-4 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}

        {started && (
          <ol className="mt-6 grid gap-3" aria-label="Transcript">
            {turns.map((t, i) => (
              <li key={i} className={`flex ${t.role === "dealer" ? "justify-end" : ""}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                    t.role === "dealer" ? "bg-accent text-white" : "bg-line-soft text-ink"
                  }`}
                >
                  <div className="mb-0.5 text-xs opacity-70">{t.role === "dealer" ? "Dealer (you)" : "Nabz agent"}</div>
                  {t.text}
                </div>
              </li>
            ))}
            {pending && <li className="text-sm text-muted">…</li>}
          </ol>
        )}

        {started && !ended && (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button variant={recording ? "primary" : "secondary"} onClick={toggleRecording} disabled={pending && !recording}>
              {recording ? "Stop and send" : "Speak"}
            </Button>
            <input
              className={`${inputClass} min-w-0 flex-1`}
              placeholder="…or type the dealer's reply (no speech credits)"
              value={typed}
              disabled={busy}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendTyped()}
            />
            <Button variant="secondary" onClick={sendTyped} disabled={busy || !typed.trim()}>
              Send
            </Button>
          </div>
        )}
      </Panel>

      {result && (
        <Panel>
          <CardHeader
            title="What the call produced"
            description="Read by the same rules as every real call: only real answers count, and a gap says why."
            action={<Pill tone={result.derivedStatus === "completed" ? "good" : "warn"}>{result.derivedStatus}</Pill>}
          />
          <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            {result.answers.map((a) => (
              <div key={a.key} className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1.5">
                <dt className="text-muted">{a.label}</dt>
                <dd className="font-medium">
                  {a.value !== null ? String(a.value) : <span className="text-faint">{STATUS_LABEL[a.status] ?? a.status}</span>}
                </dd>
              </div>
            ))}
          </dl>
          {result.flags.length > 0 && <p className="mt-3 text-xs text-muted">QA: {result.flags.join(" · ")}</p>}
        </Panel>
      )}
    </div>
  );
}
