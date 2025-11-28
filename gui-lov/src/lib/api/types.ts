/**
 * API Types - Matches backend models
 */

// ============ Projects ============

export interface Project {
  id: string;
  name: string;
  description: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  settings?: Record<string, unknown>;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  settings?: Record<string, unknown>;
}

// ============ Test Cases ============

export interface ExportVariable {
  name: string;
  json_path: string;
}

export interface TestCase {
  id: string;
  project_id: string;
  name: string;
  given_condition: string | null;
  when_action: string | null;
  then_expected: string | null;
  method: string;
  endpoint: string;
  headers: Record<string, string>;
  payload: string | null;  // Stored as JSON string in backend
  exports: ExportVariable[];
  assertion_script: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTestCaseRequest {
  name: string;
  given_condition?: string;
  when_action?: string;
  then_expected?: string;
  method: string;
  endpoint: string;
  headers?: Record<string, string>;  // JSON Value in backend
  payload?: string;                   // String in backend (not parsed JSON)
  exports?: ExportVariable[];
  assertion_script?: string;
}

export interface UpdateTestCaseRequest {
  name?: string;
  given_condition?: string;
  when_action?: string;
  then_expected?: string;
  method?: string;
  endpoint?: string;
  headers?: Record<string, string>;  // JSON Value in backend
  payload?: string;                   // String in backend (not parsed JSON)
  exports?: ExportVariable[];
  assertion_script?: string;
}

// ============ Flows ============

export interface FlowNode {
  id: string;
  type: 'start' | 'end' | 'testCase' | 'group';  // Backend uses 'type' (serde rename)
  position: { x: number; y: number };
  data: Record<string, unknown>;
  width?: number;
  height?: number;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  edge_type?: 'success' | 'failure' | 'default';
  label?: string;
}

export interface GraphData {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface Flow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  graph_data: GraphData;
  canvas_settings: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateFlowRequest {
  name: string;
  description?: string;
  graph_data?: GraphData;
  canvas_settings?: Record<string, unknown>;
}

export interface UpdateFlowRequest {
  name?: string;
  description?: string;
  canvas_settings?: Record<string, unknown>;
}

export interface UpdateGraphRequest {
  graph_data: GraphData;
  version: number;
}

// ============ Validation ============

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  node_id?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// ============ Execution ============

export interface ExecuteFlowRequest {
  debug_mode?: boolean;
  environment?: Record<string, unknown>;
  variables?: Record<string, unknown>;
}

export interface ExecutionStats {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
}

export interface ExecutionResponse {
  execution_id: string;
  flow_id: string;
  status: string;
  duration_ms: number;
  stats: ExecutionStats;
  results?: unknown[];
  context?: Record<string, unknown>;
}

// ============ Pagination ============

export interface PaginationParams {
  page?: number;
  per_page?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}
