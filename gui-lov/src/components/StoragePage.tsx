import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Check, Copy, Loader2, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SuggestInput } from "@/components/SuggestInput";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fileStoreApi } from "@/lib/api/fileStore";
import {
  blankDraft,
  defaultReference,
  draftFromStore,
  endpointHint,
  isReadOnly,
  missingFields,
  referenceLabel,
  toPayload,
  type CheckResult,
  type StoreDef,
  type StoreDraft,
  type StoreKind,
} from "@/lib/fileStore";

/**
 * Configuring a storage, and finding out whether it works before committing to it.
 *
 * **A page, not a dialog.** Half a dozen questions, two blocks of copyable help and a four-step
 * report do not fit in a modal without it scrolling inside itself — and a modal also blocks the
 * one thing an author wants while filling this in, which is to go and look at something else.
 *
 * The order of the fields is the order of the questions: **what kind**, because it decides what
 * follows; **where**, with the help an author actually needs (a ClusterIP is not reachable from
 * this machine); **how to get in**; **what tests are handed**; then **test**, then save.
 *
 * The test is a real round-trip — reach, list, upload a probe, delete it — reported step by step,
 * because listing proves the endpoint and the credentials while saying nothing about whether
 * writing is permitted, and one tick over the lot would hide a read-only key until the first
 * real upload.
 */
interface Props {
  projectId: string;
  /** Editing an existing storage, or undefined to create one. */
  store?: StoreDef;
  onClose: () => void;
  onSaved: (store: StoreDef) => void;
}

