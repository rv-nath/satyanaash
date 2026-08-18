import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus,
  Trash2,
  Copy,
  AlertTriangle,
  Link2,
  CircleSlash,
  Maximize2,
  SquarePen,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DataRow, Dataset } from "@/lib/api/types";
import type { HeaderRow } from "@/components/HeadersEditor";
import type { HeaderOrigin } from "@/lib/dataset";
import {
  addRow,
  addRowHeader,
  clearRowHeader,
  duplicateRow,
  effectiveHeaders,
  renameRowHeader,
  rowHeader,
  setRowHeader,
  suppressRowHeader,
  joinEndpoint,
  looksLikeInvalidJson,
  oneLine,
  pathVariables,
  rowPreview,
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
  /** The request's own headers, shown in a row's editor as what it inherits — so the author can
   *  see what the row actually sends, not only what it changes. */
  headers?: HeaderRow[];
  /** Shown, never edited, at the top of the row editor. A row's overrides mean nothing without
   *  the request they modify — and this is also what the Path suffix appends to and what
   *  declares the parameter names. */
  method?: string;
}

// parked, #, needs-flow, case, …one per request parameter…, path, body, expect, duplicate, delete.
// Every text column flexes now that none of them holds a field, and Case gets the most
// it can: it wraps rather than clipping, so width spent there is width spent on fewer
// wrapped lines. Expect was a fixed 150px for a value that is usually three digits.
const FIXED_GRID =
  "30px 30px 30px minmax(180px,1.1fr) minmax(100px,0.4fr) minmax(180px,1.2fr) minmax(90px,0.4fr) 34px 34px 34px";

/**
 * The grid, with **one** Parameters column inserted after Case when the request declares any.
 *
 * It used to insert one column per declared name, which made the table's shape a function of
 * the request's content: a column headed `channel`, or `bad_auth`. That is the genericness
 * problem — the column set should not depend on what one project happens to call its variables.
 * One column, always the same name, whatever the request declares.
 *
 * Absent entirely when nothing is declared, so a signup case looks exactly as it did.
 */
const gridFor = (params: string[]): string => {
  if (params.length === 0) return FIXED_GRID;
  const cols = FIXED_GRID.split(" ");
  // After parked, #, needs-flow and Case.
  return [...cols.slice(0, 4), "minmax(120px,0.8fr)", ...cols.slice(4)].join(" ");
};

/** Borders belong to the table, not to the fields — a field with its own border
 *  inside a bordered cell reads as a box in a box and wastes the width. */
const CELL = "border-r border-border";
const FIELD =
  "rounded-none border-0 bg-transparent shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-0";

/** How a row's actions appear: opacity only, so revealing them cannot move anything. `group` is
 *  on the row, so all three respond to hovering it rather than each other. */
const GUTTER_REVEAL =
  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100";

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

/**
 * The row editor's own copy of a row.
 *
 * Strings rather than `string | undefined`, so a field is never "absent" while being typed in and
 * the dirty check is a plain comparison. Converted back on commit, where blank means unset again.
 */
/**
 * Where a row is allowed to run — the two stored flags read as one three-way choice.
 *
 * `disabled` wins when both are set, matching the engine: `run_rows` skips a parked row whatever
 * the caller asked for, while `needs_flow` is honoured only by the editor's own run. Two
 * checkboxes could express a fourth combination that means nothing.
 */
type RunsMode = "everywhere" | "needs-flow" | "parked";

const runsOf = (row: DataRow): RunsMode =>
  row.disabled ? "parked" : row.needs_flow ? "needs-flow" : "everywhere";

const RUNS_LABEL: Record<RunsMode, string> = {
  everywhere: "Everywhere",
  "needs-flow": "Needs a flow",
  parked: "Parked",
};

const RUNS_HINT: Record<RunsMode, string> = {
  everywhere: "Runs from Run dataset and from a flow.",
  "needs-flow": "A flow runs it; Run dataset skips it, because the flow is the precondition.",
  parked: "Skipped everywhere until you enable it — it sends nothing and cannot fail.",
};

/** How each origin reads, and what to do about it. The wording matters more than it looks: the
 *  difference between *inherited* and *overridden* is the difference between what the request
 *  says and what this row says, and the author is here to change exactly that. */
