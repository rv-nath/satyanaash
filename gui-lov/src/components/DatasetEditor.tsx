import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Copy, AlertTriangle } from "lucide-react";
import type { Dataset } from "@/lib/api/types";
import {
  addRow,
  duplicateRow,
  looksLikeInvalidJson,
  removeRow,
  rowLabel,
  setRowBody,
  setRowExpectedStatus,
  setRowName,
} from "@/lib/dataset";

interface DatasetEditorProps {
  dataset: Dataset;
  onChange: (dataset: Dataset) => void;
  /** Used only to explain what a row with no expected status will fall back to. */
  sharedAssertion?: string;
}

// #, case, body, status, duplicate, delete
const GRID = "24px 180px minmax(240px,1fr) 88px 32px 32px";

export function DatasetEditor({ dataset, onChange, sharedAssertion }: DatasetEditorProps) {
  // Which row's body is being edited — that one expands, the rest stay one line.
  const [editingBody, setEditingBody] = useState<string | null>(null);
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
            One row per case. Each row sends its own body and checks the status it should get
            back — useful for negative and edge cases without building a flow.
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
        <div className="overflow-x-auto">
          <div className="min-w-[640px] space-y-1.5">
            {/* Header band: three columns — case, body, status. Tinted so it
                reads as a header rather than another row of inputs. */}
            <div
              className="grid items-center gap-2 rounded-t-md border-b-2 border-border bg-muted/50 px-1 py-1.5"
              style={{ gridTemplateColumns: GRID }}
            >
              <span className="w-6" />
              <span className="pl-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Case
              </span>
              <span className="pl-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Body
              </span>
              <span className="pl-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Status
              </span>
              <span />
              <span />
            </div>

            {rows.map((row, i) => {
              const body = row.body ?? "";
              const badJson = looksLikeInvalidJson(body);
              const noStatus = !(row.expected_status ?? "").trim();
              const editing = editingBody === row.id;
              return (
                <div
                  key={row.id}
                  className="grid items-start gap-2 rounded-md px-1 py-1 hover:bg-muted/30"
                  style={{ gridTemplateColumns: GRID }}
                >
                  <span className="w-6 pt-2 text-center text-xs text-muted-foreground">{i + 1}</span>

                  <Input
                    value={row.name ?? ""}
                    placeholder={rowLabel(i, row)}
                    onChange={(e) => onChange(setRowName(dataset, row.id, e.target.value))}
                    className="h-9 text-[13px]"
                    aria-label={`Case name for row ${i + 1}`}
                  />

                  <div className="min-w-0">
                    {/* One row tall until focused, so a long matrix stays scannable;
                        grows for editing and collapses back on blur. */}
                    <Textarea
                      value={body}
                      onChange={(e) => onChange(setRowBody(dataset, row.id, e.target.value))}
                      onFocus={() => setEditingBody(row.id)}
                      onBlur={() => setEditingBody((cur) => (cur === row.id ? null : cur))}
                      placeholder={'{"email": "a@b.com"}   — blank uses the Request tab\u2019s body'}
                      className={`resize-none font-mono text-xs transition-[height] duration-150 ${
                        editing
                          ? "h-[132px] min-h-0 whitespace-pre"
                          : "h-9 min-h-0 overflow-hidden whitespace-nowrap py-2"
                      } ${badJson ? "border-warning" : ""}`}
                      aria-label={`Body for ${rowLabel(i, row)}`}
                    />
                    {/* Hints only while editing — otherwise they would defeat the
                        single-row height. A bad body still shows a warning border. */}
                    {editing && (badJson || noStatus) && (
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                        {badJson && (
                          <span className="flex items-center gap-1 text-warning">
                            <AlertTriangle className="h-3 w-3" /> Not valid JSON — sent as-is
                          </span>
                        )}
                        {noStatus && (
                          <span>
                            No expected status —{" "}
                            {hasShared ? "uses the check from the Scripts tab." : "passes on any 2xx."}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <Input
                    value={row.expected_status ?? ""}
                    placeholder="200"
                    onChange={(e) => onChange(setRowExpectedStatus(dataset, row.id, e.target.value))}
                    className="h-9 font-mono text-[13px]"
                    aria-label={`Expected status for ${rowLabel(i, row)}`}
                  />

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-8 text-muted-foreground hover:text-foreground"
                    onClick={() => onChange(duplicateRow(dataset, row.id))}
                    aria-label={`Duplicate ${rowLabel(i, row)}`}
                    title="Duplicate this case"
                  >
                    <Copy className="h-3.5 w-3.5" />
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
              );
            })}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          A blank body falls back to the Request tab's body. Bodies are interpolated, so{" "}
          <code className="rounded bg-muted px-1 font-mono">{"{{baseUrl}}"}</code> and{" "}
          <code className="rounded bg-muted px-1 font-mono">{"{{$RandomEmail}}"}</code> work inside
          them. <strong className="font-medium">Run Test</strong> ignores these cases and runs the
          test as authored — use <strong className="font-medium">Run all rows</strong> to iterate.
        </p>
      )}
    </div>
  );
}
