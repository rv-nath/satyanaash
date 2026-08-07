import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, FolderKanban, Clock, Play, Trash2, MoreVertical, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useProjects, useCreateProject, useDeleteProject } from "@/hooks/useApi";
import { DeleteProjectDialog } from "@/components/DeleteProjectDialog";
import type { Project } from "@/lib/api/types";

const Projects = () => {
  // Fetch projects from API
  const { data: projects, isLoading, error } = useProjects();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newProject, setNewProject] = useState({ name: "", description: "" });

  const handleCreateProject = async () => {
    if (!newProject.name.trim()) {
      toast.error("Project name is required");
      return;
    }

    try {
      await createProjectMutation.mutateAsync({
        name: newProject.name,
        description: newProject.description || undefined,
      });
      setNewProject({ name: "", description: "" });
      setIsCreateOpen(false);
      toast.success("Project created successfully");
    } catch (err) {
      toast.error("Failed to create project");
      console.error(err);
    }
  };

  // Confirmed first, always. A project cascades to its requests, flows, suites and its whole
  // run history, with no undo and no export — and this was a single click in a dropdown.
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);

  const handleDeleteProject = async (project: Project) => {
    try {
      await deleteProjectMutation.mutateAsync(project.id);
      setPendingDelete(null);
      toast.success(`${project.name} deleted`);
    } catch (err) {
      // The dialog stays open on failure: it holds the typed confirmation, and making someone
      // find the menu and type the name again to retry would be its own small punishment.
      toast.error(err instanceof Error ? err.message : "Failed to delete project");
      console.error(err);
    }
  };

  // Format date for display
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} minutes ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FolderKanban className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-semibold font-mono text-foreground">Satyanaash</h1>
          </div>

          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                New Project
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Project</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Project Name</Label>
                  <Input
                    id="name"
                    value={newProject.name}
                    onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                    placeholder="My API Tests"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={newProject.description}
                    onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                    placeholder="Enter project description..."
                    rows={3}
                  />
                </div>
                <Button
                  onClick={handleCreateProject}
                  className="w-full"
                  disabled={createProjectMutation.isPending}
                >
                  {createProjectMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    "Create Project"
                  )}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      {/* Content */}
      <main className="container mx-auto px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold text-foreground mb-2">Projects</h2>
          <p className="text-muted-foreground">Manage your test projects and execution graphs</p>
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <span className="ml-3 text-muted-foreground">Loading projects...</span>
          </div>
        )}

        {/* Error State */}
        {error && (
          <Card className="p-8 text-center border-destructive">
            <AlertCircle className="w-12 h-12 mx-auto mb-4 text-destructive" />
            <h3 className="text-lg font-medium text-foreground mb-2">Failed to load projects</h3>
            <p className="text-muted-foreground mb-4">
              {error instanceof Error ? error.message : "Please check if the backend is running"}
            </p>
            <p className="text-sm text-muted-foreground">
              Backend should be at: http://localhost:3001
            </p>
          </Card>
        )}

        {/* Empty State */}
        {!isLoading && !error && projects?.length === 0 && (
          <Card className="p-12 text-center border-dashed">
            <FolderKanban className="w-16 h-16 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-medium text-foreground mb-2">No projects yet</h3>
            <p className="text-muted-foreground mb-6">Create your first test project to get started</p>
            <Button onClick={() => setIsCreateOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Create Project
            </Button>
          </Card>
        )}

        {/* Projects Grid */}
        {!isLoading && !error && projects && projects.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project, index) => (
              <motion.div
                key={project.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <Card className="group hover:border-primary/50 transition-all duration-200">
                  <Link to={`/project/${project.id}`}>
                    <div className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex-1">
                          <h3 className="text-lg font-semibold text-foreground mb-1 font-mono group-hover:text-primary transition-colors">
                            {project.name}
                          </h3>
                          <p className="text-sm text-muted-foreground line-clamp-2">
                            {project.description || "No description"}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.preventDefault()}>
                            <Button variant="ghost" size="icon" className="ml-2">
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={(e) => {
                                e.preventDefault();
                                setPendingDelete(project);
                              }}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      <div className="space-y-2 mb-4">
                        <div className="flex items-center gap-2 text-sm">
                          <Play className="w-4 h-4 text-primary" />
                          <span className="text-muted-foreground">Project ID: {project.id.slice(0, 8)}...</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Clock className="w-4 h-4" />
                          <span>Modified {formatDate(project.updated_at)}</span>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button variant="secondary" size="sm" className="flex-1">
                          Open
                        </Button>
                      </div>
                    </div>
                  </Link>
                </Card>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      {pendingDelete && (
        <DeleteProjectDialog
          project={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => handleDeleteProject(pendingDelete)}
          deleting={deleteProjectMutation.isPending}
        />
      )}
    </div>
  );
};

export default Projects;