const ORIGIN_NOTE: Record<HeaderOrigin, string> = {
  inherited: "from the request",
  overridden: "this case",
  suppressed: "not sent",
  "row-only": "this case only",
};

/**
 * A row's headers, over the request's.
 *
 * Shows **what the row sends**, not only what it changes — the request's own headers are listed
 * as inherited, so the author reads one screen instead of holding two lists in their head.
 * `effectiveHeaders` computes it, mirroring the engine's merge, which is the only version that
 * decides what actually goes on the wire.
 *
 * This is the section the whole page exists for. Before it, a credential could only differ
 * between rows by templating the header's value and giving each row a variable to fill — a name
 * invented for a workaround, invisible in the editor, and unable to express a header being
 * *absent* at all.
 */
function RowHeadersSection({
  dataset,
  row,
  requestHeaders,
  onChange,
}: {
  dataset: Dataset;
  row: DataRow;
  requestHeaders?: HeaderRow[];
  onChange: (d: Dataset) => void;
}) {
  const effective = effectiveHeaders(requestHeaders, row);

  return (
    <div className="space-y-2">
      {effective.length === 0 && (
        <p className="text-[13px] italic text-muted-foreground">
          This request sends no headers, and this case adds none.
        </p>
      )}
      {effective.map((h) => {
        const mine = rowHeader(row, h.key);
        const suppressed = h.origin === "suppressed";
        const inherited = h.origin === "inherited";
        return (
          <div key={h.key} className="flex items-center gap-2">
            {/* Ticked means sent. Unticking is the only way to say "no such header" — a value
                cannot say it, because blank means "unset" everywhere else here. */}
            <input
              type="checkbox"
              checked={!suppressed}
              onChange={(e) =>
                onChange(suppressRowHeader(dataset, row.id, h.key, !e.target.checked))
              }
              aria-label={`Send ${h.key}`}
              className="shrink-0"
            />
            <code className="w-44 shrink-0 truncate font-mono text-[12px]" title={h.key}>
              {h.key}
            </code>
            {inherited ? (
              // Not a disabled input: a greyed box invites a click that does nothing. The
              // request's value as text, and one button that says what will happen.
              <>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted-foreground"
                  title={h.value}
                >
                  {h.value || "—"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 text-[11px]"
                  onClick={() => onChange(setRowHeader(dataset, row.id, h.key, h.value))}
                  aria-label={`Override ${h.key} for this case`}
                >
                  Override
                </Button>
              </>
            ) : (
              <>
                <Input
                  value={mine?.value ?? ""}
                  onChange={(e) => onChange(setRowHeader(dataset, row.id, h.key, e.target.value))}
                  placeholder="—"
                  aria-label={`${h.key} for this case`}
                  disabled={suppressed}
                  className="h-8 min-w-0 flex-1 font-mono text-[13px]"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => onChange(clearRowHeader(dataset, row.id, h.key))}
                  aria-label={`Stop overriding ${h.key}`}
                >
                  Reset
                </Button>
              </>
            )}
            <span className="w-24 shrink-0 text-right text-[11px] text-muted-foreground">
              {ORIGIN_NOTE[h.origin]}
            </span>
          </div>
        );
      })}

      {/* Entries with no name yet — they exist on the row but the engine ignores them until they
          have a key, so they need somewhere to be typed. */}
      {(row.headers ?? []).map((h, i) =>
        h.key.trim() ? null : (
          <div key={`blank-${i}`} className="flex items-center gap-2">
            <span className="w-4 shrink-0" />
            <Input
              value=""
              onChange={(e) => onChange(renameRowHeader(dataset, row.id, "", e.target.value))}
              placeholder="Header name"
              aria-label="New header name"
              className="h-8 w-44 shrink-0 font-mono text-[13px]"
            />
            <Input
              value={h.value}
              onChange={(e) => onChange(setRowHeader(dataset, row.id, "", e.target.value))}
              placeholder="value"
              aria-label="New header value"
              className="h-8 min-w-0 flex-1 font-mono text-[13px]"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 text-[11px] text-muted-foreground hover:text-destructive"
              onClick={() => onChange(clearRowHeader(dataset, row.id, ""))}
              aria-label="Remove this header"
            >
              Remove
            </Button>
            <span className="w-24 shrink-0" />
          </div>
        ),
      )}

      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-[11px]"
        onClick={() => onChange(addRowHeader(dataset, row.id))}
      >
        <Plus className="h-3 w-3" />
        Add a header this case alone sends
      </Button>
    </div>
  );
}

