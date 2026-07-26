import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import type { Dataset, PayloadMode } from "@/lib/api/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  addColumn,
  rowOverrides,
  setRowPayload,
  setRowPayloadMode,
  addRow,
  isValidColumnName,
  removeColumn,
  removeRow,
  renameColumn,
  rowLabel,
  setCell,
  setRowAssertion,
  setRowName,
} from "@/lib/dataset";

interface DatasetEditorProps {
  dataset: Dataset;
  onChange: (dataset: Dataset) => void;
  /** Shown as the fallback when a row has no assertion of its own. */
  sharedAssertion?: string;
}

export function DatasetEditor({ dataset, onChange, sharedAssertion }: DatasetEditorProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const { columns, rows } = dataset;
  // name | one per column | expand | delete
  const gridCols = `160px repeat(${Math.max(columns.length, 1)}, minmax(140px, 1fr)) 32px 32px`;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[15px] font-semibold" style={{ color: "hsl(var(--lead-color))" }}>
            Run this test with several sets of values
          </p>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">
            Each row runs the request once. A row's values become{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{"{{column}}"}</code>{" "}
            for that run, and are readable in scripts as{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">data.column</code>.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onChange(addColumn(dataset))}>
            <Plus className="h-3.5 w-3.5" /> Column
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onChange(addRow(dataset))}>
            <Plus className="h-3.5 w-3.5" /> Row
          </Button>
        </div>
      </div>

      {columns.length === 0 ? (
        // Teach the model rather than just saying "empty" — a column is a
        // variable name, a row is one run.
        <div className="rounded-lg border border-dashed border-border p-6">
          <p className="text-[13px] font-medium text-foreground">
            A <span className="text-primary">column</span> is a variable, a{" "}
            <span className="text-primary">row</span> is one run.
          </p>
          <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
            Add a column per value that changes, then a row per case. Each row sends the request
            once, substituting its own values.
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="text-[12px]">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="px-2 py-1 text-left font-medium">Case</th>
                  <th className="px-2 py-1 text-left font-mono font-medium">email</th>
                  <th className="px-2 py-1 text-left font-mono font-medium">expected_status</th>
                </tr>
              </thead>
              <tbody className="font-mono text-muted-foreground">
                <tr className="border-t border-border/60">
                  <td className="px-2 py-1 font-sans">missing email</td>
                  <td className="px-2 py-1 italic opacity-60">(blank)</td>
                  <td className="px-2 py-1">400</td>
                </tr>
                <tr className="border-t border-border/60">
                  <td className="px-2 py-1 font-sans">valid</td>
                  <td className="px-2 py-1">a@b.com</td>
                  <td className="px-2 py-1">201</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mt-4 max-w-2xl text-[12px] leading-relaxed text-muted-foreground">
            Use <code className="rounded bg-muted px-1 font-mono">{"{{email}}"}</code> in the
            request, and read any column in a check as{" "}
            <code className="rounded bg-muted px-1 font-mono">data.expected_status</code>. A column
            need not be sent anywhere — <code className="rounded bg-muted px-1 font-mono">expected_status</code>{" "}
            exists only for the check.
          </p>

          <Button variant="outline" size="sm" className="mt-4 gap-1.5" onClick={() => onChange(addColumn(dataset))}>
            <Plus className="h-3.5 w-3.5" /> Add the first column
          </Button>
        </div>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <div className="min-w-max space-y-1.5">
            {/* Header band: the column NAMES. Tinted and borderless so it reads
                as a header you may edit, not as another data row. */}
            <div
              className="grid items-center gap-2 rounded-t-md border-b-2 border-border bg-muted/50 px-1 py-1.5"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span className="pl-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Case
              </span>
              {columns.map((col) => {
                const valid = isValidColumnName(col);
                return (
                  <div key={col} className="group flex items-center gap-1">
                    <Input
                      defaultValue={col}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next && next !== col) onChange(renameColumn(dataset, col, next));
                        else e.target.value = col;
                      }}
                      className={`h-7 border-transparent bg-transparent px-2 font-mono text-xs font-semibold shadow-none hover:border-input focus-visible:border-input ${
                        valid ? "" : "border-destructive text-destructive"
                      }`}
                      title={
                        valid
                          ? `Sent as {{${col}}} — click to rename`
                          : "Only letters, digits and _ (not starting with a digit) work as {{variables}}"
                      }
                    />
                    {!valid && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      onClick={() => onChange(removeColumn(dataset, col))}
                      aria-label={`Remove column ${col}`}
                      title={`Remove column "${col}"`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
              <span />
              <span />
            </div>

            {rows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                No rows yet — add one to run this test with these columns.
              </div>
            ) : (
              rows.map((row, i) => {
                const open = expanded.has(row.id);
                const hasOwn = !!(row.assertion ?? "").trim();
                const overrides = rowOverrides(row);
                const mode: PayloadMode = row.payload_mode ?? "shared";
                return (
                  <div key={row.id} className="space-y-1.5">
                    <div className="grid items-center gap-2" style={{ gridTemplateColumns: gridCols }}>
                      <Input
                        value={row.name ?? ""}
                        placeholder={rowLabel(i, row)}
                        onChange={(e) => onChange(setRowName(dataset, row.id, e.target.value))}
                        className="h-9 text-[13px]"
                      />
                      {columns.map((col) => (
                        <Input
                          key={col}
                          value={row.values[col] ?? ""}
                          onChange={(e) => onChange(setCell(dataset, row.id, col, e.target.value))}
                          className="h-9 font-mono text-[13px]"
                        />
                      ))}
                      <Button
                        variant="ghost"
                        size="icon"
                        className={`h-9 w-8 ${overrides.length ? "text-primary" : "text-muted-foreground"}`}
                        onClick={() => toggle(row.id)}
                        aria-label={`${open ? "Hide" : "Show"} overrides for ${rowLabel(i, row)}`}
                        title={
                          overrides.length
                            ? `Overrides: ${overrides.join(", ")}`
                            : "Override the body or the check for this row"
                        }
                      >
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => onChange(removeRow(dataset, row.id))}
                        aria-label={`Remove ${rowLabel(i, row)}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    {open && (
                      <div className="ml-[160px] space-y-4 rounded-md border border-border bg-muted/20 p-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Payload
                            </span>
                            <Select
                              value={mode}
                              onValueChange={(v) => onChange(setRowPayloadMode(dataset, row.id, v as PayloadMode))}
                            >
                              <SelectTrigger className="h-7 w-[150px] text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="shared">Shared</SelectItem>
                                <SelectItem value="custom">Custom</SelectItem>
                                <SelectItem value="none">No body</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {mode === "custom" && (
                            <Textarea
                              value={row.payload ?? ""}
                              onChange={(e) => onChange(setRowPayload(dataset, row.id, e.target.value))}
                              placeholder={'{"email": "{{email}}"}'}
                              className="mt-2 min-h-[72px] font-mono text-xs"
                            />
                          )}
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            {mode === "shared"
                              ? "Uses the body from the Request tab."
                              : mode === "none"
                                ? "Sends no body at all — for testing a missing request body."
                                : "Replaces the Request tab's body for this row. Still interpolated, so {{variables}} work."}
                          </p>
                        </div>

                        <div>
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Check
                          </span>
                          <Textarea
                            value={row.assertion ?? ""}
                            onChange={(e) => onChange(setRowAssertion(dataset, row.id, e.target.value))}
                            placeholder="response.status == 201"
                            className="mt-2 min-h-[64px] font-mono text-xs"
                          />
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            {hasOwn
                              ? "Used instead of the shared check for this row."
                              : sharedAssertion?.trim()
                                ? "Empty — this row uses the shared check from the Scripts tab."
                                : "Empty — this row just checks for a 2xx status."}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {columns.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Cells are interpolated, so <code className="rounded bg-muted px-1 font-mono">{"{{$RandomEmail}}"}</code>{" "}
          works. A value that looks like a number or boolean is sent as one, so a shared check can compare{" "}
          <code className="rounded bg-muted px-1 font-mono">response.status == data.expected_status</code>.{" "}
          <strong className="font-medium">Run Test</strong> ignores these rows and runs the test as authored —
          use <strong className="font-medium">Run all rows</strong> to iterate.
        </p>
      )}
    </div>
  );
}
