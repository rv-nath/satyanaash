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

/**
 * What a step that waits for a callback is waiting for.
 *
 * The path is the tail of the URL the test puts in its payload — `drCallbackUrl` — so it is
 * normally a flow variable shared with that payload, and interpolated like any other field.
 */
export interface AwaitCallbackConfig {
  path?: string;
  /** How many to wait for. A campaign to two recipients reports twice. */
  count?: number;
  timeoutMs?: number;
}

/** Mirrors `AWAIT_TIMEOUT_MS` in the engine, so the panel shows what will actually happen. */
export const AWAIT_TIMEOUT_MS = 60_000;

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
  awaitCallback?: AwaitCallbackConfig;
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

/**
 * What a waiting step does, in one line under its fields.
 *
 * States the timeout in seconds because a timeout is the thing an author gets wrong — the
 * failure it produces reads "no callback arrived", which is indistinguishable from a sender
 * that never called.
 */
export function awaitSummary(cfg: AwaitCallbackConfig | undefined): string {
  const path = (cfg?.path ?? "").trim();
  // A 0 is a cleared field, not "wait for nothing" — the same reading the engine gives it.
  const count = cfg?.count && cfg.count > 0 ? cfg.count : 1;
  const ms = cfg?.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : AWAIT_TIMEOUT_MS;
  const secs = Math.round(ms / 100) / 10;

  if (!path) {
    return "Give this step the path your test puts in its callback URL — it cannot run without one.";
  }
  const many = count === 1 ? "one callback" : `${count} callbacks`;
  return `Waits up to ${secs}s for ${many} at ${path}. Nothing arrives in time — the step fails, and the flow takes its failure edge.`;
}

/** The badge a waiting node wears on the canvas: how many, and for how long. */
export function awaitBadge(cfg: AwaitCallbackConfig | undefined): string {
  const count = cfg?.count && cfg.count > 0 ? cfg.count : 1;
  const ms = cfg?.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : AWAIT_TIMEOUT_MS;
  return `${count} · ${Math.round(ms / 1000)}s`;
}

/**
 * What a whole-response path actually does, said where it is typed.
 *
 * `$` matches the root, so the capture stores the **entire body** under one name. It is worth a
 * warning for two reasons that compound:
 *
 * - **It always succeeds**, so the "nothing at $.foo — {{name}} will not resolve" warning that
 *   catches every other wrong path can never fire for this one. A typo fails loudly; `$` fails
 *   silently.
 * - **Interpolation has no dots.** `{{campaign_info.campaignId}}` is not a thing that can
 *   resolve, so the captured blob cannot be reached into. `{{campaign_info}}` on its own pastes
 *   the whole JSON body into the URL or payload.
 *
 * Which is how one real flow sent a request with an entire response embedded in it, and why the
 * fix was to name the fields instead. Returns undefined for any ordinary path.
 */
export function rootPathWarning(
  path: string,
  name: string,
  mode: RunMode,
): string | undefined {
  const trimmed = path.trim();
  // `$` and `$.` are the two ways to write "the whole thing". Not `$..foo`, which is a real
  // recursive-descent query and matches fields rather than the root.
  if (trimmed !== "$" && trimmed !== "$.") return undefined;

  const label = name.trim() || "this variable";
  const reach =
    mode === "once"
      ? `{{${label}}} would paste the whole body in, and {{${label}}}.field is not something interpolation can resolve — it has no dots.`
      : `Each record would hold one field containing everything, and a step walking the list could not reach inside it.`;
  return `$ matches the whole response, so ${label} holds the entire body. It also always succeeds, so nothing will warn you it was wrong. ${reach} Point the path at the field you want, like $.campaignId.`;
}
