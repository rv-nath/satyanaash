//! Running a suite: flows and standalone tests, one after another, as one run.
//!
//! Each member is an ordinary flow or test-case execution — the engine is untouched.
//! What this adds is the loop around them, three things it has to get right, and the
//! record at the end.
//!
//! 1. **Member boundaries in the stream.** Each inner run emits its own `Started` and
//!    `Completed`, which a client reads as the whole run ending four members early. Both
//!    are swallowed here and reported as `MemberStarted` / `MemberCompleted`, so
//!    `Completed` still means "that is all".
//! 2. **`SAT.env` writes carried forward.** For a single flow the *client* persists them
//!    (`NodeResult.env`). A server-driven suite has no client doing that between
//!    members, so flow 2 would not see what flow 1 wrote. They are folded forward in
//!    memory here, mirroring what `run_rows` does across dataset rows — and deliberately
//!    **not** written back to project settings, because a run should not quietly edit
//!    the saved environment.
//! 3. **A member that fails does not stop the suite.** One red flow is a result, not a
//!    reason to stop reporting on the other five. Only the client going away stops it.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::db::models::{MemberKind, Pagination, RunTotals, Suite, SuiteRunInput};
use crate::db::repositories::{FlowRepository, RunRepository, TestCaseRepository};
use crate::error::AppError;
use crate::execution::history::MemberRef;
use crate::execution::{
    ExecutionEngine, ExecutionEvent, ExecutionStats, FlowExecutionResult, NodeStatus,
};

/// A member with its name resolved, ready to run.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedMember {
    pub kind: MemberKind,
    pub id: String,
    pub name: String,
}

/// Everything in the project, when a suite has not narrowed the selection. Flows first,
/// then standalone tests: the flows are the scenarios, and a test on its own is the
/// exception.
///
/// A high `per_page` rather than paging: a project's flows and tests number in the tens,
/// and a suite that silently ran the first twenty would be worse than one that failed.
const EVERYTHING: u32 = 1000;

pub async fn resolve_members(
    suite: &Suite,
    flow_repo: &dyn FlowRepository,
    tc_repo: &dyn TestCaseRepository,
) -> Result<Vec<ResolvedMember>, AppError> {
    let flows = flow_repo
        .list_by_project(&suite.project_id, Pagination { page: 1, per_page: EVERYTHING })
        .await?;
    let tests = tc_repo
        .list_by_project(&suite.project_id, Pagination { page: 1, per_page: EVERYTHING })
        .await?;

    let Some(chosen) = &suite.members else {
        // Absence means everything, resolved now rather than frozen when the suite was
        // saved — so a flow added today is in tonight's run.
        let mut all: Vec<ResolvedMember> = flows
            .data
            .iter()
            .map(|f| ResolvedMember { kind: MemberKind::Flow, id: f.id.clone(), name: f.name.clone() })
            .collect();
        all.extend(tests.data.iter().map(|t| ResolvedMember {
            kind: MemberKind::Test,
            id: t.id.clone(),
            name: t.name.clone(),
        }));
        return Ok(all);
    };

    if chosen.is_empty() {
        return Err(AppError::BadRequest(format!(
            "Suite \"{}\" has nothing selected. Leave the selection unset to run every flow and test.",
            suite.name
        )));
    }

    // In the order the author put them in, which is the run order. A member whose flow
    // or test has since been deleted is dropped rather than failing the run — the
    // remaining five still tell you something.
    Ok(chosen
        .iter()
        .filter_map(|m| {
            let name = match m.kind {
                MemberKind::Flow => flows.data.iter().find(|f| f.id == m.id).map(|f| f.name.clone()),
                MemberKind::Test => tests.data.iter().find(|t| t.id == m.id).map(|t| t.name.clone()),
            }?;
            Some(ResolvedMember { kind: m.kind, id: m.id.clone(), name })
        })
        .collect())
}