export const StoragePage = ({ projectId, store, onClose, onSaved }: Props) => {
  const queryClient = useQueryClient();
  const readOnly = isReadOnly(store);
  const [draft, setDraft] = useState<StoreDraft>(() =>
    store ? draftFromStore(store) : blankDraft("s3"),
  );
  const [check, setCheck] = useState<CheckResult | null>(null);

  const set = (patch: Partial<StoreDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    // A configuration that has changed has not been tested, and a stale green tick is the one
    // thing worse than no tick at all.
    setCheck(null);
  };

  const switchKind = (kind: StoreKind) =>
    setDraft((d) => ({
      ...blankDraft(kind),
      // What survives a change of kind is what both kinds have.
      name: d.name,
      endpoint: d.endpoint,
      prefix: d.prefix,
    }));

  const missing = missingFields(draft, store);
  const hint = endpointHint(draft.endpoint);

  const test = useMutation({
    mutationFn: () =>
      // A saved store is tested by id so the stored secret is used; a draft carries its own.
      store && !draft.secret_key && !draft.token
        ? fileStoreApi.testStore(store.id)
        : fileStoreApi.testDraft(projectId, toPayload(draft)),
    onSuccess: setCheck,
    onError: (e: Error) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: () =>
      store
        ? fileStoreApi.updateStore(store.id, toPayload(draft))
        : fileStoreApi.createStore(projectId, toPayload(draft)),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ["file-stores", projectId] });
      toast.success(store ? `${saved.name} updated` : `${saved.name} added`);
      onSaved(saved);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          title="Back to files"
          aria-label="Back to files"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">
            {store ? store.name : "Set up a storage"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Somewhere the API under test can fetch a file from.
          </p>
        </div>
      </header>

      <div className="scrollbar-hairline min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-xl space-y-5">
          {!store && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                Some requests take a whole file rather than a value — a CSV of 10,000 recipients,
                a contacts spreadsheet — and the API goes and reads it rather than finding it in
                your request. So the file has to sit somewhere the API can reach.
              </p>
              <p className="mt-2">
                You upload a file here once. Satyanaash hands back a short piece of text pointing
                at it, and you paste that into the request. From then on it is only text, so it
                works in a dataset row or an environment variable just as well.
              </p>
            </div>
          )}

        {readOnly ? (
          <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
            <p className="font-medium text-warning">Defined by environment variables</p>
            <p className="mt-1.5 leading-relaxed text-muted-foreground">
              This storage comes from <span className="font-mono">{store!.name}_*</span> in the
              shell that started satyanaash, so it cannot be edited here — that shell is the only
              place it can change, and it needs a restart. You can still test it.
            </p>
          </div>
        ) : null}

        <div className="space-y-4">
          {/* 1 — kind, because it decides which fields follow */}
          <Field
            label="What kind of storage"
            hint={
              draft.kind === "s3"
                ? "An object store — minio, AWS S3, or anything speaking the same protocol. If your team already runs one, this is it."
                : "A plain HTTP service you POST a file to and get a link back. Simpler, if you have one."
            }
          >
            <ToggleGroup
              type="single"
              value={draft.kind}
              onValueChange={(v) => v && !readOnly && switchKind(v as StoreKind)}
              className="justify-start gap-1"
              disabled={readOnly}
            >
              <ToggleGroupItem value="s3" className="h-8 px-3 text-xs data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
                minio / S3
              </ToggleGroupItem>
              <ToggleGroupItem value="http" className="h-8 px-3 text-xs data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
                File service
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>

          <Field label="Name" hint="Shown in the picker. Yours to choose.">
            {/* Dimmed to match the suggested fields. Not a suggestion — a name is yours to
                choose, and accepting "minio (dev)" would give you a storage called that — but an
                empty field must not look filled just because this one is not acceptable. */}
            <Input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={draft.kind === "s3" ? "minio (dev)" : "ngage file service"}
              className="h-8 text-xs placeholder:text-muted-foreground/50"
              disabled={readOnly}
            />
          </Field>

          {/* 2 — where, with the help that is actually needed */}
          <Field label="Endpoint" hint={hint} hintTone={hint ? "warn" : undefined}>
            {/* A suggestion, not an example: a port-forwarded minio really is on 127.0.0.1:9000,
                so one keystroke should be enough. The file-service address is a guess about
                someone else's naming, so it stays a placeholder. */}
            <SuggestInput
              value={draft.endpoint}
              onChange={(e) => set({ endpoint: e.target.value })}
              onAccept={(v) => set({ endpoint: v })}
              suggestion={draft.kind === "s3" ? "http://127.0.0.1:9000" : undefined}
              placeholder={draft.kind === "s3" ? undefined : "https://files.internal"}
              className="h-8 font-mono text-xs"
              disabled={readOnly}
            />
            {/* The step that blocks everyone the first time: a ClusterIP is not reachable from
                this machine, so the endpoint is always 127.0.0.1 plus a forwarded port. */}
            <Help
              text="In a cluster? A ClusterIP is not reachable from this machine — forward it first, then the endpoint is 127.0.0.1."
              command="kubectl port-forward svc/minio 9000:9000 -n 3rdparty"
            />
          </Field>

          {/* 3 — how to get in */}
          {draft.kind === "s3" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Bucket"
                  hint="The folder-like container your files go in. It has to exist before it can be used."
                >
                  <SuggestInput
                    value={draft.bucket ?? ""}
                    onChange={(e) => set({ bucket: e.target.value })}
                    onAccept={(v) => set({ bucket: v })}
                    suggestion="sat-fixtures"
                    className="h-8 font-mono text-xs"
                    disabled={readOnly}
                  />
                  {/* "Go and create a bucket" is a dead end for someone who has never heard of
                      one and may not be allowed to make one. Both ways out are here: see what
                      already exists, or make this one. */}
                  {!readOnly && (
                    <BucketHelp
                      projectId={projectId}
                      draft={draft}
                      onPick={(b) => set({ bucket: b })}
                    />
                  )}
                </Field>
                <Field label="Prefix" hint="Optional folder inside the bucket.">
                  <SuggestInput
                    value={draft.prefix ?? ""}
                    onChange={(e) => set({ prefix: e.target.value })}
                    onAccept={(v) => set({ prefix: v })}
                    suggestion="fixtures/"
                    className="h-8 font-mono text-xs"
                    disabled={readOnly}
                  />
                </Field>
              </div>
              <Field label="Access key">
                <Input
                  value={draft.access_key ?? ""}
                  onChange={(e) => set({ access_key: e.target.value })}
                  className="h-8 font-mono text-xs"
                  disabled={readOnly}
                />
              </Field>
              <Field
                label="Secret key"
                hint={
                  store?.has_secret && draft.secret_key === undefined
                    ? "Already set — leave blank to keep it."
                    : undefined
                }
              >
                <Input
                  type="password"
                  value={draft.secret_key ?? ""}
                  onChange={(e) => set({ secret_key: e.target.value })}
                  placeholder={store?.has_secret ? "••••••••  (set)" : ""}
                  className="h-8 font-mono text-xs"
                  disabled={readOnly}
                />
                <Help
                  text="In a Kubernetes secret? Read it out with:"
                  command="kubectl get secret minio-credentials -n 3rdparty -o jsonpath='{.data.secretKey}' | base64 -d"
                />
              </Field>
            </>
          ) : (
            <Field
              label="Token"
              hint={
                store?.has_token && draft.token === undefined
                  ? "Already set — leave blank to keep it."
                  : "Optional. Sent as a bearer token when set."
              }
            >
              <Input
                type="password"
                value={draft.token ?? ""}
                onChange={(e) => set({ token: e.target.value })}
                placeholder={store?.has_token ? "••••••••  (set)" : ""}
                className="h-8 font-mono text-xs"
                disabled={readOnly}
              />
            </Field>
          )}

          {/* 4 — what tests are handed, with the reason inline */}
          <Field label="What a test will contain">
            <ToggleGroup
              type="single"
              value={draft.reference ?? defaultReference(draft.kind)}
              onValueChange={(v) => v && !readOnly && set({ reference: v as "key" | "url" })}
              className="justify-start gap-1"
              disabled={readOnly}
            >
              <ToggleGroupItem value="key" className="h-8 px-3 text-xs data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
                A location
              </ToggleGroupItem>
              <ToggleGroupItem value="url" className="h-8 px-3 text-xs data-[state=on]:bg-primary/10 data-[state=on]:text-primary">
                A full URL
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {draft.reference === "url"
                ? "Like https://files.example/nums.csv — the API fetches it over the network, so it has to be reachable from wherever the API runs. A private address such as 10.x or 192.168.x usually is not, and many servers reject those outright."
                : `Like ${draft.bucket || "a-bucket"}/${draft.prefix || ""}nums.csv — the API looks this up in the storage it already knows about, so nothing has to be reachable from outside.`}
            </p>
          </Field>
        </div>

          {check && <CheckReport result={check} />}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => test.mutate()}
            disabled={test.isPending || missing.length > 0}
            title={missing.length > 0 ? `Needs ${missing.join(", ")}` : "Try it for real"}
          >
            {test.isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
            Test storage
          </Button>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          {missing.length > 0 && !readOnly && (
            <span className="text-[11px] text-muted-foreground">Needs {missing.join(", ")}</span>
          )}
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => save.mutate()}
              disabled={save.isPending || missing.length > 0}
            >
              {save.isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              {store ? "Save" : "Add storage"}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
};

