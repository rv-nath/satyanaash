/**
 * API Endpoints - Resource-specific functions
 */

import { apiClient } from './client';
import type {
  Project,
  CreateProjectRequest,
  UpdateProjectRequest,
  TestCase,
  CreateTestCaseRequest,
  UpdateTestCaseRequest,
  TestGroup,
  FlowGroup,
  Flow,
  CreateFlowRequest,
  UpdateFlowRequest,
  UpdateGraphRequest,
  ValidationResult,
  ValidateFlowRequest,
  ExecuteFlowRequest,
  ExecutionResponse,
  TestCaseExecutionResult,
  ExecuteTestCaseRequest,
  Suite,
  CreateSuiteRequest,
  UpdateSuiteRequest,
  SuiteRun,
  RunListing,
} from './types';

// ============ Helper for paginated responses ============

interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

/**
 * Every page of a paginated list, not just the first.
 *
 * The three list calls below asked for no page at all, took `response.data` and dropped
 * `pagination` on the floor — so they silently returned the server's default first 20. A project
 * that crossed 20 test cases lost the rest *everywhere at once*: double-clicking a node said
 * "That test case no longer exists", nodes fell back to the stale label saved on them, and the
 * config panel opened with no data rows — while the flow itself ran perfectly, because the engine
 * reads the database rather than this list.
 *
 * Follows the page count the server already reports rather than asking for one big page: a cap on
 * `per_page` would put the same bug back, one order of magnitude further out.
 */
async function fetchAll<T>(path: string): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  const first = await apiClient.get<PaginatedResponse<T>>(`${path}${sep}page=1&per_page=100`);
  const { total_pages } = first.pagination;
  if (!total_pages || total_pages <= 1) return first.data;
  const rest = await Promise.all(
    Array.from({ length: total_pages - 1 }, (_, i) =>
      apiClient.get<PaginatedResponse<T>>(`${path}${sep}page=${i + 2}&per_page=100`),
    ),
  );
  return [...first.data, ...rest.flatMap((r) => r.data)];
}

// ============ Projects API ============

export const projectsApi = {
  /** List all projects */
  list: (): Promise<Project[]> => fetchAll<Project>('/projects'),

  /** Get a single project by ID */
  get: (id: string) => apiClient.get<Project>(`/projects/${id}`),

  /** Create a new project */
  create: (data: CreateProjectRequest) => apiClient.post<Project>('/projects', data),

  /** Update a project */
  update: (id: string, data: UpdateProjectRequest) =>
    apiClient.patch<Project>(`/projects/${id}`, data),

  /** Delete a project */
  delete: (id: string) => apiClient.delete(`/projects/${id}`),
};

// ============ Test Cases API ============

export const testCasesApi = {
  /** List test cases for a project */
  list: (projectId: string): Promise<TestCase[]> =>
    fetchAll<TestCase>(`/projects/${projectId}/test-cases`),

  /** Get a single test case by ID */
  get: (id: string) => apiClient.get<TestCase>(`/test-cases/${id}`),

  /** Create a new test case in a project */
  create: (projectId: string, data: CreateTestCaseRequest) =>
    apiClient.post<TestCase>(`/projects/${projectId}/test-cases`, data),

  /** Update a test case */
  update: (id: string, data: UpdateTestCaseRequest) =>
    apiClient.patch<TestCase>(`/test-cases/${id}`, data),

  /** Delete a test case */
  delete: (id: string) => apiClient.delete(`/test-cases/${id}`),

  /** Execute a single test case */
  execute: (id: string, data?: ExecuteTestCaseRequest) =>
    apiClient.post<TestCaseExecutionResult>(`/test-cases/${id}/execute`, data || {}),
};

// ============ Groups API ============

export const groupsApi = {
  /** List groups for a project (newest first) */
  list: (projectId: string) => apiClient.get<TestGroup[]>(`/projects/${projectId}/groups`),

  /** Create a group */
  create: (projectId: string, name: string) =>
    apiClient.post<TestGroup>(`/projects/${projectId}/groups`, { name }),

  /** Rename a group */
  rename: (id: string, name: string) =>
    apiClient.patch<TestGroup>(`/groups/${id}`, { name }),

  /** Delete a group (its tests fall back to Ungrouped) */
  delete: (id: string) => apiClient.delete(`/groups/${id}`),
};

// ============ Flow Groups API ============

