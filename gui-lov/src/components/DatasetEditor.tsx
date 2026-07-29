import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Copy, AlertTriangle, Link2 } from "lucide-react";
import type { Dataset } from "@/lib/api/types";
import {
  addRow,
  duplicateRow,
  joinEndpoint,
  looksLikeInvalidJson,
  oneLine,
  removeRow,
  rowLabel,
  isStatusShorthand,
  setRowBody,
  setRowCheck,
  setRowName,
  setRowNeedsFlow,
  setRowPath,
} from "@/lib/dataset";

interface DatasetEditorProps {
  dataset: Dataset;
  onChange: (dataset: Dataset) => void;
  /** Used only to explain what a row with no check of its own falls back to. */
  sharedAssertion?: string;
}

// #, needs-flow, case, path, body, expect, duplicate, delete
const GRID =
  "30px 30px 150px minmax(110px,0.45fr) minmax(180px,1fr) minmax(150px,0.55fr) 34px 34px";

/** Borders belong to the table, not to the fields — a field with its own border
 *  inside a bordered cell reads as a box in a box and wastes the width. */
const CELL = "border-r border-border";
const FIELD =
  "rounded-none border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0";

interface CellProps {
  value: string;
  onChange: (value: string) => void;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  placeholder: string;
  label: string;
  /** Colour for the collapsed preview — used to flag a body that isn't JSON. */
  tone?: string;
  /** Shown under the field while editing only; it would break the row height otherwise. */
  hint?: ReactNode;
}

/**
 * One row tall until it's being edited, so a long matrix stays scannable.
 * Collapsed it's a button showing a minified preview clipped with an ellipsis —
 * a textarea can't do that, and a pretty-printed body would show as a lone "{".
 */
function EditableCell({
  value,
  onChange,
  editing,
  onEdit,
  onDone,
  placeholder,
  label,
  tone,
  hint,
}: CellProps) {
  if (!editing) {
    const preview = oneLine(value);
    return (
      <div className={`min-w-0 ${CELL}`}>
        <button
          type="button"
          onClick={onEdit}
          onFocus={onEdit}
          aria-label={label}
          title={preview || undefined}
          className={`block h-9 w-full truncate px-2 text-left font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
            preview ? (tone ?? "text-foreground") : "text-muted-foreground/70"
          }`}
        >
          {preview || placeholder}
        </button>
      </div>
    );
  }
  return (
    <div className={`min-w-0 ${CELL}`}>
      <Textarea
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the click that opened
        // this cell was aimed at the field it replaces.
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onDone}
        placeholder={placeholder}
        aria-label={label}
        className={`scrollbar-hairline h-[132px] min-h-0 w-full resize-none whitespace-pre px-2 py-1.5 font-mono text-xs ${FIELD}`}
      />
      {hint && <div className="px-2 pb-1.5">{hint}</div>}
    </div>
  );
}

