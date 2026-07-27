/**
 * React Query hooks for API calls
 *
 * These hooks wrap our API endpoints with React Query for:
 * - Automatic caching
 * - Loading/error states
 * - Cache invalidation on mutations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsApi, testCasesApi, flowsApi, groupsApi } from '@/lib/api';
import type {
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateTestCaseRequest,
  UpdateTestCaseRequest,
  CreateFlowRequest,
  UpdateFlowRequest,
  UpdateGraphRequest,
  ValidateFlowRequest,
  ExecuteFlowRequest,
  ExecuteTestCaseRequest,
} from '@/lib/api';

// ============ Query Keys ============
// These are cache keys - same key = same cached data

export const queryKeys = {
  projects: ['projects'] as const,
  project: (id: string) => ['projects', id] as const,
  testCases: (projectId: string) => ['testCases', projectId] as const,
  testCase: (id: string) => ['testCase', id] as const,
  groups: (projectId: string) => ['groups', projectId] as const,
  flows: (projectId: string) => ['flows', projectId] as const,
  flow: (id: string) => ['flow', id] as const,
};

// ============ Projects Hooks ============

/** Fetch all projects */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: projectsApi.list,
  });
}

/** Fetch a single project */
export function useProject(id: string) {
  return useQuery({
    queryKey: queryKeys.project(id),
    queryFn: () => projectsApi.get(id),
    enabled: !!id, // Only run if id is provided
  });
}

/** Create a new project */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectRequest) => projectsApi.create(data),
    onSuccess: () => {
      // Refetch projects list after creating
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

/** Update a project */
export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProjectRequest }) =>
      projectsApi.update(id, data),
    onSuccess: (updatedProject) => {
      // Update single project cache directly with response data (no refetch needed)
      queryClient.setQueryData(queryKeys.project(updatedProject.id), updatedProject);
      // Invalidate list only (exact match to avoid prefix matching)
      queryClient.invalidateQueries({ queryKey: queryKeys.projects, exact: true });
    },
  });
}

/** Delete a project */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => projectsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// ============ Test Cases Hooks ============

/** Fetch test cases for a project */
export function useTestCases(projectId: string) {
  return useQuery({
    queryKey: queryKeys.testCases(projectId),
    queryFn: () => testCasesApi.list(projectId),
    enabled: !!projectId,
  });
}

/** Fetch a single test case */
export function useTestCase(id: string) {
  return useQuery({
    queryKey: queryKeys.testCase(id),
    queryFn: () => testCasesApi.get(id),
    enabled: !!id,
  });
}

/** Create a new test case */
export function useCreateTestCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: CreateTestCaseRequest }) =>
      testCasesApi.create(projectId, data),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.testCases(projectId) });
    },
  });
}

/** Update a test case */
export function useUpdateTestCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data, projectId }: { id: string; data: UpdateTestCaseRequest; projectId: string }) =>
      testCasesApi.update(id, data),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.testCases(projectId) });
    },
  });
}

/** Delete a test case */
export function useDeleteTestCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId: string }) =>
      testCasesApi.delete(id),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.testCases(projectId) });
    },
  });
}

/** Execute a single test case */
export function useExecuteTestCase() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: ExecuteTestCaseRequest }) =>
      testCasesApi.execute(id, data),
  });
}

// ============ Groups Hooks ============

/** Fetch groups for a project (newest first) */
export function useTestGroups(projectId: string) {
  return useQuery({
    queryKey: queryKeys.groups(projectId),
    queryFn: () => groupsApi.list(projectId),
    enabled: !!projectId,
  });
}

/** Create a group */
export function useCreateGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, name }: { projectId: string; name: string }) =>
      groupsApi.create(projectId, name),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.groups(projectId) });
    },
  });
}

/** Rename a group */
export function useRenameGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string; projectId: string }) =>
      groupsApi.rename(id, name),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.groups(projectId) });
    },
  });
}

/** Delete a group (its tests fall back to Ungrouped) */
export function useDeleteGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; projectId: string }) => groupsApi.delete(id),
    onSuccess: (_, { projectId }) => {
      // Groups changed, and tests' group_id changed too.
      queryClient.invalidateQueries({ queryKey: queryKeys.groups(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.testCases(projectId) });
    },
  });
}

// ============ Flows Hooks ============

/** Fetch flows for a project */
export function useFlows(projectId: string) {
  return useQuery({
    queryKey: queryKeys.flows(projectId),
    queryFn: () => flowsApi.list(projectId),
    enabled: !!projectId,
  });
}

/** Fetch a single flow (includes graph data) */
export function useFlow(id: string) {
  return useQuery({
    queryKey: queryKeys.flow(id),
    queryFn: () => flowsApi.get(id),
    enabled: !!id,
  });
}

/** Create a new flow */
export function useCreateFlow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: CreateFlowRequest }) =>
      flowsApi.create(projectId, data),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.flows(projectId) });
    },
  });
}

/** Update flow metadata (name, description) */
export function useUpdateFlow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data, projectId }: { id: string; data: UpdateFlowRequest; projectId: string }) =>
      flowsApi.update(id, data),
    onSuccess: (_, { id, projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.flows(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.flow(id) });
    },
  });
}

/** Update flow graph (nodes and edges) */
export function useUpdateFlowGraph() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateGraphRequest }) =>
      flowsApi.updateGraph(id, data),
    onSuccess: (updatedFlow) => {
      // Update cache directly with new data
      queryClient.setQueryData(queryKeys.flow(updatedFlow.id), updatedFlow);
    },
  });
}

/** Delete a flow */
/** Copy a flow, graph and all */
export function useCloneFlow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; projectId: string; name?: string }) =>
      flowsApi.clone(id, name),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.flows(projectId) });
    },
  });
}

export function useDeleteFlow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId: string }) =>
      flowsApi.delete(id),
    onSuccess: (_, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.flows(projectId) });
    },
  });
}

/** Validate a flow's graph structure (optionally with current unsaved graph) */
export function useValidateFlow() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: ValidateFlowRequest }) =>
      flowsApi.validate(id, data),
  });
}

/** Execute a flow */
export function useExecuteFlow() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data?: ExecuteFlowRequest }) =>
      flowsApi.execute(id, data),
  });
}
