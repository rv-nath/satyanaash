import { describe, it, expect, vi, afterEach } from "vitest";
import { apiClient, ApiClientError } from "@/lib/api/client";

const failWith = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText: "Bad Request",
      json: async () => body,
    }),
  );

describe("apiClient errors", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports what the server actually said", async () => {
    // The server names this field `error`. Reading `message` instead turned every
    // explanation it sent into "Unknown error" — the whole point of sending one.
    failWith(409, {
      error: "Version conflict: expected 1, got 2",
      code: "VERSION_CONFLICT",
      details: { expected_version: 1, actual_version: 2 },
    });

    const thrown = (await apiClient.get("/flows/f1").catch((e) => e)) as ApiClientError;
    expect(thrown).toBeInstanceOf(ApiClientError);
    expect(thrown.message).toBe("Version conflict: expected 1, got 2");
    expect(thrown.code).toBe("VERSION_CONFLICT");
    expect(thrown.status).toBe(409);
    // Details survive, so a caller can act on the numbers rather than parse prose.
    expect(thrown.details).toEqual({ expected_version: 1, actual_version: 2 });
  });

  it("still reads a body that uses `message`, which our API never sends", async () => {
    // A proxy in front of the API might; there is no reason to lose that either.
    failWith(502, { message: "upstream unavailable", code: "BAD_GATEWAY" });
    const thrown = (await apiClient.get("/flows/f1").catch((e) => e)) as ApiClientError;
    expect(thrown.message).toBe("upstream unavailable");
  });

  it("falls back to the status text when the body isn't JSON at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => {
          throw new Error("not json");
        },
      }),
    );
    const thrown = (await apiClient.get("/flows/f1").catch((e) => e)) as ApiClientError;
    expect(thrown.message).toBe("Bad Request");
    expect(thrown.code).toBe("UNKNOWN_ERROR");
  });
});
