import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { ProjectsDashboard } from './pages/ProjectsDashboard';
import { GraphEditor } from './pages/GraphEditor';
import { ExecutionDashboard } from './pages/ExecutionDashboard';

// Root route with layout
const rootRoute = createRootRoute({
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
});

// Home route
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ProjectsDashboard,
});

// Graph editor route
const graphEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/editor',
  component: GraphEditor,
});

// Execution dashboard route
const executionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/runs/$runId',
  component: ExecutionDashboard,
});

// Create the route tree
const routeTree = rootRoute.addChildren([
  indexRoute,
  graphEditorRoute,
  executionRoute,
]);

// Create and export the router
export const router = createRouter({ routeTree });

// Register router type for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
