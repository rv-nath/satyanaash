export type Project = {
  id: string;
  name: string;
  description?: string;
  test_count: number;
  group_count: number;
  created_at: string;
  updated_at: string;
  last_run_status?: 'completed' | 'failed' | 'running';
  pass_rate?: number;
};

export type TestCase = {
  id: string;
  name: string;
  given?: string;
  when?: string;
  then?: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: [string, string][];
  payload?: string;
  payload_type?: 'json' | 'xml' | 'form-data' | 'multipart' | 'text' | 'binary';
  repeat_count?: number;
  auth_type?: 'none' | 'authorizer' | 'authorized';
  delay_ms?: number;
  failure_strategy?: 'stop' | 'continue' | 'retry';
  retry_count?: number;
  retry_delay_ms?: number;
  pre_test_script?: string;
  post_test_script?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
};

export type GraphNode = {
  id: string;
  type: 'test_case' | 'group' | 'conditional' | 'loop' | 'parallel' | 'entry' | 'exit';
  position: { x: number; y: number };
  data: {
    label: string;
    test_case_id?: string;
    group_id?: string;
    condition?: string;
    [key: string]: any;
  };
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type?: 'always' | 'on_success' | 'on_failure' | 'custom' | 'http_status';
  label?: string;
  animated?: boolean;
  style?: Record<string, any>;
};

export type ExecutionRun = {
  run_id: string;
  project_id: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms?: number;
  started_at: string;
  ended_at?: string;
};

export type ExecutionEvent = {
  type: 'SuiteBegin' | 'SuiteEnd' | 'TestCaseBegin' | 'TestCaseEnd' | 'NodeExecutionBegin' | 'NodeExecutionEnd';
  timestamp: string;
  run_id: string;
  node_id?: string;
  test_case_id?: string;
  test_name?: string;
  status?: 'passed' | 'failed' | 'skipped';
  duration_ms?: number;
  http_status?: number;
  error_message?: string;
};