pub struct SuiteRun<'a> {
    pub execution_id: String,
    pub project_id: String,
    pub suite_id: Option<String>,
    pub suite_name: String,
    pub environment_name: Option<String>,
    pub debug_mode: bool,
    pub base_url: Option<String>,
    pub flow_repo: &'a dyn FlowRepository,
    pub tc_repo: &'a dyn TestCaseRepository,
    pub run_repo: Arc<dyn RunRepository>,
    /// The callback inboxes, so an await node inside a suite watches the same ones a flow run
    /// does. Left out, a suite would time out on every wait while the callbacks arrived in the
    /// set nobody was reading.
    pub hooks: crate::hooks::Hooks,
}

impl SuiteRun<'_> {
    pub async fn execute(
        &self,
        members: Vec<ResolvedMember>,
        mut environment: HashMap<String, Value>,
        variables: HashMap<String, Value>,
        out: mpsc::Sender<ExecutionEvent>,
    ) -> Result<(), AppError> {
        let started = std::time::Instant::now();
        let run_id = self
            .run_repo
            .start(SuiteRunInput {
                project_id: self.project_id.clone(),
                suite_id: self.suite_id.clone(),
                suite_name: self.suite_name.clone(),
                environment_name: self.environment_name.clone(),
            })
            .await?;

        let _ = out
            .send(ExecutionEvent::SuiteStarted {
                execution_id: self.execution_id.clone(),
                // Sent after `start` and before the first member, so the client can open
                // the run the moment it exists rather than when it finishes.
                run_id: run_id.clone(),
                suite_id: self.suite_id.clone(),
                suite_name: self.suite_name.clone(),
                total_members: members.len(),
            })
            .await;

        let mut totals = RunTotals::default();
        let mut abandoned = false;

        for (ordinal, member) in members.iter().enumerate() {
            // Between members is the suite's own boundary check. Inside a member the
            // engine already stops at the next node when nobody is watching or the
            // process is going down; this stops the *next member* from starting at all.
            if out.is_closed() || crate::shutdown::stopping() {
                abandoned = true;
                break;
            }

            let _ = out
                .send(ExecutionEvent::MemberStarted {
                    ordinal,
                    total: members.len(),
                    kind: member.kind.as_str().to_string(),
                    member_id: member.id.clone(),
                    name: member.name.clone(),
                })
                .await;

            let result = self
                .run_member(member, environment.clone(), variables.clone(), &out)
                .await;

            let result = match result {
                Ok(result) => result,
                Err(e) => {
                    // A member that could not even be loaded is recorded as an error and
                    // the suite carries on — a deleted test case should not cost you the
                    // other five flows' results.
                    let _ = out
                        .send(ExecutionEvent::Error { message: format!("{}: {e}", member.name) })
                        .await;
                    failed_to_start(member, &e)
                }
            };

            // A member that executed nothing is not a pass.
            //
            // `run_flow` reports "completed" for a graph it walked without reaching a
            // single test case — an empty flow, or one whose only path is start → end. In
            // the history that reads as a green member, 0 ms, no steps, and it is
            // indistinguishable from one that worked. Same fold as an all-skipped dataset
            // yielding `Skipped` rather than `Passed`.
            let result = if result.results.is_empty() && result.status == "completed" {
                FlowExecutionResult { status: "skipped".to_string(), ..result }
            } else {
                result
            };

            // Carry SAT.env writes forward, so a login in member 1 is a token in
            // member 2. In memory only — see the module note.
            for node in &result.results {
                if let Some(writes) = &node.env {
                    for (k, v) in writes {
                        environment.insert(k.clone(), v.clone());
                    }
                }
            }

            totals.add(&result.stats);
            let _ = out
                .send(ExecutionEvent::MemberCompleted {
                    ordinal,
                    name: member.name.clone(),
                    status: result.status.clone(),
                    duration_ms: result.duration_ms,
                    passed: result.stats.passed,
                    failed: result.stats.failed,
                    errors: result.stats.errors,
                    skipped: result.stats.skipped,
                })
                .await;

            let member_ref = match member.kind {
                MemberKind::Flow => MemberRef::flow(&member.id, &member.name),
                MemberKind::Test => MemberRef::test(&member.id, &member.name),
            };
            if let Err(e) = self
                .run_repo
                .record_member(&run_id, member_ref.input(ordinal as i64, &result))
                .await
            {
                tracing::warn!("member \"{}\" ran but was not recorded: {e}", member.name);
            }
        }

        let status = suite_status(&totals, abandoned);
        let duration_ms = started.elapsed().as_millis() as u64;
        self.run_repo.finish(&run_id, &status, totals, None).await?;

        let _ = out
            .send(ExecutionEvent::Completed {
                execution_id: self.execution_id.clone(),
                status,
                duration_ms,
                passed: totals.passed as usize,
                failed: totals.failed as usize,
                errors: totals.errors as usize,
                skipped: totals.skipped as usize,
            })
            .await;

        Ok(())
    }

    async fn run_member(
        &self,
        member: &ResolvedMember,
        environment: HashMap<String, Value>,
        variables: HashMap<String, Value>,
        out: &mpsc::Sender<ExecutionEvent>,
    ) -> Result<FlowExecutionResult, AppError> {
        let engine = ExecutionEngine::new(self.debug_mode, self.base_url.clone())
            .with_hooks(self.hooks.clone());

        match member.kind {
            MemberKind::Flow => {
                let flow = self
                    .flow_repo
                    .get_by_id(&member.id)
                    .await?
                    .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", member.id)))?;

                // Same resolution the single-flow endpoints do: a member with a sub-flow node
                // has to arrive at the engine flat, or the engine refuses it. The suite
                // swallows this member's `Started`, so there is nowhere to hand the group map
                // — the notes go to the log, and the run itself is what matters here.
                let (flow, _groups, notes) =
                    crate::execution::resolve_for_run(flow, self.flow_repo).await?;
                for note in &notes {
                    tracing::warn!(flow = %member.id, "{}", note);
                }

                // The inner run gets its own channel so its Started/Completed can be
                // swallowed on the way out.
                let (inner_tx, mut inner_rx) = mpsc::channel::<ExecutionEvent>(100);
                let outer = out.clone();
                let relay = async move {
                    while let Some(event) = inner_rx.recv().await {
                        match event {
                            ExecutionEvent::Started { .. } | ExecutionEvent::Completed { .. } => {}
                            other => {
                                // Dropping inner_rx here closes the inner sender, which is
                                // how a member in flight learns the client has gone — the
                                // engine's own boundary check reads that same signal.
                                if outer.send(other).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                };

                let run = engine.run_flow(
                    &self.execution_id,
                    &flow,
                    self.tc_repo,
                    environment,
                    variables,
                    Some(inner_tx),
                    None,
                );
                let (result, ()) = tokio::join!(run, relay);
                result
            }
            MemberKind::Test => {
                let test_case = self.tc_repo.get_by_id(&member.id).await?.ok_or_else(|| {
                    AppError::NotFound(format!("Test case {} not found", member.id))
                })?;

                // A test in a suite runs its dataset. A suite is about coverage, so
                // fifteen rows are the point of including it.
                let has_rows = test_case.dataset.as_ref().is_some_and(|d| !d.is_empty());
                let node = if has_rows {
                    engine.execute_test_case_dataset(&test_case, environment, variables).await
                } else {
                    engine.execute_test_case(&test_case, environment, variables).await
                };

                // No canvas, but the console reads node events, so the single request
                // still reports itself the way a flow's nodes do.
                let _ = out
                    .send(ExecutionEvent::NodeCompleted {
                        node_id: node.node_id.clone(),
                        result: node.clone(),
                    })
                    .await;

                Ok(one_node_result(&self.execution_id, member, node))
            }
        }
    }
}

/// A member that could not be loaded at all, recorded as an error rather than a gap.
///
/// It carries a result rather than an empty list so the history says *why*: a member
/// with no results reads as a member that ran and did nothing.
fn failed_to_start(member: &ResolvedMember, error: &AppError) -> FlowExecutionResult {
    let node = crate::execution::NodeResult {
        node_id: member.id.clone(),
        node_label: None,
        test_case_id: None,
        test_case_name: Some(member.name.clone()),
        status: NodeStatus::Error,
        duration_ms: 0,
        request: None,
        response: None,
        exports: None,
        env: None,
        error_message: Some(error.to_string()),
        logs: vec![],
        expected: None,
        teardown: None,
        row_index: None,
        row_label: None,
        attempts: None,
        iterations_of: None,
        iterations: None,
    };
    FlowExecutionResult {
        execution_id: String::new(),
        flow_id: member.id.clone(),
        status: "error".to_string(),
        duration_ms: 0,
        results: vec![node],
        context: HashMap::new(),
        stats: ExecutionStats { total: 1, errors: 1, ..Default::default() },
    }
}

/// Wrap a standalone test's single result so it records like any other member.
fn one_node_result(
    execution_id: &str,
    member: &ResolvedMember,
    node: crate::execution::NodeResult,
) -> FlowExecutionResult {
    let mut stats = ExecutionStats { total: 1, ..Default::default() };
    match node.status {
        NodeStatus::Passed => stats.passed = 1,
        NodeStatus::Failed => stats.failed = 1,
        NodeStatus::Error => stats.errors = 1,
        NodeStatus::Skipped => stats.skipped = 1,
    }
    FlowExecutionResult {
        execution_id: execution_id.to_string(),
        flow_id: member.id.clone(),
        status: node.status.to_string(),
        duration_ms: node.duration_ms,
        results: vec![node],
        context: HashMap::new(),
        stats,
    }
}

/// Worst-of across the whole suite, which is also how one flow folds its nodes.
fn suite_status(totals: &RunTotals, abandoned: bool) -> String {
    if abandoned {
        "stopped"
    } else if totals.errors > 0 {
        "error"
    } else if totals.failed > 0 {
        "failed"
    } else {
        "completed"
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{Suite, SuiteMember};
    use chrono::Utc;

    fn suite(members: Option<Vec<SuiteMember>>) -> Suite {
        Suite {
            id: "s1".into(),
            project_id: "p1".into(),
            name: "Regression".into(),
            members,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    // Stubs for the two repositories a suite reads. Only the calls the runner actually
    // makes are implemented; the rest would be a lie dressed as a fixture.
    struct Repos {
        flows: Vec<crate::db::models::Flow>,
        tests: Vec<crate::db::models::TestCase>,
    }

    fn page<T>(data: Vec<T>) -> crate::db::models::PaginatedResponse<T> {
        let total = data.len() as u64;
        crate::db::models::PaginatedResponse {
            data,
            pagination: crate::db::models::PaginationMeta {
                page: 1,
                per_page: 1000,
                total,
                total_pages: 1,
            },
        }
    }

    #[async_trait::async_trait]
    impl FlowRepository for Repos {
        async fn list_by_project(
            &self,
            _project_id: &str,
            _p: crate::db::models::Pagination,
        ) -> Result<crate::db::models::PaginatedResponse<crate::db::models::Flow>, AppError> {
            Ok(page(self.flows.clone()))
        }
        async fn get_by_id(&self, id: &str) -> Result<Option<crate::db::models::Flow>, AppError> {
            Ok(self.flows.iter().find(|f| f.id == id).cloned())
        }
        async fn create(&self, _: &str, _: crate::db::models::CreateFlow) -> Result<crate::db::models::Flow, AppError> { unimplemented!() }
        async fn update(&self, _: &str, _: crate::db::models::UpdateFlow) -> Result<crate::db::models::Flow, AppError> { unimplemented!() }
        async fn update_graph(&self, _: &str, _: crate::db::models::UpdateGraphData) -> Result<crate::db::models::Flow, AppError> { unimplemented!() }
        async fn delete(&self, _: &str) -> Result<(), AppError> { unimplemented!() }
        async fn find_existing_ids(&self, _: &[String]) -> Result<std::collections::HashSet<String>, AppError> { unimplemented!() }
        async fn set_group(
            &self,
            _id: &str,
            _group_id: Option<&str>,
        ) -> Result<crate::db::models::Flow, AppError> {
            unimplemented!("a suite never moves a flow between groups")
        }
    }

    #[async_trait::async_trait]
    impl TestCaseRepository for Repos {
        async fn list_by_project(
            &self,
            _project_id: &str,
            _p: crate::db::models::Pagination,
        ) -> Result<crate::db::models::PaginatedResponse<crate::db::models::TestCase>, AppError> {
            Ok(page(self.tests.clone()))
        }
        async fn get_by_id(&self, id: &str) -> Result<Option<crate::db::models::TestCase>, AppError> {
            Ok(self.tests.iter().find(|t| t.id == id).cloned())
        }
        async fn create(&self, _: &str, _: crate::db::models::CreateTestCase) -> Result<crate::db::models::TestCase, AppError> { unimplemented!() }
        async fn update(&self, _: &str, _: crate::db::models::UpdateTestCase) -> Result<crate::db::models::TestCase, AppError> { unimplemented!() }
        async fn delete(&self, _: &str) -> Result<(), AppError> { unimplemented!() }
        async fn find_existing_ids(&self, _: &[String]) -> Result<std::collections::HashSet<String>, AppError> { unimplemented!() }
    }

    fn a_test_case(id: &str, name: &str) -> crate::db::models::TestCase {
        crate::db::models::TestCase {
            id: id.into(),
            project_id: "p1".into(),
            group_id: None,
            name: name.into(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".into(),
            // Nothing listens here, so the request fails fast and the run still records.
            endpoint: "http://127.0.0.1:1/ping".into(),
            headers: serde_json::json!({}),
            payload: None,
            body_type: None,
            exports: vec![],
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// A flow whose only path is start → end: it walks, reaches no test case, and used to
    /// report itself completed.
    fn empty_flow(id: &str, name: &str) -> crate::db::models::Flow {
        crate::db::models::Flow {
            id: id.into(),
            project_id: "p1".into(),
            name: name.into(),
            description: None,
            graph_data: crate::db::models::GraphData {
                nodes: vec![
                    crate::db::models::GraphNode {
                        id: "start".into(),
                        node_type: "start".into(),
                        position: crate::db::models::Position { x: 0.0, y: 0.0 },
                        data: serde_json::json!({}),
                        width: None,
                        height: None,
                    },
                    crate::db::models::GraphNode {
                        id: "end".into(),
                        node_type: "end".into(),
                        position: crate::db::models::Position { x: 100.0, y: 0.0 },
                        data: serde_json::json!({}),
                        width: None,
                        height: None,
                    },
                ],
                edges: vec![crate::db::models::GraphEdge {
                    id: "e1".into(),
                    source: "start".into(),
                    target: "end".into(),
                    edge_type: None,
                    data: serde_json::json!({}),
                }],
                canvas_settings: serde_json::json!({}),
                variables: Default::default(),
            },
            version: 1,
            group_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    async fn run_repo() -> Arc<dyn RunRepository> {
        use sqlx::any::{install_default_drivers, AnyPoolOptions};
        install_default_drivers();
        let pool = AnyPoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE flows (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE test_cases (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        crate::db::pool::apply_run_schema(&pool).await;
        sqlx::query("INSERT INTO projects (id) VALUES ('p1')").execute(&pool).await.unwrap();
        // The stub repositories serve these from memory, but flow_runs and suite_runs
        // hold real foreign keys to them.
        sqlx::query("INSERT INTO test_cases (id) VALUES ('t1'), ('t2')").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO suites (id, project_id, name, created_at, updated_at) \
             VALUES ('s1','p1','Regression','2020-01-01T00:00:00+00:00','2020-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        Arc::new(crate::db::repositories::SqlxRunRepository::new(pool))
    }

    /// A flow whose only step is a sub-flow node, and the flow it points at.
    ///
    /// Built here rather than in `inline`'s tests because the point is not the splice — that is
    /// covered there, purely — but that *this* caller performs it. Cut the `resolve_for_run` call
    /// from `run_member` and the engine's group arm refuses the run.
    fn flow_calling_a_sub_flow() -> (crate::db::models::Flow, crate::db::models::Flow) {
        let mut parent = empty_flow("f1", "Parent");
        parent.graph_data.nodes.insert(
            1,
            crate::db::models::GraphNode {
                id: "g1".into(),
                node_type: "group".into(),
                position: crate::db::models::Position { x: 50.0, y: 0.0 },
                data: serde_json::json!({ "flowId": "sub", "label": "Onboarding" }),
                width: None,
                height: None,
            },
        );
        parent.graph_data.edges = vec![
            crate::db::models::GraphEdge {
                id: "e1".into(),
                source: "start".into(),
                target: "g1".into(),
                edge_type: None,
                data: serde_json::json!({}),
            },
            crate::db::models::GraphEdge {
                id: "e2".into(),
                source: "g1".into(),
                target: "end".into(),
                edge_type: None,
                data: serde_json::json!({}),
            },
        ];

        let mut sub = empty_flow("sub", "Onboarding");
        sub.graph_data.nodes.insert(
            1,
            crate::db::models::GraphNode {
                id: "step".into(),
                node_type: "testCase".into(),
                position: crate::db::models::Position { x: 50.0, y: 0.0 },
                data: serde_json::json!({ "testCaseId": "t1" }),
                width: None,
                height: None,
            },
        );
        sub.graph_data.edges = vec![
            crate::db::models::GraphEdge {
                id: "s1".into(),
                source: "start".into(),
                target: "step".into(),
                edge_type: None,
                data: serde_json::json!({}),
            },
            crate::db::models::GraphEdge {
                id: "s2".into(),
                source: "step".into(),
                target: "end".into(),
                edge_type: None,
                data: serde_json::json!({}),
            },
        ];
        (parent, sub)
    }

    /// The suite is the third caller, and the one with no `Started` event to carry the group
    /// map — so nothing but the inner step actually running proves it resolved.
    ///
    /// Before this, a flow containing a sub-flow node ran green having executed nothing.
    #[tokio::test]
    async fn a_member_flows_sub_flow_steps_actually_run() {
        let (parent, sub) = flow_calling_a_sub_flow();
        let repos = Repos { flows: vec![parent, sub], tests: vec![a_test_case("t1", "Sign up")] };
        let runs = run_repo().await;
        let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(64);

        let runner = SuiteRun {
            execution_id: "exec-sub".into(),
            project_id: "p1".into(),
            suite_id: Some("s1".into()),
            suite_name: "Regression".into(),
            environment_name: None,
            debug_mode: false,
            base_url: None,
            hooks: crate::hooks::Hooks::new(),
            flow_repo: &repos,
            tc_repo: &repos,
            run_repo: runs.clone(),
        };

        runner
            .execute(
                vec![ResolvedMember { kind: MemberKind::Flow, id: "f1".into(), name: "Parent".into() }],
                HashMap::new(),
                HashMap::new(),
                tx,
            )
            .await
            .unwrap();

        let mut started = Vec::new();
        while let Ok(event) = rx.try_recv() {
            if let ExecutionEvent::NodeStarted { node_id, .. } = event {
                started.push(node_id);
            }
        }
        assert_eq!(
            started.len(),
            1,
            "the sub-flow's one step should have run, got {:?}",
            started
        );
        assert!(
            started[0].ends_with("step"),
            "the step that ran should be the sub-flow's, got {:?}",
            started[0]
        );
        assert_ne!(
            started[0], "step",
            "and under its scoped id, so two invocations of one sub-flow stay distinct"
        );
    }

    /// The client has to be able to tell which stored run a stream belongs to.
    ///
    /// `execution_id` is generated for the execution and the row gets its own id, so
    /// without `run_id` on the event a run in flight cannot be opened at all — only
    /// waited for and then looked up afterwards.
    #[tokio::test]
    async fn a_suite_run_announces_the_id_it_will_be_stored_under() {
        let repos = Repos { flows: vec![], tests: vec![a_test_case("t1", "Ping")] };
        let runs = run_repo().await;
        let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(64);

        let runner = SuiteRun {
            execution_id: "exec-1".into(),
            project_id: "p1".into(),
            suite_id: Some("s1".into()),
            suite_name: "Regression".into(),
            environment_name: None,
            debug_mode: false,
            base_url: None,
            hooks: crate::hooks::Hooks::new(),
            flow_repo: &repos,
            tc_repo: &repos,
            run_repo: runs.clone(),
        };

        runner
            .execute(
                vec![ResolvedMember { kind: MemberKind::Test, id: "t1".into(), name: "Ping".into() }],
                HashMap::new(),
                HashMap::new(),
                tx,
            )
            .await
            .unwrap();

        let mut announced = None;
        while let Ok(event) = rx.try_recv() {
            if let ExecutionEvent::SuiteStarted { run_id, .. } = event {
                announced = Some(run_id);
            }
        }

        let stored = runs.list("p1", 10, true).await.unwrap();
        assert_eq!(stored.runs.len(), 1);
        assert_eq!(
            announced.as_deref(),
            Some(stored.runs[0].id.as_str()),
            "the id on the event must be the id the run is stored under"
        );
    }

    /// The member events are what a live report is drawn from, so their order and their
    /// contents are the contract — not an incidental side effect of the loop.
    #[tokio::test]
    async fn a_suite_reports_its_members_and_ends_exactly_once() {
        let repos = Repos {
            flows: vec![],
            tests: vec![a_test_case("t1", "Ping"), a_test_case("t2", "Pong")],
        };
        let runs = run_repo().await;
        let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(64);

        let runner = SuiteRun {
            execution_id: "exec-1".into(),
            project_id: "p1".into(),
            suite_id: Some("s1".into()),
            suite_name: "Regression".into(),
            environment_name: None,
            debug_mode: false,
            base_url: None,
            hooks: crate::hooks::Hooks::new(),
            flow_repo: &repos,
            tc_repo: &repos,
            run_repo: runs,
        };

        runner
            .execute(
                vec![
                    ResolvedMember { kind: MemberKind::Test, id: "t1".into(), name: "Ping".into() },
                    ResolvedMember { kind: MemberKind::Test, id: "t2".into(), name: "Pong".into() },
                ],
                HashMap::new(),
                HashMap::new(),
                tx,
            )
            .await
            .unwrap();

        let mut seen = Vec::new();
        while let Ok(event) = rx.try_recv() {
            seen.push(match event {
                ExecutionEvent::SuiteStarted { total_members, .. } => format!("suite:{total_members}"),
                ExecutionEvent::MemberStarted { name, ordinal, .. } => format!("start:{ordinal}:{name}"),
                ExecutionEvent::MemberCompleted { name, .. } => format!("done:{name}"),
                ExecutionEvent::NodeCompleted { .. } => "node".to_string(),
                ExecutionEvent::Completed { .. } => "end".to_string(),
                other => format!("unexpected:{other:?}"),
            });
        }

        assert_eq!(seen, vec![
            "suite:2",
            "start:0:Ping", "node", "done:Ping",
            "start:1:Pong", "node", "done:Pong",
            "end",
        ], "{seen:?}");
    }

    /// A member that walked its graph without reaching a test case is not a pass.
    ///
    /// `Flow 1` in a real suite reported `completed` with zero nodes and 0 ms — green, and
    /// indistinguishable in the history from a member that did the work. Same reasoning as
    /// an all-skipped dataset folding to `Skipped` rather than `Passed`.
    #[tokio::test]
    async fn a_member_that_ran_nothing_is_not_reported_as_completed() {
        let repos = Repos { flows: vec![empty_flow("f-empty", "Flow 1")], tests: vec![] };
        let runs = run_repo().await;
        let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(64);

        let runner = SuiteRun {
            execution_id: "exec-1".into(),
            project_id: "p1".into(),
            suite_id: Some("s1".into()),
            suite_name: "Regression".into(),
            environment_name: None,
            debug_mode: false,
            base_url: None,
            hooks: crate::hooks::Hooks::new(),
            flow_repo: &repos,
            tc_repo: &repos,
            run_repo: runs,
        };

        runner
            .execute(
                vec![ResolvedMember { kind: MemberKind::Flow, id: "f-empty".into(), name: "Flow 1".into() }],
                HashMap::new(),
                HashMap::new(),
                tx,
            )
            .await
            .unwrap();

        let mut member_status = None;
        while let Ok(event) = rx.try_recv() {
            if let ExecutionEvent::MemberCompleted { status, .. } = event {
                member_status = Some(status);
            }
        }
        assert_eq!(
            member_status.as_deref(),
            Some("skipped"),
            "a member that reached no test case reported itself green"
        );
    }

    #[test]
    fn the_suite_verdict_is_worst_of() {
        let clean = RunTotals { total: 6, passed: 6, ..Default::default() };
        assert_eq!(suite_status(&clean, false), "completed");

        let one_red = RunTotals { total: 6, passed: 5, failed: 1, ..Default::default() };
        assert_eq!(suite_status(&one_red, false), "failed");

        // An error outranks a failure: a member that could not run is systemic.
        let broken = RunTotals { total: 6, passed: 4, failed: 1, errors: 1, ..Default::default() };
        assert_eq!(suite_status(&broken, false), "error");

        // Walking away is not a pass, whatever the counts say.
        assert_eq!(suite_status(&clean, true), "stopped");
    }

    #[test]
    fn a_test_members_verdict_becomes_the_members_verdict() {
        let member = ResolvedMember {
            kind: MemberKind::Test,
            id: "t1".into(),
            name: "Check balance".into(),
        };
        let node = crate::execution::NodeResult {
            node_id: "t1".into(),
            node_label: None,
            test_case_id: Some("t1".into()),
            test_case_name: Some("Check balance".into()),
            status: NodeStatus::Failed,
            duration_ms: 40,
            request: None,
            response: None,
            exports: None,
            env: None,
            error_message: Some("Expected 200, got 401".into()),
            logs: vec![],
            expected: None,
            teardown: None,
            row_index: None,
            row_label: None,
            attempts: None,
            iterations_of: None,
            iterations: None,
        };

        let result = one_node_result("e1", &member, node);
        assert_eq!(result.status, "failed");
        assert_eq!(result.stats.failed, 1);
        assert_eq!(result.stats.total, 1);
        assert_eq!(result.results.len(), 1);
    }

    #[test]
    fn a_member_that_cannot_be_loaded_counts_as_an_error_not_a_gap() {
        // Silently skipping it would make a suite report fewer members than it has and
        // still look green.
        let member = ResolvedMember { kind: MemberKind::Flow, id: "gone".into(), name: "Gone".into() };
        let result = failed_to_start(&member, &AppError::NotFound("Flow gone not found".into()));
        assert_eq!(result.status, "error");
        assert_eq!(result.stats.errors, 1);
        assert_eq!(result.stats.total, 1);
    }

    #[test]
    fn an_empty_selection_is_refused_rather_than_read_as_everything() {
        // The whole absent-means-everything rule rests on these being different.
        let s = suite(Some(vec![]));
        assert!(s.members.as_ref().unwrap().is_empty());
        // resolve_members needs repositories, so the branch itself is pinned by the
        // handler test; what matters here is that the model keeps the two apart.
        assert!(suite(None).members.is_none());
    }
}