export function DatasetEditor({ dataset, onChange, sharedAssertion }: DatasetEditorProps) {
  const [editingBody, setEditingBody] = useState<string | null>(null);
  const [editingCheck, setEditingCheck] = useState<string | null>(null);
  const { rows } = dataset;
  const hasShared = !!sharedAssertion?.trim();

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[15px] font-semibold" style={{ color: "hsl(var(--lead-color))" }}>
            Run this test against several bodies
          </p>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">
            One row per case. Each row sends its own body and says what should come back —
            useful for negative and edge cases without building a flow.
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={() => onChange(addRow(dataset))}>
          <Plus className="h-3.5 w-3.5" /> Add case
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6">
          <p className="text-[13px] font-medium text-foreground">No cases yet.</p>
          <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
            A case is a body plus the status you expect. For example:
          </p>
          <div className="mt-3 space-y-1.5 font-mono text-[12px] text-muted-foreground">
            <div>
              <span className="text-foreground">empty body</span> →{" "}
              <code className="rounded bg-muted px-1">{"{}"}</code> → expect{" "}
              <span className="text-foreground">400</span>
            </div>
            <div>
              <span className="text-foreground">email missing</span> →{" "}
              <code className="rounded bg-muted px-1">{'{"mobile":"9180500001"}'}</code> → expect{" "}
              <span className="text-foreground">400</span>
            </div>
            <div>
              <span className="text-foreground">valid</span> →{" "}
              <code className="rounded bg-muted px-1">{'{"email":"a@b.com","mobile":"9180500002"}'}</code>{" "}
              → expect <span className="text-foreground">201</span>
            </div>
          </div>
          <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={() => onChange(addRow(dataset))}>
            <Plus className="h-3.5 w-3.5" /> Add the first case
          </Button>
        </div>
      ) : (
        <div className="scrollbar-hairline overflow-x-auto">
          <div className="min-w-[810px] overflow-hidden rounded-md border border-border">
            {/* Header band, tinted so it reads as a header rather than another row
                of inputs. Its cells carry the same dividers as the rows below. */}
            <div
              className="grid items-center border-b border-border bg-muted/40"
              style={{ gridTemplateColumns: GRID }}
            >
              <span className={CELL} />
              <span
                className={`flex items-center justify-center text-muted-foreground ${CELL}`}
                title="Needs a flow — Run dataset skips these rows"
              >
                <Link2 className="h-3 w-3" />
              </span>
              {["Case", "Path / query", "Body", "Expect"].map((h) => (
                <span
                  key={h}
                  className={`px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground ${CELL}`}
                >
                  {h}
                </span>
              ))}
              <span className={CELL} />
              <span />
            </div>

            {rows.map((row, i) => {
              const body = row.body ?? "";
              const check = row.check ?? "";
              const badJson = looksLikeInvalidJson(body);
              const label = rowLabel(i, row);
              return (
                <div
                  key={row.id}
                  className="grid items-stretch border-t border-border first:border-t-0 hover:bg-muted/20"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span className={`pt-2 text-center text-xs text-muted-foreground ${CELL}`}>
                    {i + 1}
                  </span>

                  {/* Needs a flow. Sits in its own narrow column rather than a fifth
                      field, because it isn't part of the request — it says where the row
                      can run. */}
                  <button
                    type="button"
                    onClick={() => onChange(setRowNeedsFlow(dataset, row.id, !row.needs_flow))}
                    aria-label={`${row.needs_flow ? "Run" : "Don't run"} ${label} from Run dataset`}
                    aria-pressed={row.needs_flow === true}
                    title={
                      row.needs_flow
                        ? "Needs a flow — Run dataset skips this row. Click to run it here too."
                        : "Runs from Run dataset. Click if it needs a login or other setup first."
                    }
                    className={`flex h-9 items-center justify-center transition-colors ${CELL} ${
                      row.needs_flow
                        ? "text-primary"
                        : "text-muted-foreground/25 hover:text-muted-foreground"
                    }`}
                  >
                    <Link2 className="h-3.5 w-3.5" />
                  </button>

                  <div className={`min-w-0 ${CELL}`}>
                    <Input
                      value={row.name ?? ""}
                      placeholder={label}
                      onChange={(e) => onChange(setRowName(dataset, row.id, e.target.value))}
                      className={`h-9 px-2 text-[13px] ${FIELD}`}
                      aria-label={`Case name for row ${i + 1}`}
                    />
                  </div>

                  <div className={`min-w-0 ${CELL}`}>
                    <Input
                      value={row.path ?? ""}
                      placeholder="?org=acme"
                      onChange={(e) => onChange(setRowPath(dataset, row.id, e.target.value))}
                      className={`h-9 px-2 font-mono text-[13px] ${FIELD}`}
                      aria-label={`Path or query for ${label}`}
                      title={
                        row.path?.trim()
                          ? `Appended to the request's endpoint: …${joinEndpoint("", row.path)}`
                          : "Appended to the request's endpoint — leave blank to use it as authored"
                      }
                    />
                  </div>

                  <EditableCell
                    value={body}
                    onChange={(v) => onChange(setRowBody(dataset, row.id, v))}
                    editing={editingBody === row.id}
                    onEdit={() => setEditingBody(row.id)}
                    onDone={() => setEditingBody((cur) => (cur === row.id ? null : cur))}
                    placeholder={"{\"email\": \"a@b.com\"}   — blank uses the Request tab’s body"}
                    label={`Body for ${label}`}
                    tone={badJson ? "text-warning" : undefined}
                    hint={
                      badJson ? (
                        <span className="flex items-center gap-1 text-[11px] text-warning">
                          <AlertTriangle className="h-3 w-3" /> Not valid JSON — sent as-is
                        </span>
                      ) : undefined
                    }
                  />

                  <EditableCell
                    value={check}
                    onChange={(v) => onChange(setRowCheck(dataset, row.id, v))}
                    editing={editingCheck === row.id}
                    onEdit={() => setEditingCheck(row.id)}
                    onDone={() => setEditingCheck((cur) => (cur === row.id ? null : cur))}
                    placeholder="400   — or an expression"
                    label={`Expected result for ${label}`}
                    hint={
                      <p className="text-[11px] text-muted-foreground">
                        {!check.trim()
                          ? hasShared
                            ? "Blank — this row passes on any 2xx (the Scripts tab is not used for rows)."
                            : "Blank — this row passes on any 2xx."
                          : isStatusShorthand(check)
                            ? `Shorthand for response.status == ${check.trim()}`
                            : "Rhai expression — must end in something true or false."}
                      </p>
                    }
                  />

                  <div className={CELL}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-full rounded-none text-muted-foreground hover:text-foreground"
                      onClick={() => onChange(duplicateRow(dataset, row.id))}
                      aria-label={`Duplicate ${label}`}
                      title="Duplicate this case"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-full rounded-none text-muted-foreground hover:text-destructive"
                    onClick={() => onChange(removeRow(dataset, row.id))}
                    aria-label={`Remove ${label}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <strong className="font-medium">Path / query</strong> is appended to the request's
          endpoint — <code className="rounded bg-muted px-1 font-mono">?org=acme</code> or{" "}
          <code className="rounded bg-muted px-1 font-mono">/acme/summary</code> — and joins
          with <code className="rounded bg-muted px-1 font-mono">&amp;</code> if the endpoint
          already has a query. A blank body falls back to the Request tab's body. Both are
          interpolated, so{" "}
          <code className="rounded bg-muted px-1 font-mono">{"{{baseUrl}}"}</code> and{" "}
          <code className="rounded bg-muted px-1 font-mono">{"{{$RandomEmail}}"}</code> work inside
          them. The <Link2 className="inline h-3 w-3" /> column marks a row that only means
          something after a login or other setup: <strong className="font-medium">Run
          dataset</strong> skips those, and a flow node runs them — the flow being the
          precondition. <strong className="font-medium">Run request</strong> ignores these
          cases entirely and runs the request as authored.
        </p>
      )}
    </div>
  );
}
