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
    // A data row's line already reads as a sentence — "✗  3  no sender  400  12ms
    // Expected HTTP 201, got 400" — so it takes no colon; its request and response
    // follow indented beneath it.
    const head = detail.note !== undefined
      ? `${detail.label}  ${detail.note}`
      : `${detail.label}:`;
    if (detail.value.includes("\n")) {
      // A JSON body keeps its own shape, indented as a block under its label.
      lines.push(`  ${head}`);
      for (const line of detail.value.split("\n")) lines.push(`    ${line}`);
    } else if (detail.note !== undefined) {
      lines.push(`  ${head}`);
      if (detail.value) lines.push(`    ${detail.value}`);
    } else {
      lines.push(`  ${head} ${detail.value}`);
    }
  }
  return lines.join("\n");
}

export function formatLogs(logs: ConsoleLog[]): string {
  return logs.map(formatLog).join("\n");
}
