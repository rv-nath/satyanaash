import { create } from 'zustand';
import type { Project } from '../types';

interface MockStore {
  projects: Project[];
  addProject: (project: Omit<Project, 'id' | 'created_at' | 'updated_at' | 'test_count' | 'group_count'>) => Project;
  updateProject: (id: string, data: Partial<Project>) => void;
  deleteProject: (id: string) => void;
  getProject: (id: string) => Project | undefined;
}

// Initial mock data
const initialProjects: Project[] = [
  {
    id: '1',
    name: 'My API Tests',
    description: 'Authentication and user management APIs',
    test_count: 45,
    group_count: 8,
    created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    last_run_status: 'completed',
    pass_rate: 0.95,
  },
  {
    id: '2',
    name: 'E-commerce Tests',
    description: 'Product catalog and checkout flow tests',
    test_count: 32,
    group_count: 5,
    created_at: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    last_run_status: 'completed',
    pass_rate: 0.88,
  },
  {
    id: '3',
    name: 'Payment Gateway Integration',
    description: 'Stripe and PayPal payment processing',
    test_count: 18,
    group_count: 3,
    created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    last_run_status: 'failed',
    pass_rate: 0.72,
  },
];

export const useMockStore = create<MockStore>((set, get) => ({
  projects: initialProjects,

  addProject: (projectData) => {
    const newProject: Project = {
      ...projectData,
      id: Date.now().toString(),
      test_count: 0,
      group_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    set((state) => ({
      projects: [...state.projects, newProject],
    }));

    return newProject;
  },

  updateProject: (id, data) => {
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, ...data, updated_at: new Date().toISOString() } : p
      ),
    }));
  },

  deleteProject: (id) => {
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
    }));
  },

  getProject: (id) => {
    return get().projects.find((p) => p.id === id);
  },
}));
