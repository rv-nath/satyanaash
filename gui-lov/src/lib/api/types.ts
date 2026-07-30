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

/** One data-driven case: what to send, and what should come back. */
export interface DataRow {
  id: string;
  /** Human label for this case, shown in the results table. */
  name?: string | null;
  /** Body to send instead of the test case's payload. Still interpolated, so
   *  {{variables}} work. Blank means "use the test case's payload". */
  body?: string | null;
  /** What must be true for this row to pass: either a bare status code ("400")
   *  or a Rhai expression. Blank means "any 2xx". */
  check?: string | null;
  /** Appended to the test case's endpoint for this row — "?org=acme",
   *  "/acme/summary" — so one request can be varied by URL as well as by body.
   *  Interpolated like the endpoint itself. Blank uses the endpoint as authored. */
  path?: string | null;
  /** This row only means something after something else has happened — a login, a
   *  top-up. "Run dataset" skips it; a flow node runs it, the flow being the
   *  precondition. Says where a row can run, not why. */
  needs_flow?: boolean;
  /** Values for the `{{names}}` the request already declares — the path parameters in
   *  `/campaigns/{{channel}}/pause/{{campaignID}}`. The editor reads the names off the
   *  endpoint, so there is nothing to define. A name left out isn't set by this row and
   *  resolves from wherever it would have anyway. */
  vars?: Record<string, string>;
}

/** A table of cases. "Run dataset" in the editor iterates them, and so does a flow
 *  node set to run once per row. A plain run, and any node not set that way, ignore
 *  them and send the request as authored. */
export interface Dataset {
  rows: DataRow[];
}

export interface TestCase {
  id: string;
  project_id: string;
  group_id?: string | null;
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
  pre_test_script: string | null;
  dataset?: Dataset | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTestCaseRequest {
  name: string;
  group_id?: string;
  given_condition?: string;
  when_action?: string;
  then_expected?: string;
  method: string;
  endpoint: string;
  headers?: Record<string, string>;  // JSON Value in backend
  payload?: string;                   // String in backend (not parsed JSON)
  exports?: ExportVariable[];
  assertion_script?: string;
  pre_test_script?: string;
  /** Always send this (even empty) — the backend PATCH merge keeps the existing
   *  dataset when the field is absent, which would make clearing impossible. */
  dataset?: Dataset;
}

export interface UpdateTestCaseRequest {
  name?: string;
  group_id?: string;
  given_condition?: string;
  when_action?: string;
  then_expected?: string;
  method?: string;
  endpoint?: string;
  headers?: Record<string, string>;  // JSON Value in backend
  payload?: string;                   // String in backend (not parsed JSON)
  exports?: ExportVariable[];
  assertion_script?: string;
  pre_test_script?: string;
  /** Always send this (even empty) — the backend PATCH merge keeps the existing
   *  dataset when the field is absent, which would make clearing impossible. */
  dataset?: Dataset;
}

export interface TestGroup {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
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

export interface CanvasSettings {
  edgeType?: 'default' | 'smoothstep' | 'step' | 'straight';
  showEdgeLabels?: boolean;
  viewport?: { x: number; y: number; zoom: number };
}

export interface GraphData {
  nodes: FlowNode[];
  edges: FlowEdge[];
  canvas_settings?: CanvasSettings;
  variables?: Record<string, unknown>;
}

export interface Flow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  graph_data: GraphData;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateFlowRequest {
  name: string;
  description?: string;
  graph_data?: GraphData;
}

export interface UpdateFlowRequest {
  name?: string;
  description?: string;
  version: number;  // Required for optimistic locking
}

export interface UpdateGraphRequest {
  graph_data: GraphData;  // canvas_settings is now inside graph_data
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
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateFlowRequest {
  nodes?: unknown[];
  edges?: unknown[];
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

// ============ Test Case Execution ============

export interface RequestLog {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ResponseLog {
  status: number;
  headers: Record<string, string>;
  body: string;
  json?: unknown;
}

export interface TestCaseExecutionResult {
  node_id: string;
  /** The node's own name on the canvas, when the author gave it one. */
  node_label?: string;
  /** Set when this node ran as teardown, so cleanup trouble reads as cleanup
   *  trouble rather than as the scenario failing. */
  teardown?: boolean;
  test_case_id?: string;
  test_case_name?: string;
  status: 'passed' | 'failed' | 'error' | 'skipped';
  /** What this run required, after interpolation — "HTTP 400", a Rhai expression, or
   *  "any 2xx". Recorded by the engine rather than looked up in the dataset, which may
   *  have been edited since the run. */
  expected?: string;
  duration_ms: number;
  request?: RequestLog;
  response?: ResponseLog;
  exports?: Record<string, unknown>;
  /** Environment writes made by SAT.env — client persists to the active env */
  env?: Record<string, unknown>;
  error_message?: string;
  logs: string[];
  /** Index of the data row this result came from (iteration results only) */
  row_index?: number;
  /** Label for that row — its name, else "Row N" */
  row_label?: string;
  /** Per-row results; present only on the aggregate of a "run all rows" run */
  iterations?: TestCaseExecutionResult[];
}

export interface ExecuteTestCaseRequest {
  variables?: Record<string, unknown>;
  /** Effective environment (Globals + active env) to run against */
  environment?: Record<string, unknown>;
  /** Override: HTTP method (runs with this instead of saved value) */
  method?: string;
  /** Override: Endpoint URL */
  endpoint?: string;
  /** Override: Request headers */
  headers?: Record<string, string>;
  /** Override: Request payload/body */
  payload?: string;
  /** Override: Assertion script */
  assertion_script?: string;
  /** Override: Pre-test script */
  pre_test_script?: string;
  /** Override: data rows, so the editor can run unsaved rows */
  dataset?: Dataset;
  /** Run every data row instead of the test case as authored */
  all_rows?: boolean;
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
