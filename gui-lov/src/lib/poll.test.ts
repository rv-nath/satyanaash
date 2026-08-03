import { describe, it, expect } from "vitest";
import {
  POLL_INTERVAL_MS,
  attemptsNote,
  POLL_TIMEOUT_MS,
  humanDuration,
  maxAttempts,
  msToSeconds,
  pollSummary,
  pollTiming,
  secondsToMs,
} from "@/lib/poll";

describe("poll timing", () => {
  it("fills in the engine's defaults", () => {
    expect(pollTiming(undefined)).toEqual({
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    expect(pollTiming({ until: "x" }).intervalMs).toBe(POLL_INTERVAL_MS);
  });

  it("treats zero and nonsense as unset, not as a tight loop", () => {
    // The same reading the engine makes. A half-cleared field must not become a request
    // sent as fast as the network allows.
    expect(pollTiming({ intervalMs: 0, timeoutMs: 0 })).toEqual({
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    expect(pollTiming({ intervalMs: Number.NaN }).intervalMs).toBe(POLL_INTERVAL_MS);
    expect(pollTiming({ intervalMs: -5 }).intervalMs).toBe(POLL_INTERVAL_MS);
  });
});

describe("attempt count", () => {
  it("counts the first attempt, which costs no waiting", () => {
    // 2s apart over 2m: t=0, 2, 4 … 120 — sixty waits, sixty-one sends.
    expect(maxAttempts(2_000, 120_000)).toBe(61);
    // A budget of exactly one interval still buys a second attempt.
    expect(maxAttempts(3_000, 3_000)).toBe(2);
  });

  it("is one when the budget is shorter than the interval", () => {
    // The case POLL_BUDGET_BELOW_INTERVAL warns about: polling in name only.
    expect(maxAttempts(5_000, 3_000)).toBe(1);
    expect(maxAttempts(5_000, 0)).toBe(1);
  });
});

describe("the summary line", () => {
  it("says what the node will do, so nobody has to work it out", () => {
    expect(pollSummary(2_000, 120_000)).toBe(
      "Asks every 2s for up to 2m — at most 61 attempts.",
    );
  });

  it("names the problem when the budget is too short to wait even once", () => {
    const line = pollSummary(5_000, 3_000);
    expect(line).toContain("Asks once and gives up");
    // Both numbers, so the fix needs no arithmetic.
    expect(line).toContain("3s");
    expect(line).toContain("5s");
  });
});

describe("durations", () => {
  it("reads as a wait rather than a number of milliseconds", () => {
    expect(humanDuration(2_000)).toBe("2s");
    expect(humanDuration(500)).toBe("500ms");
    expect(humanDuration(90_000)).toBe("1m 30s");
    expect(humanDuration(120_000)).toBe("2m");
    expect(humanDuration(1_500)).toBe("1.5s");
  });
});

describe("the seconds the panel edits", () => {
  it("round-trips a stored value", () => {
    expect(secondsToMs(msToSeconds(2_000), POLL_INTERVAL_MS)).toBe(2_000);
    expect(secondsToMs(msToSeconds(1_500), POLL_INTERVAL_MS)).toBe(1_500);
  });

  it("falls back to the default rather than to no wait", () => {
    // An empty field means "I didn't say", not "send as fast as you can".
    expect(secondsToMs("", POLL_INTERVAL_MS)).toBe(POLL_INTERVAL_MS);
    expect(secondsToMs("abc", POLL_TIMEOUT_MS)).toBe(POLL_TIMEOUT_MS);
    expect(secondsToMs("0", POLL_INTERVAL_MS)).toBe(POLL_INTERVAL_MS);
    expect(secondsToMs("-3", POLL_INTERVAL_MS)).toBe(POLL_INTERVAL_MS);
  });
});

describe("what the report says about a poll", () => {
  it("names the attempts a single duration cannot account for", () => {
    expect(attemptsNote(3, 4_200)).toBe("3 attempts · 4.2s");
    expect(attemptsNote(1, 240)).toBe("1 attempt · 240ms");
  });

  it("says nothing for a node that did not poll", () => {
    // Not "1 attempt" on every result in the report — a column confirming the normal.
    expect(attemptsNote(undefined, 240)).toBeUndefined();
  });
});