/**
 * One case, on a page of its own.
 *
 * It was a dialog first, and outgrew it the moment headers arrived: `max-h-[60vh]` was already
 * clipping the body field with five sections in it. A page also gets the things a modal cannot —
 * the browser's back button, a URL that can be pasted, and no fight with the document-level
 * Escape listener that `EditableCell` still carries scar tissue from.
 *
 * **No draft, no Save.** Edits go straight through the same reducers the table's inline cells
 * use, and the test case's own dirty-and-save owns the result. A modal needs Cancel because it
 * is a detour; a page is just where you are.
 *
 * The matrix is what you give up by being here, so the header offers the way back and a way
 * along: *row 3 of 13*, with prev and next, because walking a dataset case by case is exactly
 * what you come to a page like this to do.
 */
function RowPage({
  dataset,
  row,
  index,
  names,
  requestHeaders,
  endpoint,
  method,
  sharedAssertion,
  onChange,
  onClose,
  onGo,
}: {
  dataset: Dataset;
  row: DataRow;
  index: number;
  names: string[];
  requestHeaders?: HeaderRow[];
  endpoint?: string;
  method?: string;
  sharedAssertion?: string;
  onChange: (d: Dataset) => void;
  onClose: () => void;
  onGo: (delta: number) => void;
}) {
  const total = dataset.rows.length;
  const label = rowLabel(index, row);
  const mode = runsOf(row);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2" onClick={onClose}>
          <ChevronLeft className="h-4 w-4" />
          All {total} {total === 1 ? "case" : "cases"}
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            case {index + 1} of {total}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => onGo(-1)}
            disabled={index === 0}
            aria-label="Previous case"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => onGo(1)}
            disabled={index === total - 1}
            aria-label="Next case"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-[15px] font-semibold" style={{ color: "hsl(var(--lead-color))" }}>
          {label}
        </h3>
        {/* The request this case varies, shown and never editable — a case cannot change the
            method or the endpoint, and a box would say it can. It is here because the path
            suffix appends to it and the parameters below are declared by it. */}
        <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
          {method ? `${method} ` : ""}
          {endpoint ?? ""}
        </p>
      </div>

      <Labelled label="Case name" hint="what this case is trying">
        <Input
          value={row.name ?? ""}
          onChange={(e) => onChange(setRowName(dataset, row.id, e.target.value))}
          placeholder="what this case is trying"
          aria-label="Case name"
          className="h-9 max-w-xl text-[13px]"
        />
      </Labelled>

      <Labelled label="Headers" hint="Ticked headers are sent. Untick one to send no such header.">
        <RowHeadersSection
          dataset={dataset}
          row={row}
          requestHeaders={requestHeaders}
          onChange={onChange}
        />
      </Labelled>

      {/* Absent, not empty, when the endpoint declares nothing — a section headed "Parameters"
          with no fields under it reads as something failing to load. */}
      {names.length > 0 && (
        <Labelled label="Parameters" hint="blank falls back to the environment or an earlier step">
          <div className="max-w-xl space-y-2">
            {names.map((name) => (
              <div key={name} className="flex items-center gap-2">
                <code className="w-44 shrink-0 truncate font-mono text-[12px] text-primary">
                  {`{{${name}}}`}
                </code>
                <Input
                  value={rowVar(row, name)}
                  onChange={(e) => onChange(setRowVar(dataset, row.id, name, e.target.value))}
                  placeholder="—"
                  aria-label={`${name} for this case`}
                  className="h-8 min-w-0 flex-1 font-mono text-[13px]"
                />
              </div>
            ))}
          </div>
        </Labelled>
      )}

      <Labelled
        label="Path / query"
        hint={
          (row.path ?? "").trim()
            ? `Appended to the request's endpoint: …${joinEndpoint("", row.path ?? "")}`
            : "Appended to the request's endpoint (e.g. ?org=acme) — blank sends it as authored"
        }
      >
        <Input
          value={row.path ?? ""}
          onChange={(e) => onChange(setRowPath(dataset, row.id, e.target.value))}
          placeholder="?org=acme"
          aria-label="Path or query"
          className="h-9 max-w-xl font-mono text-[13px]"
        />
      </Labelled>

      <Labelled
        label="Body"
        hint={
          (row.body ?? "").trim()
            ? looksLikeInvalidJson(row.body ?? "")
              ? "This does not look like JSON."
              : "Sent instead of the request's body."
            : "Blank uses the request's body."
        }
      >
        <Textarea
          value={row.body ?? ""}
          onChange={(e) => onChange(setRowBody(dataset, row.id, e.target.value))}
          placeholder={'{"email": "a@b.com"}'}
          aria-label="Body"
          className={`scrollbar-hairline h-[220px] w-full resize-y whitespace-pre font-mono text-[13px] ${
            (row.body ?? "").trim() && looksLikeInvalidJson(row.body ?? "") ? "text-warning" : ""
          }`}
        />
      </Labelled>

      <Labelled
        label="Expect"
        hint={
          !(row.check ?? "").trim()
            ? sharedAssertion?.trim()
              ? "Blank — this case passes on any 2xx (the Scripts tab is not used for cases)."
              : "Blank — this case passes on any 2xx."
            : isStatusShorthand(row.check ?? "")
              ? `Shorthand for response.status == ${(row.check ?? "").trim()}`
              : "Rhai expression — must end in something true or false."
        }
      >
        <Input
          value={row.check ?? ""}
          onChange={(e) => onChange(setRowCheck(dataset, row.id, e.target.value))}
          placeholder="401   — or an expression"
          aria-label="Expect"
          className="h-9 max-w-xl font-mono text-[13px]"
        />
      </Labelled>

      <Labelled label="Runs" hint={RUNS_HINT[mode]}>
        <div className="flex flex-wrap gap-4">
          {(["everywhere", "needs-flow", "parked"] as RunsMode[]).map((m) => (
            <label key={m} className="flex items-center gap-1.5 text-[13px]">
              <input
                type="radio"
                name="runs"
                checked={mode === m}
                onChange={() => {
                  const next = setRowNeedsFlow(dataset, row.id, m === "needs-flow");
                  onChange(setRowDisabled(next, row.id, m === "parked"));
                }}
              />
              {RUNS_LABEL[m]}
            </label>
          ))}
        </div>
      </Labelled>
    </div>
  );
}

