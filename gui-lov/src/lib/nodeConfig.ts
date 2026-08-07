/**
 * A node's config — the shape, and the derivations the panel and the canvas both need.
 *
 * This shape used to be an inline cast in `NodeConfigPanel` and a second, shorter one in
 * `TestCaseNode`, which is two places to remember when a key is added. It is one type here
 * for the same reason `lib/poll.ts` exists: the panel, the badge and the tests all read the
 * same slice of `data.config`, so it should be described once and tested once.
 */

export interface InputVariable {
  key: string;
  value: string;
}

export interface OutputVariable {
  name: string;
  /** JSONPath rooted at the response body, e.g. "$.data.campaignId". */
  path: string;
  description?: string;
}

/** "Once per item in a list": which list, and what to call each element. */
export interface ForEachConfig {
  list?: string;
  /**
   * A name for each element. Needed **only** when the list holds plain values — a record's
   * fields already carry the names the author gave them when collecting.
   */
  as?: string;
}

/** Where a step that runs more than once puts what each run produced. */
export interface CollectConfig {
  into?: string;
  /**
   * What must be true of a response for it to have produced anything worth collecting.
   *
   * Passing is not the same as producing: a negative case expecting a 400 passes, and no
   * campaign was created. Absent means "any run that passed".
   */
  when?: string;
}

export interface NodeConfig {
  inputVars?: InputVariable[];
  outputVars?: OutputVariable[];
  check?: string;
  teardown?: boolean;
  forEachRow?: boolean;
  rowIds?: string[];
  poll?: { until?: string; intervalMs?: number; timeoutMs?: number };
  forEach?: ForEachConfig;
  collect?: CollectConfig;
}

/**
 * How many times a step runs, and driven by what.
 *
 * One value rather than two independent booleans, because the three are mutually exclusive
 * and a toggle that can express "both" is a toggle that will. The engine refuses a node set
 * to both kinds; making the UI unable to say it is better than validating it afterwards.
 */
export type RunMode = "once" | "rows" | "items";

export function runModeOf(config: NodeConfig | undefined): RunMode {
  if (!config) return "once";
  // `forEach` wins the read only so a hand-edited node opens showing something coherent;
  // it is still refused at run time rather than silently resolved. See FOREACH_AND_FANOUT.
  if (listName(config.forEach)) return "items";
  if (config.forEachRow === true) return "rows";
  return "once";
}

/**
 * The list a step walks, with the braces forgiven.
 *
 * Everyone will type `{{launched}}`, because that is how a variable is written everywhere
 * else in this app. Accepting both here and in the engine's `for_each` keeps one config from
 * having two readings.
 */
export function listName(spec: ForEachConfig | undefined): string {
  return stripBraces(spec?.list ?? "");
}

export function stripBraces(raw: string): string {
  return raw.trim().replace(/^\{\{/, "").replace(/\}\}$/, "").trim();
}

/**
 * A name for each element, suggested from the list's name.
 *
 * `campaignIds` → `campaignId`, `launched` → nothing. Only offered where the plural is
 * unambiguous: guessing `statu` out of `status` would be worse than saying nothing, and a
 * suggestion that is usually wrong trains people to ignore the ones that are right.
 */
export function itemVarSuggestion(list: string): string | undefined {
  const name = stripBraces(list);
  if (/[a-z0-9]ies$/i.test(name)) return `${name.slice(0, -3)}y`;
  // Not `ss` (address, status) and not `us`/`is` — English plurals this simple rule cannot
  // be trusted on.
  if (/[a-rt-z]s$/i.test(name) && !/[su]s$/i.test(name)) return name.slice(0, -1);
  return undefined;
}

/**
 * What this step hands to the steps after it, in one line.
 *
 * The three states are deliberately distinct, because "nothing is carried forward" was the
 * old silent failure: fields with nowhere to go, whose only symptom was `{{name}}` arriving
 * literally at a later node.
 */
export function collectionSummary(
  into: string,
  fields: OutputVariable[],
  when?: string,
): string {
  const named = fields.map((f) => f.name.trim()).filter(Boolean);
  const list = stripBraces(into);
  // Only qualifies the sentence — a condition with nothing to collect is caught below.
  const only = when?.trim() ? ` when ${when.trim()}` : "";

  if (!list && named.length === 0) {
    return "Nothing is carried forward from this step.";
  }
  if (!list) {
    return `${named.join(", ")} need a list to be collected into — name one above, or nothing is carried forward.`;
  }
  if (named.length === 0) {
    // Points *down*, at the button in the empty row below, and states the payoff rather than
    // repeating the instruction the empty row is already giving. Two messages saying the same
    // thing in different words, one above the other, is how "add a field" became a puzzle.
    return `Add a field below, and each run will add one record to "${list}".`;
  }
  return `Each run adds one record to "${list}"${only}, holding ${named.join(", ")}. A later step can run once per record.`;
}

/**
 * The help line under the list a step walks.
 *
 * `upstream` is the collections earlier steps in this flow produce. A name that is not among
 * them is *probably* wrong and possibly fine — a script or a project variable can hold a list
 * too — so it is said as a doubt, not an error.
 */
export function walkSummary(list: string, itemVar: string, upstream: string[]): string {
  const name = stripBraces(list);
  if (!name) {
    return "Pick the list to walk — usually one an earlier step collects.";
  }
  const known = upstream.some((u) => u === name);
  const item = stripBraces(itemVar);
  const each = item
    ? `Each element is available as {{${item}}}.`
    : "A record's fields are available under the names they were collected with.";
  return known
    ? `Runs once per element of "${name}". ${each}`
    : `Runs once per element of "${name}" — no earlier step in this flow collects that name, so check it exists by the time this step runs. ${each}`;
}

/** The badge a canvas node wears when it walks a list. Absent when it doesn't. */
export function walkBadge(config: NodeConfig | undefined): string | undefined {
  if (runModeOf(config) !== "items") return undefined;
  return `per ${listName(config?.forEach)}`;
}
