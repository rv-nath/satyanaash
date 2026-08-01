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
                suite_id: self.suite_id.clone(),
                suite_name: self.suite_name.clone(),
                total_members: members.len(),
            })
            .await;

        let mut totals = RunTotals::default();
        let mut abandoned = false;

        for (ordinal, member) in members.iter().enumerate() {
            // Between members is the suite's own boundary check. Inside a member the
            // engine already stops at the next node when nobody is watching.
            if out.is_closed() {
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
        let engine = ExecutionEngine::new(self.debug_mode, self.base_url.clone());

        match member.kind {
            MemberKind::Flow => {
                let flow = self
                    .flow_repo
                    .get_by_id(&member.id)
                    .await?
                    .ok_or_else(|| AppError::NotFound(format!("Flow {} not found", member.id)))?;

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
