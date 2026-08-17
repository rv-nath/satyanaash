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
  /** This row isn't finished: it sends nothing and asserts nothing, anywhere. Unlike
   *  `needs_flow`, which says *where* a row can run, this says it runs nowhere until you
   *  enable it — somewhere to park a case while you work out what it should say. */
  disabled?: boolean;
}

/** A table of cases. "Run dataset" in the editor iterates them, and so does a flow
 *  node set to run once per row. A plain run, and any node not set that way, ignore
 *  them and send the request as authored. */
export interface Dataset {
  rows: DataRow[];
}


/**
 * How to read a test case's `payload`.
 *
 * `json` sends it verbatim — the default, and what every test case written before form
 * bodies existed does. The form types read it as a JSON array of {@link FormField}.
 *
 * One column, not two, deliberately: `DataRow.body` already overrides `payload` wholesale,
 * so a dataset row can replace a form body with no new concept and no second override path.
 */
export type BodyType = 'json' | 'urlencoded' | 'multipart';

/**
 * One part of a form body.
 *
 * A part carrying a `filename` **is** a file part — there is no separate mode, because
 * multipart has none. The server reads the extension off it and nothing else, which is how
 * `/api/v1/numbers/upload` answers "Only XLSX, XLS or CSV files are allowed".
 *
 * Several fields may share one `name`: that is exactly how an array of files is encoded, so
 * nothing may dedupe by name.
 */
export interface FormField {
  name: string;
  value: string;
  /** Unticked fields are not sent. Stored as the exception, so an ordinary field says
   *  nothing and a saved payload does not churn. */
  disabled?: boolean;
  /** Present ⇒ a file part. */
  filename?: string;
  /** Defaults from the filename's extension when unset. */
  content_type?: string;
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
  /** How to read `payload`. Absent means `json` — sent verbatim. */
  body_type?: BodyType | null;
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
  body_type?: BodyType;
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
  body_type?: BodyType;
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
  /** The bucket this flow sits in. Absent or null is Ungrouped — every flow predating groups. */
  group_id?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A bucket of flows.
 *
 * Structurally a `TestGroup`, and deliberately its own type: they are separate tables and a
 * separate set of names, so a function that takes one must not silently accept the other.
 * **Not** the canvas `group` node, which runs a sub-flow — that name is the older misnomer.
 */
export interface FlowGroup {
  id: string;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CreateFlowRequest {
  name: string;
  description?: string;
  graph_data?: GraphData;
  /** The sidebar bucket to create it in. Omitted is Ungrouped. */
  group_id?: string | null;
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

/**
 * One sub-flow node on the canvas, and the steps it turned into.
 *
 * A flow's sub-flow nodes are spliced into its graph before the run, so what executes is a
 * flat flow whose inner steps carry synthetic ids. This is how the client gets back from
 * those ids to the node the author can see — **the only way**. The ids are joined by an
 * unprintable separator precisely so nothing is tempted to split one.
 *
 * Arrives on the `started` event, and only when there are any.
 */
export interface InlinedGroup {
  /** The id of the node on the author's own canvas. */
  group_node_id: string;
  flow_id: string;
  flow_name: string;
  /** The ids the run will report under, in the order they were spliced. */
  node_ids: string[];
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
  /** How many times the request was sent, on a node that polls. Absent when it does not
   *  — the report says nothing rather than reporting "1", and a single duration cannot
   *  tell "one slow request" from "sixty quick ones". */
  attempts?: number;
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
  /**
   * What the `iterations` are, when they are not data rows — `"item"` for a step that walks
   * a collected list. Absent for a dataset fan-out, which is every run recorded before it,
   * so `iterationNoun` supplies the default rather than every caller.
   */
  iterations_of?: string;
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

// ============ Suites and run history ============

export type MemberKind = 'flow' | 'test';

export interface SuiteMember {
  kind: MemberKind;
  id: string;
}

export interface Suite {
  id: string;
  project_id: string;
  name: string;
  /**
   * The ordered selection. **Absent means every flow and test in the project**, resolved
   * when the suite runs — so a flow added tomorrow is included. An empty array means
   * nothing is selected, and the run is refused rather than quietly doing everything.
   *
   * New suites are created empty. "Everything" is a deliberate choice for the one suite
   * that wants it (a nightly full regression), not a default that hides what it covers.
   */
  members?: SuiteMember[];
  created_at: string;
  updated_at: string;
}

export interface CreateSuiteRequest {
  name: string;
  members?: SuiteMember[];
}

export interface UpdateSuiteRequest {
  name?: string;
  /** Omit to leave the selection alone; `null` resets it to "everything". */
  members?: SuiteMember[] | null;
}

/** One member's run within a stored run. */
export interface FlowRun {
  id: string;
  suite_run_id: string;
  ordinal: number;
  member_kind: MemberKind;
  /** Null once the flow has been deleted — the record outlives what it ran. */
  flow_id?: string | null;
  test_case_id?: string | null;
  /** What it was called when it ran, not what the project calls it now. */
  name: string;
  status: string;
  started_at: string;
  duration_ms?: number | null;
  error_message?: string | null;
  /** Filled by `runsApi.get`, empty in the list. */
  results?: TestCaseExecutionResult[];
}

/** One press of Run. A single flow is stored as an ad-hoc run of one. */
export interface SuiteRun {
  id: string;
  project_id: string;
  /** Null for an ad-hoc single-flow run, and for a run whose suite was deleted. */
  suite_id?: string | null;
  suite_name: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  environment_name?: string | null;
  error_message?: string | null;
  members?: FlowRun[];
}

/**
 * A page of run history, and what it is not showing.
 *
 * The count travels with the rows because omitting it silently would read as "that's all
 * there is" — the same dishonest completeness a dataset hides when it reports only the
 * rows it ran.
 */
export interface RunListing {
  runs: SuiteRun[];
  /** Ad-hoc runs left out of this page. Zero when they were asked for. */
  adhoc_hidden: number;
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