/** What the Parameters heading says on hover: the names it stands for. The heading is one fixed
 *  word now, so this is the only place the declared names are written out — without it the column
 *  would not say what it holds. */
function paramsTitle(params: string[]): string {
  return `Each case's own values for:\n${params.map((n) => `{{${n}}}`).join("\n")}`;
}

/** A field with its name above it and, below, what is true when it is blank. Every field on this
 *  page has a fallback and each one's is different, so the sentence belongs beside the box rather
 *  than in a legend nobody reads. */
function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function DatasetEditor({
  dataset,
  onChange,
  sharedAssertion,
  endpoint,
  headers,
  method,
}: DatasetEditorProps) {
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
  // Read off the request rather than declared: you already named them in the URL, or in a
  // header value. Endpoint names lead, because you read those off the URL in order.
  const params = useMemo(() => pathVariables(endpoint), [endpoint]);
  const grid = gridFor(params);

  /**
   * Which case is open, in the URL.
   *
   * By **id**, not index — a duplicate or a remove would silently repoint an index at a different
   * case. In the URL rather than in state so the browser's back button leaves the case, the link
   * can be pasted, and reopening the tab lands where you were. Merged into the existing params
   * rather than replacing them, or opening a case would drop `?flow=` and `?rail=`.
   *
   * Pushed, not replaced: leaving a case is what Back should do here, which is the whole reason
   * this is a page.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const openRowId = searchParams.get("row");
  const openRowIndex = rows.findIndex((r) => r.id === openRowId);
  const openRow = openRowIndex >= 0 ? rows[openRowIndex] : null;
  const setEditingRow = (id: string | null) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("row", id);
        else next.delete("row");
        return next;
      },
      // Replaced when clearing: Back from the table should leave the Data tab, not step through
      // every case visited on the way.
      id ? undefined : { replace: true },
    );

  // The page replaces the table rather than sitting beside it: this is a detail view, and the
  // matrix behind it would be scrolled away and unreadable anyway. Everything about getting back
  // to it lives in the page's own header.
  if (openRow) {
    return (
      <RowPage
        dataset={dataset}
        row={openRow}
        index={openRowIndex}
        names={params}
        requestHeaders={headers}
        endpoint={endpoint}
        method={method}
        sharedAssertion={sharedAssertion}
        onChange={onChange}
        onClose={() => setEditingRow(null)}
        onGo={(delta) => {
          const next = rows[openRowIndex + delta];
          if (next) setEditingRow(next.id);
        }}
      />
    );
  }

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
              {["Case", ...(params.length > 0 ? ["Parameters"] : []), "Path / query", "Body", "Expect"].map((h, hi) => {
                // The Parameters heading is a fixed word like every other heading now — it
                // used to be the variable's own name, which made the table's shape a function
                // of the request's content. It keeps the primary tint, because the column is
                // still conditional on the request declaring something.
                const param = params.length > 0 && hi === 1;
                return (
                  <span
                    key={h}
                    className={`truncate px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${CELL} ${
                      param ? "text-primary" : "text-muted-foreground"
                    }`}
                    // Naming the declared names and where each came from, because the two
                    // behave differently: an endpoint parameter changes what you ask for, a
                    // header value changes how you ask — most often the credential you ask with.
                    title={param ? paramsTitle(params) : undefined}
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
              // The values this row sets, as the Parameters cell reads them.
              const preview = rowPreview(row, params);

              return (
                <div
                  key={row.id}
                  className={`group grid items-stretch border-t border-border first:border-t-0 hover:bg-muted/20 ${
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

                  {/* One column for all of them, and it shows the **values** — an icon here
                      would say that a row sets something without saying what, which is the
                      complaint this whole column exists to answer. Scanning down it is how you
                      see what the matrix actually varies; clicking opens the row's own form,
                      because a token does not fit in a cell and a name that only a header
                      declares has nowhere else to be edited. */}
                  {params.length > 0 && (
                    <div className={`min-w-0 ${CELL} ${dim ? "opacity-50" : ""}`}>
                      <button
                        type="button"
                        onClick={() => setEditingRow(row.id)}
                        aria-label={`Parameters for ${label}`}
                        title={preview || undefined}
                        className="flex h-9 w-full items-center px-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        {preview ? (
                          <span className="truncate font-mono text-[13px]">{preview}</span>
                        ) : (
                          // What is *true* of an empty cell, in prose, never an example — the
                          // same rule the body and expect cells follow.
                          <span className="truncate text-[11px] italic text-muted-foreground">
                            sets none of them
                          </span>
                        )}
                      </button>
                    </div>
                  )}

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

                  {/* Three actions on this row, revealed by hovering it or tabbing into them.
                      Always-present icons decorate every row with controls you want on one — the
                      same argument the ⊘ and ⛓ markers already make on the other side.

                      **Opacity, never width.** The cells keep their 34px whether or not the icons
                      show, because a gutter that appears on hover and reflows the row would shift
                      every value sideways as the pointer travels down twenty rows.

                      Keyed off the row, not the cell, so moving between the three does not make
                      them flicker — and `focus-visible` is what keeps the row editor reachable
                      without a mouse. */}
                  <div className={CELL}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-9 w-full rounded-none text-muted-foreground transition-opacity hover:text-foreground ${GUTTER_REVEAL}`}
                      onClick={() => setEditingRow(row.id)}
                      aria-label={`Edit ${label}`}
                      title="Edit this case — everything it carries"
                    >
                      <SquarePen className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className={CELL}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-9 w-full rounded-none text-muted-foreground transition-opacity hover:text-foreground ${GUTTER_REVEAL}`}
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
                    className={`h-9 w-full rounded-none text-muted-foreground transition-opacity hover:text-destructive ${GUTTER_REVEAL}`}
                    onClick={() => onChange(removeRow(dataset, row.id))}
                    aria-label={`Remove ${label}`}
                    title="Remove this case"
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
