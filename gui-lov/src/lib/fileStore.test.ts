import { describe, it, expect } from "vitest";
import {
  blankDraft,
  defaultReference,
  draftFromStore,
  endpointHint,
  extensionIsKnown,
  extensionWarning,
  formatSize,
  isReadOnly,
  matchesQuery,
  missingFields,
  referenceLabel,
  sortFiles,
  storeLabel,
  toPayload,
  type StoreDef,
  type StoredFile,
} from "@/lib/fileStore";

const store = (over: Partial<StoreDef> = {}): StoreDef => ({
  id: "s1",
  project_id: "p1",
  name: "minio (dev)",
  kind: "s3",
  endpoint: "http://127.0.0.1:9000",
  bucket: "sat-fixtures",
  prefix: "fixtures/",
  access_key: "MV5SimprxKP2XBpFVA2l",
  reference: "key",
  region: "us-east-1",
  has_secret: true,
  has_token: false,
  source: "project",
  created_at: "2026-08-04T10:00:00Z",
  updated_at: "2026-08-04T10:00:00Z",
  ...over,
});

const file = (over: Partial<StoredFile> = {}): StoredFile => ({
  name: "nums100.csv",
  key: "fixtures/nums100.csv",
  reference: "sat-fixtures/fixtures/nums100.csv",
  size: 4198,
  ...over,
});

describe("the reference form", () => {
  it("defaults to what each kind of storage can actually deliver", () => {
    // A URL pointing at an in-cluster minio is an RFC1918 address, which is exactly what this
    // platform's SSRF guard rejects — so defaulting S3 to a URL would default it to broken.
    expect(defaultReference("s3")).toBe("key");
    expect(defaultReference("http")).toBe("url");
    expect(blankDraft("s3").reference).toBe("key");
    expect(blankDraft("http").reference).toBe("url");
  });

  it("is not called a URL when it is not one, and does not borrow a product's vocabulary", () => {
    // A key is genuinely not a URL, so calling it one would be a small lie an author reads every
    // time. But "bucket" and "key" are one storage product's words, and they belong on the page
    // that explains them rather than in a toast.
    expect(referenceLabel("key")).toBe("location");
    expect(referenceLabel("url")).toBe("URL");
    expect(referenceLabel(undefined)).toBe("link");
  });
});

describe("editing an existing storage", () => {
  it("leaves the secrets undefined, meaning “keep what is stored”", () => {
    // The failure this prevents: the server never sends the secret, so the form cannot echo it.
    // Sending an empty string would clear a working credential on every rename.
    const draft = draftFromStore(store());
    expect(draft.secret_key).toBeUndefined();
    expect(draft.token).toBeUndefined();
    // Everything else round-trips.
    expect(draft.name).toBe("minio (dev)");
    expect(draft.bucket).toBe("sat-fixtures");
    expect(draft.access_key).toBe("MV5SimprxKP2XBpFVA2l");
  });

  it("does not demand a secret that is already stored", () => {
    // Otherwise every edit — even a rename — would require re-typing a credential.
    const draft = draftFromStore(store());
    expect(missingFields(draft, store())).toEqual([]);
    // …but a brand new storage does need one.
    expect(missingFields(draft, undefined)).toEqual(["a secret key"]);
  });

  it("drops untouched secrets from the payload and keeps typed ones", () => {
    const untouched = toPayload(draftFromStore(store()));
    expect("secret_key" in untouched).toBe(false);
    expect("token" in untouched).toBe(false);

    const typed = toPayload({ ...draftFromStore(store()), secret_key: "newsecret" });
    expect(typed.secret_key).toBe("newsecret");
  });

  it("does not send a bucket or access key for a file service", () => {
    // They mean nothing to it, and sending them would leave stale values in the row.
    const payload = toPayload({ ...blankDraft("http"), name: "svc", endpoint: "https://files" });
    expect("bucket" in payload).toBe(false);
    expect("access_key" in payload).toBe(false);
  });
});

describe("what still needs filling in", () => {
  it("says it in words rather than naming fields", () => {
    // Shown next to a disabled button, so it has to say what to do.
    expect(missingFields(blankDraft("s3"))).toEqual([
      "a name",
      "an endpoint",
      "a bucket",
      "an access key",
      "a secret key",
    ]);
    // A file service needs far less — no bucket, and auth is optional.
    expect(missingFields(blankDraft("http"))).toEqual(["a name", "an endpoint"]);
  });

  it("catches the endpoint mistake before a round-trip", () => {
    expect(endpointHint("127.0.0.1:9000")).toContain("http://127.0.0.1:9000");
    expect(endpointHint("http://127.0.0.1:9000")).toBeUndefined();
    expect(endpointHint("https://files.internal")).toBeUndefined();
    // Nothing typed yet is not a mistake.
    expect(endpointHint("  ")).toBeUndefined();
  });
});

describe("a storage from the environment", () => {
  it("is read-only, because the shell that exported it is the only place to change it", () => {
    expect(isReadOnly(store({ source: "env" }))).toBe(true);
    expect(isReadOnly(store())).toBe(false);
    expect(isReadOnly(undefined)).toBe(false);
  });
});

describe("labels", () => {
  it("describe a storage without ever carrying a credential", () => {
    expect(storeLabel(store())).toBe("minio · sat-fixtures @ 127.0.0.1:9000");
    expect(storeLabel(store({ kind: "http", endpoint: "https://files.internal/" }))).toBe(
      "file service · files.internal",
    );
    // The access key is in the object; it must not reach the label.
    expect(storeLabel(store())).not.toContain("MV5Simprx");
  });
});

describe("extensions", () => {
  it("warns without blocking, and says why that is deliberate", () => {
    expect(extensionIsKnown("nums.csv")).toBe(true);
    expect(extensionIsKnown("contacts.XLSX")).toBe(true);
    expect(extensionIsKnown("notes.pdf")).toBe(false);

    expect(extensionWarning("nums.csv")).toBeUndefined();
    const w = extensionWarning("notes.pdf")!;
    expect(w).toContain(".pdf");
    // "wrong extension → 400" is a case the author wants, so the copy must not read as an error.
    expect(w).toContain("case you are writing");
  });
});

describe("the file list", () => {
  it("puts what you just uploaded first", () => {
    const files = [
      file({ name: "old.csv", uploaded_at: "2026-08-01T09:00:00Z" }),
      file({ name: "new.csv", uploaded_at: "2026-08-04T09:00:00Z" }),
    ];
    expect(sortFiles(files).map((f) => f.name)).toEqual(["new.csv", "old.csv"]);
  });

  it("falls back to the name when the storage reports no timestamp", () => {
    // S3 answers a PUT with no body, so there is nothing to report — and inventing one would
    // sort convincingly wrongly.
    const files = [file({ name: "b.csv" }), file({ name: "a.csv" })];
    expect(sortFiles(files).map((f) => f.name)).toEqual(["a.csv", "b.csv"]);
  });

  it("searches the reference as well as the name", () => {
    // Pasting a URL back in to find out which file it was is a real move.
    expect(matchesQuery(file(), "nums1")).toBe(true);
    expect(matchesQuery(file(), "sat-fixtures")).toBe(true);
    expect(matchesQuery(file(), "nothing")).toBe(false);
    expect(matchesQuery(file(), "   ")).toBe(true);
  });

  it("reads sizes at a glance rather than to the byte", () => {
    expect(formatSize(412)).toBe("412 B");
    expect(formatSize(4198)).toBe("4.1 KB");
    expect(formatSize(19_293_798)).toBe("18.4 MB");
    expect(formatSize(-1)).toBe("—");
  });
});
