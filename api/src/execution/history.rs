//! Turning a finished run into a stored one.
//!
//! Every press of Run becomes a `suite_run`, whether or not a suite was involved: a
//! single flow is an ad-hoc run of one, with `suite_id` NULL and the flow's own name.
//! One code path and one table, so a flow you ran by hand shows up in the history beside
//! a nightly suite, and the report tab is useful before anyone defines a suite at all.

use std::sync::Arc;

use tracing::warn;

use crate::db::models::{FlowRunInput, MemberKind, RunTotals, SuiteRunInput};
use crate::db::repositories::RunRepository;
use crate::execution::FlowExecutionResult;

/// What a member was, for the record: which flow or test case, and what it was called.
pub struct MemberRef {
    pub kind: MemberKind,
    pub id: String,
    pub name: String,
}

impl MemberRef {
    pub fn flow(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self { kind: MemberKind::Flow, id: id.into(), name: name.into() }
    }

    pub fn test(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self { kind: MemberKind::Test, id: id.into(), name: name.into() }
    }

    fn flow_id(&self) -> Option<String> {
        matches!(self.kind, MemberKind::Flow).then(|| self.id.clone())
    }

    fn test_case_id(&self) -> Option<String> {
        matches!(self.kind, MemberKind::Test).then(|| self.id.clone())
    }

    pub fn input(&self, ordinal: i64, result: &FlowExecutionResult) -> FlowRunInput {
        let started_at = chrono::Utc::now()
            - chrono::Duration::milliseconds(result.duration_ms.min(i64::MAX as u64) as i64);
        FlowRunInput {
            ordinal,
            member_kind: self.kind,
            flow_id: self.flow_id(),
            test_case_id: self.test_case_id(),
            name: self.name.clone(),
            status: result.status.clone(),
            started_at,
            duration_ms: Some(result.duration_ms.min(i64::MAX as u64) as i64),
            error_message: None,
            results: result.results.clone(),
        }
    }
}

/// Store one flow's run as a run of its own.
///
/// Never fails the caller. The run already happened and the author already watched it
/// stream — losing the record is worth a line in the log, not an error where a result
/// should be.
pub async fn record_single(
    repo: &Arc<dyn RunRepository>,
    project_id: &str,
    member: MemberRef,
    result: &FlowExecutionResult,
    environment_name: Option<String>,
) {
    if let Err(e) = try_record_single(repo, project_id, member, result, environment_name).await {
        warn!("run finished but was not recorded: {e}");
    }
}

async fn try_record_single(
    repo: &Arc<dyn RunRepository>,
    project_id: &str,
    member: MemberRef,
    result: &FlowExecutionResult,
    environment_name: Option<String>,
) -> Result<(), crate::error::AppError> {
    let run_id = repo
        .start(SuiteRunInput {
            project_id: project_id.to_string(),
            suite_id: None,
            // An ad-hoc run is named after the one thing it ran.
            suite_name: member.name.clone(),
            environment_name,
        })
        .await?;

    let status = result.status.clone();
    repo.record_member(&run_id, member.input(0, result)).await?;

    let mut totals = RunTotals::default();
    totals.add(&result.stats);
    repo.finish(&run_id, &status, totals, None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::SuiteRun;
    use crate::db::repositories::SqlxRunRepository;
    use crate::execution::{ExecutionStats, NodeResult, NodeStatus};
    use sqlx::any::{install_default_drivers, AnyPoolOptions};
    use sqlx::AnyPool;

    async fn setup() -> AnyPool {
        install_default_drivers();
        let pool = AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE flows (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE test_cases (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        for statement in include_str!("../../migrations/009_runs.sql").split(';') {
            let stmt = statement.trim();
            if stmt.lines().any(|l| !l.trim().is_empty() && !l.trim().starts_with("--")) {
                sqlx::query(stmt).execute(&pool).await.unwrap();
            }
        }
        sqlx::query("INSERT INTO projects (id) VALUES ('p1')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO flows (id) VALUES ('f1')").execute(&pool).await.unwrap();
        pool
    }

    fn a_result(status: &str) -> FlowExecutionResult {
        FlowExecutionResult {
            execution_id: "e1".into(),
            flow_id: "f1".into(),
            status: status.into(),
            duration_ms: 1240,
            results: vec![NodeResult {
                node_id: "n1".into(),
                node_label: None,
                test_case_id: None,
                test_case_name: Some("Login".into()),
                status: NodeStatus::Passed,
                duration_ms: 40,
                request: None,
                response: None,
                exports: None,
                env: None,
                error_message: None,
                logs: vec![],
                expected: None,
                teardown: None,
                row_index: None,
                row_label: None,
                iterations: None,
            }],
            context: Default::default(),
            stats: ExecutionStats { total: 1, passed: 1, ..Default::default() },
        }
    }

    async fn only_run(repo: &Arc<dyn RunRepository>) -> SuiteRun {
        // include_adhoc: these are runs of a single flow, which the index hides by default.
        let listed = repo.list("p1", 10, true).await.unwrap();
        assert_eq!(listed.runs.len(), 1);
        repo.get(&listed.runs[0].id).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn a_single_flow_run_is_stored_as_a_run_of_one() {
        let repo: Arc<dyn RunRepository> = Arc::new(SqlxRunRepository::new(setup().await));
        record_single(&repo, "p1", MemberRef::flow("f1", "JT1 – SMS"), &a_result("completed"), None).await;

        let run = only_run(&repo).await;
        // Named after the one thing it ran, and not attached to any suite.
        assert_eq!(run.suite_name, "JT1 – SMS");
        assert_eq!(run.suite_id, None);
        assert_eq!(run.status, "completed");
        assert_eq!(run.passed, 1);
        assert_eq!(run.members.len(), 1);
        assert_eq!(run.members[0].flow_id.as_deref(), Some("f1"));
        assert_eq!(run.members[0].results[0].node_id, "n1");
    }

    #[tokio::test]
    async fn a_stopped_run_is_still_recorded() {
        // Cancelling is an ordinary ending, not an absence of one: what ran, ran.
        let repo: Arc<dyn RunRepository> = Arc::new(SqlxRunRepository::new(setup().await));
        record_single(&repo, "p1", MemberRef::flow("f1", "JT1 – SMS"), &a_result("stopped"), None).await;

        let run = only_run(&repo).await;
        assert_eq!(run.status, "stopped");
        assert_eq!(run.members[0].results.len(), 1);
    }

    #[tokio::test]
    async fn a_recording_failure_does_not_reach_the_caller() {
        // The run already happened and the author already watched it stream. A history
        // write that fails is worth a log line, not an error where a result should be.
        let repo: Arc<dyn RunRepository> = Arc::new(SqlxRunRepository::new(setup().await));
        // No such project, so the insert violates its foreign key.
        record_single(&repo, "nope", MemberRef::flow("f1", "JT1 – SMS"), &a_result("completed"), None).await;
        assert!(repo.list("nope", 10, true).await.unwrap().runs.is_empty());
    }
}
