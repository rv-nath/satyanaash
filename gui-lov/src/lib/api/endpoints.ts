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

// ============ Projects API ============

export const projectsApi = {
  /** List all projects */
  list: async (): Promise<Project[]> => {
    const response = await apiClient.get<PaginatedResponse<Project>>('/projects');
    return response.data;
  },

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
  list: async (projectId: string): Promise<TestCase[]> => {
    const response = await apiClient.get<PaginatedResponse<TestCase>>(`/projects/${projectId}/test-cases`);
    return response.data;
  },

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

// ============ Flows API ============

export const flowsApi = {
  /** List flows for a project */
  list: async (projectId: string): Promise<Flow[]> => {
    const response = await apiClient.get<PaginatedResponse<Flow>>(`/projects/${projectId}/flows`);
    return response.data;
  },

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
  /** Newest first, headlines only — no request or response bodies. */
  list: (projectId: string, limit = 50) =>
    apiClient.get<SuiteRun[]>(`/projects/${projectId}/runs?limit=${limit}`),

  /** One run in full, bodies unpacked and fan-out rows reattached to their nodes. */
  get: (id: string) => apiClient.get<SuiteRun>(`/runs/${id}`),

  delete: (id: string) => apiClient.delete(`/runs/${id}`),
};

// ============ Re-export types ============

export * from './types';
