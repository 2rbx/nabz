import { weekLabel } from "./domain/week";

/**
 * Display formatting shared by ops and client pages. Pure, and independent of the machine's timezone.
 */

/**
 * Rupees per US dollar used to show a call's charges (billed in US cents) in rupees. Approximate and
 * fixed on purpose: costs stay comparable across weeks. The exact amount in dollars is always shown too.
 */
export const USD_INR_RATE = 92;

/**
 * What one survey call usually costs on the voice stack, for estimates before a run: about 2 minutes at ~6¢ a
 * minute, billed in 30-second pulses. Actual costs are recorded per call.
 */
export const ESTIMATED_CALL_CENTS = 12;

/** Seconds as "m:ss" (or "h:mm:ss"); "—" when unknown. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A call's cost (US cents) as rupees for display, with the exact dollar amount alongside. */
export function formatCost(cents: number | null | undefined): { inr: string; usd: string } {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return { inr: "—", usd: "—" };
  const usd = cents / 100;
  const inr = usd * USD_INR_RATE;
  return {
    inr: `₹${inr.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    usd: `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`,
  };
}

const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "2 Nov 2026, 11:42" in India Standard Time, whatever the server's timezone. */
export function formatIstDateTime(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "—";
  const parts = Object.fromEntries(IST_DATE_TIME.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

const IST_DAY = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
});

/** "26 Oct" in India Standard Time. */
export function formatIstDay(date: Date | null | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return "—";
  return IST_DAY.format(date);
}

/** An index value (0–100) to one decimal, "—" when there's none. */
export function formatIndex(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(1);
}

/** A signed change to one decimal with a true minus sign: "+4.2", "−1.9", "0.0". */
export function formatChange(delta: number): string {
  const r = Math.round(delta * 10) / 10;
  if (r === 0) return "0.0";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}`;
}

/** "2026-10-26" → "Week 44, 2026" (ISO week, the year that holds its Thursday). */
export function formatWeekTitle(weekStart: string): string {
  const [year, week] = weekLabel(weekStart).split("-W");
  return `Week ${Number(week)}, ${year}`;
}

/** "2026-10-26" → "W44", for chart axes. */
export function formatWeekShort(weekStart: string): string {
  return `W${weekLabel(weekStart).slice(-2)}`;
}

const SHORT_DATE = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });

/** A survey week's Monday to Sunday: "26 Oct – 1 Nov". */
export function formatWeekRange(weekStart: string): string {
  const monday = new Date(`${weekStart}T00:00:00Z`);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return `${SHORT_DATE.format(monday)} – ${SHORT_DATE.format(sunday)}`;
}
