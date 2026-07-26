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

export function DatasetEditor({ dataset, onChange, sharedAssertion }: DatasetEditorProps) {
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
        <div className="space-y-3">
          {rows.map((row, i) => {
            const body = row.body ?? "";
            const badJson = looksLikeInvalidJson(body);
            return (
              <div key={row.id} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 shrink-0 text-center text-xs text-muted-foreground">{i + 1}</span>
                  <Input
                    value={row.name ?? ""}
                    placeholder={rowLabel(i, row)}
                    onChange={(e) => onChange(setRowName(dataset, row.id, e.target.value))}
                    className="h-8 flex-1 text-[13px]"
                    aria-label={`Case name for row ${i + 1}`}
                  />
                  <span className="shrink-0 text-[11px] text-muted-foreground">expect</span>
                  <Input
                    value={row.expected_status ?? ""}
                    placeholder="200"
                    onChange={(e) => onChange(setRowExpectedStatus(dataset, row.id, e.target.value))}
                    className="h-8 w-[72px] shrink-0 font-mono text-[13px]"
                    aria-label={`Expected status for ${rowLabel(i, row)}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => onChange(duplicateRow(dataset, row.id))}
                    aria-label={`Duplicate ${rowLabel(i, row)}`}
                    title="Duplicate this case"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => onChange(removeRow(dataset, row.id))}
                    aria-label={`Remove ${rowLabel(i, row)}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <Textarea
                  value={body}
                  onChange={(e) => onChange(setRowBody(dataset, row.id, e.target.value))}
                  placeholder='{"email": "a@b.com"}     — blank uses the Request tab’s body'
                  className="mt-2 min-h-[72px] font-mono text-xs"
                  aria-label={`Body for ${rowLabel(i, row)}`}
                />

                <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                  {badJson && (
                    <span className="flex items-center gap-1 text-warning">
                      <AlertTriangle className="h-3 w-3" /> Not valid JSON — sent as-is
                    </span>
                  )}
                  {!(row.expected_status ?? "").trim() && (
                    <span>
                      No expected status —{" "}
                      {hasShared ? "uses the check from the Scripts tab." : "passes on any 2xx."}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
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