const Field = ({
  label,
  hint,
  hintTone,
  children,
}: {
  label: string;
  hint?: string;
  hintTone?: "warn";
  children: React.ReactNode;
}) => (
  <div>
    <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
    <div className="mt-1">{children}</div>
    {hint && (
      <p className={`mt-1 text-[11px] ${hintTone === "warn" ? "text-warning" : "text-muted-foreground"}`}>
        {hint}
      </p>
    )}
  </div>
);

/** A sentence and a command to copy — the thing that was otherwise a trip to the docs. */
const Help = ({ text, command }: { text: string; command: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 rounded border border-border bg-muted/40 p-2">
      <p className="text-[11px] leading-relaxed text-muted-foreground">{text}</p>
      <div className="mt-1 flex items-start gap-1">
        <code className="min-w-0 flex-1 break-all font-mono text-[10px] text-foreground">
          {command}
        </code>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0"
          onClick={() => {
            navigator.clipboard?.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          title="Copy"
          aria-label={`Copy: ${command}`}
        >
          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
    </div>
  );
};

/**
 * The steps, each with its own verdict.
 *
 * A step that never ran is a dash, not a cross — it failed to happen rather than failing, and a
 * cross would send the author to look at permissions when the endpoint is what is wrong.
 */
const CheckReport = ({ result }: { result: CheckResult }) => (
  <div
    className={`rounded-md border p-3 ${
      result.ok ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5"
    }`}
  >
    <p className={`text-xs font-medium ${result.ok ? "text-success" : "text-destructive"}`}>
      {result.ok ? "This storage works" : "This storage is not usable yet"}
    </p>
    <ul className="mt-2 space-y-1.5">
      {result.steps.map((s) => (
        <li key={s.step} className="flex items-start gap-2 text-[11px]">
          <span className="mt-[1px] shrink-0">
            {s.ok === true ? (
              <Check className="h-3 w-3 text-success" />
            ) : s.ok === false ? (
              <X className="h-3 w-3 text-destructive" />
            ) : (
              <Minus className="h-3 w-3 text-muted-foreground/60" />
            )}
          </span>
          <span className="min-w-0">
            <span className={s.ok === null ? "text-muted-foreground/60" : "text-foreground"}>
              {s.step}
            </span>
            {s.ok === null && <span className="text-muted-foreground/60"> — not attempted</span>}
            {s.detail && (
              <span className="block break-words font-mono text-[10px] text-muted-foreground">
                {s.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  </div>
);

/**
 * The way out of "the bucket does not exist".
 *
 * Two buttons, because there are two situations and they need different answers. Someone with
 * rights can make the bucket. Someone without — a test author whose platform team owns the
 * storage — needs to see which ones they are already allowed to use, and if none suit, an error
 * precise enough to forward.
 *
 * Neither appears until there is a credential to try, because a listing without one is a 403
 * that teaches nothing.
 */
const BucketHelp = ({
  projectId,
  draft,
  onPick,
}: {
  projectId: string;
  draft: StoreDraft;
  onPick: (bucket: string) => void;
}) => {
  const [buckets, setBuckets] = useState<string[] | null>(null);

  const ready = !!draft.endpoint.trim() && !!draft.access_key?.trim() && !!draft.secret_key?.trim();

  const list = useMutation({
    mutationFn: () => fileStoreApi.buckets(projectId, toPayload(draft)),
    onSuccess: setBuckets,
    onError: (e: Error) => toast.error(e.message),
  });

  const create = useMutation({
    mutationFn: () => fileStoreApi.createBucket(projectId, toPayload(draft), draft.bucket ?? ""),
    onSuccess: () => {
      toast.success(`Created ${draft.bucket}`);
      list.mutate();
    },
    // The likely answer for a test author, and the message is written to be forwarded.
    onError: (e: Error) => toast.error(e.message),
  });

  if (!ready) {
    return (
      <p className="mt-1.5 text-[11px] text-muted-foreground/70">
        Fill in the endpoint and credentials, and this will show you which buckets you can use.
      </p>
    );
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-[11px]"
          onClick={() => list.mutate()}
          disabled={list.isPending}
        >
          {list.isPending && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
          Show me what exists
        </Button>
        {draft.bucket?.trim() && !buckets?.includes(draft.bucket.trim()) && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => create.mutate()}
            disabled={create.isPending}
          >
            {create.isPending && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
            Create “{draft.bucket.trim()}”
          </Button>
        )}
      </div>

      {buckets && (
        <div className="rounded border border-border bg-muted/30 p-2">
          {buckets.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              This credential can see no buckets. Create one above, or ask whoever administers the
              storage for one.
            </p>
          ) : (
            <>
              <p className="text-[10px] text-muted-foreground">Pick one:</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {buckets.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => onPick(b)}
                    className={`rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                      draft.bucket?.trim() === b
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default StoragePage;
