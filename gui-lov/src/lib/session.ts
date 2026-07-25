/**
 * Session variables — a Postman-style disposable store scripts can write to
 * (SAT.session) so standalone test-case runs can chain values without a flow.
 *
 * Stored per-project in localStorage. Highest priority at resolution time
 * (tier 0), sent with each execute request and refreshed from the response.
 * Never written to project settings — clear it any time.
 */

export type SessionVars = Record<string, unknown>;

const key = (projectId: string) => `sat.session.${projectId}`;

/** Read the session store for a project (empty object if none / corrupt). */
export function readSession(projectId: string): SessionVars {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SessionVars) : {};
  } catch {
    return {};
  }
}

/** Overwrite the whole session store for a project. */
export function writeSession(projectId: string, vars: SessionVars): void {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(vars ?? {}));
  } catch {
    /* ignore quota/serialization errors */
  }
}

/** Wipe the session store for a project. */
export function clearSession(projectId: string): void {
  localStorage.removeItem(key(projectId));
}

/** Remove a single session variable; returns the updated store. */
export function removeSessionVar(projectId: string, name: string): SessionVars {
  const next = readSession(projectId);
  delete next[name];
  writeSession(projectId, next);
  return next;
}
