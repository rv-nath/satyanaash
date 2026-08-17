import { describe, it, expect, vi, afterEach } from "vitest";
import { testCasesApi, flowsApi, projectsApi } from "@/lib/api/endpoints";

/**
 * Lists that run past the first page.
 *
 * The three list calls asked for no page, took `data` and discarded `pagination`, so they
 * returned the server's default first 20 and nothing else. A project that crossed 20 test cases
 * lost the rest everywhere at once — double-clicking a node said "That test case no longer
 * exists", nodes fell back to the stale label stored on them, the config panel opened with no
 * data rows — while the flow ran perfectly, because the engine reads the database, not this list.
 *
 * Nothing in the app noticed until a real project got big enough, which is why these are here.
 */
const page = (items: unknown[], pageNo: number, totalPages: number, total: number) => ({
  ok: true,
  status: 200,
  json: async () => ({
    data: items,
    pagination: { page: pageNo, per_page: 100, total, total_pages: totalPages },
  }),
});

/**
 * A server holding `count` records — and, crucially, **defaulting to 20 per page when the caller
 * does not ask**, exactly as `Pagination::default()` does in the API.
 *
 * That default is the whole bug. A mock that paginates at whatever the client requests cannot
 * reproduce it: the first version of this file did that, and its "all 27 come back" test passed
 * against the broken code.
 */
const serverWith = (count: number) => {
  const all = Array.from({ length: count }, (_, i) => ({ id: `t${i}`, name: `case ${i}` }));
  const fetchMock = vi.fn(async (url: string) => {
    const q = new URL(url, "http://x").searchParams;
    const size = Number(q.get("per_page") ?? 20);        // the server's default, not the client's wish
    const p = Number(q.get("page") ?? 1);
    const totalPages = Math.max(1, Math.ceil(count / size));
    return page(all.slice((p - 1) * size, p * size), p, totalPages, count);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("listing everything, not just the first page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns all 27 test cases, the size that first broke this", async () => {
    serverWith(27);
    expect(await testCasesApi.list("p1")).toHaveLength(27);
  });

  it("asks for one page when one page is all there is", async () => {
    const fetchMock = serverWith(27);
    await testCasesApi.list("p1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows the page count the server reports", async () => {
    const fetchMock = serverWith(250);
    expect(await testCasesApi.list("p1")).toHaveLength(250);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("copes with an empty project", async () => {
    serverWith(0);
    expect(await testCasesApi.list("p1")).toEqual([]);
  });

  it("does the same for flows and projects, which had the identical bug", async () => {
    serverWith(150);
    expect(await flowsApi.list("p1")).toHaveLength(150);
    serverWith(150);
    expect(await projectsApi.list()).toHaveLength(150);
  });

  it("keeps the query string intact when the path already has one", async () => {
    // `?` vs `&` — getting this wrong silently returns page 1 forever.
    const fetchMock = serverWith(27);
    await testCasesApi.list("p1");
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/\?page=1&per_page=100$/);
  });
});
