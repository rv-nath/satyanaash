/**
 * A node that may have to ask more than once.
 *
 * Multi-stage uploads answer 202 with `{"status":"pending",…}` and the real outcome only
 * exists after asking again. The engine reads `node.data.config.poll`, and **an absent
 * `until` means no polling** — which is every node that existed before this.
 *
 * The arithmetic lives here rather than in the panel so the attempt count can be tested.
 * The author states an interval and a budget, which is what they know; the count is the
 * thing they would otherwise have to work out, and it silently changes meaning whenever
 * the interval does.
 */

/** Mirrors `POLL_INTERVAL_MS` / `POLL_TIMEOUT_MS` in `api/src/execution/engine.rs`. */
export const POLL_INTERVAL_MS = 2_000;
export const POLL_TIMEOUT_MS = 120_000;

export interface PollConfig {
  until: string;
  intervalMs?: number;
  timeoutMs?: number;
}

/** The interval and budget in force, with the engine's defaults filled in. */
export function pollTiming(poll: Partial<PollConfig> | undefined): {
  intervalMs: number;
  timeoutMs: number;
} {
  // Zero or nonsense means "unset", the same reading the engine's `ms` helper makes — so
  // a half-cleared field cannot turn into a tight loop.
  const ms = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    intervalMs: ms(poll?.intervalMs, POLL_INTERVAL_MS),
    timeoutMs: ms(poll?.timeoutMs, POLL_TIMEOUT_MS),
  };
}

/**
 * How many times the request can be sent before the budget runs out.
 *
 * The first attempt costs no waiting, so a budget of exactly one interval buys two
 * attempts. **A budget shorter than the interval buys exactly one** — polling in name
 * only, which is what the panel warns about and what `POLL_BUDGET_BELOW_INTERVAL` catches
 * server-side.
 */
export function maxAttempts(intervalMs: number, timeoutMs: number): number {
  if (intervalMs <= 0) return 1;
  return Math.floor(Math.max(timeoutMs, 0) / intervalMs) + 1;
}

/**
 * "2s", "1m 30s", "2m" — an interval and a budget read as durations, not milliseconds.
 *
 * Deliberately not `formatDuration` from `runHistory`: that one formats a *measured*
 * duration, where consistent precision matters ("2.0s", "2m 00s"). This one formats a
 * number the author typed, where the trailing zeros read as noise.
 */
export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${trim(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${trim(rest)}s`;
}

function trim(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** The one line under the fields: what this node will actually do. */
export function pollSummary(intervalMs: number, timeoutMs: number): string {
  const attempts = maxAttempts(intervalMs, timeoutMs);
  if (attempts <= 1) {
    return `Asks once and gives up — the budget (${humanDuration(
      timeoutMs,
    )}) is shorter than the interval (${humanDuration(intervalMs)}).`;
  }
  return `Asks every ${humanDuration(intervalMs)} for up to ${humanDuration(
    timeoutMs,
  )} — at most ${attempts} attempts.`;
}

/**
 * Seconds typed in the panel, back to the milliseconds the engine reads.
 *
 * The panel is in seconds because that is how the author thinks about a wait, but the
 * wire stays in milliseconds so nothing has to guess at a unit. Blank or unreadable falls
 * back to the default rather than to zero: an empty field means "I didn't say", not "no
 * wait at all".
 */
export function secondsToMs(text: string, fallback: number): number {
  const seconds = Number.parseFloat(text);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return Math.round(seconds * 1000);
}

/** Milliseconds from a stored config, as the seconds the panel shows. */
export function msToSeconds(ms: number): string {
  return String(Math.round((ms / 1000) * 100) / 100);
}

/**
 * "3 attempts · 4.2s" — what a single duration cannot say.
 *
 * Only for a node that polled. Elsewhere the duration stands alone, because "1 attempt"
 * on every result in the report would be a column of noise confirming the normal.
 */
export function attemptsNote(attempts: number | undefined, durationMs: number): string | undefined {
  if (attempts === undefined) return undefined;
  return `${attempts} attempt${attempts === 1 ? "" : "s"} · ${humanDuration(durationMs)}`;
}
