import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Copy, AlertTriangle, Link2, ChevronUp } from "lucide-react";
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

// #, needs-flow, case, path, body, expect, duplicate, delete.
// Every text column flexes now that none of them holds a field, and Case gets the most
// it can: it wraps rather than clipping, so width spent there is width spent on fewer
// wrapped lines. Expect was a fixed 150px for a value that is usually three digits.
const GRID =
  "30px 30px minmax(180px,1.1fr) minmax(100px,0.4fr) minmax(180px,1.2fr) minmax(90px,0.4fr) 34px 34px";

/** The column divider. Collapsed rows hold previews rather than fields now, so the
 *  old borderless-field rule went with them: the fields in the expanded panel are not
 *  inside cells and wear their own borders like any other form. */
const CELL = "border-r border-border";

/** Which field a click was aimed at, so opening the row can focus it. */
type Field = "name" | "path" | "body" | "check";

interface SummaryCellProps {
  value: string;
  /** Opens the row with this field focused. */
  onOpen: () => void;
  placeholder: string;
  label: string;
  /** Colour for the preview — used to flag a body that isn't JSON. */
  tone?: string;
  /** Muted, because this row isn't part of this run — see `needs_flow`. Applied to the
   *  cell rather than the whole row so the red marker beside it stays vivid: CSS opacity
   *  can't be undone by a child. */
  dim?: boolean;
  /** Proportional rather than monospace — a case name is prose, not a payload. */
  prose?: boolean;
  /**
   * Show all of it, wrapping and growing the row, instead of clipping to one line.
   *
   * For the Case column only. A row's name is what identifies it — reading the matrix
   * means reading the names, and a name you have to hover to finish is not readable.
   * A payload is different: nobody reads a fifteen-line body out of a table cell, so
   * those stay one line and open when you want them.
   */
  wrap?: boolean;
}

/**
 * One cell of a collapsed row: a minified preview, clipped with an ellipsis, carrying
 * the whole value as its tooltip. Read-only on purpose — a live `<input>` cannot show
 * an ellipsis, which is exactly how the Case column came to cut names off with no cue
 * that anything was missing.
 *
 * Clicking it opens the row and focuses this field, so editing still costs one click.
 */
function SummaryCell({ value, onOpen, placeholder, label, tone, dim, prose, wrap }: SummaryCellProps) {
  const preview = oneLine(value);
  return (
    <div className={`min-w-0 ${CELL} ${dim ? "opacity-50" : ""}`}>
      <button
        type="button"
        onClick={onOpen}
        onFocus={onOpen}
        aria-label={label}
        // A wrapped cell shows everything, so a tooltip would only repeat what is
        // already on screen.
        title={!wrap && preview ? preview : undefined}
        className={`block w-full px-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
          wrap ? "min-h-9 break-words py-2 leading-snug" : "h-9 truncate"
        } ${prose ? "text-[13px]" : "font-mono text-xs"} ${
          preview ? (tone ?? "text-foreground") : "text-muted-foreground/70"
        }`}
      >
        {preview || placeholder}
      </button>
    </div>
  );
}

/** A labelled field in the expanded row. */
function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

interface ExpandedRowProps {
  dataset: Dataset;
  onChange: (dataset: Dataset) => void;
  rowId: string;
  index: number;
  /** Focused on open, so clicking a cell in the collapsed row costs one click. */
  focus: Field | null;
  onClose: () => void;
  hasShared: boolean;
}

/**
 * The row being edited, across the table's whole width.
 *
 * Replaces that row's grid line rather than appearing beneath it, so the row is not on
 * screen twice. Everything the collapsed row offered stays reachable — the ⛓ flag,
 * duplicate, delete — because collapsing a row just to delete it would be daft.
 */
