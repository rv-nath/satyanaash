/**
 * Environments & Globals (Plan 4)
 *
 * Globals live in `project.settings.variables` (shared across environments).
 * Environments live in `project.settings.environments` (switchable var sets).
 * The active environment is per-user, stored in localStorage.
 *
 * At execution the frontend sends `effectiveEnv(...)` — globals overlaid with the
 * active environment (env wins) — as the request `environment`.
 */
import { generateUUID } from "@/lib/utils/uuid";

export type EnvVars = Record<string, string>;

export interface Environment {
  id: string;
  name: string;
  variables: EnvVars;
}

type Settings = Record<string, unknown> | null | undefined;

export function readGlobals(settings: Settings): EnvVars {
  const v = (settings as Record<string, unknown>)?.variables;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, String(val)])
    );
  }
  return {};
}

export function readEnvironments(settings: Settings): Environment[] {
  const e = (settings as Record<string, unknown>)?.environments;
  if (Array.isArray(e)) {
    return e
      .filter((x): x is Environment => !!x && typeof x === "object" && "id" in x && "name" in x)
      .map((x) => ({
        id: String(x.id),
        name: String(x.name),
        variables:
          x.variables && typeof x.variables === "object"
            ? Object.fromEntries(Object.entries(x.variables).map(([k, val]) => [k, String(val)]))
            : {},
      }));
  }
  return [];
}

const activeKey = (projectId: string) => `sat.activeEnv.${projectId}`;

export function getActiveEnvId(projectId: string): string | null {
  const v = localStorage.getItem(activeKey(projectId));
  return v && v !== "none" ? v : null;
}

export function setActiveEnvId(projectId: string, id: string | null): void {
  localStorage.setItem(activeKey(projectId), id ?? "none");
}

/** Globals overlaid with the active environment (environment wins). */
export function effectiveEnv(
  globals: EnvVars,
  environments: Environment[],
  activeId: string | null
): EnvVars {
  const active = activeId ? environments.find((e) => e.id === activeId) : undefined;
  return { ...globals, ...(active?.variables ?? {}) };
}

export function genEnvId(): string {
  return generateUUID();
}

/**
 * Merge script-written vars (SAT.env) into the active environment — or Globals
 * when no environment is active — and return updated settings to persist.
 */
export function mergeEnvWrites(
  settings: Settings,
  activeId: string | null,
  writes: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(settings || {}) };
  const strWrites = Object.fromEntries(Object.entries(writes).map(([k, v]) => [k, String(v)]));
  if (activeId) {
    next.environments = readEnvironments(settings).map((e) =>
      e.id === activeId ? { ...e, variables: { ...e.variables, ...strWrites } } : e
    );
  } else {
    next.variables = { ...readGlobals(settings), ...strWrites };
  }
  return next;
}
