import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  Trash2,
  Copy,
  AlertTriangle,
  Link2,
  CircleSlash,
  Maximize2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  setRowDisabled,
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

// parked, #, needs-flow, case, …one per endpoint parameter…, path, body, expect, duplicate, delete.
// Every text column flexes now that none of them holds a field, and Case gets the most
// it can: it wraps rather than clipping, so width spent there is width spent on fewer
// wrapped lines. Expect was a fixed 150px for a value that is usually three digits.
const FIXED_GRID =
  "30px 30px 30px minmax(180px,1.1fr) minmax(100px,0.4fr) minmax(180px,1.2fr) minmax(90px,0.4fr) 34px 34px";

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
  // After parked, #, needs-flow and Case.
  return [...cols.slice(0, 4), paramCols, ...cols.slice(4)].join(" ");
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
  /**
   * An example, shown **only while editing**.
   *
   * It cannot be shown collapsed. These cells are `border-0 bg-transparent` — invisible
   * until focused — so a sample body sitting in an empty cell reads as a real body, and the
   * author only discovers otherwise by clicking in and typing. `whenEmpty` is what a
   * collapsed empty cell says instead.
   */
  placeholder: string;
  /**
   * What is *true* when this cell is blank — not an example of what could go in it.
   *
   * Rendered as italic prose, never in the mono face the values use, because the one thing
   * it must never be mistaken for is a value.
   */
  whenEmpty: string;
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
   * Offer room to write in, in a dialog.
   *
   * For the cells that hold code rather than a word: Expect is a `minmax(90px,0.4fr)` column,
   * and expanding in place leaves a Rhai expression in ninety pixels. Opt-in rather than on
   * every cell — a three-character path parameter does not need a dialog, and an icon in every
   * cell of twenty-one rows is the clutter this table was cleaned up to remove.
   */
  expandable?: boolean;
  /**
   * Ruled through, because this row is parked.
   *
   * Only ever the Case name. A line through monospace JSON collides with the braces and
   * quotes and stops the payload being readable at all, and the payload is what you come
   * back to finish. Not applied while editing either — you can't read what you're typing
   * through a line.
   */
  struck?: boolean;
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
  whenEmpty,
  label,
  tone,
  hint,
  dim,
  prose,
  struck,
  wrap,
  editorHeight,
  expandable,
}: CellProps) {
  // Local, because it is about this moment and not something to remember. Also what tells the
  // blur handler below to hold its fire.
  const [expanded, setExpanded] = useState(false);
  /**
   * The dialog's own copy, committed on Save.
   *
   * Live-editing the cell would have made Escape mean *keep* — and Escape means abandon
   * everywhere else in this app and every other one. A modal that cannot be backed out of is
   * not a modal; the price is one snapshot to diff against.
   */
  const [draft, setDraft] = useState(value);
  const dirty = draft !== value;

  const openBig = () => {
    setDraft(value);
    setExpanded(true);
  };
  const closeBig = (save: boolean) => {
    if (save) onChange(draft);
    setExpanded(false);
    onDone();
  };

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
          } ${struck ? "line-through" : ""} ${
            preview
              ? `${prose ? "text-[13px]" : "font-mono text-xs"} ${tone ?? "text-foreground"}`
              : // Italic, proportional and dimmer: three signals that this is the editor
                // talking about an empty cell, not the cell's contents. One of them —
                // dropping the mono face — is the one that actually stops a JSON-shaped
                // note from reading as JSON.
                "text-[13px] italic text-muted-foreground/60"
          }`}
        >
          {preview || whenEmpty}
        </button>
      </div>
    );
  }
  const monospace = prose ? "text-[13px]" : "font-mono text-xs";

  return (
    <div className={`relative min-w-0 ${CELL}`}>
      <Textarea
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the click that opened
        // this cell was aimed at the field it replaces.
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Held while the dialog is open: the dialog taking focus is a blur, and collapsing the
        // cell would unmount the dialog along with it.
        onBlur={() => {
          if (!expanded) onDone();
        }}
        placeholder={placeholder}
        aria-label={label}
        className={`scrollbar-hairline ${editorHeight} min-h-0 w-full resize-y px-2 py-1.5 ${
          // A body keeps its authored line breaks; a name is prose and wraps.
          wrap ? "whitespace-normal" : "whitespace-pre"
        } ${expandable ? "pr-7" : ""} ${monospace} ${FIELD}`}
      />
      {expandable && (
        <button
          type="button"
          // Without this the mousedown blurs the textarea, `onDone` collapses the cell, and the
          // button is gone before the click lands on it.
          onMouseDown={(e) => e.preventDefault()}
          onClick={openBig}
          // Not "Edit {label} in a larger editor": that string contains the cell's own label,
          // so every existing query for the cell matched the button too. Exactly one cell edits
          // at a time, so one of these is on screen at once, and the dialog it opens is titled
          // with the cell's full label.
          aria-label="Room to write"
          title="Room to write"
          className="absolute right-0.5 top-0.5 rounded p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      )}
      {hint && <div className="px-2 pb-1.5">{hint}</div>}

      <Dialog open={expanded} onOpenChange={(open) => !open && closeBig(false)}>
        <DialogContent
          className="max-w-2xl"
          // Belt to the braces in `TestCaseEditor`: that document-level Escape listener closed
          // the whole editor when a dialog inside it was dismissed. It now ignores Escape while
          // a modal is open; stopping it here as well means neither fix alone is load-bearing.
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="text-sm">{label}</DialogTitle>
            <DialogDescription className="text-[13px]">
              {/* Says what the two buttons do, because a modal over a live table has to be
                  clear about which of the two versions survives. */}
              Save keeps this; Escape or Cancel leaves the cell as it was.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the dialog was opened to type in.
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // The shortcut for "done" that does not fight the newline this field is for.
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                closeBig(true);
              }
            }}
            placeholder={placeholder}
            aria-label={label}
            className={`scrollbar-hairline h-[320px] w-full resize-none whitespace-pre ${monospace}`}
          />
          {hint}
          <DialogFooter className="gap-2 sm:justify-between">
            <span className="self-center text-[11px] text-muted-foreground">
              {dirty ? "Unsaved changes" : "No changes"}
            </span>
            <span className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => closeBig(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => closeBig(true)} disabled={!dirty}>
                Save
              </Button>
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
              <span
                className={`flex items-center justify-center text-muted-foreground ${CELL}`}
                title="Parked — a row you're still drafting, skipped everywhere"
              >
                <CircleSlash className="h-3 w-3" />
              </span>
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
              // Parked, or waiting on a flow: either way this row takes no part in a
              // Run dataset, and its fields step back to say so.
              const parked = row.disabled === true;
              const dim = parked || row.needs_flow === true;

              return (
                <div
                  key={row.id}
                  className={`grid items-stretch border-t border-border first:border-t-0 hover:bg-muted/20 ${
                    // Tinted rather than fainter: 50% is already near the legibility
                    // floor, and a parked row is one you mean to come back and finish.
                    parked ? "bg-muted/30" : ""
                  }`}
                  style={{ gridTemplateColumns: grid }}
                >
                  {/* Parked. Nothing is drawn for a row that runs: running is the norm,
                      and decorating every row with a tick spends attention saying
                      "normal". Ghosted until hovered, exactly as the ⛓ beside it — amber
                      rather than red, because parking is a choice, not a blockade. */}
                  <button
                    type="button"
                    onClick={() => onChange(setRowDisabled(dataset, row.id, !parked))}
                    aria-label={`${parked ? "Enable" : "Disable"} ${label}`}
                    aria-pressed={parked}
                    title={
                      parked
                        ? "Parked — skipped everywhere until you enable it"
                        : "Park this row while you draft it"
                    }
                    className={`flex h-9 items-center justify-center transition-colors ${CELL} ${
                      parked
                        ? "text-warning"
                        : "text-muted-foreground/25 hover:text-muted-foreground"
                    }`}
                  >
                    <CircleSlash className="h-3.5 w-3.5" />
                  </button>

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
                    placeholder="what this case is trying"
                    whenEmpty={label}
                    label={`Case name for row ${i + 1}`}
                    dim={dim}
                    prose
                    struck={parked}
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
                      // Italic and proportional, for the same reason the collapsed cells
                      // are: `?org=acme` in this column's mono face read as a path this row
                      // actually sends. The example lives in the tooltip now.
                      placeholder="as authored"
                      onChange={(e) => onChange(setRowPath(dataset, row.id, e.target.value))}
                      className={`h-9 px-2 font-mono text-[13px] placeholder:font-sans placeholder:italic placeholder:text-muted-foreground/60 ${FIELD}`}
                      aria-label={`Path or query for ${label}`}
                      title={
                        row.path?.trim()
                          ? `Appended to the request's endpoint: …${joinEndpoint("", row.path)}`
                          : "Appended to the request's endpoint (e.g. ?org=acme) — blank sends it as authored"
                      }
                    />
                  </div>

                  <EditableCell
                    value={body}
                    onChange={(v) => onChange(setRowBody(dataset, row.id, v))}
                    editing={isEditing(row.id, "body")}
                    onEdit={edit(row.id, "body")}
                    onDone={done(row.id, "body")}
                    placeholder={"{\"email\": \"a@b.com\"}"}
                    // The fault this replaces: the example above was shown collapsed and
                    // truncated, so a blank cell read as `{"email": "a@b.com"}` — a body
                    // this row does not have. What is true is that it sends the request's.
                    whenEmpty="uses the request’s body"
                    label={`Body for ${label}`}
                    dim={dim}
                    tone={badJson ? "text-warning" : undefined}
                    editorHeight="h-[220px]"
                    expandable
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
                    // Not "e.g. 400": blank *is* a rule — `Check::Unstated` requires a 2xx —
                    // and this is the same words the result reports as what was expected.
                    whenEmpty="any 2xx"
                    label={`Expected result for ${label}`}
                    dim={dim}
                    editorHeight="h-[88px]"
                    expandable
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
