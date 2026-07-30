import { useMemo, useState, type ReactNode } from "react";
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
  pathVariables,
  removeRow,
  rowVar,
  rowLabel,
  isStatusShorthand,
  setRowBody,
  setRowCheck,
  setRowName,
  setRowNeedsFlow,
  setRowPath,
  setRowVar,
} from "@/lib/dataset";

interface DatasetEditorProps {
  dataset: Dataset;
  onChange: (dataset: Dataset) => void;
  /** Used only to explain what a row with no check of its own falls back to. */
  sharedAssertion?: string;
  /** The request's endpoint. Its `{{names}}` become a column each, so a row can be the
   *  SMS case and the next the email one without the endpoint being cut down to a
   *  prefix for rows to append to. */
  endpoint?: string;
}

// #, needs-flow, case, …one per endpoint parameter…, path, body, expect, duplicate, delete.
// Every text column flexes now that none of them holds a field, and Case gets the most
// it can: it wraps rather than clipping, so width spent there is width spent on fewer
// wrapped lines. Expect was a fixed 150px for a value that is usually three digits.
const FIXED_GRID =
  "30px 30px minmax(180px,1.1fr) minmax(100px,0.4fr) minmax(180px,1.2fr) minmax(90px,0.4fr) 34px 34px";

/**
 * The grid, with a column per endpoint parameter inserted after Case.
 *
 * Parameters hold ids and enum values rather than prose, so they get narrow flexible
 * columns; when there are enough of them to overrun the pane, the table scrolls rather
 * than squeezing the body. Each stays comparable down its own column, which is what a
 * matrix is for.
 */
const gridFor = (params: string[]): string => {
  if (params.length === 0) return FIXED_GRID;
  const cols = FIXED_GRID.split(" ");
  const paramCols = params.map(() => "minmax(90px,0.5fr)").join(" ");
  // After #, needs-flow and Case.
  return [...cols.slice(0, 3), paramCols, ...cols.slice(3)].join(" ");
};

/** Borders belong to the table, not to the fields — a field with its own border
 *  inside a bordered cell reads as a box in a box and wastes the width. */
const CELL = "border-r border-border";
const FIELD =
  "rounded-none border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0";

/** Which cell of which row is being edited. One at a time. */
type Field = "name" | "body" | "check";

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
  /** Muted, because this row isn't part of this run — see `needs_flow`. Applied to the
   *  cell rather than the whole row so the red marker beside it stays vivid: CSS opacity
   *  can't be undone by a child. */
  dim?: boolean;
  /** Proportional rather than monospace — a case name is prose, not a payload. */
  prose?: boolean;
  /**
   * Show all of it, wrapping and growing the row, instead of clipping to one line.
   *
   * For the Case column. A row's name is what identifies it — reading the matrix means
   * reading the names, and a name you have to hover to finish is not readable. A payload
   * is different: nobody reads a fifteen-line body out of a table cell, so it stays one
   * line, minified, and opens when you want it.
   */
  wrap?: boolean;
  /** How tall the editor grows to. */
  editorHeight: string;
}

