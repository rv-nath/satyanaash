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

  /** Delete a flow */
  delete: (id: string) => apiClient.delete(`/flows/${id}`),

  /** Validate a flow's graph structure (optionally with unsaved graph data) */
  validate: (id: string, data?: ValidateFlowRequest) =>
    apiClient.post<ValidationResult>(`/flows/${id}/validate`, data || {}),

  /** Execute a flow */
  execute: (id: string, data?: ExecuteFlowRequest) =>
    apiClient.post<ExecutionResponse>(`/flows/${id}/execute`, data || {}),
};

// ============ Re-export types ============

export * from './types';
