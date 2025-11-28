import React, { useState } from 'react';
import { Plus, Search, Play, History, MoreVertical, FolderOpen } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useProjects, useExecuteProject, useCreateProject } from '../hooks/useProjects';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import { Input, Textarea } from '../components/ui/Input';
import { formatDate } from '../lib/utils';

export function ProjectsDashboard() {
  const { data: projects, isLoading } = useProjects();
  const [showCreateModal, setShowCreateModal] = useState(false);

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-neutral-900">Projects</h1>
          <p className="text-neutral-500 mt-2">
            Manage your API test projects
          </p>
        </div>

        {/* Overview Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-neutral-500">Total Projects</p>
                  <p className="text-3xl font-bold text-neutral-900 mt-1">
                    {projects?.length || 0}
                  </p>
                </div>
                <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center">
                  <FolderOpen className="w-6 h-6 text-primary-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-neutral-500">Active Tests</p>
                  <p className="text-3xl font-bold text-neutral-900 mt-1">
                    {projects?.reduce((sum, p) => sum + p.test_count, 0) || 0}
                  </p>
                </div>
                <div className="w-12 h-12 bg-success-100 rounded-lg flex items-center justify-center">
                  <Play className="w-6 h-6 text-success-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-neutral-500">Avg Pass Rate</p>
                  <p className="text-3xl font-bold text-neutral-900 mt-1">
                    {projects?.filter(p => p.pass_rate).length
                      ? Math.round(
                          projects
                            .filter(p => p.pass_rate)
                            .reduce((sum, p) => sum + (p.pass_rate || 0), 0) /
                            projects.filter(p => p.pass_rate).length
                        )
                      : 0}
                    %
                  </p>
                </div>
                <div className="w-12 h-12 bg-warning-100 rounded-lg flex items-center justify-center">
                  <History className="w-6 h-6 text-warning-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Projects List */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Your Projects</CardTitle>
              <Button onClick={() => setShowCreateModal(true)}>
                <Plus className="w-4 h-4 mr-2" />
                New Project
              </Button>
            </div>
          </CardHeader>

          <CardContent>
            {/* Search */}
            <div className="mb-6">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-neutral-500" />
                <Input
                  placeholder="Search projects..."
                  className="pl-10"
                />
              </div>
            </div>

            {/* Projects Grid */}
            {isLoading ? (
              <div className="text-center py-12 text-neutral-500">Loading projects...</div>
            ) : projects && projects.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {projects.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <FolderOpen className="w-16 h-16 text-neutral-300 mx-auto mb-4" />
                <p className="text-neutral-500 mb-4">No projects yet</p>
                <Button onClick={() => setShowCreateModal(true)}>
                  Create Your First Project
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create Project Modal */}
      {showCreateModal && (
        <CreateProjectModal
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: any }) {
  const navigate = useNavigate();
  const executeProject = useExecuteProject(project.id);
  const [showMenu, setShowMenu] = useState(false);

  const handleOpen = () => {
    navigate({ to: '/projects/$projectId/editor', params: { projectId: project.id } });
  };

  return (
    <Card className="hover:border-primary-300 transition-colors">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex-1">
            <h3 className="font-semibold text-lg text-neutral-900 mb-1">
              {project.name}
            </h3>
            {project.description && (
              <p className="text-sm text-neutral-500 line-clamp-2">
                {project.description}
              </p>
            )}
          </div>
          <button
            onClick={() => setShowMenu(!showMenu)}
            className="p-1 hover:bg-neutral-200 rounded"
          >
            <MoreVertical className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        <div className="flex items-center gap-3 text-sm text-neutral-600 mb-4">
          <span>{project.test_count} tests</span>
          <span>•</span>
          <span>{project.group_count} groups</span>
        </div>

        {project.last_run_status && (
          <div className="mb-4">
            <Badge variant={project.last_run_status === 'completed' ? 'success' : 'error'}>
              {project.last_run_status === 'completed' ? '✓' : '✗'}{' '}
              {project.pass_rate ? `${Math.round(project.pass_rate * 100)}%` : 'N/A'}
            </Badge>
          </div>
        )}

        <div className="flex gap-2">
          <Button size="sm" className="flex-1" variant="secondary" onClick={handleOpen}>
            <FolderOpen className="w-4 h-4 mr-1" />
            Open
          </Button>
          <Button
            size="sm"
            className="flex-1"
            onClick={() => executeProject.mutate({})}
            loading={executeProject.isPending}
          >
            <Play className="w-4 h-4 mr-1" />
            Run
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CreateProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const createProject = useCreateProject();

  const handleCreate = async () => {
    if (!name.trim()) return;

    try {
      const newProject = await createProject.mutateAsync({ name, description });
      setName('');
      setDescription('');
      onClose();
      // Navigate to the graph editor for the new project
      navigate({ to: '/projects/$projectId/editor', params: { projectId: newProject.id } });
    } catch (error) {
      console.error('Failed to create project:', error);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Create New Project">
      <div className="space-y-4">
        <Input
          label="Project Name"
          placeholder="My API Tests"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        <Textarea
          label="Description"
          placeholder="Describe your project..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            loading={createProject.isPending}
            disabled={!name.trim()}
          >
            Create Project
          </Button>
        </div>
      </div>
    </Modal>
  );
}