function ExpandedRow({ dataset, onChange, rowId, index, focus, onClose, hasShared }: ExpandedRowProps) {
  const row = dataset.rows.find((r) => r.id === rowId);
  if (!row) return null;

  const body = row.body ?? "";
  const check = row.check ?? "";
  const label = rowLabel(index, row);
  const badJson = looksLikeInvalidJson(body);

  return (
    <div
      className="border-t border-border bg-muted/20 first:border-t-0"
      // Escape gets you out. Blur deliberately does not: tabbing from Case to Body
      // would otherwise collapse the panel out from under you.
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="w-[26px] shrink-0 text-center text-xs text-muted-foreground">
          {index + 1}
        </span>
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
          className={`shrink-0 rounded p-1 transition-colors ${
            row.needs_flow ? "text-destructive" : "text-muted-foreground/40 hover:text-muted-foreground"
          }`}
        >
          <Link2 className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onChange(duplicateRow(dataset, row.id))}
          aria-label={`Duplicate ${label}`}
          title="Duplicate this case"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => {
            onChange(removeRow(dataset, row.id));
            onClose();
          }}
          aria-label={`Remove ${label}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label={`Collapse ${label}`}
          title="Collapse this case (Esc)"
        >
          <ChevronUp className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-3 px-3 pb-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Labelled label="Case">
            <Input
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the click that opened
              // this row was aimed at this field.
              autoFocus={focus === "name"}
              value={row.name ?? ""}
              placeholder={label}
              onChange={(e) => onChange(setRowName(dataset, row.id, e.target.value))}
              className="h-8 text-[13px]"
              aria-label={`Case name for row ${index + 1}`}
            />
          </Labelled>
          <Labelled label="Path / query">
            <Input
              // eslint-disable-next-line jsx-a11y/no-autofocus -- see above
              autoFocus={focus === "path"}
              value={row.path ?? ""}
              placeholder="?org=acme"
              onChange={(e) => onChange(setRowPath(dataset, row.id, e.target.value))}
              className="h-8 font-mono text-[13px]"
              aria-label={`Path or query for ${label}`}
              title={
                row.path?.trim()
                  ? `Appended to the request's endpoint: …${joinEndpoint("", row.path)}`
                  : "Appended to the request's endpoint — leave blank to use it as authored"
              }
            />
          </Labelled>
        </div>

        <Labelled label="Body">
          <Textarea
            // eslint-disable-next-line jsx-a11y/no-autofocus -- see above
            autoFocus={focus === "body"}
            value={body}
            onChange={(e) => onChange(setRowBody(dataset, row.id, e.target.value))}
            placeholder={"{\"email\": \"a@b.com\"}   — blank uses the Request tab’s body"}
            aria-label={`Body for ${label}`}
            className="scrollbar-hairline h-[200px] min-h-0 w-full resize-y whitespace-pre font-mono text-xs"
          />
          {badJson && (
            <span className="mt-1 flex items-center gap-1 text-[11px] text-warning">
              <AlertTriangle className="h-3 w-3" /> Not valid JSON — sent as-is
            </span>
          )}
        </Labelled>

        <div className="grid items-start gap-3 sm:grid-cols-[220px_1fr]">
          <Labelled label="Expect">
            <Textarea
              // eslint-disable-next-line jsx-a11y/no-autofocus -- see above
              autoFocus={focus === "check"}
              value={check}
              onChange={(e) => onChange(setRowCheck(dataset, row.id, e.target.value))}
              placeholder="400   — or an expression"
              aria-label={`Expected result for ${label}`}
              className="scrollbar-hairline h-[64px] min-h-0 w-full resize-y whitespace-pre font-mono text-xs"
            />
          </Labelled>
          <p className="text-[11px] text-muted-foreground sm:mt-[22px]">
            {!check.trim()
              ? hasShared
                ? "Blank — this row passes on any 2xx (the Scripts tab is not used for rows)."
                : "Blank — this row passes on any 2xx."
              : isStatusShorthand(check)
                ? `Shorthand for response.status == ${check.trim()}`
                : "Rhai expression — must end in something true or false."}
          </p>
        </div>
      </div>
    </div>
  );
}

export function DatasetEditor({ dataset, onChange, sharedAssertion }: DatasetEditorProps) {
  // One row open at a time, and which of its fields the click was aimed at. A matrix is
  // for comparing rows; two of them expanded at once stops being one.
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [focusField, setFocusField] = useState<Field | null>(null);
  const open = (rowId: string, field: Field | null) => {
    setOpenRow(rowId);
    setFocusField(field);
  };
  const close = () => {
    setOpenRow(null);
    setFocusField(null);
  };
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
            useful for negative and edge cases without building a flow. Click a row to
            open it with room to edit.
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
              // Muted where the marker is red: this row won't take part in a Run dataset.
              const dim = row.needs_flow === true;

              if (openRow === row.id) {
                return (
                  <ExpandedRow
                    key={row.id}
                    dataset={dataset}
                    onChange={onChange}
                    rowId={row.id}
                    index={i}
                    focus={focusField}
                    onClose={close}
                    hasShared={hasShared}
                  />
                );
              }

              return (
                <div
                  key={row.id}
                  className="grid items-stretch border-t border-border first:border-t-0 hover:bg-muted/20"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span
                    className={`pt-2 text-center text-xs text-muted-foreground ${CELL} ${
                      dim ? "opacity-50" : ""
                    }`}
                  >
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
                      // Red: this row is blocked here, not merely different.
                      row.needs_flow
                        ? "text-destructive"
                        : "text-muted-foreground/25 hover:text-muted-foreground"
                    }`}
                  >
                    <Link2 className="h-3.5 w-3.5" />
                  </button>

                  <SummaryCell
                    value={row.name ?? ""}
                    onOpen={() => open(row.id, "name")}
                    placeholder={label}
                    label={`Case name for row ${i + 1}`}
                    dim={dim}
                    prose
                    wrap
                  />

                  <SummaryCell
                    value={row.path ?? ""}
                    onOpen={() => open(row.id, "path")}
                    placeholder="?org=acme"
                    label={`Path or query for ${label}`}
                    dim={dim}
                  />

                  <SummaryCell
                    value={body}
                    onOpen={() => open(row.id, "body")}
                    placeholder={"{\"email\": \"a@b.com\"}   — blank uses the Request tab’s body"}
                    label={`Body for ${label}`}
                    dim={dim}
                    tone={badJson ? "text-warning" : undefined}
                  />

                  <SummaryCell
                    value={check}
                    onOpen={() => open(row.id, "check")}
                    placeholder="400   — or an expression"
                    label={`Expected result for ${label}`}
                    dim={dim}
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