/**
 * A cell that grows into a real editor while you're in it.
 *
 * Collapsed it's a button, not a field: a `<input>` cannot show an ellipsis, and a
 * pretty-printed body would preview as a lone "{". Wrapped cells show everything;
 * clipped ones carry the whole value as a tooltip.
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
  dim,
  prose,
  wrap,
  editorHeight,
}: CellProps) {
  if (!editing) {
    const preview = oneLine(value);
    return (
      <div className={`min-w-0 ${CELL} ${dim ? "opacity-50" : ""}`}>
        <button
          type="button"
          onClick={onEdit}
          onFocus={onEdit}
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
        className={`scrollbar-hairline ${editorHeight} min-h-0 w-full resize-y px-2 py-1.5 ${
          // A body keeps its authored line breaks; a name is prose and wraps.
          wrap ? "whitespace-normal" : "whitespace-pre"
        } ${prose ? "text-[13px]" : "font-mono text-xs"} ${FIELD}`}
      />
      {hint && <div className="px-2 pb-1.5">{hint}</div>}
    </div>
  );
}

export function DatasetEditor({ dataset, onChange, sharedAssertion, endpoint }: DatasetEditorProps) {
  // One cell at a time: which row, and which of its fields. A matrix is for comparing
  // rows, and several rows swollen at once stops being one.
  const [editing, setEditing] = useState<{ rowId: string; field: Field } | null>(null);
  const isEditing = (rowId: string, field: Field) =>
    editing?.rowId === rowId && editing.field === field;
  const edit = (rowId: string, field: Field) => () => setEditing({ rowId, field });
  const done = (rowId: string, field: Field) => () =>
    setEditing((cur) => (cur?.rowId === rowId && cur.field === field ? null : cur));
  const { rows } = dataset;
  const hasShared = !!sharedAssertion?.trim();
  // Read off the endpoint rather than declared: you already named them in the URL.
  const params = useMemo(() => pathVariables(endpoint), [endpoint]);
  const grid = gridFor(params);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[15px] font-semibold" style={{ color: "hsl(var(--lead-color))" }}>
            Run this test against several bodies
          </p>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">
            One row per case. Each row sends its own body and says what should come back —
            useful for negative and edge cases without building a flow. Click a case or a
            body to edit it with room.
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
              style={{ gridTemplateColumns: grid }}
            >
              <span className={CELL} />
              <span
                className={`flex items-center justify-center text-muted-foreground ${CELL}`}
                title="Needs a flow — Run dataset skips these rows"
              >
                <Link2 className="h-3 w-3" />
              </span>
              {["Case", ...params, "Path / query", "Body", "Expect"].map((h, hi) => {
                // A parameter's heading is its name from the URL, so it keeps the
                // author's casing and takes the primary tint that marks it as something
                // the endpoint asked for rather than a fixed column. One casing class or
                // the other, never both: two of them in the same string are settled by
                // stylesheet order, not by which was written last.
                const param = hi > 0 && hi <= params.length;
                return (
                  <span
                    key={h}
                    className={`truncate px-2 py-1.5 text-[10px] font-semibold tracking-wider ${CELL} ${
                      param ? "font-mono normal-case text-primary" : "uppercase text-muted-foreground"
                    }`}
                    title={param ? `{{${h}}} in the endpoint — each row's value for it` : undefined}
                  >
                    {h}
                  </span>
                );
              })}
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

              return (
                <div
                  key={row.id}
                  className="grid items-stretch border-t border-border first:border-t-0 hover:bg-muted/20"
                  style={{ gridTemplateColumns: grid }}
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

                  {/* Wrapped when idle, so the name — the row's identity — is readable
                      without hovering; a roomy field when you're in it. */}
                  <EditableCell
                    value={row.name ?? ""}
                    onChange={(v) => onChange(setRowName(dataset, row.id, v))}
                    editing={isEditing(row.id, "name")}
                    onEdit={edit(row.id, "name")}
                    onDone={done(row.id, "name")}
                    placeholder={label}
                    label={`Case name for row ${i + 1}`}
                    dim={dim}
                    prose
                    wrap
                    editorHeight="h-[72px]"
                  />

                  {/* One per `{{name}}` in the endpoint. Live fields: an id or an enum
                      value is short, and these are the columns you scan down to see what
                      this matrix actually varies. Blank means this row doesn't set it,
                      so it resolves from wherever it would have anyway. */}
                  {params.map((name) => (
                    <div key={name} className={`min-w-0 ${CELL} ${dim ? "opacity-50" : ""}`}>
                      <Input
                        value={rowVar(row, name)}
                        placeholder="—"
                        onChange={(e) => onChange(setRowVar(dataset, row.id, name, e.target.value))}
                        className={`h-9 px-2 font-mono text-[13px] ${FIELD}`}
                        aria-label={`${name} for ${label}`}
                        title={`{{${name}}} for this row — blank falls back to the environment or an earlier step`}
                      />
                    </div>
                  ))}

                  {/* Short by nature — a live field, no expanding needed. */}
                  <div className={`min-w-0 ${CELL} ${dim ? "opacity-50" : ""}`}>
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
                    editing={isEditing(row.id, "body")}
                    onEdit={edit(row.id, "body")}
                    onDone={done(row.id, "body")}
                    placeholder={"{\"email\": \"a@b.com\"}   — blank uses the Request tab’s body"}
                    label={`Body for ${label}`}
                    dim={dim}
                    tone={badJson ? "text-warning" : undefined}
                    editorHeight="h-[220px]"
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
                    editing={isEditing(row.id, "check")}
                    onEdit={edit(row.id, "check")}
                    onDone={done(row.id, "check")}
                    placeholder="400   — or an expression"
                    label={`Expected result for ${label}`}
                    dim={dim}
                    editorHeight="h-[88px]"
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