/** Buckets of flows. `flow-groups` in the path, so nothing has to guess which kind. */
export const flowGroupsApi = {
  list: (projectId: string) => apiClient.get<FlowGroup[]>(`/projects/${projectId}/flow-groups`),

  create: (projectId: string, name: string) =>
    apiClient.post<FlowGroup>(`/projects/${projectId}/flow-groups`, { name }),

  rename: (id: string, name: string) =>
    apiClient.patch<FlowGroup>(`/flow-groups/${id}`, { name }),

  /** Delete a group; its flows fall back to Ungrouped rather than being deleted. */
  delete: (id: string) => apiClient.delete(`/flow-groups/${id}`),

  /**
   * Move a flow into a group, or out of every group with `null`.
   *
   * No `version`: which bucket a flow sits in is about the sidebar, not the graph, so a drag
   * cannot fail because somebody else edited the canvas.
   */
  move: (flowId: string, groupId: string | null) =>
    apiClient.patch<Flow>(`/flows/${flowId}/group`, { group_id: groupId }),
};

// ============ Flows API ============

export const flowsApi = {
  /** List flows for a project */
  list: (projectId: string): Promise<Flow[]> =>
    fetchAll<Flow>(`/projects/${projectId}/flows`),

  /** Get a single flow by ID (includes graph data) */
  get: (id: string) => apiClient.get<Flow>(`/flows/${id}`),

  /** Create a new flow in a project */
  create: (projectId: string, data: CreateFlowRequest) =>
    apiClient.post<Flow>(`/projects/${projectId}/flows`, data),

  /** Update flow metadata (name, description, canvas settings) */
  update: (id: string, data: UpdateFlowRequest) =>
    apiClient.patch<Flow>(`/flows/${id}`, data),

  /** Update flow graph (nodes and edges) */
  updateGraph: (id: string, data: UpdateGraphRequest) =>
    apiClient.put<Flow>(`/flows/${id}/graph`, data),

  /** Copy a flow with its whole graph. Omit the name and the server picks
   *  "<name> (copy)", stepping to "(copy 2)" if that's taken. */
  clone: (id: string, name?: string) =>
    apiClient.post<Flow>(`/flows/${id}/clone`, name ? { name } : {}),

  /** Delete a flow */
  delete: (id: string) => apiClient.delete(`/flows/${id}`),

  /** Validate a flow's graph structure (optionally with unsaved graph data) */
  validate: (id: string, data?: ValidateFlowRequest) =>
    apiClient.post<ValidationResult>(`/flows/${id}/validate`, data || {}),

  /** Execute a flow */
  execute: (id: string, data?: ExecuteFlowRequest) =>
    apiClient.post<ExecutionResponse>(`/flows/${id}/execute`, data || {}),
};

// ============ Suites API ============

export const suitesApi = {
  /** List suites for a project (newest first) */
  list: (projectId: string) => apiClient.get<Suite[]>(`/projects/${projectId}/suites`),

  get: (id: string) => apiClient.get<Suite>(`/suites/${id}`),

  /** Create a suite. Send `members: []` for a blank one — omitting the field means
   *  "everything in the project", which is a choice rather than a starting point. */
  create: (projectId: string, data: CreateSuiteRequest) =>
    apiClient.post<Suite>(`/projects/${projectId}/suites`, data),

  update: (id: string, data: UpdateSuiteRequest) =>
    apiClient.patch<Suite>(`/suites/${id}`, data),

  delete: (id: string) => apiClient.delete(`/suites/${id}`),
};

// ============ Run history API ============

export const runsApi = {
  /**
   * Newest first, headlines only — no request or response bodies.
   *
   * Runs of a single flow started by hand are left out unless asked for, and counted so
   * the caller can say how many it is not showing. Filtered on the server: `limit` would
   * otherwise let a debug loop of twenty flow runs hide every suite run.
   */
  list: (projectId: string, opts: { limit?: number; includeAdhoc?: boolean } = {}) =>
    apiClient.get<RunListing>(
      `/projects/${projectId}/runs?limit=${opts.limit ?? 50}&include_adhoc=${opts.includeAdhoc ?? false}`,
    ),

  /** One run in full, bodies unpacked and fan-out rows reattached to their nodes. */
  get: (id: string) => apiClient.get<SuiteRun>(`/runs/${id}`),

  delete: (id: string) => apiClient.delete(`/runs/${id}`),
};

// ============ Re-export types ============

export * from './types';
