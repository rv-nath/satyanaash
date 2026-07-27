import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal, X, Trash2, ChevronRight, ChevronDown, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { formatLog, formatLogs, formatTimestamp } from "@/lib/consoleText";
import type { ConsoleLog, ConsoleLogDetail } from "@/hooks/useExecutionStream";

/** One console per flow. The tab names whose run you are reading. */
export interface ConsoleTab {
  id: string;
  name: string;
  entries: number;
  running: boolean;
}

interface ConsolePanelProps {
  logs: ConsoleLog[];
  tabs: ConsoleTab[];
  activeTabId: string | null;
  onSelectTab: (flowId: string) => void;
  onCloseTab: (flowId: string) => void;
  onClose?: () => void;
  onClear?: () => void;
}

const ConsolePanel = ({
  logs,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onClose,
  onClear,
}: ConsolePanelProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  // Rows are tracked by index, so a stale expansion would open an unrelated
  // entry after switching flows.
  useEffect(() => {
    setExpandedRows(new Set());
  }, [activeTabId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  // Clear expanded state when logs are cleared
  useEffect(() => {
    if (logs.length <= 1) {
      setExpandedRows(new Set());
    }
  }, [logs.length]);

  const copy = async (text: string, what: string) => {
    if (await copyText(text)) {
      toast.success(`Copied ${what}`);
    } else {
      // Rather than fail mutely — the usual cause is a browser refusing the
      // clipboard on a plain-http origin.
      toast.error("Couldn't reach the clipboard. Select the text and copy manually.");
    }
  };

  const toggleRow = (index: number) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const getLogColor = (type: ConsoleLog["type"]) => {
    switch (type) {
      case "success":
        return "text-success";
      case "error":
        return "text-destructive";
      default:
        return "text-console-text";
    }
  };

  return (
    <div className="h-full bg-console-background border-t border-border flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="w-4 h-4 shrink-0 text-primary" />
          <div className="scrollbar-hairline flex min-w-0 items-center gap-1 overflow-x-auto">
            {tabs.length === 0 ? (
              <span className="text-sm font-mono font-semibold text-foreground">Console</span>
            ) : (
              tabs.map((tab) => {
                const active = tab.id === activeTabId;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => onSelectTab(tab.id)}
                    title={`${tab.name} — ${tab.entries} ${tab.entries === 1 ? "entry" : "entries"}`}
                    className={`group flex max-w-[200px] shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-mono transition-colors ${
                      active
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                    }`}
                  >
                    {tab.running && (
                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
                    )}
                    <span className="truncate">{tab.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {tab.entries}
                    </span>
                    {/* A span, not a button: nesting buttons is invalid HTML. */}
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`Close ${tab.name} console`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseTab(tab.id);
                      }}
                      className="shrink-0 rounded opacity-0 hover:text-destructive group-hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            disabled={logs.length === 0}
            onClick={() =>
              copy(
                formatLogs(logs),
                `${logs.length} ${logs.length === 1 ? "entry" : "entries"}`,
              )
            }
            title="Copy the whole console, including collapsed request and response details"
            aria-label="Copy console"
          >
            <Copy className="w-3 h-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClear} title="Clear this flow\u2019s console">
            <Trash2 className="w-3 h-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} title="Close console">
            <X className="w-3 h-3" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-4 space-y-1 font-mono text-xs">
          {logs.length === 0 && (
            <p className="text-muted-foreground">
              No output yet — run this flow and its log appears here.
            </p>
          )}
          {logs.map((log, index) => {
            const hasDetails = log.details && log.details.length > 0;
            const isExpanded = expandedRows.has(index);

            return (
              <div key={index}>
                <div
                  className={`group flex items-start gap-3 rounded px-2 py-1 ${hasDetails ? 'cursor-pointer hover:bg-muted/10' : 'hover:bg-muted/5'}`}
                  onClick={hasDetails ? () => toggleRow(index) : undefined}
                >
                  {hasDetails && (
                    <span className="text-muted-foreground shrink-0 w-3 mt-0.5">
                      {isExpanded
                        ? <ChevronDown className="w-3 h-3" />
                        : <ChevronRight className="w-3 h-3" />}
                    </span>
                  )}
                  <span className="text-muted-foreground shrink-0">
                    [{formatTimestamp(log.timestamp)}]
                  </span>
                  <span className={`min-w-0 flex-1 ${getLogColor(log.type)}`}>{log.message}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={(e) => {
                      // The row itself toggles details; this must not.
                      e.stopPropagation();
                      copy(formatLog(log), "this entry");
                    }}
                    title="Copy this entry"
                    aria-label={`Copy entry: ${log.message}`}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>

                {hasDetails && isExpanded && (
                  <div className="ml-8 pl-4 border-l border-border/50 my-1 space-y-1">
                    {log.details!.map((detail, di) => (
                      <DetailRow key={di} detail={detail} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
};

const DetailRow = ({ detail }: { detail: ConsoleLogDetail }) => {
  const isMultiline = detail.value.includes('\n');
  const colorClass = detail.type === 'error' ? 'text-destructive' : 'text-console-text';

  return (
    <div className="py-0.5">
      <span className="text-muted-foreground">{detail.label}: </span>
      {isMultiline ? (
        <pre className={`${colorClass} mt-1 whitespace-pre-wrap break-all bg-muted/10 rounded px-2 py-1`}>
          {detail.value}
        </pre>
      ) : (
        <span className={colorClass}>{detail.value}</span>
      )}
    </div>
  );
};

export default ConsolePanel;
