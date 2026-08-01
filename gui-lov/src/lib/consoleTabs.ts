/**
 * Which consoles exist, and what they are called.
 *
 * A console is keyed by whatever produced the output. That used to be a flow id and
 * nothing else, so the list was built by filtering the flow rail — which silently dropped
 * any key that wasn't a flow. A suite run logs under `suite:<id>`, so its output was
 * collected, stored, and then never shown: the panel had no tab to put it in.
 *
 * Derived from the log keys themselves rather than from a rail, so a producer added later
 * cannot go missing the same way.
 */
import { SUITE_LOG_PREFIX } from '@/lib/runHistory';

export interface ConsoleTabInfo {
  id: string;
  name: string;
  entries: number;
  running: boolean;
}

interface Named {
  id: string;
  name: string;
}

export function isSuiteLogKey(key: string): boolean {
  return key.startsWith(SUITE_LOG_PREFIX);
}

export function suiteIdFromLogKey(key: string): string {
  return key.slice(SUITE_LOG_PREFIX.length);
}

/**
 * @param logKeys every key that has output
 * @param flows the flow rail, in its own order
 * @param suites the suite rail, for naming a suite's console
 * @param activeFlowId kept in the list even with no output, so the panel is never headless
 * @param executingId what is running right now, if anything
 */
export function consoleTabsFor({
  logKeys,
  flows,
  suites,
  activeFlowId,
  activeSuiteKey,
  executingId,
  entryCount,
}: {
  logKeys: string[];
  flows: Named[];
  suites: Named[];
  activeFlowId?: string | null;
  activeSuiteKey?: string | null;
  executingId?: string | null;
  entryCount: (key: string) => number;
}): ConsoleTabInfo[] {
  const wanted = new Set(logKeys);
  if (activeFlowId) wanted.add(activeFlowId);
  if (activeSuiteKey) wanted.add(activeSuiteKey);

  const tab = (id: string, name: string): ConsoleTabInfo => ({
    id,
    name,
    entries: entryCount(id),
    running: executingId === id,
  });

  // Flows first in rail order, then suites — the same order the sidebar reads.
  const tabs = flows.filter((f) => wanted.has(f.id)).map((f) => tab(f.id, f.name));

  for (const suite of suites) {
    const key = `${SUITE_LOG_PREFIX}${suite.id}`;
    if (wanted.has(key)) tabs.push(tab(key, suite.name));
  }

  // Anything left over: a flow or suite deleted since it ran, or a key from a producer
  // this function has not been taught about. Shown rather than dropped — output with no
  // home is exactly the bug this replaced.
  const placed = new Set(tabs.map((t) => t.id));
  for (const key of logKeys) {
    if (placed.has(key)) continue;
    tabs.push(tab(key, isSuiteLogKey(key) ? 'Suite (deleted)' : 'Flow (deleted)'));
  }

  return tabs;
}

/** Which console to show: the pinned one if it still exists, else the first. */
export function shownConsole(tabs: ConsoleTabInfo[], pinned: string | null): string | null {
  return tabs.some((t) => t.id === pinned) ? pinned : tabs[0]?.id ?? null;
}
