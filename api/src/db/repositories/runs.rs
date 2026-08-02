//! Run history repository.
//!
//! Writes happen at two boundaries and nowhere else: once when a run starts, and once
//! per member as that member finishes. Nothing is written per node — a fifteen-row
//! fan-out would otherwise put fifteen round trips on the path of a test that is already
//! waiting on the network.
//!
//! Bodies are redacted and packed on the way in (`db::blob`); every column a report
//! would group or filter on stays plain text.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{AnyPool, Row};
use uuid::Uuid;

use crate::db::blob;
use crate::db::models::*;
use crate::error::AppError;
use crate::execution::NodeResult;
use super::RunRepository;

pub struct SqlxRunRepository {
    pool: AnyPool,
}

impl SqlxRunRepository {
    pub fn new(pool: AnyPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl RunRepository for SqlxRunRepository {
    async fn start(&self, input: SuiteRunInput) -> Result<String, AppError> {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO suite_runs
               (id, project_id, suite_id, suite_name, status, started_at, environment_name)
               VALUES (?, ?, ?, ?, 'running', ?, ?)"#,
        )
        .bind(&id)
        .bind(&input.project_id)
        .bind(&input.suite_id)
        .bind(&input.suite_name)
        .bind(Utc::now().to_rfc3339())
        .bind(&input.environment_name)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    async fn record_member(&self, suite_run_id: &str, input: FlowRunInput) -> Result<(), AppError> {
        // One transaction per member: a half-written flow run — its node results missing
        // or its rows orphaned — would read as a flow that ran and did nothing.
        let mut tx = self.pool.begin().await?;
        let flow_run_id = Uuid::new_v4().to_string();

        sqlx::query(
            r#"INSERT INTO flow_runs
               (id, suite_run_id, ordinal, member_kind, flow_id, test_case_id, name,
                status, started_at, duration_ms, error_message)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&flow_run_id)
        .bind(suite_run_id)
        .bind(input.ordinal)
        .bind(input.member_kind.as_str())
        .bind(&input.flow_id)
        .bind(&input.test_case_id)
        .bind(&input.name)
        .bind(&input.status)
        .bind(input.started_at.to_rfc3339())
        .bind(input.duration_ms)
        .bind(&input.error_message)
        .execute(&mut *tx)
        .await?;

        for (ordinal, result) in input.results.iter().enumerate() {
            let node_row_id = Uuid::new_v4().to_string();
            insert_result(&mut tx, &flow_run_id, None, &node_row_id, ordinal as i64, result).await?;

            // A fan-out node's rows hang off its aggregate. Recording only the aggregate
            // would lose which of fifteen cases failed, which is the granularity the
            // whole history exists for.
            if let Some(rows) = &result.iterations {
                for (row_ordinal, row) in rows.iter().enumerate() {
                    let row_id = Uuid::new_v4().to_string();
                    insert_result(
                        &mut tx,
                        &flow_run_id,
                        Some(&node_row_id),
                        &row_id,
                        row_ordinal as i64,
                        row,
                    )
                    .await?;
                }
            }
        }

        tx.commit().await?;
        Ok(())
    }

    async fn finish(
        &self,
        suite_run_id: &str,
        status: &str,
        totals: RunTotals,
        error_message: Option<String>,
    ) -> Result<(), AppError> {
        let now = Utc::now();
        let started: Option<String> =
            sqlx::query_scalar("SELECT started_at FROM suite_runs WHERE id = ?")
                .bind(suite_run_id)
                .fetch_optional(&self.pool)
                .await?;
        let duration_ms = started
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|s| (now - s.with_timezone(&Utc)).num_milliseconds());

        sqlx::query(
            r#"UPDATE suite_runs
               SET status = ?, completed_at = ?, duration_ms = ?,
                   total = ?, passed = ?, failed = ?, errors = ?, skipped = ?,
                   error_message = ?
               WHERE id = ?"#,
        )
        .bind(status)
        .bind(now.to_rfc3339())
        .bind(duration_ms)
        .bind(totals.total)
        .bind(totals.passed)
        .bind(totals.failed)
        .bind(totals.errors)
        .bind(totals.skipped)
        .bind(&error_message)
        .bind(suite_run_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn list(
        &self,
        project_id: &str,
        limit: i64,
        include_adhoc: bool,
    ) -> Result<RunListing, AppError> {
        // Headline columns only. A history page wants a hundred rows of summary, not a
        // hundred runs' worth of bodies — and those are packed blobs it could not show
        // in a list anyway.
        //
        // Two statements rather than one with a conditional predicate: the Any driver
        // binds positionally, and a query whose shape changes with a flag is the kind of
        // thing that silently binds the wrong parameter.
        let sql = if include_adhoc {
            r#"SELECT id, project_id, suite_id, suite_name, status, started_at, completed_at,
                      duration_ms, total, passed, failed, errors, skipped,
                      environment_name, error_message
               FROM suite_runs WHERE project_id = ?
               ORDER BY started_at DESC LIMIT ?"#
        } else {
            r#"SELECT id, project_id, suite_id, suite_name, status, started_at, completed_at,
                      duration_ms, total, passed, failed, errors, skipped,
                      environment_name, error_message
               FROM suite_runs WHERE project_id = ? AND suite_id IS NOT NULL
               ORDER BY started_at DESC LIMIT ?"#
        };

        let rows = sqlx::query(sql)
            .bind(project_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;

        let runs: Vec<SuiteRun> = rows.iter().map(row_to_suite_run).collect::<Result<_, _>>()?;

        // Counted over the whole project, not the page: "23 hidden" answers "what am I
        // not looking at", which a per-page count would understate.
        let adhoc_hidden = if include_adhoc {
            0
        } else {
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM suite_runs WHERE project_id = ? AND suite_id IS NULL",
            )
            .bind(project_id)
            .fetch_one(&self.pool)
            .await?
        };

        Ok(RunListing { runs, adhoc_hidden })
    }

    async fn get(&self, id: &str) -> Result<Option<SuiteRun>, AppError> {
        let row = sqlx::query(
            r#"SELECT id, project_id, suite_id, suite_name, status, started_at, completed_at,
                      duration_ms, total, passed, failed, errors, skipped,
                      environment_name, error_message
               FROM suite_runs WHERE id = ?"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else { return Ok(None) };
        let mut run = row_to_suite_run(&row)?;

        let member_rows = sqlx::query(
            r#"SELECT id, suite_run_id, ordinal, member_kind, flow_id, test_case_id, name,
                      status, started_at, duration_ms, error_message
               FROM flow_runs WHERE suite_run_id = ? ORDER BY ordinal"#,
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;

        for member_row in &member_rows {
            let mut member = row_to_flow_run(member_row)?;
            member.results = self.results_for(&member.id).await?;
            run.members.push(member);
        }

        Ok(Some(run))
    }

    async fn delete(&self, id: &str) -> Result<(), AppError> {
        let result = sqlx::query("DELETE FROM suite_runs WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::NotFound(format!("Run {} not found", id)));
        }
        Ok(())
    }
}

impl SqlxRunRepository {
    /// Node results for one member, each with its dataset rows reattached.
    async fn results_for(&self, flow_run_id: &str) -> Result<Vec<NodeResult>, AppError> {
        let rows = sqlx::query(
            r#"SELECT id, parent_id, ordinal, node_id, node_label, test_case_id, test_case_name,
                      status, duration_ms, expected, teardown, row_index, row_label,
                      error_message, request, response, logs, exports
               FROM run_results WHERE flow_run_id = ? ORDER BY parent_id IS NULL DESC, ordinal"#,
        )
        .bind(flow_run_id)
        .fetch_all(&self.pool)
        .await?;

        // Nodes first (parent_id NULL sorts first above), so every row finds its
        // aggregate already in place.
        let mut nodes: Vec<(String, NodeResult)> = Vec::new();
        for row in &rows {
            let parent_id: Option<String> = row.try_get("parent_id")?;
            let id: String = row.try_get("id")?;
            let result = row_to_node_result(row)?;
            match parent_id {
                None => nodes.push((id, result)),
                Some(parent) => {
                    if let Some((_, node)) = nodes.iter_mut().find(|(nid, _)| *nid == parent) {
                        node.iterations.get_or_insert_with(Vec::new).push(result);
                    }
                }
            }
        }

        Ok(nodes.into_iter().map(|(_, node)| node).collect())
    }
}

async fn insert_result(
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    flow_run_id: &str,
    parent_id: Option<&str>,
    id: &str,
    ordinal: i64,
    result: &NodeResult,
) -> Result<(), AppError> {
    // Redact before packing, and never the other way round: a compressed token is still
    // a token, only harder to notice.
    let request = result
        .request
        .as_ref()
        .and_then(|r| blob::pack_json(Some(blob::redact(r).as_ref())));

    sqlx::query(
        r#"INSERT INTO run_results
           (id, flow_run_id, parent_id, ordinal, node_id, node_label, test_case_id,
            test_case_name, status, duration_ms, expected, teardown, row_index, row_label,
            error_message, request, response, logs, exports)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(id)
    .bind(flow_run_id)
    .bind(parent_id)
    .bind(ordinal)
    .bind(&result.node_id)
    .bind(&result.node_label)
    .bind(&result.test_case_id)
    .bind(&result.test_case_name)
    .bind(result.status.to_string())
    .bind(result.duration_ms as i64)
    .bind(&result.expected)
    .bind(i64::from(result.teardown.unwrap_or(false)))
    .bind(result.row_index.map(|i| i as i64))
    .bind(&result.row_label)
    .bind(&result.error_message)
    .bind(request)
    .bind(blob::pack_json(result.response.as_ref()))
    .bind((!result.logs.is_empty()).then(|| blob::pack_json(Some(&result.logs))).flatten())
    .bind(blob::pack_json(result.exports.as_ref()))
    .execute(&mut **tx)
    .await?;

    Ok(())
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|e| AppError::Internal(e.to_string()))
}

fn row_to_suite_run(row: &sqlx::any::AnyRow) -> Result<SuiteRun, AppError> {
    let started: String = row.try_get("started_at")?;
    let completed: Option<String> = row.try_get("completed_at")?;

    Ok(SuiteRun {
        id: row.try_get("id")?,
        project_id: row.try_get("project_id")?,
        suite_id: row.try_get("suite_id")?,
        suite_name: row.try_get("suite_name")?,
        status: row.try_get("status")?,
        started_at: parse_time(&started)?,
        completed_at: completed.as_deref().map(parse_time).transpose()?,
        duration_ms: row.try_get("duration_ms")?,
        total: row.try_get("total")?,
        passed: row.try_get("passed")?,
        failed: row.try_get("failed")?,
        errors: row.try_get("errors")?,
        skipped: row.try_get("skipped")?,
        environment_name: row.try_get("environment_name")?,
        error_message: row.try_get("error_message")?,
        members: Vec::new(),
    })
}

fn row_to_flow_run(row: &sqlx::any::AnyRow) -> Result<FlowRun, AppError> {
    let started: String = row.try_get("started_at")?;
    let kind: String = row.try_get("member_kind")?;

    Ok(FlowRun {
        id: row.try_get("id")?,
        suite_run_id: row.try_get("suite_run_id")?,
        ordinal: row.try_get("ordinal")?,
        member_kind: MemberKind::parse(&kind).unwrap_or(MemberKind::Flow),
        flow_id: row.try_get("flow_id")?,
        test_case_id: row.try_get("test_case_id")?,
        name: row.try_get("name")?,
        status: row.try_get("status")?,
        started_at: parse_time(&started)?,
        duration_ms: row.try_get("duration_ms")?,
        error_message: row.try_get("error_message")?,
        results: Vec::new(),
    })
}

fn row_to_node_result(row: &sqlx::any::AnyRow) -> Result<NodeResult, AppError> {
    let status: String = row.try_get("status")?;
    let duration_ms: i64 = row.try_get("duration_ms")?;
    let teardown: i64 = row.try_get("teardown")?;
    let row_index: Option<i64> = row.try_get("row_index")?;
    let request: Option<Vec<u8>> = row.try_get("request")?;
    let response: Option<Vec<u8>> = row.try_get("response")?;
    let logs: Option<Vec<u8>> = row.try_get("logs")?;
    let exports: Option<Vec<u8>> = row.try_get("exports")?;

    Ok(NodeResult {
        node_id: row.try_get("node_id")?,
        node_label: row.try_get("node_label")?,
        test_case_id: row.try_get("test_case_id")?,
        test_case_name: row.try_get("test_case_name")?,
        status: serde_json::from_value(serde_json::Value::String(status))
            .map_err(|e| AppError::Internal(e.to_string()))?,
        duration_ms: duration_ms.max(0) as u64,
        request: blob::unpack_json(request.as_deref()),
        response: blob::unpack_json(response.as_deref()),
        exports: blob::unpack_json(exports.as_deref()),
        // Never stored: SAT.env writes are applied by the client at the time, and
        // replaying a past run's writes into today's environment would be a side effect
        // of *reading* history.
        env: None,
        error_message: row.try_get("error_message")?,
        logs: blob::unpack_json(logs.as_deref()).unwrap_or_default(),
        expected: row.try_get("expected")?,
        teardown: (teardown != 0).then_some(true),
        row_index: row_index.map(|i| i.max(0) as usize),
        row_label: row.try_get("row_label")?,
        iterations: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{NodeStatus, RequestLog, ResponseLog};
    use sqlx::any::{install_default_drivers, AnyPoolOptions};
    use std::collections::HashMap;

    const TOKEN: &str = "eyJhbGciOiJIUzI1NiJ9.aVeryLongStandInForATwoKilobyteBearerToken";

    async fn setup() -> AnyPool {
        install_default_drivers();
        let pool = AnyPoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory sqlite");

        // Foreign keys on, or ON DELETE SET NULL never fires and the test that pins it
        // would pass for the wrong reason.
        sqlx::query("PRAGMA foreign_keys=ON").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE projects (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE flows (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE test_cases (id TEXT PRIMARY KEY)").execute(&pool).await.unwrap();
        for statement in include_str!("../../../migrations/009_runs.sql").split(';') {
            let stmt = statement.trim();
            if stmt.lines().any(|l| !l.trim().is_empty() && !l.trim().starts_with("--")) {
                sqlx::query(stmt).execute(&pool).await.unwrap();
            }
        }
        sqlx::query("INSERT INTO projects (id) VALUES ('p1')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO flows (id) VALUES ('f1')").execute(&pool).await.unwrap();
        pool
    }

    fn node(id: &str, status: NodeStatus) -> NodeResult {
        NodeResult {
            node_id: id.into(),
            node_label: None,
            test_case_id: Some("tc1".into()),
            test_case_name: Some("Send SMS".into()),
            status,
            duration_ms: 42,
            request: Some(RequestLog {
                method: "POST".into(),
                url: "http://host/sms".into(),
                headers: [("Authorization".to_string(), format!("Bearer {TOKEN}"))]
                    .into_iter()
                    .collect::<HashMap<_, _>>(),
                body: Some(r#"{"channel":"SMS"}"#.into()),
            }),
            response: Some(ResponseLog {
                status: 201,
                headers: HashMap::new(),
                body: r#"{"ok":true}"#.into(),
                json: None,
            }),
            exports: None,
            env: None,
            error_message: None,
            logs: vec!["a note".into()],
            expected: Some("201".into()),
            teardown: None,
            row_index: None,
            row_label: None,
            iterations: None,
        }
    }

    fn member(results: Vec<NodeResult>) -> FlowRunInput {
        FlowRunInput {
            ordinal: 0,
            member_kind: MemberKind::Flow,
            flow_id: Some("f1".into()),
            test_case_id: None,
            name: "JT1 – SMS".into(),
            status: "completed".into(),
            started_at: Utc::now(),
            duration_ms: Some(1240),
            error_message: None,
            results,
        }
    }

    /// A run of a flow started by hand — `suite_id` NULL, which is what makes it ad-hoc.
    async fn a_run(repo: &SqlxRunRepository, results: Vec<NodeResult>) -> String {
        a_run_of(repo, None, results).await
    }

    async fn a_run_of(
        repo: &SqlxRunRepository,
        suite_id: Option<&str>,
        results: Vec<NodeResult>,
    ) -> String {
        let id = repo
            .start(SuiteRunInput {
                project_id: "p1".into(),
                suite_id: suite_id.map(str::to_string),
                suite_name: "JT1 – SMS".into(),
                environment_name: Some("staging".into()),
            })
            .await
            .unwrap();
        repo.record_member(&id, member(results)).await.unwrap();
        repo.finish(&id, "completed", RunTotals { total: 1, passed: 1, ..Default::default() }, None)
            .await
            .unwrap();
        id
    }

    #[tokio::test]
    async fn a_run_reads_back_as_it_was_written() {
        let repo = SqlxRunRepository::new(setup().await);
        let id = a_run(&repo, vec![node("n1", NodeStatus::Passed)]).await;

        let run = repo.get(&id).await.unwrap().expect("the run");
        assert_eq!(run.status, "completed");
        assert_eq!(run.passed, 1);
        assert_eq!(run.environment_name.as_deref(), Some("staging"));
        assert!(run.duration_ms.is_some());

        let member = &run.members[0];
        assert_eq!(member.name, "JT1 – SMS");
        let result = &member.results[0];
        assert_eq!(result.node_id, "n1");
        assert_eq!(result.status, NodeStatus::Passed);
        assert_eq!(result.expected.as_deref(), Some("201"));
        assert_eq!(result.logs, vec!["a note".to_string()]);
        assert_eq!(result.response.as_ref().unwrap().status, 201);
        assert_eq!(result.request.as_ref().unwrap().body.as_deref(), Some(r#"{"channel":"SMS"}"#));
    }

    #[tokio::test]
    async fn a_stored_run_holds_no_bearer_token() {
        // Unpacked, not raw: a compressed token is still a token, and scanning the
        // packed bytes would pass while the credential sat in the database intact.
        let pool = setup().await;
        let repo = SqlxRunRepository::new(pool.clone());
        a_run(&repo, vec![node("n1", NodeStatus::Passed)]).await;

        let stored: Vec<Vec<u8>> =
            sqlx::query_scalar("SELECT request FROM run_results WHERE request IS NOT NULL")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(!stored.is_empty(), "nothing was stored to check");
        for packed in stored {
            let text = blob::unpack(Some(&packed)).unwrap().unwrap();
            assert!(!text.contains(TOKEN), "the bearer token reached storage: {text}");
            assert!(text.contains("redacted"));
        }
    }

    #[tokio::test]
    async fn a_fan_outs_rows_are_each_recorded() {
        let repo = SqlxRunRepository::new(setup().await);
        let mut aggregate = node("fanout", NodeStatus::Failed);
        aggregate.iterations = Some(vec![
            NodeResult { row_index: Some(0), row_label: Some("valid".into()), ..node("fanout", NodeStatus::Passed) },
            NodeResult { row_index: Some(2), row_label: Some("no sender".into()), ..node("fanout", NodeStatus::Failed) },
        ]);
        let id = a_run(&repo, vec![aggregate]).await;

        let run = repo.get(&id).await.unwrap().unwrap();
        let node = &run.members[0].results[0];
        let rows = node.iterations.as_ref().expect("rows came back attached to their node");
        assert_eq!(rows.len(), 2);
        // The row's own index, not its position in the selection — that distinction is
        // what makes "row 3 failed" mean anything.
        assert_eq!(rows[1].row_index, Some(2));
        assert_eq!(rows[1].row_label.as_deref(), Some("no sender"));
        assert_eq!(rows[0].status, NodeStatus::Passed);
    }

    #[tokio::test]
    async fn deleting_a_flow_keeps_its_history() {
        // A history that edits itself when you tidy up is not a history. Flip the FK back
        // to ON DELETE CASCADE in 009 and this fails.
        let pool = setup().await;
        let repo = SqlxRunRepository::new(pool.clone());
        let id = a_run(&repo, vec![node("n1", NodeStatus::Passed)]).await;

        sqlx::query("DELETE FROM flows WHERE id = 'f1'").execute(&pool).await.unwrap();

        let run = repo.get(&id).await.unwrap().expect("the run outlived the flow");
        let member = &run.members[0];
        assert_eq!(member.flow_id, None, "the link is dropped");
        assert_eq!(member.name, "JT1 – SMS", "but what it was called is still on record");
        assert_eq!(member.results.len(), 1, "and so is what it did");
    }

    #[tokio::test]
    async fn the_list_is_newest_first_and_carries_no_bodies() {
        let pool = setup().await;
        let repo = SqlxRunRepository::new(pool.clone());
        a_run(&repo, vec![node("n1", NodeStatus::Passed)]).await;
        a_run(&repo, vec![node("n2", NodeStatus::Passed)]).await;
        sqlx::query("UPDATE suite_runs SET started_at = '2020-01-01T00:00:00+00:00' WHERE id = (SELECT id FROM suite_runs LIMIT 1)")
            .execute(&pool).await.unwrap();

        let listing = repo.list("p1", 50, true).await.unwrap();
        assert_eq!(listing.runs.len(), 2);
        assert!(listing.runs[0].started_at > listing.runs[1].started_at);
        // The list is a hundred headlines, not a hundred runs' worth of packed bodies.
        assert!(listing.runs.iter().all(|r| r.members.is_empty()));
        // Nothing is hidden when everything was asked for.
        assert_eq!(listing.adhoc_hidden, 0);
    }

    #[tokio::test]
    async fn the_index_hides_ad_hoc_runs_by_default_and_counts_them() {
        // Running a flow is how you author one, and a debug loop of twenty would push
        // last night's suite run off the first screen. Filtered here rather than in the
        // client, because `limit` would hide the suite runs before the client saw them.
        let pool = setup().await;
        sqlx::query(
            "INSERT INTO suites (id, project_id, name, created_at, updated_at) \
             VALUES ('s1','p1','Regression','2020-01-01T00:00:00+00:00','2020-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let repo = SqlxRunRepository::new(pool);

        a_run_of(&repo, Some("s1"), vec![node("n1", NodeStatus::Passed)]).await;
        for _ in 0..3 {
            a_run(&repo, vec![node("n1", NodeStatus::Passed)]).await;
        }

        let listing = repo.list("p1", 50, false).await.unwrap();
        assert_eq!(listing.runs.len(), 1, "only the suite run is listed");
        assert_eq!(listing.runs[0].suite_id.as_deref(), Some("s1"));
        // Said out loud rather than silently omitted: "that's all there is" would be a lie.
        assert_eq!(listing.adhoc_hidden, 3);

        let everything = repo.list("p1", 50, true).await.unwrap();
        assert_eq!(everything.runs.len(), 4);
    }

    #[tokio::test]
    async fn the_hidden_count_covers_the_project_not_the_page() {
        // "23 hidden" answers "what am I not looking at". Counting only within the page
        // would understate it exactly when the page is full and it matters most.
        let repo = SqlxRunRepository::new(setup().await);
        for _ in 0..5 {
            a_run(&repo, vec![node("n1", NodeStatus::Passed)]).await;
        }

        let listing = repo.list("p1", 2, false).await.unwrap();
        assert!(listing.runs.is_empty());
        assert_eq!(listing.adhoc_hidden, 5);
    }

    #[tokio::test]
    async fn a_run_is_visible_while_it_is_still_going() {
        // Written up front, so a server that dies mid-suite leaves a run marked running
        // rather than no trace of the hour it spent.
        let repo = SqlxRunRepository::new(setup().await);
        let id = repo
            .start(SuiteRunInput {
                project_id: "p1".into(),
                suite_id: None,
                suite_name: "Nightly".into(),
                environment_name: None,
            })
            .await
            .unwrap();

        let run = repo.get(&id).await.unwrap().unwrap();
        assert_eq!(run.status, "running");
        assert_eq!(run.completed_at, None);
    }

    #[tokio::test]
    async fn deleting_a_run_takes_its_members_and_results_with_it() {
        let pool = setup().await;
        let repo = SqlxRunRepository::new(pool.clone());
        let id = a_run(&repo, vec![node("n1", NodeStatus::Passed)]).await;

        repo.delete(&id).await.unwrap();

        assert!(repo.get(&id).await.unwrap().is_none());
        let orphans: i64 = sqlx::query_scalar("SELECT count(*) FROM run_results")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(orphans, 0);
    }
}
