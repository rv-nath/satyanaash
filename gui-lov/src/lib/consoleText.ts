/**
 * Turning console entries into plain text for a clipboard.
 *
 * Details are always included, whether or not the row is expanded on screen: the
 * reason to copy a run is to read the request and response somewhere else, and a
 * paste that silently omitted them would be worse than no paste at all.
 */
import type { ConsoleLog } from "@/hooks/useExecutionStream";

/** 24-hour clock, matching what the console shows. */
export function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatLog(log: ConsoleLog): string {
  const lines = [`[${formatTimestamp(log.timestamp)}] ${log.message}`];
  for (const detail of log.details ?? []) {
    if (detail.value.includes("\n")) {
      // A JSON body keeps its own shape, indented as a block under its label.
      lines.push(`  ${detail.label}:`);
      for (const line of detail.value.split("\n")) lines.push(`    ${line}`);
    } else {
      lines.push(`  ${detail.label}: ${detail.value}`);
    }
  }
  return lines.join("\n");
}

export function formatLogs(logs: ConsoleLog[]): string {
  return logs.map(formatLog).join("\n");
}
