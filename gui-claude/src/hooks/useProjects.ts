import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/api';
import type { Project } from '../types';
import { useMockStore } from '../lib/mockStore';

// Toggle this to switch between mock and real API
const USE_MOCK_DATA = true;

export function useProjects(params?: { page?: number; limit?: number }) {
  const mockProjects = useMockStore((state) => state.projects);

  return useQuery({
    queryKey: ['projects', params],
    queryFn: async () => {
      if (USE_MOCK_DATA) {
        // Simulate network delay
        await new Promise((resolve) => setTimeout(resolve, 300));
        return mockProjects;
      }
      const { data } = await apiClient.get<{ data: Project[] }>('/projects', { params });
      return data.data;
    },
  });
}

export function useProject(projectId: string | undefined) {
  const getProject = useMockStore((state) => state.getProject);

  return useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      if (USE_MOCK_DATA) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const project = getProject(projectId!);
        if (!project) throw new Error('Project not found');
        return project;
      }
      const { data } = await apiClient.get<Project>(`/projects/${projectId}`);
      return data;
    },
    enabled: !!projectId,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  const addProject = useMockStore((state) => state.addProject);

  return useMutation({
    mutationFn: async (data: { name: string; description?: string }) => {
      if (USE_MOCK_DATA) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return addProject(data);
      }
      const response = await apiClient.post<Project>('/projects', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useUpdateProject(projectId: string) {
  const queryClient = useQueryClient();
  const updateProject = useMockStore((state) => state.updateProject);
  const getProject = useMockStore((state) => state.getProject);

  return useMutation({
    mutationFn: async (data: { name?: string; description?: string }) => {
      if (USE_MOCK_DATA) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        updateProject(projectId, data);
        return getProject(projectId)!;
      }
      const response = await apiClient.put<Project>(`/projects/${projectId}`, data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  const deleteProject = useMockStore((state) => state.deleteProject);

  return useMutation({
    mutationFn: async (projectId: string) => {
      if (USE_MOCK_DATA) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        deleteProject(projectId);
        return;
      }
      await apiClient.delete(`/projects/${projectId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useExecuteProject(projectId: string) {
  return useMutation({
    mutationFn: async (options?: { version?: string; dry_run?: boolean }) => {
      if (USE_MOCK_DATA) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          run_id: `run-${Date.now()}`,
          status: 'running',
          websocket_url: `ws://localhost:8080/api/ws/run-${Date.now()}`,
        };
      }
      const { data } = await apiClient.post(`/projects/${projectId}/execute`, options);
      return data;
    },
  });
}
