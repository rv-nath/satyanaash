import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ConsoleLog {
  timestamp: string;
  message: string;
  type: "info" | "success" | "error";
}

interface ConsolePanelProps {
  logs: ConsoleLog[];
  onClose?: () => void;
}

const ConsolePanel = ({ logs, onClose }: ConsolePanelProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

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
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="w-3 h-3" />
        </Button>
      </div>

      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-4 space-y-1 font-mono text-xs">
          {logs.map((log, index) => (
            <div key={index} className="flex gap-3 hover:bg-muted/5 px-2 py-1 rounded">
              <span className="text-muted-foreground shrink-0">
                [{formatTimestamp(log.timestamp)}]
              </span>
              <span className={getLogColor(log.type)}>{log.message}</span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

export default ConsolePanel;
