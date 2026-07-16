import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal, X, Trash2, ChevronRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConsoleLog, ConsoleLogDetail } from "@/hooks/useExecutionStream";

interface ConsolePanelProps {
  logs: ConsoleLog[];
  onClose?: () => void;
  onClear?: () => void;
}

const ConsolePanel = ({ logs, onClose, onClear }: ConsolePanelProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

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

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  };

  return (
    <div className="h-full bg-console-background border-t border-border flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold font-mono text-foreground">Console</span>
          <span className="text-xs text-muted-foreground">
            {logs.length} {logs.length === 1 ? "entry" : "entries"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClear} title="Clear console">
            <Trash2 className="w-3 h-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} title="Close console">
            <X className="w-3 h-3" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-4 space-y-1 font-mono text-xs">
          {logs.map((log, index) => {
            const hasDetails = log.details && log.details.length > 0;
            const isExpanded = expandedRows.has(index);

            return (
              <div key={index}>
                <div
                  className={`flex gap-3 px-2 py-1 rounded ${hasDetails ? 'cursor-pointer hover:bg-muted/10' : 'hover:bg-muted/5'}`}
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
                  <span className={getLogColor(log.type)}>{log.message}</span>
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
