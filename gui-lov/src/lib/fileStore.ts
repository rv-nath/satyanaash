/**
 * Storages, and the files in them.
 *
 * A campaign's `recipients.files` takes URLs or minio bucket/keys, and an author should not have
 * to know which — they upload a file and copy what comes back. Uploading happens at that moment,
 * so the reference is real and stable immediately, which is why nothing else in the app needs to
 * change: it is text from then on. Paste it into a body, or name it as an environment variable.
 *
 * Storages are **named and project-scoped**, not per-environment. Uploading happens while
 * authoring, so which environment is selected has no bearing on the result — and having two at
 * once is the point, because migrating from minio to a file-service pod means running both for a
 * while.
 */

/** Extensions this platform accepts for a recipients file. */
export const KNOWN_EXTENSIONS = ["csv", "txt", "xls", "xlsx"] as const;

export type StoreKind = "s3" | "http";
export type ReferenceForm = "key" | "url";

/** A storage as the server describes it. Never carries a secret — there is no field for one. */
export interface StoreDef {
  id: string;
  project_id: string;
  name: string;
  kind: StoreKind;
  endpoint: string;
  bucket?: string;
  prefix: string;
  access_key?: string;
  reference: ReferenceForm;
  region: string;
  /** A secret is stored — so the form shows "••••••• (set)" and only overwrites it if you type. */
  has_secret: boolean;
  has_token: boolean;
  /** `env` storages are read-only: the shell that exported them is the only place to change them. */
  source: "project" | "env";
  created_at: string;
  updated_at: string;
}

/** What the form sends. The two secrets are omitted rather than blanked when unchanged. */
export interface StoreDraft {
  name: string;
  kind: StoreKind;
  endpoint: string;
  bucket?: string;
  prefix?: string;
  access_key?: string;
  secret_key?: string;
  token?: string;
  reference?: ReferenceForm;
  region?: string;
}

export interface CheckStep {
  step: string;
  /** `null` means an earlier step failed and this one never ran — not the same as failing. */
  ok: boolean | null;
  detail?: string;
}

export interface CheckResult {
  ok: boolean;
  steps: CheckStep[];
}

export interface StoredFile {
  name: string;
  key: string;
  /** What the author pastes into a test: a URL, or `bucket/key`. */
  reference: string;
  size: number;
  uploaded_at?: string;
}

// ---------------------------------------------------------------- storages

export function isReadOnly(store: StoreDef | undefined): boolean {
  return store?.source === "env";
}

/** "minio · sat-fixtures @ 127.0.0.1:9000" — never a credential. */
export function storeLabel(store: StoreDef): string {
  const host = store.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (store.kind === "s3") {
    return store.bucket ? `minio · ${store.bucket} @ ${host}` : `minio · ${host}`;
  }
  return `file service · ${host}`;
}

/** A blank storage of this kind, with the reference form that kind can actually deliver. */
export function blankDraft(kind: StoreKind): StoreDraft {
  return {
    name: "",
    kind,
    endpoint: "",
    bucket: kind === "s3" ? "" : undefined,
    prefix: "",
    access_key: kind === "s3" ? "" : undefined,
    secret_key: "",
    token: kind === "http" ? "" : undefined,
    reference: defaultReference(kind),
  };
}

/**
 * minio hands over a key, a file service its own URL.
 *
 * A URL pointing at an in-cluster minio is an RFC1918 address, which is exactly what this
 * platform's SSRF guard rejects — so defaulting an S3 storage to a URL would default it to
 * broken.
 */
export function defaultReference(kind: StoreKind): ReferenceForm {
  return kind === "http" ? "url" : "key";
}

/**
 * A draft for editing an existing storage.
 *
 * **The secrets come back empty, meaning "leave them alone".** The server never sends them, so
 * the form cannot echo them; sending an empty string would clear a working credential on every
 * rename.
 */
export function draftFromStore(store: StoreDef): StoreDraft {
  return {
    name: store.name,
    kind: store.kind,
    endpoint: store.endpoint,
    bucket: store.bucket ?? "",
    prefix: store.prefix,
    access_key: store.access_key ?? "",
    secret_key: undefined,
    token: undefined,
    reference: store.reference,
    region: store.region,
  };
}

/**
 * What still has to be filled in before this can be saved or tested.
 *
 * Author-facing words, not field names — this is shown next to a disabled button, so it has to
 * say what to do rather than name an identifier.
 */
export function missingFields(draft: StoreDraft, existing?: StoreDef): string[] {
  const missing: string[] = [];
  if (!draft.name.trim()) missing.push("a name");
  if (!draft.endpoint.trim()) missing.push("an endpoint");
  if (draft.kind === "s3") {
    if (!draft.bucket?.trim()) missing.push("a bucket");
    if (!draft.access_key?.trim()) missing.push("an access key");
    // Already stored counts as present: the form was never given it, and demanding it again
    // would make every edit require re-typing a credential.
    if (!draft.secret_key?.trim() && !existing?.has_secret) missing.push("a secret key");
  }
  return missing;
}

/** The endpoint mistake worth catching before a round-trip: no scheme. */
export function endpointHint(endpoint: string): string | undefined {
  const e = endpoint.trim();
  if (!e || e.startsWith("http://") || e.startsWith("https://")) return undefined;
  return `Needs a scheme — try http://${e}`;
}

/**
 * What to send: the secrets are dropped when untouched, so absence means "keep the stored one".
 *
 * An empty string is deliberately *not* dropped when the author cleared a field they had typed
 * into, because clearing is a real request. Only `undefined` means "unchanged".
 */
export function toPayload(draft: StoreDraft): StoreDraft {
  const out: StoreDraft = { ...draft, name: draft.name.trim(), endpoint: draft.endpoint.trim() };
  if (out.secret_key === undefined || out.secret_key === "") delete out.secret_key;
  if (out.token === undefined || out.token === "") delete out.token;
  if (out.kind === "http") {
    delete out.bucket;
    delete out.access_key;
  }
  return out;
}

// ---------------------------------------------------------------- files

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function extensionIsKnown(name: string): boolean {
  return (KNOWN_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/**
 * Advice, never a refusal.
 *
 * "wrong extension → 400" is a case an author wants to write, so blocking the upload would make
 * that test unwritable. The store holds whatever it is given.
 */
export function extensionWarning(name: string): string | undefined {
  if (extensionIsKnown(name)) return undefined;
  const ext = extensionOf(name);
  return `${ext ? `.${ext}` : "No extension"} — this API accepts ${KNOWN_EXTENSIONS.map(
    (e) => `.${e}`,
  ).join(" ")}, so it will reject this. Fine if that is the case you are writing.`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What to call the thing you copy.
 *
 * "location" rather than "bucket / key": a key is genuinely not a URL, so calling it one would
 * be a small lie an author reads every time — but *bucket* and *key* are words from one
 * particular storage product, and they belong on the page that explains them rather than in a
 * toast. The precise form is shown there.
 */
export function referenceLabel(reference: ReferenceForm | undefined): string {
  if (reference === "key") return "location";
  if (reference === "url") return "URL";
  return "link";
}

/** Newest first, then by name — a list you scan for what you just uploaded. */
export function sortFiles(files: StoredFile[]): StoredFile[] {
  return [...files].sort((a, b) => {
    const at = a.uploaded_at ?? "";
    const bt = b.uploaded_at ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function matchesQuery(file: StoredFile, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // The reference too: pasting a URL back in to find which file it was is a real move.
  return file.name.toLowerCase().includes(q) || file.reference.toLowerCase().includes(q);
}
