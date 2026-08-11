//! Flow execution engine
//!
//! Executes test flows by traversing the graph and running test cases.
//! Uses repository pattern for fetching test case data on-demand.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::info;

use crate::db::models::{DataRow, ExportVariable, Flow, GraphNode, TestCase};
use crate::db::repositories::TestCaseRepository;
use crate::error::AppError;
use crate::execution::body::BodyType;

use super::{ExecutionContext, AssertionEngine, HttpExecutor, PreTestScriptEngine, VarSource};
use super::assertions::AssertionInput;
use super::variables;
use super::http::{RequestLog, ResponseLog};

/// The last meaningful line of a script — for an assertion that's the expression
/// whose value decided pass/fail, which is what a failure report should quote.
fn last_expression(script: &str) -> String {
    script
        .lines()
        .map(|l| l.trim().trim_end_matches(';'))
        .filter(|l| !l.is_empty() && !l.starts_with("//"))
        .next_back()
        .unwrap_or("")
        .to_string()
}

/// Collect `{{name}}` placeholders still present in an outgoing request, i.e.
/// variables that failed to resolve.
fn find_unresolved(
    url: &str,
    headers: &HashMap<String, String>,
    body: Option<&str>,
) -> Vec<String> {
    let re = match regex::Regex::new(r"\{\{([^{}]+)\}\}") {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut sources: Vec<&str> = vec![url];
    for v in headers.values() {
        sources.push(v.as_str());
    }
    if let Some(b) = body {
        sources.push(b);
    }
    let mut names: Vec<String> = Vec::new();
    for s in sources {
        for caps in re.captures_iter(s) {
            if let Some(m) = caps.get(1) {
                let name = format!("{{{{{}}}}}", m.as_str().trim());
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
    }
    names
}

/// The body this run sends, before interpolation: the row's own body if it gave
/// one, else the test case's payload.
fn resolve_body<'a>(row: Option<&'a DataRow>, test_case: &'a TestCase) -> Option<&'a str> {
    row.and_then(|r| r.body_override())
        .or_else(|| test_case.payload.as_deref())
}

/// The endpoint template for this row: the test case's, plus whatever the row appends.
///
/// Composed *before* interpolation, so the result is what gets interpolated, scanned
/// for unresolved names, checked for leftover "null"s and reported by the provenance
/// log. Reading `test_case.endpoint` directly anywhere in the request cycle would make
/// a row's own `{{org}}` invisible to all four.
fn resolve_endpoint<'a>(row: Option<&'a DataRow>, test_case: &'a TestCase) -> Cow<'a, str> {
    let Some(suffix) = row.and_then(|r| r.path_suffix()) else {
        return Cow::Borrowed(&test_case.endpoint);
    };
    // A row adding "?org=acme" to an endpoint that already has a query would otherwise
    // produce "?limit=10?org=acme" — a URL the server reads as one broken parameter.
    let joined = if suffix.starts_with('?') && test_case.endpoint.contains('?') {
        format!("{}&{}", test_case.endpoint, &suffix[1..])
    } else {
        format!("{}{}", test_case.endpoint, suffix)
    };
    Cow::Owned(joined)
}

/// The shared post-test script, if there is a non-empty one.
/// An AppError's own prefix reads as noise once the caller has said which script
/// failed: "This row's check could not run: Assertion error: …" says it twice.
fn plain(e: &AppError) -> String {
    let msg = e.to_string();
    for prefix in ["Assertion error: ", "Internal error: "] {
        if let Some(rest) = msg.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    msg
}

/// "(body has: access_token, refresh_token)" — enough to spot a misspelling
/// without dumping a whole response into the log.
fn top_level_keys(json: &Value) -> String {
    const MAX: usize = 8;
    match json.as_object() {
        Some(map) if !map.is_empty() => {
            let mut names: Vec<&str> = map.keys().take(MAX).map(String::as_str).collect();
            let more = map.len().saturating_sub(names.len());
            let tail = if more > 0 { format!(", … {} more", more) } else { String::new() };
            names.sort_unstable();
            format!(" (body has: {}{})", names.join(", "), tail)
        }
        _ => String::new(),
    }
}

/// What a hand-written check says: a bare status code, a Rhai expression, or
/// nothing. Written once because a dataset row's Expect and a node's Expect mean
/// exactly the same thing and must not drift apart.
enum Check<'a> {
    Status(u16),
    Expr(&'a str),
    Unstated,
}

fn parse_check(raw: Option<&str>) -> Check<'_> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Check::Unstated,
        Some(text) => match text.parse::<u16>() {
            Ok(status) => Check::Status(status),
            Err(_) => Check::Expr(text),
        },
    }
}

/// A node marked "always run": teardown. Excluded from the normal path and run
/// after it, however the run ended.
fn is_teardown(node: &GraphNode) -> bool {
    node.data
        .get("config")
        .and_then(|c| c.get("teardown"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// A polled response in one line, for the attempt log.
///
/// The whole body would flood sixty attempts; the fields a poll turns on — status, counts —
/// are what the reader is watching change.
fn summarise_body(body: &str) -> String {
    let flat: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 120 {
        return flat;
    }
    format!("{}…", flat.chars().take(120).collect::<String>())
}

/// A node that may have to ask more than once.
///
/// Multi-stage uploads answer 202 with `{"status":"pending",…}` and the real outcome only
/// exists after polling. This is **not** a loop: nothing iterates, one request is re-sent
/// until its answer settles, so it is a property of the node rather than a structure around
/// it.
///
/// **`until` and `check` have distinct jobs, deliberately.** `until` says the answer has
/// settled; `check` says whether it was the right answer. Collapsing them lies: an upload
/// whose status becomes `"failed"` would be retried to the budget and reported as "timed
/// out" rather than "the upload failed", hiding the real result behind a slow one.
#[derive(Debug, Clone, PartialEq)]
struct PollConfig {
    /// Rhai, interpolated exactly like `check`.
    until: String,
    interval_ms: u64,
    timeout_ms: u64,
}

/// Shared with `validation::graph`, so the warning about a budget shorter than an interval
/// is measured against the same numbers the engine will actually use.
pub const POLL_INTERVAL_MS: u64 = 2_000;
pub const POLL_TIMEOUT_MS: u64 = 120_000;

/// `config.poll.until` marks a node. Absent means no polling, which is every node that
/// existed before this.
fn poll_config(node: &GraphNode) -> Option<PollConfig> {
    let poll = node.data.get("config").and_then(|c| c.get("poll"))?;
    let until = poll.get("until").and_then(|v| v.as_str()).map(str::trim)?;
    if until.is_empty() {
        return None;
    }
    let ms = |key: &str, fallback: u64| {
        poll.get(key).and_then(|v| v.as_u64()).filter(|n| *n > 0).unwrap_or(fallback)
    };
    Some(PollConfig {
        until: until.to_string(),
        interval_ms: ms("intervalMs", POLL_INTERVAL_MS),
        timeout_ms: ms("timeoutMs", POLL_TIMEOUT_MS),
    })
}

/// An edge this author explicitly labelled `failure`, and nothing else.
///
/// Strict on purpose. `pick_edge` falls back — exact type, `default`, untyped, then the first
/// edge it can find — which is right for a graph drawn without labels but catastrophic for a
/// failure: it would find the happy path and take it. Every edge in a real flow here is untyped,
/// so that fallback was not a rare case, it was the only case.
fn failure_edge(flow: &Flow, current_id: &str) -> Option<String> {
    flow.graph_data
        .edges
        .iter()
        .find(|e| e.source == current_id && e.edge_type.as_deref() == Some("failure"))
        .map(|e| e.target.clone())
}

/// A node's fan-out choice, as the canvas stores it.
#[derive(Debug, PartialEq)]
enum FanOut {
    /// Run the request once, as authored — the dataset is ignored.
    Off,
    /// One request per row, every row.
    AllRows,
    /// One request per row, for these row ids.
    Rows(Vec<String>),
}

/// `config.forEachRow` marks a node; `config.rowIds` narrows it.
///
/// **An absent `rowIds` means every row** — absence is already how this config says
/// "unset", and it means a row added to the dataset later is included without anyone
/// revisiting the node. An *empty* list is different: it means none, and the node says
/// so rather than helpfully running everything the author just unticked.
fn fan_out(node: &GraphNode) -> FanOut {
    let config = node.data.get("config");
    let marked = config
        .and_then(|c| c.get("forEachRow"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !marked {
        return FanOut::Off;
    }
    match config.and_then(|c| c.get("rowIds")).and_then(|v| v.as_array()) {
        None => FanOut::AllRows,
        Some(ids) => {
            let mut wanted: Vec<String> = Vec::new();
            for id in ids.iter().filter_map(|v| v.as_str()) {
                let id = id.trim();
                if !id.is_empty() && !wanted.iter().any(|seen| seen == id) {
                    wanted.push(id.to_string());
                }
            }
            FanOut::Rows(wanted)
        }
    }
}

/// What a node will actually run.
enum RowPlan {
    /// Once, as authored.
    Once,
    /// One request per row, in dataset order whatever order they were selected in.
    Rows(Vec<(usize, DataRow)>),
    /// One request per element of a list an earlier step produced.
    ///
    /// Synthesised as rows on purpose: the loop, the verdict fold, the `SAT.env` fold, the
    /// per-iteration records and every screen that renders them are the dataset's, so
    /// walking a list costs one substitution rather than a second implementation of all of
    /// it. A dataset is authored up front and cannot know ids the server just minted —
    /// that gap is the whole reason this exists.
    Items(Vec<(usize, DataRow)>),
    /// Rows were chosen and none of them are there any more.
    NothingSelected(String),
}

/// A value named in a message, kept to one readable line — a 4 KB response body quoted in
/// full is not an explanation.
fn short(text: &str) -> String {
    const MAX: usize = 60;
    let one_line = text.replace('\n', " ");
    if one_line.chars().count() <= MAX {
        return one_line;
    }
    format!("{}…", one_line.chars().take(MAX).collect::<String>())
}

/// "Once per item in a list": which list, and what to call each element.
struct ForEach {
    /// The variable holding the list.
    list: String,
    /// A name for each element, needed only when the list holds plain values rather than
    /// records — a record's fields already carry the names the author gave them.
    item_var: Option<String>,
}

/// Read the `forEach` config, forgiving the `{{…}}` everyone will type.
fn for_each(node: &GraphNode) -> Option<ForEach> {
    let cfg = node.data.get("config")?.get("forEach")?;
    let text = |key: &str| {
        cfg.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().trim_start_matches("{{").trim_end_matches("}}").trim().to_string())
            .filter(|s| !s.is_empty())
    };
    Some(ForEach { list: text("list").unwrap_or_default(), item_var: text("as") })
}

/// Turn a list into rows, one per element, saying what it found when it can't.
///
/// Every branch that gives up returns `NothingSelected`, which is `Failed` with a message
/// — nothing broke, the step was mis-configured, and `Failed` still routes down a failure
/// edge instead of ending the run.
fn plan_items(
    spec: &ForEach,
    test_case: &TestCase,
    ctx: &ExecutionContext,
    logs: &mut Vec<String>,
) -> RowPlan {
    if spec.list.is_empty() {
        return RowPlan::NothingSelected(
            "This step is set to run once per item, but no list is named. Open the node and pick the list to walk".to_string(),
        );
    }

    let Some(value) = ctx.resolve(&spec.list) else {
        return RowPlan::NothingSelected(format!(
            "No variable named \"{}\" — the step that collects it must run before this one",
            spec.list
        ));
    };

    let items = match value {
        Value::Array(items) => items.clone(),
        other => {
            return RowPlan::NothingSelected(format!(
                "\"{}\" is a single value ({}), not a list — collect it on a step that runs more than once",
                spec.list,
                short(&variables::value_to_string(other))
            ));
        }
    };

    if items.is_empty() {
        // Nothing ran is not a pass — the same rule as a dataset whose every row is parked.
        return RowPlan::NothingSelected(format!(
            "\"{}\" is empty, so there is nothing to run",
            spec.list
        ));
    }

    // The `{{names}}` this request declares, minus the built-ins, which are generated per use.
    let mut needed: Vec<String> = Vec::new();
    let mut templates: Vec<Cow<'_, str>> = vec![Cow::Borrowed(test_case.endpoint.as_str())];
    if let Some(payload) = &test_case.payload {
        templates.push(Cow::Borrowed(payload.as_str()));
    }
    if let Some(headers) = test_case.headers.as_object() {
        for value in headers.values() {
            if let Some(text) = value.as_str() {
                templates.push(Cow::Borrowed(text));
            }
        }
    }
    for template in &templates {
        for name in variables::declared_names(template) {
            if !name.starts_with('$') && !needed.contains(&name) {
                needed.push(name);
            }
        }
    }

    let mut rows: Vec<(usize, DataRow)> = Vec::with_capacity(items.len());
    // Items dropped, named once at the end. One line per item would be the wall of warnings
    // the collection tally exists to avoid — and on a mixed dataset it is the same rows.
    let mut skipped: Vec<String> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let vars: BTreeMap<String, String> = match item {
            // A record: spread its fields, so two captures from one response arrive
            // together and under the names the author already chose.
            Value::Object(fields) => fields
                .iter()
                .filter(|(name, _)| name.as_str() != RECORD_ROW_KEY)
                .map(|(name, value)| (name.clone(), variables::value_to_string(value)))
                .collect(),
            Value::Array(_) => {
                return RowPlan::NothingSelected(format!(
                    "\"{}\" holds lists, which is neither a record nor a value this step can send",
                    spec.list
                ));
            }
            plain => {
                let Some(name) = &spec.item_var else {
                    return RowPlan::NothingSelected(format!(
                        "\"{}\" holds plain values, so each one needs a name — set \"Name each item\"",
                        spec.list
                    ));
                };
                BTreeMap::from([(name.clone(), variables::value_to_string(plain))])
            }
        };

        // A blank value is filtered out of row vars, which would leave {{name}} resolving
        // from a *lower* tier and send a confidently wrong request to a real API. Say which
        // one, and drop it.
        let blank: Vec<&str> = vars
            .iter()
            .filter(|(_, v)| v.trim().is_empty())
            .map(|(k, _)| k.as_str())
            .collect();
        if !blank.is_empty() {
            logs.push(format!(
                "⚠ {}[{}] has no value for {} — skipped, rather than sending whatever an earlier step left behind",
                spec.list,
                index,
                blank.join(", ")
            ));
            continue;
        }

        // A name the request needs that this record hasn't got, and nothing else supplies.
        //
        // Blank was only half the problem: a field **absent** from a record is not a blank
        // value, so the guard above never saw it. `{{campaignId}}` then went out as those
        // fourteen literal characters — to a real API, seven times, in a mixed dataset where
        // the negative rows had no id to give. The engine warns about a literal placeholder
        // and sends anyway, which is right for a hand-authored request and wrong here: the
        // author never wrote this iteration, the list did, and an item that cannot fill the
        // request is not a test of anything.
        let missing: Vec<&str> = needed
            .iter()
            .filter(|name| !vars.contains_key(*name))
            .filter(|name| ctx.resolve(name).is_none())
            .map(|name| name.as_str())
            .collect();
        if !missing.is_empty() {
            skipped.push(format!(
                "{} (no {})",
                label_of(item, &spec.list, index),
                missing.join(", ")
            ));
            continue;
        }

        rows.push((
            index,
            DataRow {
                id: format!("{}[{}]", spec.list, index),
                // The row that produced this record, so the report reads "100 recipients"
                // rather than "Row 2".
                name: item
                    .get(RECORD_ROW_KEY)
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                ..Default::default()
            },
        ));
        // Set after construction: `DataRow`'s `vars` is the field the row loop reads.
        rows.last_mut().unwrap().1.vars = vars;
    }

    if !skipped.is_empty() {
        logs.push(format!(
            "{} of {} item(s) in \"{}\" could not fill this request and were not sent: {}",
            skipped.len(),
            items.len(),
            spec.list,
            skipped.join("; ")
        ));
    }

    if rows.is_empty() {
        return RowPlan::NothingSelected(format!(
            "No item in \"{}\" could fill this request, so nothing ran — {}",
            spec.list,
            skipped.join("; ")
        ));
    }

    RowPlan::Items(rows)
}

/// What to call an item in a message — the row that produced it, else its position.
fn label_of(item: &Value, list: &str, index: usize) -> String {
    item.get(RECORD_ROW_KEY)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}[{}]", list, index))
}

/// Work out which rows a node runs, saying out loud anything that narrows the plan.
///
/// A selection is never quietly shortened: the author asked for coverage, and coverage
/// silently going missing is how a green run comes to mean nothing.
fn plan_rows(node: &GraphNode, test_case: &TestCase, logs: &mut Vec<String>) -> RowPlan {
    let choice = fan_out(node);
    if choice == FanOut::Off {
        return RowPlan::Once;
    }

    let rows: Vec<DataRow> = test_case
        .dataset
        .as_ref()
        .map(|d| d.rows.clone())
        .unwrap_or_default();

    if rows.is_empty() {
        logs.push(format!(
            "⚠ This step is set to run once per data row, but \"{}\" has no data rows — the request ran once, as authored",
            test_case.name
        ));
        return RowPlan::Once;
    }

    match choice {
        FanOut::Off => RowPlan::Once,
        FanOut::AllRows => RowPlan::Rows(rows.into_iter().enumerate().collect()),
        FanOut::Rows(wanted) => {
            if wanted.is_empty() {
                return RowPlan::NothingSelected(format!(
                    "No data rows are selected for this step, so nothing ran. Open the node and pick the rows of \"{}\" it should run",
                    test_case.name
                ));
            }
            let selected: Vec<(usize, DataRow)> = rows
                .iter()
                .cloned()
                .enumerate()
                .filter(|(_, row)| wanted.iter().any(|id| *id == row.id))
                .collect();

            let missing: Vec<&str> = wanted
                .iter()
                .filter(|id| !rows.iter().any(|row| &row.id == *id))
                .map(String::as_str)
                .collect();

            if selected.is_empty() {
                return RowPlan::NothingSelected(format!(
                    "None of the {} row(s) selected for this step exist in \"{}\" any more, so nothing ran ({})",
                    wanted.len(),
                    test_case.name,
                    missing.join(", ")
                ));
            }
            if !missing.is_empty() {
                logs.push(format!(
                    "⚠ {} selected data row(s) are no longer in \"{}\" ({}) — nothing ran for them. Open this node and re-pick its rows",
                    missing.len(),
                    test_case.name,
                    missing.join(", ")
                ));
            }
            // A row left out of the selection produces no result at all — unlike a
            // parked one, which is reported as skipped. Without this the only clue is a
            // gap in the row numbers, which reads as "the last one didn't run" when it
            // was really the first two.
            if selected.len() < rows.len() {
                let left_out: Vec<String> = rows
                    .iter()
                    .enumerate()
                    .filter(|(_, row)| !wanted.iter().any(|id| *id == row.id))
                    .map(|(i, _)| (i + 1).to_string())
                    .collect();
                logs.push(format!(
                    "Running {} of the {} data rows in \"{}\" — row(s) {} are not selected on this node",
                    selected.len(),
                    rows.len(),
                    test_case.name,
                    left_out.join(", ")
                ));
            }
            if rows.iter().any(|row| row.id.trim().is_empty()) {
                logs.push(
                    "⚠ Some data rows have no id and can't be selected individually — open the request's Data tab and save it once to give them ids"
                        .to_string(),
                );
            }
            RowPlan::Rows(selected)
        }
    }
}

/// Teardown nodes in the order their edges imply — "log in as admin, then delete"
/// has to happen in that order, and the order they appear in the graph's node list
/// is whatever the canvas happened to produce.
fn teardown_sequence(flow: &Flow) -> Vec<&GraphNode> {
    let marked: Vec<&GraphNode> = flow.graph_data.nodes.iter().filter(|n| is_teardown(n)).collect();
    let leads_to = |from: &str, to: &str| {
        flow.graph_data.edges.iter().any(|e| e.source == from && e.target == to)
    };

    // A chain starts at a marked node no other marked node points at.
    let mut ordered: Vec<&GraphNode> = Vec::new();
    let mut placed: Vec<&str> = Vec::new();
    for start in marked.iter().filter(|n| {
        !marked.iter().any(|other| other.id != n.id && leads_to(&other.id, &n.id))
    }) {
        let mut current = Some(*start);
        while let Some(node) = current {
            if placed.contains(&node.id.as_str()) {
                break; // a cycle; whatever is left is appended below
            }
            placed.push(&node.id);
            ordered.push(node);
            current = marked
                .iter()
                .find(|next| next.id != node.id && leads_to(&node.id, &next.id))
                .copied();
        }
    }
    // Anything unreachable that way (a cycle, or two disconnected chains) still runs.
    for node in marked {
        if !placed.contains(&node.id.as_str()) {
            ordered.push(node);
        }
    }
    ordered
}

/// Names this flow declares as output variables. A teardown node using one of them
/// must get its value from *this* run: `{{baseUrl}}` legitimately comes from the
/// environment, `{{new_account_id}}` does not.
fn flow_produced_names(flow: &Flow) -> std::collections::HashSet<String> {
    let mut names = std::collections::HashSet::new();
    for node in &flow.graph_data.nodes {
        let rows = node.data
            .get("config")
            .and_then(|c| c.get("outputVars"))
            .and_then(|v| v.as_array());
        for row in rows.into_iter().flatten() {
            if let Some(name) = row.get("name").and_then(|v| v.as_str()) {
                let name = name.trim();
                if !name.is_empty() {
                    names.insert(name.to_string());
                }
            }
        }
    }
    names
}

/// Why a teardown node must not be sent, if so.
///
/// Deleting is not something to attempt hopefully. Two ways a teardown request can
/// be aimed at the wrong thing, and both end the same way — skip, and say why:
///
///  * a `{{name}}` that resolved to nothing would go out as a literal; a URL with a
///    brace in it is never what anyone intended.
///  * a name this flow produces, but whose value came from the environment, is a
///    leftover from an earlier run — it names a real resource this run never
///    created, and deleting it would be destroying a stranger's data.
fn teardown_blocked(
    test_case: &TestCase,
    ctx: &ExecutionContext,
    produced: &std::collections::HashSet<String>,
    // Anything else this run will put on the wire — a fan-out row's own body and URL
    // suffix, which the test case knows nothing about. Left out, a row could aim a
    // delete at a leftover id and slip past the guard entirely.
    extra_templates: &[&str],
) -> Option<String> {
    let mut templates: Vec<&str> = vec![test_case.endpoint.as_str()];
    templates.extend(extra_templates);
    if let Some(map) = test_case.headers.as_object() {
        templates.extend(map.values().filter_map(|v| v.as_str()));
    }
    if let Some(payload) = test_case.payload.as_deref() {
        templates.push(payload);
    }

    for template in templates {
        for (name, source, _) in ctx.provenance_all(template) {
            match source {
                None => {
                    return Some(format!(
                        "Not run: {{{{{}}}}} was never produced by this run, so this request would go out with a placeholder in it",
                        name
                    ))
                }
                Some(VarSource::Environment) if produced.contains(&name) => {
                    return Some(format!(
                        "Not run: {} came from environment/globals, not from this run — it is a leftover naming something this run never created",
                        name
                    ))
                }
                _ => {}
            }
        }
    }
    None
}

fn shared_script(test_case: &TestCase) -> Option<&str> {
    test_case
        .assertion_script
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// The only real differences between the flow-node path and the standalone path.
/// Everything else about running a test case is shared — see `run_once`.
struct RunOptions<'a> {
    /// "direct" for the editor path, the node id for the flow path.
    node_id: &'a str,
    /// Node-level `outputVars`; empty for the standalone path.
    extra_exports: &'a [ExportVariable],
    /// Warn when a `{{name}}` reaches the wire unresolved.
    report_unresolved: bool,
    /// Set on iteration results so the UI can label them.
    row_index: Option<usize>,
    row_label: Option<String>,
    /// This node's own Expect, when the author gave it one. A node states what
    /// should be true for its place in the flow — the same request may be a 202
    /// in one scenario and a 402 in another — and like a dataset row it stands
    /// alone: the test case's post-test script does not run for that node.
    node_check: Option<&'a str>,
    /// Set when this node may have to ask more than once. Wraps only the send — the
    /// verdict and exports still run once, against the final response.
    poll: Option<&'a PollConfig>,
    /// The stream this run reports to, when there is one.
    ///
    /// Read between poll attempts, for the same reason `RunState::should_stop` reads it at
    /// every node boundary: a poll can hold a run open for two minutes, which is long
    /// enough that "a run nobody is watching stops" has to be true inside a node and not
    /// just between them.
    watcher: Option<&'a mpsc::Sender<ExecutionEvent>>,
}

impl RunOptions<'_> {
    /// True when the only client for this run has gone.
    fn unwatched(&self) -> bool {
        self.watcher.is_some_and(|tx| tx.is_closed())
    }
}

/// The only differences between the editor's "Run dataset" and a flow node running one
/// request per row. Everything else about iterating rows — cloning the context, folding
/// `SAT.env` forward, the worst-of verdict, the `[row] ` log prefix — lives in
/// `run_rows` and only there, so the two paths cannot drift.
struct RowRunOptions<'a> {
    /// "direct" for the editor path, the node id for the flow path.
    node_id: &'a str,
    /// Node-level `outputVars`. Empty for a fan-out node: a row's context is a clone
    /// about to be dropped, so exporting into it is work with no effect. What a fan-out
    /// hands forward goes through `collect` instead.
    extra_exports: &'a [ExportVariable],
    /// What this step gathers across its runs, when the author named it. `None` for the
    /// editor's "Run dataset", which has no node to configure and nothing downstream.
    collect: Option<Collection<'a>>,
    /// This node's Expect, applied to any row that hasn't stated one of its own.
    node_check: Option<&'a str>,
    /// Set when this node may have to ask more than once. Wraps only the send — the
    /// verdict and exports still run once, against the final response.
    poll: Option<&'a PollConfig>,
    /// The stream this run reports to, passed through to each row's send.
    watcher: Option<&'a mpsc::Sender<ExecutionEvent>>,
    /// True only for the editor's "Run dataset", which has no earlier steps: a row
    /// marked `needs_flow` is reported as skipped instead of being sent, because
    /// running it there produces a failure that says nothing about the request. A flow
    /// node passes false — the flow is the precondition.
    honour_needs_flow: bool,
}

/// What a step that runs more than once gathers, for the steps after it.
///
/// **One record per run, not one array per name.** Two parallel arrays — `campaignIds`
/// and `txnIds` — hold the pairing and cannot express it: the interpolation regex has no
/// dots and no brackets, so the third run could never ask for *its* `txnId`. A record
/// keeps a run's captures together, and the step that walks the list spreads them back
/// out as ordinary `{{names}}`.
#[derive(Copy, Clone)]
struct Collection<'a> {
    /// The list's name, as the author typed it — `launched`.
    into: &'a str,
    /// The record's fields: the node's `outputVars`, unchanged.
    fields: &'a [ExportVariable],
    /// What must be true of a response for it to have produced anything worth collecting.
    ///
    /// Passing is not the same as producing. A negative case expecting a 400 **passes** — and
    /// no campaign was created. Without this, whether it contributes depends on whether the
    /// error body happens to carry a field with the same name as one being collected, which is
    /// an accident of the API's error shape rather than anything the author said. Absent means
    /// "any run that passed", which is every step written before this.
    when: Option<&'a str>,
}

/// What collecting noticed across a whole step, so it can be said once.
///
/// Per-run warnings were the first attempt, and they were unusable on the dataset this
/// feature exists for: nineteen rows of which nine are negative cases expecting a 400 and
/// therefore holding no id at all. Two lines per such row is eighteen warnings about a run
/// doing exactly what it was told — and a warning that is usually wrong is one nobody reads.
#[derive(Default)]
struct CollectTally {
    /// Runs that produced no field at all, by row label.
    empty: Vec<String>,
    /// (row, field) for a record that came out with some fields and not others. Distinct
    /// from `empty`, and the more interesting case: something *did* come back, incomplete.
    partial: Vec<(String, String)>,
    /// Runs whose response wasn't JSON.
    not_json: Vec<String>,
    /// Fields whose path matched more than one value.
    multi: Vec<String>,
    /// Runs the author's own condition ruled out, by row label. Not a warning: saying "this
    /// launch was rejected so there is no campaign to verify" is the condition doing its job.
    unmet: Vec<String>,
    /// The condition itself is broken. One message for the step, not one per run.
    broken: Option<String>,
}

impl CollectTally {
    /// At most three lines, each naming the rows it is about — enough to act on, and short
    /// enough to read.
    fn lines(&self, into: &str, ran: usize) -> Vec<String> {
        let mut out = Vec::new();
        let names = |rows: &[String]| {
            const SHOWN: usize = 5;
            let shown = rows.iter().take(SHOWN).cloned().collect::<Vec<_>>().join(", ");
            if rows.len() > SHOWN {
                format!("{} and {} more", shown, rows.len() - SHOWN)
            } else {
                shown
            }
        };

        if !self.not_json.is_empty() {
            out.push(format!(
                "⚠ {} of {} run(s) answered with something that isn't JSON, so nothing was collected: {}",
                self.not_json.len(),
                ran,
                names(&self.not_json)
            ));
        }
        if let Some(why) = &self.broken {
            out.push(format!(
                "⚠ \"Collect when\" could not be judged, so nothing was collected into \"{}\": {}",
                into, why
            ));
        }
        if !self.unmet.is_empty() {
            out.push(format!(
                "{} of {} run(s) did not meet \"{}\"'s collect condition, so they added no record: {}",
                self.unmet.len(),
                ran,
                into,
                names(&self.unmet)
            ));
        }
        if !self.empty.is_empty() {
            out.push(format!(
                "{} of {} run(s) produced none of \"{}\"'s fields and added no record: {}",
                self.empty.len(),
                ran,
                into,
                names(&self.empty)
            ));
        }
        for (row, field) in &self.partial {
            out.push(format!(
                "⚠ \"{}\" is missing from the record for {} — that field's path found nothing there",
                field, row
            ));
        }
        let mut multi: Vec<&String> = self.multi.iter().collect();
        multi.sort();
        multi.dedup();
        for field in multi {
            out.push(format!(
                "⚠ \"{}\" matched more than one value — the first was used. Narrow its path to the one you want",
                field
            ));
        }
        out
    }
}

/// Which of the two things a JSONPath lookup is for. The query is identical; only the
/// advice when it finds nothing differs, and that advice is the whole value of the log
/// line.
#[derive(Copy, Clone, PartialEq)]
enum CaptureKind {
    /// A name a later request writes as `{{name}}`.
    Export,
    /// One field of the record a step is collecting.
    Field,
}

/// Run these JSONPaths against one response body and say what happened to each.
///
/// Extracted so exporting and collecting share one implementation of "query and report"
/// rather than two that drift — the messages are the only difference.
fn capture(
    specs: &[&ExportVariable],
    json: &Value,
    kind: CaptureKind,
    debug: bool,
    logs: &mut Vec<String>,
    // Field names whose path matched more than once. Reported by the caller, once for the
    // whole step rather than once per run.
    multi: &mut Vec<String>,
) -> HashMap<String, Value> {
    use jsonpath_rust::JsonPath;

    let noun = match kind {
        CaptureKind::Export => "Export",
        CaptureKind::Field => "Field",
    };
    let mut got = HashMap::new();

    for spec in specs {
        match json.query(&spec.json_path) {
            Ok(results) => {
                if let Some(value) = results.first() {
                    got.insert(spec.name.clone(), (*value).clone());
                    if debug && kind == CaptureKind::Export {
                        logs.push(format!("Exported {} = {:?}", spec.name, value));
                    }
                    if kind == CaptureKind::Field && results.len() > 1 {
                        multi.push(spec.name.clone());
                    }
                } else if kind == CaptureKind::Export {
                    // A path that matches nothing used to look exactly like a path that
                    // worked. One typo ("$.accesss_token") then shows up much later as a
                    // literal {{name}} in another request, so name what the body offered.
                    logs.push(format!(
                        "⚠ Export \"{}\": nothing at {}{} — {{{{{}}}}} will not resolve",
                        spec.name,
                        spec.json_path,
                        top_level_keys(json),
                        spec.name
                    ));
                }
                // A field that found nothing is reported by the caller, once for the whole
                // step — see `Collected` in `run_rows`.
            }
            // An unusable path is a typo in the config, not a property of one response, so
            // it is worth saying wherever it happens.
            Err(e) => logs.push(format!(
                "⚠ {} \"{}\" has an unusable path {}: {}",
                noun, spec.name, spec.json_path, e
            )),
        }
    }

    got
}

/// One record for one run — the fields the author picked, plus which row produced it.
///
/// `None` when nothing was captured: a record holding only `_row` says a request happened
/// and nothing came back worth having, which is noise in the list and a lie in the count.
fn record(
    fields: &[ExportVariable],
    json: Option<&Value>,
    row_label: &str,
    debug: bool,
    logs: &mut Vec<String>,
    tally: &mut CollectTally,
) -> Option<Value> {
    let json = match json {
        Some(j) => j,
        None => {
            tally.not_json.push(row_label.to_string());
            return None;
        }
    };

    let specs: Vec<&ExportVariable> = fields.iter().collect();
    let got = capture(&specs, json, CaptureKind::Field, debug, logs, &mut tally.multi);
    if got.is_empty() {
        // Very often correct rather than wrong: in a dataset of negative cases beside
        // positive ones, a 400 that was expected has no id to give. Counted, named at the
        // end, and not warned about here.
        tally.empty.push(row_label.to_string());
        return None;
    }
    for spec in fields {
        if !got.contains_key(&spec.name) {
            tally.partial.push((row_label.to_string(), spec.name.clone()));
        }
    }

    let mut obj = serde_json::Map::new();
    for (name, value) in got {
        obj.insert(name, value);
    }
    // Which run this came from, so the step that consumes the list can label its
    // iterations by the row that produced them. Never spread as a variable: it names the
    // record's origin, it is not something the author captured.
    obj.insert(RECORD_ROW_KEY.to_string(), Value::String(row_label.to_string()));
    Some(Value::Object(obj))
}

/// The one reserved field name in a collected record.
const RECORD_ROW_KEY: &str = "_row";

/// Result status for a node execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatus {
    Passed,
    Failed,
    Error,
    Skipped,
}

impl std::fmt::Display for NodeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeStatus::Passed => write!(f, "passed"),
            NodeStatus::Failed => write!(f, "failed"),
            NodeStatus::Error => write!(f, "error"),
            NodeStatus::Skipped => write!(f, "skipped"),
        }
    }
}

/// Result of executing a single node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeResult {
    pub node_id: String,
    /// What this node is called on the canvas, when the author named it. Two nodes
    /// can share one test case in different roles ("Login as new user" vs "Root
    /// login"), and a result that says only "Login" can't tell them apart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_label: Option<String>,
    pub test_case_id: Option<String>,
    pub test_case_name: Option<String>,
    pub status: NodeStatus,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<RequestLog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<ResponseLog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exports: Option<HashMap<String, Value>>,
    /// Environment writes made by SAT.env during this run — client persists them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub logs: Vec<String>,
    /// What this run actually required, after interpolation — "400", a Rhai
    /// expression, or "any 2xx" when nothing was stated.
    ///
    /// Recorded rather than looked up by the client, because the dataset it would read
    /// may have been edited since the run: the matrix would then show a requirement
    /// that wasn't the one applied. This is the text that decided the verdict, with
    /// `{{expected_count}}` already resolved to the value used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    /// Set on a node that runs as teardown, so a cleanup problem is never mistaken
    /// for the scenario failing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teardown: Option<bool>,
    /// Index of the data row this result came from (iteration results only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_index: Option<usize>,
    /// Label for that row — its name, else "Row N".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_label: Option<String>,
    /// How many times this node asked, when it polled. Absent for the ordinary single
    /// request, so nothing changes for a node that does not poll.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<usize>,
    /// What the `iterations` below are, when they are not data rows.
    ///
    /// A step walking a collected list reports through the dataset's machinery, so without
    /// this every screen says "2/2 rows passed" about something with no rows — a small lie,
    /// in the one place an author looks to find out what ran. Absent for a dataset, so the
    /// wire format and every existing reader are unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations_of: Option<String>,
    /// Per-row results. Present only on the aggregate of a "run all rows" run;
    /// every other producer leaves it None so the wire format is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iterations: Option<Vec<NodeResult>>,
}

/// Events emitted during execution (for WebSocket streaming)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionEvent {
    /// Execution started
    Started {
        execution_id: String,
        flow_id: String,
        total_nodes: usize,
    },
    /// Node execution started
    NodeStarted {
        node_id: String,
        node_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        node_label: Option<String>,
        test_case_id: Option<String>,
        test_case_name: Option<String>,
    },
    /// Node execution completed
    NodeCompleted {
        node_id: String,
        result: NodeResult,
    },
    /// Parked before this node, waiting for the author to say go on. Which node comes
    /// next is the engine's to answer — it depends on the last verdict, and teardown
    /// nodes are hopped over — so it is said here rather than worked out again by the
    /// canvas from a copy of the routing rules.
    Paused {
        node_id: String,
    },
    /// A suite is about to work through its members.
    ///
    /// A suite's members each run a flow, and each of those would otherwise emit its own
    /// `Started` and `Completed` — which a client reads as the whole run finishing, four
    /// members early. The suite runner swallows the inner pair and reports member
    /// boundaries with these instead, so `Completed` keeps meaning "that is all".
    SuiteStarted {
        execution_id: String,
        /// The id this run is stored under, announced before anything executes.
        ///
        /// Without it the client cannot tell which history row the stream belongs to —
        /// `execution_id` is generated for the execution and the stored row gets its own
        /// — so a run in flight could not be opened, only waited for.
        run_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        suite_id: Option<String>,
        suite_name: String,
        total_members: usize,
    },
    /// The suite moved on to this member.
    MemberStarted {
        ordinal: usize,
        total: usize,
        kind: String,
        /// The flow or test case being run. A client with that flow's canvas open can
        /// follow the node events that come next.
        member_id: String,
        name: String,
    },
    /// That member is done. The suite carries on regardless — one failing flow is a
    /// result, not a reason to stop reporting on the other five.
    MemberCompleted {
        ordinal: usize,
        name: String,
        status: String,
        duration_ms: u64,
        passed: usize,
        failed: usize,
        errors: usize,
        skipped: usize,
    },
    /// Execution completed
    Completed {
        execution_id: String,
        status: String,
        duration_ms: u64,
        passed: usize,
        failed: usize,
        errors: usize,
        skipped: usize,
    },
    /// Execution error
    Error {
        message: String,
    },
}

/// Final execution result
#[derive(Debug, Clone, Serialize)]
pub struct FlowExecutionResult {
    pub execution_id: String,
    pub flow_id: String,
    pub status: String,
    pub duration_ms: u64,
    pub results: Vec<NodeResult>,
    pub context: HashMap<String, Value>,
    pub stats: ExecutionStats,
}

/// Execution statistics
#[derive(Debug, Clone, Serialize, Default)]
pub struct ExecutionStats {
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub errors: usize,
    pub skipped: usize,
}

/// What the author pressed while a run was paused.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepCommand {
    /// Run the next node, then pause again.
    Next,
    /// Finish the flow without pausing again.
    RunToEnd,
    /// Abandon the run. Cleanup still happens.
    Stop,
}

/// Permission to run the next node, when the author is driving.
///
/// The mirror image of `event_tx`: events go out one per node, commands come back
/// one per node. Nothing else in the engine knows a run can be paused — a `Stepper`
/// simply makes the next node wait.
struct Stepper {
    rx: mpsc::Receiver<StepCommand>,
    /// Cleared by `RunToEnd`, and by anything that ends the pausing for good — after
    /// that the run proceeds at full speed and never touches the channel again.
    pausing: bool,
    /// The first node of a run goes without asking. Pressing "Run step-by-step"
    /// should *run a node* and then wait, not sit there waiting for a Next before
    /// anything at all has happened.
    first: bool,
}

/// What a `Stepper` decided about the node that is about to run.
#[derive(Debug, PartialEq)]
enum Resume {
    /// Run it.
    Go,
    /// Abandon the traversal: the author pressed Stop, or the stream went away
    /// while we were waiting.
    Abandon,
}

impl Stepper {
    fn new(rx: mpsc::Receiver<StepCommand>) -> Self {
        Self { rx, pausing: true, first: true }
    }

    /// Whether the next node will actually be held up.
    fn will_pause(&self) -> bool {
        self.pausing && !self.first
    }

    /// Wait for permission to run the next node.
    ///
    /// Once this has answered `Abandon` it stops pausing, so a caller that carries on
    /// regardless — the teardown loop does, on purpose — is not asked again.
    async fn wait(&mut self) -> Resume {
        if !self.will_pause() {
            self.first = false; // the free node has been taken
            return Resume::Go;
        }
        match self.rx.recv().await {
            Some(StepCommand::Next) => Resume::Go,
            Some(StepCommand::RunToEnd) => {
                self.pausing = false;
                Resume::Go
            }
            Some(StepCommand::Stop) => {
                self.pausing = false;
                Resume::Abandon
            }
            // The sender is gone, which means the stream it was registered against
            // has been dropped. Nobody is left to press Next, so waiting again would
            // hang this task for good.
            None => {
                self.pausing = false;
                Resume::Abandon
            }
        }
    }
}

/// What one flow run accumulates as it walks the graph.
///
/// Bundled because the traversal is recursive: five `&mut` parameters threaded
/// through every `Box::pin` call is exactly where a mismatched argument order
/// hides, and the list was about to grow again.
struct RunState<'a> {
    /// Test cases already fetched, so a node visited twice costs one query.
    tc_cache: HashMap<String, TestCase>,
    results: Vec<NodeResult>,
    stats: ExecutionStats,
    /// Borrowed rather than owned: `execute_flow` still sends Started and
    /// Completed either side of the traversal.
    event_tx: &'a Option<mpsc::Sender<ExecutionEvent>>,
    /// Set when the author is running the flow a node at a time.
    stepper: Option<Stepper>,
    /// Raised when the process is going down. Read at the same boundary as a client
    /// walking away, and answered the same way: stop, but clean up.
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl RunState<'_> {
    /// True when there is no longer any reason to carry on.
    ///
    /// Two ways that happens, answered identically: the stream this run reports to was
    /// dropped — the browser tab closed, or the author navigated away — or the process
    /// is shutting down. Either way the remaining nodes would create accounts, send
    /// messages and delete things with every result going nowhere.
    ///
    /// A run with no stream at all (the plain `POST /execute`) is never "gone": there
    /// is a client blocked on the response, and no way to notice if there isn't.
    fn should_stop(&self) -> bool {
        if self.stop.load(std::sync::atomic::Ordering::Relaxed) {
            return true;
        }
        self.event_tx.as_ref().is_some_and(|tx| tx.is_closed())
    }

    /// Hold the run here until the author says to go on. Instant unless they are
    /// stepping.
    async fn pause_before_next(&mut self, node_id: &str) -> Resume {
        let Some(stepper) = &mut self.stepper else {
            return Resume::Go;
        };
        if stepper.will_pause() {
            if let Some(tx) = self.event_tx {
                let _ = tx.send(ExecutionEvent::Paused { node_id: node_id.to_string() }).await;
            }
        }
        match self.event_tx {
            // Watch the stream while waiting for the press. If the tab closes mid-pause
            // nobody will ever send Next, and the `should_stop` check at the top of the
            // node can't help — this task is parked inside `wait`, not between nodes.
            // Shutdown is watched for exactly the same reason.
            Some(tx) => tokio::select! {
                resume = stepper.wait() => resume,
                _ = tx.closed() => {
                    stepper.pausing = false;
                    Resume::Abandon
                }
                _ = crate::shutdown::stop_requested() => {
                    stepper.pausing = false;
                    Resume::Abandon
                }
            },
            None => tokio::select! {
                resume = stepper.wait() => resume,
                _ = crate::shutdown::stop_requested() => {
                    stepper.pausing = false;
                    Resume::Abandon
                }
            },
        }
    }
}

/// Flow execution engine
pub struct ExecutionEngine {
    http: HttpExecutor,
    assertions: AssertionEngine,
    pre_test: PreTestScriptEngine,
    debug_mode: bool,
    base_url: Option<String>,
    /// The process-wide stop flag, held rather than read from a static so a test can
    /// give an engine its own and never touch the one every other test is reading.
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ExecutionEngine {
    /// Create a new execution engine
    pub fn new(debug_mode: bool, base_url: Option<String>) -> Self {
        // Normalize base URL: remove trailing slash if present
        let base_url = base_url.map(|u| u.trim_end_matches('/').to_string());

        Self {
            http: HttpExecutor::new(),
            assertions: AssertionEngine::new(),
            pre_test: PreTestScriptEngine::new(),
            debug_mode,
            base_url,
            stop: crate::shutdown::flag(),
        }
    }

    /// Give this engine its own stop flag, so a test can raise one without touching the
    /// process-wide flag every other test is reading.
    #[cfg(test)]
    fn stopping_on(mut self, flag: std::sync::Arc<std::sync::atomic::AtomicBool>) -> Self {
        self.stop = flag;
        self
    }

    /// Build the full URL by prepending base_url to relative paths
    fn build_url(&self, endpoint: &str) -> String {
        // If endpoint already has a protocol, use it as-is
        if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
            return endpoint.to_string();
        }

        // Prepend base URL if available
        if let Some(ref base) = self.base_url {
            // Ensure proper joining (base has no trailing /, endpoint starts with /)
            if endpoint.starts_with('/') {
                format!("{}{}", base, endpoint)
            } else {
                format!("{}/{}", base, endpoint)
            }
        } else {
            // No base URL - return as-is (will fail with helpful error in http executor)
            endpoint.to_string()
        }
    }

    /// Execute a flow with optional event streaming, start to finish.
    pub async fn execute_flow(
        &self,
        execution_id: &str,
        flow: &Flow,
        tc_repo: &dyn TestCaseRepository,
        environment: HashMap<String, Value>,
        execution_vars: HashMap<String, Value>,
        event_tx: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<FlowExecutionResult, AppError> {
        self.run_flow(execution_id, flow, tc_repo, environment, execution_vars, event_tx, None)
            .await
    }

    /// The flow loop proper.
    ///
    /// `resume_rx` is `Some` when the author is driving the run a node at a time: one
    /// command per node, sent by `POST /executions/{id}/step`. See `Stepper`.
    pub async fn run_flow(
        &self,
        execution_id: &str,
        flow: &Flow,
        tc_repo: &dyn TestCaseRepository,
        environment: HashMap<String, Value>,
        execution_vars: HashMap<String, Value>,
        event_tx: Option<mpsc::Sender<ExecutionEvent>>,
        resume_rx: Option<mpsc::Receiver<StepCommand>>,
    ) -> Result<FlowExecutionResult, AppError> {
        let start = std::time::Instant::now();
        let flow_vars = flow.graph_data.variables.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut ctx = ExecutionContext::new(execution_vars, environment, flow_vars);

        // Find START node
        let start_node = flow.graph_data.nodes.iter()
            .find(|n| n.node_type == "start")
            .ok_or_else(|| AppError::BadRequest("Flow has no START node".to_string()))?;

        // Count executable nodes for progress
        let total_nodes = flow.graph_data.nodes.iter()
            .filter(|n| n.node_type == "testCase" || n.node_type == "group")
            .count();

        // Emit started event
        if let Some(tx) = &event_tx {
            let _ = tx.send(ExecutionEvent::Started {
                execution_id: execution_id.to_string(),
                flow_id: flow.id.clone(),
                total_nodes,
            }).await;
        }

        let mut state = RunState {
            tc_cache: HashMap::new(),
            results: Vec::new(),
            stats: ExecutionStats::default(),
            event_tx: &event_tx,
            stepper: resume_rx.map(Stepper::new),
            stop: self.stop.clone(),
        };

        // Execute graph starting from START node
        let final_status = self
            .traverse_and_execute(flow, &start_node.id, tc_repo, &mut ctx, &mut state)
            .await?;

        // Teardown: runs however the path above ended — passed, failed, or stopped
        // dead on an error. That is the whole point: an account created by a run
        // that then broke still has to be cleaned up.
        let produced = flow_produced_names(flow);
        for node in teardown_sequence(flow) {
            if node.node_type != "testCase" {
                continue;
            }
            // Cleanup is walked a node at a time too, but Stop here only stops the
            // *pausing*: the answer is deliberately discarded, so the remaining
            // teardown nodes run straight through rather than being abandoned. There
            // is no version of "cancel" that leaves the account behind.
            let _ = state.pause_before_next(&node.id).await;
            let mut result = self
                .execute_test_case_node(
                    node,
                    tc_repo,
                    &mut state.tc_cache,
                    &mut ctx,
                    state.event_tx,
                    Some(&produced),
                )
                .await;
            result.teardown = Some(true);
            // Counted in the total as well as in its verdict. Without this a teardown node
            // added to the pass/fail tallies while the denominator stayed behind, so a
            // flow with two cleanup nodes reported more errors than it had nodes — which
            // the run history then rendered as "0/14 passed · 18 errored".
            state.stats.total += 1;
            match result.status {
                NodeStatus::Passed => state.stats.passed += 1,
                NodeStatus::Failed => state.stats.failed += 1,
                NodeStatus::Error => state.stats.errors += 1,
                NodeStatus::Skipped => state.stats.skipped += 1,
            }
            if let Some(tx) = &event_tx {
                let _ = tx.send(ExecutionEvent::NodeCompleted {
                    node_id: node.id.clone(),
                    result: result.clone(),
                }).await;
            }
            state.results.push(result);
        }

        // The headline has to agree with the tally underneath it.
        //
        // `final_status` is whatever the last node's routing returned, which said "completed"
        // for a flow that had a failure three steps earlier — the run history said "failed"
        // about the same run, because it looks at the counts. Two answers about one run, and
        // the more visible one was the flattering one.
        //
        // "stopped" survives: the author or a shutdown ended the run, and how far it got is a
        // different fact from whether what ran was any good.
        let final_status = match final_status.as_str() {
            "stopped" => final_status,
            _ if state.stats.errors > 0 => "error".to_string(),
            _ if state.stats.failed > 0 => "failed".to_string(),
            _ => final_status,
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        // Emit completed event
        if let Some(tx) = &event_tx {
            let _ = tx.send(ExecutionEvent::Completed {
                execution_id: execution_id.to_string(),
                status: final_status.clone(),
                duration_ms,
                passed: state.stats.passed,
                failed: state.stats.failed,
                errors: state.stats.errors,
                skipped: state.stats.skipped,
            }).await;
        }

        Ok(FlowExecutionResult {
            execution_id: execution_id.to_string(),
            flow_id: flow.id.clone(),
            status: final_status,
            duration_ms,
            results: state.results,
            context: ctx.get_context().clone(),
            stats: state.stats,
        })
    }

    /// Traverse graph and execute nodes
    async fn traverse_and_execute(
        &self,
        flow: &Flow,
        current_node_id: &str,
        tc_repo: &dyn TestCaseRepository,
        ctx: &mut ExecutionContext,
        state: &mut RunState<'_>,
    ) -> Result<String, AppError> {
        let node = flow.graph_data.nodes.iter()
            .find(|n| n.id == current_node_id)
            .ok_or_else(|| AppError::Internal(format!("Node '{}' not found", current_node_id)))?;

        match node.node_type.as_str() {
            "start" => {
                // Find outgoing edge and continue
                if let Some(next_id) = self.find_next_node(flow, current_node_id, None) {
                    return Box::pin(self.traverse_and_execute(
                        flow, &next_id, tc_repo, ctx, state
                    )).await;
                }
                Ok("completed".to_string())
            }
            "end" => {
                // Reached end node
                Ok("completed".to_string())
            }
            "testCase" => {
                // Nobody is listening any more, so stop here instead of working through
                // the rest of the flow unobserved. Those nodes would still create
                // accounts, send messages and delete things, with every result going
                // nowhere. Teardown below is deliberately *not* guarded this way:
                // whatever this run already created still has to be cleaned up.
                if state.should_stop() {
                    return Ok("stopped".to_string());
                }

                // Wait here when the author is driving. Instant otherwise.
                if state.pause_before_next(&node.id).await == Resume::Abandon {
                    return Ok("stopped".to_string());
                }

                // Execute test case node
                let result = self.execute_test_case_node(
                    node, tc_repo, &mut state.tc_cache, ctx, state.event_tx, None
                ).await;

                let status = result.status.clone();
                state.stats.total += 1;
                match &status {
                    NodeStatus::Passed => state.stats.passed += 1,
                    NodeStatus::Failed => state.stats.failed += 1,
                    NodeStatus::Error => state.stats.errors += 1,
                    NodeStatus::Skipped => state.stats.skipped += 1,
                }

                // Emit node completed event
                if let Some(tx) = state.event_tx {
                    let _ = tx.send(ExecutionEvent::NodeCompleted {
                        node_id: node.id.clone(),
                        result: result.clone(),
                    }).await;
                }

                state.results.push(result);

                // Where a verdict sends the run.
                //
                // **A failure stops unless a `failure` edge says otherwise.** It used to route
                // like any other verdict, which meant falling through `pick_edge`'s chain —
                // exact type, then `default`, then untyped, then *the first edge* — and every
                // edge an author actually draws is untyped. So a failed step quietly continued
                // down the happy path.
                //
                // Nothing useful happens after that. The step that failed is usually the step
                // that was going to export an id, so what follows either fails for a second
                // reason or asserts against a value that never arrived. One root cause becomes
                // six red nodes.
                //
                // An **explicit** `failure` edge is the exception, and the only one: it is the
                // author saying they have a recovery path in mind. It is matched strictly, so
                // the fallback chain cannot conjure one out of an untyped edge.
                let next_id = match status {
                    NodeStatus::Error => return Ok("error".to_string()),
                    NodeStatus::Failed => match failure_edge(flow, current_node_id) {
                        Some(id) => Some(id),
                        None => return Ok("failed".to_string()),
                    },
                    // A pass, or a skip, keeps the lenient routing: untyped edges are how a
                    // flow is normally drawn, and they have to keep meaning "then this".
                    NodeStatus::Passed => self.find_next_node(flow, current_node_id, Some("success")),
                    NodeStatus::Skipped => self.find_next_node(flow, current_node_id, None),
                };

                if let Some(next_id) = next_id {
                    return Box::pin(self.traverse_and_execute(
                        flow, &next_id, tc_repo, ctx, state
                    )).await;
                }

                // No next node - determine final status
                match status {
                    NodeStatus::Failed => Ok("failed".to_string()),
                    _ => Ok("completed".to_string()),
                }
            }
            "group" => {
                // TODO: Implement nested flow execution
                // For now, skip group nodes
                if let Some(next_id) = self.find_next_node(flow, current_node_id, Some("success")) {
                    return Box::pin(self.traverse_and_execute(
                        flow, &next_id, tc_repo, ctx, state
                    )).await;
                }
                Ok("completed".to_string())
            }
            _ => {
                // Unknown node type, try to continue
                if let Some(next_id) = self.find_next_node(flow, current_node_id, None) {
                    return Box::pin(self.traverse_and_execute(
                        flow, &next_id, tc_repo, ctx, state
                    )).await;
                }
                Ok("completed".to_string())
            }
        }
    }

    /// Execute a test case node
    async fn execute_test_case_node(
        &self,
        node: &GraphNode,
        tc_repo: &dyn TestCaseRepository,
        tc_cache: &mut HashMap<String, TestCase>,
        ctx: &mut ExecutionContext,
        event_tx: &Option<mpsc::Sender<ExecutionEvent>>,
        // Set only for a teardown run: the names this flow produces, against which
        // the request is checked before anything is sent.
        teardown_guard: Option<&std::collections::HashSet<String>>,
    ) -> NodeResult {
        let start = std::time::Instant::now();
        let mut logs = Vec::new();

        // The canvas name for this node, when the author gave it one. Blank counts
        // as unnamed: an empty title would just erase the test case name downstream.
        let node_label = node.data.get("alias")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());

        // Extract test case ID from node data
        let tc_id = node.data.get("testCaseId")
            .or_else(|| node.data.get("test_case_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let tc_id = match tc_id {
            Some(id) => id,
            None => {
                return NodeResult {
                    node_label: node_label.clone(),
                    node_id: node.id.clone(),
                    teardown: None,
                    expected: None,
                    test_case_id: None,
                    test_case_name: None,
                    status: NodeStatus::Error,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request: None,
                    response: None,
                    exports: None,
                    env: None,
                    error_message: Some("Node missing testCaseId".to_string()),
                    logs,
                    row_index: None,
                    row_label: None,
                    attempts: None,
                    iterations_of: None,
                    iterations: None,
                };
            }
        };

        // Fetch test case (from cache or DB)
        let test_case = if let Some(tc) = tc_cache.get(&tc_id) {
            tc.clone()
        } else {
            match tc_repo.get_by_id(&tc_id).await {
                Ok(Some(tc)) => {
                    tc_cache.insert(tc_id.clone(), tc.clone());
                    tc
                }
                Ok(None) => {
                    return NodeResult {
                        node_label: node_label.clone(),
                        node_id: node.id.clone(),
                        teardown: None,
                        expected: None,
                        test_case_id: Some(tc_id),
                        test_case_name: None,
                        status: NodeStatus::Error,
                        duration_ms: start.elapsed().as_millis() as u64,
                        request: None,
                        response: None,
                        exports: None,
                        env: None,
                        error_message: Some("Test case not found".to_string()),
                        logs,
                        row_index: None,
                        row_label: None,
                        attempts: None,
                        iterations_of: None,
                        iterations: None,
                    };
                }
                Err(e) => {
                    return NodeResult {
                        node_label: node_label.clone(),
                        node_id: node.id.clone(),
                        teardown: None,
                        expected: None,
                        test_case_id: Some(tc_id),
                        test_case_name: None,
                        status: NodeStatus::Error,
                        duration_ms: start.elapsed().as_millis() as u64,
                        request: None,
                        response: None,
                        exports: None,
                        env: None,
                        error_message: Some(format!("Failed to fetch test case: {}", e)),
                        logs,
                        row_index: None,
                        row_label: None,
                        attempts: None,
                        iterations_of: None,
                        iterations: None,
                    };
                }
            }
        };

        // Emit node started event (now we have the test case name)
        if let Some(tx) = event_tx {
            let _ = tx.send(ExecutionEvent::NodeStarted {
                node_id: node.id.clone(),
                node_type: "testCase".to_string(),
                node_label: node_label.clone(),
                test_case_id: Some(tc_id.clone()),
                test_case_name: Some(test_case.name.clone()),
            }).await;
        }

        if self.debug_mode {
            logs.push(format!("Executing test case: {}", test_case.name));
        }

        // Inject node-level input variables (static per-node overrides from flow editor)
        let node_input_vars: HashMap<String, Value> = node.data
            .get("config")
            .and_then(|c| c.get("inputVars"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let key = item.get("key")?.as_str()?;
                        let val = item.get("value")?.as_str()?;
                        if key.is_empty() { return None; }
                        Some((key.to_string(), Value::String(val.to_string())))
                    })
                    .collect()
            })
            .unwrap_or_default();

        if self.debug_mode && !node_input_vars.is_empty() {
            for (k, v) in &node_input_vars {
                logs.push(format!("Node input var: {} = {:?}", k, v));
            }
        }
        ctx.set_node_input_vars(node_input_vars);

        // Teardown only: check what this request would be aimed at before sending
        // it. Checked *after* node input vars are set, so a value supplied on the
        // node counts as coming from the node.
        // Planned before the teardown guard, so the guard can inspect what a row would
        // actually send, and reused below rather than planned twice.
        // Once, once per data row, or once per item in a list — and never two of those.
        // The three-way toggle in the panel makes the last case unreachable, but config is
        // JSON and a hand-edited node must not quietly get one of them.
        let plan = match (for_each(node), fan_out(node) != FanOut::Off) {
            (Some(_), true) => RowPlan::NothingSelected(
                "This step is set to run both once per data row and once per item in a list. Open the node and pick one".to_string(),
            ),
            (Some(spec), false) => plan_items(&spec, &test_case, ctx, &mut logs),
            (None, _) => plan_rows(node, &test_case, &mut logs),
        };
        let walking_a_list = matches!(plan, RowPlan::Items(_));

        if let Some(produced) = teardown_guard {
            let row_templates: Vec<&str> = match &plan {
                RowPlan::Rows(rows) | RowPlan::Items(rows) => rows
                    .iter()
                    .flat_map(|(_, row)| {
                        [row.body_override(), row.path_suffix()].into_iter().flatten()
                    })
                    .collect(),
                _ => Vec::new(),
            };
            if let Some(reason) = teardown_blocked(&test_case, ctx, produced, &row_templates) {
                logs.push(reason.clone());
                return NodeResult {
                    node_id: node.id.clone(),
                    node_label,
                    teardown: Some(true),
                    expected: None,
                    test_case_id: Some(test_case.id.clone()),
                    test_case_name: Some(test_case.name.clone()),
                    status: NodeStatus::Skipped,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request: None,
                    response: None,
                    exports: None,
                    env: None,
                    error_message: Some(reason),
                    logs,
                    row_index: None,
                    row_label: None,
                    attempts: None,
                    iterations_of: None,
                    iterations: None,
                };
            }
        }

        // Accumulates SAT.env writes from pre-test + assertion scripts (persisted by the client)
        let mut env_writes: HashMap<String, Value> = HashMap::new();

        // Node-level outputVars merge with the test case's own exports. A row that
        // is only half filled in used to be dropped in silence, and the only symptom
        // was {{name}} arriving literally at some later node — so say so here.
        let mut node_output_vars: Vec<ExportVariable> = Vec::new();
        if let Some(rows) = node.data
            .get("config")
            .and_then(|c| c.get("outputVars"))
            .and_then(|v| v.as_array())
        {
            for row in rows {
                let field = |key: &str| {
                    row.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string()
                };
                let (name, path) = (field("name"), field("path"));
                match (name.is_empty(), path.is_empty()) {
                    (false, false) => node_output_vars
                        .push(ExportVariable { name, json_path: path }),
                    (false, true) => logs.push(format!(
                        "⚠ Output variable \"{}\" has no JSON path, so nothing was \
                         captured — {{{{{}}}}} will not resolve",
                        name, name
                    )),
                    (true, false) => logs.push(format!(
                        "⚠ Output variable with path {} has no name, so nothing was captured",
                        path
                    )),
                    // A blank row the author just added and hasn't filled in.
                    (true, true) => {}
                }
            }
        }

        // The name the author gave this step's collection, when it runs more than once.
        // Read here beside the fields it gathers, since one is meaningless without the other.
        let collect_into = node.data
            .get("config")
            .and_then(|c| c.get("collect"))
            .and_then(|c| c.get("into"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let collect_when = node.data
            .get("config")
            .and_then(|c| c.get("collect"))
            .and_then(|c| c.get("when"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        // This node's Expect, when the author gave it one.
        let node_check = node.data
            .get("config")
            .and_then(|c| c.get("check"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());

        // May this node have to ask more than once? A property of the node, like teardown
        // and fan-out — not a structure around it, because nothing iterates.
        let poll = poll_config(node);

        // Once, or once per data row? Decided here rather than in run_once, because a
        // fan-out sends N requests and run_once is the one-request cycle.
        let mut result = match plan {
            RowPlan::Once => {
                self.run_once(
                    &test_case,
                    None,
                    ctx,
                    RunOptions {
                        node_id: &node.id,
                        extra_exports: &node_output_vars,
                        node_check,
                        poll: poll.as_ref(),
                        watcher: event_tx.as_ref(),
                        // Was false here and true on the standalone path —
                        // unintentional drift. An unresolved {{var}} shipping as a
                        // literal is worth saying out loud wherever it happens; in a
                        // flow it is the likelier place, since the value was supposed
                        // to come from an earlier node.
                        report_unresolved: true,
                        row_index: None,
                        row_label: None,
                    },
                    logs,
                    &mut env_writes,
                    start,
                )
                .await
            }

            RowPlan::Rows(rows) | RowPlan::Items(rows) => {
                // A step that runs more than once gathers one record per run, under a name
                // the author gives it. Without that name there is nowhere to put the
                // records, and the old symptom returns: {{name}} arriving literally at a
                // later node, which is the failure mode this codebase keeps paying for.
                let collect = match (collect_into, node_output_vars.is_empty()) {
                    (Some(into), false) => Some(Collection {
                        into,
                        fields: &node_output_vars,
                        when: collect_when,
                    }),
                    (Some(into), true) => {
                        logs.push(format!(
                            "⚠ \"{}\" has no fields to collect — add output variable(s) naming what to take from each response",
                            into
                        ));
                        None
                    }
                    (None, false) => {
                        logs.push(format!(
                            "⚠ This step runs once per data row, so its output variable(s) {} need a list to be collected into — set \"Collect into\". Nothing was carried forward",
                            node_output_vars
                                .iter()
                                .map(|e| e.name.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ));
                        None
                    }
                    (None, true) => {
                        if collect_when.is_some() {
                            logs.push(
                                "⚠ A collect condition is set but nothing is being collected — set \"Collect into\" and the field(s) to take, or the condition does nothing"
                                    .to_string(),
                            );
                        }
                        None
                    }
                };
                if !test_case.exports.is_empty() {
                    logs.push(format!(
                        "⚠ \"{}\"'s own exports are captured per row but do not survive this step — rows are isolated",
                        test_case.name
                    ));
                }
                self.run_rows(
                    &test_case,
                    &rows,
                    ctx,
                    RowRunOptions {
                        node_id: &node.id,
                        extra_exports: &[],
                        collect,
                        node_check,
                        poll: poll.as_ref(),
                        watcher: event_tx.as_ref(),
                        // A flow node runs every row it selected: the flow is what
                        // satisfies them.
                        honour_needs_flow: false,
                    },
                    logs,
                    &mut env_writes,
                    start,
                )
                .await
            }

            RowPlan::NothingSelected(reason) => {
                logs.push(reason.clone());
                NodeResult {
                    node_id: node.id.clone(),
                    node_label: None,
                    teardown: None,
                    expected: None,
                    test_case_id: Some(test_case.id.clone()),
                    test_case_name: Some(test_case.name.clone()),
                    // Failed, not Error: nothing broke, the step was mis-configured —
                    // and Failed routes down the failure edge instead of ending the run.
                    status: NodeStatus::Failed,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request: None,
                    response: None,
                    exports: None,
                    env: None,
                    error_message: Some(reason),
                    logs,
                    row_index: None,
                    row_label: None,
                    attempts: None,
                    iterations_of: None,
                    iterations: None,
                }
            }
        };
        result.node_label = node_label;
        // What its child rows are, so nothing downstream says "2/2 rows passed" about a
        // step with no rows. Set here rather than in `run_rows`, which is shared by both
        // fan-out kinds and deliberately cannot tell them apart.
        if walking_a_list {
            result.iterations_of = Some("item".to_string());
        }
        result
    }

    /// Process exports from response using JSONPath
    fn process_exports(
        &self,
        test_case: &TestCase,
        node_exports: &[ExportVariable],
        json: &Option<Value>,
        ctx: &mut ExecutionContext,
        logs: &mut Vec<String>,
    ) -> Option<HashMap<String, Value>> {
        // Combine test case exports and node-level exports (node exports take precedence)
        let all_exports: Vec<&ExportVariable> = {
            let mut combined: Vec<&ExportVariable> = test_case.exports.iter().collect();
            // Node exports override test case exports with the same name
            for ne in node_exports {
                if !combined.iter().any(|e| e.name == ne.name) {
                    combined.push(ne);
                } else {
                    // Replace the test case export with the node export
                    combined.retain(|e| e.name != ne.name);
                    combined.push(ne);
                }
            }
            combined
        };

        if all_exports.is_empty() {
            return None;
        }

        let json = match json {
            Some(j) => j,
            None => {
                // Exports were configured against a body that isn't JSON. Silence
                // here reads as "extracted fine" and the names never resolve.
                logs.push(format!(
                    "⚠ Response is not JSON, so nothing was extracted for: {}",
                    all_exports.iter().map(|e| e.name.as_str()).collect::<Vec<_>>().join(", ")
                ));
                return None;
            }
        };

        let mut ignored = Vec::new();
        let exported =
            capture(&all_exports, json, CaptureKind::Export, self.debug_mode, logs, &mut ignored);
        for (name, value) in &exported {
            ctx.set(name, value.clone());
        }

        if exported.is_empty() {
            None
        } else {
            Some(exported)
        }
    }

    /// Find the next node to execute based on edge type
    /// The next node to run, stepping over any teardown node in the way.
    ///
    /// Teardown nodes are not part of the path — they run after it — but one may sit
    /// anywhere in the chain the author drew. Simply refusing to walk into it would
    /// end the traversal there and silently drop everything downstream, so the chain
    /// closes over the gap instead.
    fn find_next_node(&self, flow: &Flow, current_id: &str, preferred_type: Option<&str>) -> Option<String> {
        let is_marked = |id: &str| {
            flow.graph_data.nodes.iter().any(|n| n.id == id && is_teardown(n))
        };
        let mut from = current_id.to_string();
        // The node count bounds the walk: a cycle of teardown nodes can't spin here.
        for _ in 0..=flow.graph_data.nodes.len() {
            let target = self.pick_edge(flow, &from, preferred_type)?;
            if !is_marked(&target) {
                return Some(target);
            }
            from = target;
        }
        None
    }

    /// Which edge to take out of a node, ignoring what the target is.
    fn pick_edge(&self, flow: &Flow, current_id: &str, preferred_type: Option<&str>) -> Option<String> {
        let edges: Vec<_> = flow.graph_data.edges.iter()
            .filter(|e| e.source == current_id)
            .collect();

        if edges.is_empty() {
            return None;
        }

        // Edge routing rules:
        // 1. If preferred_type is specified, look for exact match first
        // 2. Then look for "default" type
        // 3. Then use any edge (first one)

        if let Some(ptype) = preferred_type {
            // Look for exact match
            if let Some(edge) = edges.iter().find(|e| {
                e.edge_type.as_ref().map(|t| t == ptype).unwrap_or(false)
            }) {
                return Some(edge.target.clone());
            }
        }

        // Look for default edge
        if let Some(edge) = edges.iter().find(|e| {
            e.edge_type.as_ref().map(|t| t == "default").unwrap_or(false)
        }) {
            return Some(edge.target.clone());
        }

        // Look for edge with no type (implicit default)
        if let Some(edge) = edges.iter().find(|e| e.edge_type.is_none()) {
            return Some(edge.target.clone());
        }

        // Fall back to first edge
        edges.first().map(|e| e.target.clone())
    }

    /// One pre-test → interpolate → HTTP → assert → export cycle.
    ///
    /// Shared by the standalone editor path (`execute_test_case`) and the flow-node
    /// path (`execute_test_case_node`) so the two cannot drift. `ctx` is mutated
    /// (pre-test vars, exports, SAT.env writes); `env_writes` accumulates the
    /// environment writes the client is expected to persist. `start` is passed in so
    /// the reported duration covers the caller's setup (e.g. fetching the test case).
    async fn run_once(
        &self,
        test_case: &TestCase,
        // The data row for this iteration, or None for a normal run.
        row: Option<&DataRow>,
        ctx: &mut ExecutionContext,
        opts: RunOptions<'_>,
        mut logs: Vec<String>,
        env_writes: &mut HashMap<String, Value>,
        start: std::time::Instant,
    ) -> NodeResult {
        // Every early exit reports the same identity; only the message and how far we
        // got differ. Each expansion returns, so moving `logs` repeatedly is fine.
        macro_rules! bail {
            ($msg:expr, $req:expr, $resp:expr) => {
                return NodeResult {
                    node_label: None,
                    node_id: opts.node_id.to_string(),
                    teardown: None,
                    expected: None,
                    test_case_id: Some(test_case.id.clone()),
                    test_case_name: Some(test_case.name.clone()),
                    status: NodeStatus::Error,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request: $req,
                    response: $resp,
                    exports: None,
                    env: None,
                    error_message: Some($msg),
                    logs,
                    row_index: opts.row_index,
                    row_label: opts.row_label.clone(),
                    attempts: None,
                    iterations_of: None,
                    iterations: None,
                }
            };
        }

        // Execute pre-test script if present (sets variables before interpolation)
        if let Some(ref script) = test_case.pre_test_script {
            if !script.trim().is_empty() {
                match self.pre_test.execute(script, &ctx.environment_snapshot()) {
                    Ok(outcome) => {
                        logs.extend(outcome.output);
                        for (k, v) in outcome.vars {
                            if self.debug_mode {
                                logs.push(format!("Pre-test set: {} = {:?}", k, v));
                            }
                            ctx.set(&k, v);
                        }
                        for (k, v) in outcome.env {
                            ctx.set_environment_var(&k, v.clone());
                            env_writes.insert(k, v);
                        }
                    }
                    Err(e) => bail!(format!("Pre-test script failed: {}", plain(&e)), None, None),
                }
            }
        }

        // The endpoint this row asks for — the test case's, plus the row's own suffix.
        // Composed once here and used by the interpolation *and* every diagnostic
        // below, so a row's {{org}} is visible to all of them.
        let endpoint_template = resolve_endpoint(row, test_case);

        // Interpolate endpoint URL and prepend base URL if needed
        // Interpolated like `check` is, so a node or row variable can supply a value.
        // Falls back to the literal when a name does not resolve, matching what `check` does
        // rather than failing the request over a placeholder.
        let interpolated_until = opts
            .poll
            .map(|p| ctx.interpolate(&p.until).unwrap_or_else(|_| p.until.clone()))
            .unwrap_or_default();

        let endpoint = match ctx.interpolate(&endpoint_template) {
            Ok(u) => u,
            Err(e) => bail!(format!("URL interpolation failed: {}", e), None, None),
        };
        let url = self.build_url(&endpoint);

        if self.debug_mode {
            logs.push(format!("URL: {} {}", test_case.method, url));
        }

        // Convert headers from JSON Value to HashMap
        let mut headers = HashMap::new();
        if let Some(obj) = test_case.headers.as_object() {
            for (key, value) in obj {
                if let Some(v) = value.as_str() {
                    if let (Ok(k), Ok(val)) = (ctx.interpolate(key), ctx.interpolate(v)) {
                        headers.insert(k, val);
                    }
                }
            }
        }

        // Interpolate payload (body)
        // A data row may supply its own body; otherwise the test case's payload is
        // used. Either way it is interpolated, so {{variables}} work in both.
        let body = match resolve_body(row, test_case) {
            Some(payload_str) => match ctx.interpolate(payload_str) {
                Ok(interpolated) => Some(interpolated),
                Err(e) => bail!(format!("Payload interpolation failed: {}", e), None, None),
            },
            None => None,
        };

        // Variables that never resolved go out as literal "{{name}}" text — usually
        // the real cause of a puzzling 4xx. Say so instead of failing silently.
        if opts.report_unresolved {
            let unresolved = find_unresolved(&url, &headers, body.as_deref());
            if !unresolved.is_empty() {
                logs.push(format!(
                    "⚠ Unresolved variable(s) sent literally: {}",
                    unresolved.join(", ")
                ));
            }

            // A name that resolved to the text "null" looks fine in the request and
            // is invisible to the check above — it resolved. Almost always a
            // leftover in Globals or an environment. Read from the templates, since
            // by now the value is indistinguishable from a legitimate "null".
            let mut placeholders: Vec<String> = ctx.placeholder_values(&endpoint_template);
            if let Some(map) = test_case.headers.as_object() {
                for value in map.values() {
                    if let Some(text) = value.as_str() {
                        placeholders.extend(ctx.placeholder_values(text));
                    }
                }
            }
            if let Some(template) = resolve_body(row, test_case) {
                placeholders.extend(ctx.placeholder_values(template));
            }
            placeholders.sort();
            placeholders.dedup();
            if !placeholders.is_empty() {
                logs.push(format!(
                    "⚠ Variable(s) resolved to the text \"null\": {} — check Globals and \
                     the active environment for a leftover value",
                    placeholders.join(", ")
                ));
            }
        }

        // In debug mode, say where each {{name}} came from. A value that resolves
        // from the environment when this run was supposed to produce it looks
        // completely normal in the request — it is the one failure no warning can
        // detect, so the answer is to show the tier and let the author see it.
        if self.debug_mode {
            let mut seen: Vec<String> = Vec::new();
            let mut templates: Vec<&str> = vec![endpoint_template.as_ref()];
            if let Some(map) = test_case.headers.as_object() {
                templates.extend(map.values().filter_map(|v| v.as_str()));
            }
            if let Some(body_template) = resolve_body(row, test_case) {
                templates.push(body_template);
            }
            for template in templates {
                for (name, source, value) in ctx.provenance(template) {
                    if seen.contains(&name) {
                        continue;
                    }
                    seen.push(name.clone());
                    logs.push(format!("{} ← {} = {}", name, source.label(), value));
                }
            }
        }

        // Capture request info before executing (for debugging even on failure)
        let request_log = RequestLog {
            method: test_case.method.clone(),
            url: url.clone(),
            headers: headers.clone(),
            body: body.clone(),
        };

        // Execute HTTP request.
        //
        // Wrapped in an attempt loop when the node polls. Only the *send* is repeated: the
        // verdict cascade and the exports below run once, against the final response. A
        // verdict evaluated per attempt would report the first "pending" as a failure, and
        // exports run per attempt would fire three times.
        let body_type = test_case.body_type.as_deref().map(BodyType::parse).unwrap_or_default();
        let mut attempts: usize = 0;
        let poll_deadline = opts
            .poll
            .map(|p| std::time::Instant::now() + std::time::Duration::from_millis(p.timeout_ms));

        // Set when the poll ran out of budget or was cut short. A poll that never settled
        // has no outcome, and that is not the same as a request that failed — so it is
        // carried to the verdict rather than decided here.
        let mut poll_unsettled: Option<String> = None;
        let http_result = loop {
            attempts += 1;
            let sent = match self
                .http
                .execute(&test_case.method, &url, &headers, body.as_deref(), body_type)
                .await
            {
                Ok(r) => r,
                Err(e) => bail!(
                    format!("HTTP request failed: {}", e),
                    Some(request_log),
                    None
                ),
            };

            let Some(poll) = opts.poll else { break sent };
            let status = sent.response.status;

            // One line per attempt with the polled values. `0/2 → 1/2 → 2/2` is exactly what
            // an author debugging a slow upload wants, and a node that gave up shows every
            // attempt it made.
            logs.push(format!(
                "poll attempt {}: {} {}",
                attempts,
                status,
                summarise_body(&sent.response.body)
            ));

            // A 404 means the id is wrong and a 401 means the token expired. Neither
            // improves by asking again, so retrying for the whole budget would waste the
            // wait and bury the reason.
            if (400..500).contains(&status) {
                logs.push(format!(
                    "stopped polling: {} will not change on a retry — check the id the \
                     earlier step exported",
                    status
                ));
                break sent;
            }

            match self.assertions.evaluate(AssertionInput {
                script: &interpolated_until,
                status,
                body: &sent.response.body,
                json: &sent.response.json,
                headers: &sent.response.headers,
                env: &ctx.environment_snapshot(),
            }) {
                Ok(outcome) => match outcome.passed {
                    Some(true) => {
                        logs.push(format!("settled after {} attempt(s)", attempts));
                        break sent;
                    }
                    Some(false) => {}
                    // Not a boolean at all. Waiting out the budget would only delay a report
                    // about the author's expression, same as `check` refuses a non-boolean.
                    // Not a boolean at all — an assignment, or a value. Waiting out the
                    // budget would only delay a report about the author's expression, the
                    // same refusal `check` already makes.
                    None => bail!(
                        "\"until\" must be an expression that is true or false".to_string(),
                        Some(request_log),
                        Some(sent.response)
                    ),
                },
                Err(e) => {
                    // An `until` that cannot be evaluated is the author's mistake and will
                    // not fix itself, so waiting out the budget would only delay the report.
                    bail!(
                        format!("\"until\" could not be evaluated: {}", plain(&e)),
                        Some(request_log),
                        Some(sent.response)
                    );
                }
            }

            let out_of_time = poll_deadline.is_some_and(|d| std::time::Instant::now() >= d);
            if out_of_time {
                // Failed, never Error: the request worked every time — the wait ran out.
                // `Error` would abort the flow and claim something systemic went wrong,
                // which is a different and worse story.
                let reason = format!(
                    "gave up after {} attempt(s) — \"until\" never became true within {}ms",
                    attempts, poll.timeout_ms
                );
                logs.push(reason.clone());
                poll_unsettled = Some(reason);
                break sent;
            }

            tokio::time::sleep(std::time::Duration::from_millis(poll.interval_ms)).await;

            // Between attempts is a boundary like any other: a run nobody is watching, or a
            // process going down, must not keep polling for two minutes.
            if self.stop.load(std::sync::atomic::Ordering::Relaxed) || opts.unwatched() {
                let reason = format!(
                    "stopped polling after {} attempt(s): the run was abandoned before \
                     \"until\" became true",
                    attempts
                );
                logs.push(reason.clone());
                poll_unsettled = Some(reason);
                break sent;
            }
        };

        if self.debug_mode {
            logs.push(format!("Response status: {}", http_result.response.status));
        }

        // One line per request at info level. Without this the server is silent
        // during a run: tower-http's TraceLayer only logs at debug, and no handler
        // logs anything.
        let row_note = opts
            .row_label
            .as_deref()
            .map(|l| format!(" [{}]", l))
            .unwrap_or_default();
        info!(
            "{} {} -> {} ({}ms){}",
            test_case.method,
            url,
            http_result.response.status,
            start.elapsed().as_millis(),
            row_note
        );

        // Run assertions. On failure we record *why*, so the console shows a reason
        // instead of a bare "failed".
        let mut assertion_failure: Option<String> = None;
        let status_code = http_result.response.status;

        // Where the verdict comes from, most specific first:
        //
        //  * a dataset row's Expect,
        //  * else this node's Expect (its role in the flow: 202 here, 402 there),
        //  * else the test case's post-test script.
        //
        // The first two stand alone — the shared script does not run for them. The
        // author has said what should be true for this row or this step, and a
        // script written for the request in isolation can neither decide nor break
        // it. Nothing is lost: output variables run either way, and an Expect can
        // capture for itself.
        // A row's Expect wins; when a row hasn't stated one, this node's applies. That
        // middle step is what lets one dataset serve two scenarios: the rows describe
        // the request, and the node says what its actor should get back — a listing that
        // is 200 for a super user and 403 for an org admin.
        let stated_check: Option<(Option<String>, &str)> = match row {
            Some(data_row) => Some(match data_row.check_expr() {
                Some(expr) => (Some(expr.to_string()), "This row's check"),
                None => (opts.node_check.map(str::to_string), "This node's check"),
            }),
            None => opts.node_check.map(|c| (Some(c.to_string()), "This node's check")),
        };

        // A check is interpolated, like the URL, headers and body already are — it was
        // the one string that wasn't. That's what lets a row state the shape of the
        // truth once and each node supply the actor's value:
        //
        // response.json.items.len() == {{expected_count}}
        //
        // Strings keep the body convention: `response.json.org == "{{org_id}}"`. An
        // unresolved name stays literal, so the ⚠ warning fires rather than the check
        // quietly comparing against nothing.
        let own_check = stated_check.map(|(raw, what)| {
            (raw.map(|text| ctx.interpolate(&text).unwrap_or(text)), what)
        });

        // What was required, in the words the author would recognise. Kept beside the
        // verdict so the two can't disagree.
        // No initialiser: every path through the verdict below states what was required,
        // and the compiler is a better guarantee of that than a `None` default which would
        // silently mean "nothing was expected" if a path ever forgot.
        let expected: Option<String>;

        // A poll that never settled has nothing to judge, so the cascade must not run.
        // The last response is mid-flight by definition, and a 202 satisfies the default
        // 2xx check — reporting "passed" on an upload whose outcome nobody waited for is
        // exactly the dishonest green this feature exists to remove.
        let assertion_passed = if let Some(reason) = poll_unsettled {
            expected = Some(format!("\"until\" to become true: {}", interpolated_until));
            assertion_failure = Some(reason);
            false
        } else {
            match own_check {
                Some((ref raw, what)) => {
                    expected = Some(match parse_check(raw.as_deref()) {
                        Check::Status(code) => format!("HTTP {}", code),
                        Check::Expr(expr) => expr.to_string(),
                        Check::Unstated => "any 2xx".to_string(),
                    });
                    let passed = match parse_check(raw.as_deref()) {
                        Check::Status(expected) => {
                            let ok = status_code == expected;
                            if !ok {
                                assertion_failure =
                                    Some(format!("Expected HTTP {}, got {}", expected, status_code));
                            }
                            ok
                        }
                        Check::Expr(expr) => match self.assertions.evaluate(AssertionInput {
                            script: expr,
                            status: status_code,
                            body: &http_result.response.body,
                            json: &http_result.response.json,
                            headers: &http_result.response.headers,
                            env: &ctx.environment_snapshot(),
                        }) {
                            Ok(outcome) => {
                                logs.extend(outcome.output);
                                // A check may capture on its way to a verdict.
                                for (k, v) in outcome.vars {
                                    ctx.set(&k, v);
                                }
                                for (k, v) in outcome.env {
                                    ctx.set_environment_var(&k, v.clone());
                                    env_writes.insert(k, v);
                                }
                                match outcome.passed {
                                    Some(true) => true,
                                    Some(false) => {
                                        assertion_failure = Some(format!(
                                            "Check returned false: {}  (actual: HTTP {})",
                                            last_expression(expr), status_code
                                        ));
                                        false
                                    }
                                    // Not a yes/no answer — say so rather than guessing.
                                    None => {
                                        assertion_failure = Some(format!(
                                            "{} must be a status code or an expression that is \
                                             true or false — got: {}",
                                            what,
                                            last_expression(expr)
                                        ));
                                        false
                                    }
                                }
                            }
                            Err(e) => bail!(
                                format!("{} could not run: {}", what, plain(&e)),
                                Some(http_result.request),
                                Some(http_result.response)
                            ),
                        },
                        Check::Unstated => {
                            let ok = AssertionEngine::default_assertion(status_code);
                            if !ok {
                                assertion_failure = Some(format!(
                                    "No check given, so a 2xx was required — got HTTP {}",
                                    status_code
                                ));
                            }
                            ok
                        }
                    };
                    if let Some(ref reason) = assertion_failure {
                        logs.push(reason.clone());
                    }
                    passed
                }
                None => {
                    // Post-test script: runs for its side effects (SAT.vars / SAT.env)
                    // and decides the verdict when it ends in a boolean.
                    let mut script_verdict: Option<bool> = None;
                    let script = shared_script(test_case);
                    if let Some(script) = script {
                        match self.assertions.evaluate(AssertionInput {
                            script,
                            status: status_code,
                            body: &http_result.response.body,
                            json: &http_result.response.json,
                            headers: &http_result.response.headers,
                            env: &ctx.environment_snapshot(),
                        }) {
                            Ok(outcome) => {
                                script_verdict = outcome.passed;
                                logs.extend(outcome.output);
                                for (k, v) in outcome.vars {
                                    ctx.set(&k, v);
                                }
                                for (k, v) in outcome.env {
                                    ctx.set_environment_var(&k, v.clone());
                                    env_writes.insert(k, v);
                                }
                            }
                            // The script couldn't run at all — a defect in the test, not
                            // a failed check. Don't persist whatever it wrote before
                            // throwing: half-captured values poison later runs.
                            Err(e) => bail!(
                                format!("Post-test script could not run: {}", plain(&e)),
                                Some(http_result.request),
                                Some(http_result.response)
                            ),
                        }
                    }

                    expected = Some(match script_verdict {
                        // What the script's last expression asserted.
                        Some(_) => last_expression(script.unwrap_or("")).to_string(),
                        // A capture-only script leaves the verdict to the 2xx rule.
                        None => "any 2xx".to_string(),
                    });

                    match script_verdict {
                        Some(verdict) => {
                            if !verdict {
                                let reason = format!(
                                    "Assertion returned false: {}  (actual: HTTP {})",
                                    last_expression(script.unwrap_or("")), status_code
                                );
                                logs.push(reason.clone());
                                assertion_failure = Some(reason);
                            }
                            verdict
                        }
                        // No boolean to judge by — a capture-only script is legitimate —
                        // so fall back to the same rule a dataset row uses.
                        None => {
                            let ok = AssertionEngine::default_assertion(status_code);
                            if !ok {
                                let reason = format!(
                                    "Assertion failed: expected a 2xx status, got HTTP {}",
                                    status_code
                                );
                                logs.push(reason.clone());
                                assertion_failure = Some(reason);
                            }
                            ok
                        }
                    }
                }
            }
        };

        // Process exports only if the assertion passed
        let exports = if assertion_passed {
            self.process_exports(
                test_case,
                opts.extra_exports,
                &http_result.response.json,
                ctx,
                &mut logs,
            )
        } else {
            None
        };

        NodeResult {
            node_label: None,
            node_id: opts.node_id.to_string(),
            teardown: None,
            test_case_id: Some(test_case.id.clone()),
            test_case_name: Some(test_case.name.clone()),
            status: if assertion_passed { NodeStatus::Passed } else { NodeStatus::Failed },
            expected,
            duration_ms: start.elapsed().as_millis() as u64,
            request: Some(http_result.request),
            response: Some(http_result.response),
            exports,
            env: if env_writes.is_empty() { None } else { Some(env_writes.clone()) },
            error_message: assertion_failure,
            logs,
            row_index: opts.row_index,
            row_label: opts.row_label,
            // Only when it polled. A node that asked once says nothing, so the report reads
            // unchanged for every request that is not multi-staged.
            attempts: opts.poll.map(|_| attempts),
            iterations_of: None,
            iterations: None,
        }
    }

    /// Run a test case once per data row and return one aggregate result whose
    /// `iterations` holds the per-row results.
    ///
    /// Each row gets a *clone* of the base context so exports and pre-test vars
    /// can't leak between rows — but `SAT.env` writes are folded forward, so a
    /// later row does see what an earlier one persisted. Rows run sequentially and
    /// a failing row never stops the rest.
    pub async fn execute_test_case_dataset(
        &self,
        test_case: &TestCase,
        environment: HashMap<String, Value>,
        variables: HashMap<String, Value>,
    ) -> NodeResult {
        let start = std::time::Instant::now();
        let rows: Vec<(usize, DataRow)> = test_case
            .dataset
            .as_ref()
            .map(|d| d.rows.iter().cloned().enumerate().collect())
            .unwrap_or_default();

        let mut base_ctx = ExecutionContext::new(variables, environment, HashMap::new());
        let mut env_writes: HashMap<String, Value> = HashMap::new();

        self.run_rows(
            test_case,
            &rows,
            &mut base_ctx,
            RowRunOptions {
                node_id: "direct",
                extra_exports: &[],
                // Nothing downstream to hand a collection to: this is the editor's own
                // "Run dataset", with no node to configure and no next step.
                collect: None,
                node_check: None,
                honour_needs_flow: true,
                // The editor's own run has no stream to lose and does not poll: polling
                // lives on the node, so "Run request" sends exactly once.
                poll: None,
                watcher: None,
            },
            Vec::new(),
            &mut env_writes,
            start,
        )
        .await
    }

    /// Run one request per row against `base_ctx`, folded into one aggregate result
    /// whose `iterations` holds the per-row results.
    ///
    /// Each row gets a *clone* of the base context, so exports and pre-test vars can't
    /// leak between rows while every row still sees whatever the caller's context
    /// already holds — which is how a row inherits an earlier node's JWT. `SAT.env`
    /// writes are folded forward, so a later row does see what an earlier one
    /// persisted. Rows run sequentially and a failing row never stops the rest.
    ///
    /// Rows carry their index *in the dataset*, so a selected subset is still labelled
    /// and ordered the way the editor's matrix shows it.
    ///
    /// Deliberately sequential: the `SAT.env` fold is order-dependent, and the Rhai
    /// engines share a thread-local `print()` sink (`execution/script_log.rs`), so
    /// concurrent rows would file their output under the wrong result.
    async fn run_rows(
        &self,
        test_case: &TestCase,
        rows: &[(usize, DataRow)],
        base_ctx: &mut ExecutionContext,
        opts: RowRunOptions<'_>,
        logs: Vec<String>,
        env_writes: &mut HashMap<String, Value>,
        start: std::time::Instant,
    ) -> NodeResult {
        let mut iterations: Vec<NodeResult> = Vec::with_capacity(rows.len());
        let mut logs = logs;
        let mut records: Vec<Value> = Vec::new();
        let mut tally = CollectTally::default();

        info!("Running \"{}\" over {} data row(s)", test_case.name, rows.len());

        for (index, row) in rows {
            let label = crate::db::models::Dataset::label_for(*index, row);

            // Two reasons a row isn't sent, and they are not the same thing. `disabled`
            // means the row is parked and nobody runs it; `needs_flow` means only the
            // editor can't satisfy it, and a flow node runs it happily. Either way it is
            // reported — a row you didn't run is a row you should be able to see you
            // didn't run.
            let parked = if row.disabled {
                Some("Disabled — this row is parked and runs nowhere until you enable it")
            } else if opts.honour_needs_flow && row.needs_flow {
                Some("Needs a flow — \"Run dataset\" has no earlier steps to satisfy it. Run it from a flow node instead")
            } else {
                None
            };

            if let Some(reason) = parked {
                let reason = reason.to_string();
                iterations.push(NodeResult {
                    node_id: opts.node_id.to_string(),
                    node_label: None,
                    teardown: None,
                    expected: None,
                    test_case_id: Some(test_case.id.clone()),
                    test_case_name: Some(test_case.name.clone()),
                    status: NodeStatus::Skipped,
                    duration_ms: 0,
                    request: None,
                    response: None,
                    exports: None,
                    env: None,
                    error_message: Some(reason.clone()),
                    logs: vec![reason],
                    row_index: Some(*index),
                    row_label: Some(label),
                    attempts: None,
                    iterations_of: None,
                    iterations: None,
                });
                continue;
            }

            let mut row_ctx = base_ctx.clone();
            // This row's own values for the request's `{{names}}`. Set on the clone, so
            // one row's channel cannot reach the next — the same reason the clone exists.
            if !row.vars.is_empty() {
                row_ctx.set_row_vars(
                    row.vars
                        .iter()
                        .filter(|(name, value)| !name.trim().is_empty() && !value.trim().is_empty())
                        .map(|(name, value)| (name.clone(), Value::String(value.clone())))
                        .collect(),
                );
            }
            let mut row_env: HashMap<String, Value> = HashMap::new();

            let result = self
                .run_once(
                    test_case,
                    Some(row),
                    &mut row_ctx,
                    RunOptions {
                        node_id: opts.node_id,
                        node_check: opts.node_check,
                        extra_exports: opts.extra_exports,
                        report_unresolved: true,
                        row_index: Some(*index),
                        row_label: Some(label.clone()),
                        // Passed through, not dropped: a fan-out node's rows each poll,
                        // because the node is what says the request is multi-staged.
                        poll: opts.poll,
                        watcher: opts.watcher,
                    },
                    Vec::new(),
                    &mut row_env,
                    std::time::Instant::now(),
                )
                .await;

            // Carry SAT.env writes forward to later rows and out to the caller.
            for (k, v) in row_env {
                base_ctx.set_environment_var(&k, v.clone());
                env_writes.insert(k, v);
            }

            // One record per run, gathered here rather than inside `run_once`, because the
            // row's own context is a clone about to be dropped and the whole point is to
            // reach a *later* step. Only a run that passed contributes: an id from a
            // request that failed is not an id anything can be verified against.
            if let Some(collection) = &opts.collect {
                // Passing is the floor, not the bar. `when` is the bar when the author set one.
                let produced = result.status == NodeStatus::Passed
                    && match (collection.when, &result.response) {
                        (None, _) => true,
                        (Some(cond), Some(response)) => {
                            // Interpolated like `check` and `until`, so a condition can name a
                            // value the node or the row supplies. An unusable template is the
                            // condition being broken, same as an unusable expression.
                            let cond = match row_ctx.interpolate(cond) {
                                Ok(text) => text,
                                Err(e) => {
                                    tally.broken = Some(e.to_string());
                                    iterations.push(result);
                                    continue;
                                }
                            };
                            match self.assertions.evaluate(AssertionInput {
                                script: &cond,
                                status: response.status,
                                body: &response.body,
                                json: &response.json,
                                headers: &response.headers,
                                env: &base_ctx.environment_snapshot(),
                            }) {
                                Ok(outcome) => match outcome.passed {
                                    Some(true) => true,
                                    Some(false) => {
                                        tally.unmet.push(label.clone());
                                        false
                                    }
                                    // Neither true nor false is a broken condition, not a
                                    // verdict. Said once (see `CollectTally::lines`) and treated
                                    // as "did not produce", so the collection ends up absent and
                                    // the consuming step fails naming it — rather than the tool
                                    // guessing what the author meant.
                                    None => {
                                        tally.broken = Some(format!(
                                            "must be true or false, and \"{}\" is neither",
                                            cond
                                        ));
                                        false
                                    }
                                },
                                Err(e) => {
                                    tally.broken = Some(e.to_string());
                                    false
                                }
                            }
                        }
                        // No response to judge — nothing was produced either way.
                        (Some(_), None) => false,
                    };

                if produced {
                    let mut notes = Vec::new();
                    if let Some(rec) = record(
                        collection.fields,
                        result.response.as_ref().and_then(|r| r.json.as_ref()),
                        &label,
                        self.debug_mode,
                        &mut notes,
                        &mut tally,
                    ) {
                        records.push(rec);
                    }
                    logs.extend(notes.into_iter().map(|n| format!("[{}] {}", label, n)));
                }
            }

            iterations.push(result);
        }

        // No rows at all would fold to `Passed` having sent nothing — the worst kind of
        // green. Neither caller should reach this, which is why it's worth stating.
        if iterations.is_empty() {
            logs.push("No data rows to run".to_string());
            return NodeResult {
                node_id: opts.node_id.to_string(),
                teardown: None,
                expected: None,
                node_label: None,
                test_case_id: Some(test_case.id.clone()),
                test_case_name: Some(test_case.name.clone()),
                status: NodeStatus::Failed,
                duration_ms: start.elapsed().as_millis() as u64,
                request: None,
                response: None,
                exports: None,
                env: None,
                error_message: Some("No data rows to run".to_string()),
                logs,
                row_index: None,
                row_label: None,
                attempts: None,
                iterations_of: None,
                iterations: Some(Vec::new()),
            };
        }

        let failed = iterations.iter().filter(|r| r.status == NodeStatus::Failed).count();
        let errored = iterations.iter().filter(|r| r.status == NodeStatus::Error).count();
        let skipped = iterations.iter().filter(|r| r.status == NodeStatus::Skipped).count();
        // Nothing was sent, so there is nothing to be green about. The fold below counts
        // only Failed and Error, which would otherwise call a dataset of entirely parked
        // rows a pass — the same "worst kind of green" the empty case above guards
        // against, and easy to reach once rows can be parked while a dataset is reworked.
        let nothing_ran = skipped == iterations.len();
        let status = if nothing_ran {
            NodeStatus::Skipped
        } else if errored > 0 {
            NodeStatus::Error
        } else if failed > 0 {
            NodeStatus::Failed
        } else {
            NodeStatus::Passed
        };
        let not_passed = failed + errored;
        let error_message = if nothing_ran {
            Some(format!(
                "No rows ran — all {} are parked or need a flow",
                iterations.len()
            ))
        } else {
            (not_passed > 0)
                .then(|| format!("{} of {} rows did not pass", not_passed, iterations.len()))
        };
        info!(
            "\"{}\" finished: {} of {} rows passed{} ({}ms)",
            test_case.name,
            iterations.len() - not_passed - skipped,
            iterations.len(),
            // "not run" rather than "needed a flow": a skipped row is now either parked
            // or waiting on a flow, and each row's own message says which.
            if skipped > 0 { format!(", {} not run", skipped) } else { String::new() },
            start.elapsed().as_millis()
        );

        // Hand the collection to the steps after this one.
        //
        // Absent rather than empty when nothing was captured: "no variable named launched"
        // is something the consuming step can explain and point at, while an empty list
        // reads as "the API returned nothing" — a different bug with a different fix.
        let collected = opts.collect.as_ref().and_then(|c| {
            if records.is_empty() {
                logs.push(format!(
                    "⚠ Nothing was collected into \"{}\", so {{{{{}}}}} will not resolve — \
                     no run produced any of its fields",
                    c.into, c.into
                ));
                logs.extend(tally.lines(c.into, iterations.len()));
                None
            } else {
                logs.push(format!(
                    "Collected into \"{}\": {} record(s) from {} row(s)",
                    c.into,
                    records.len(),
                    iterations.len()
                ));
                logs.extend(tally.lines(c.into, iterations.len()));
                let value = Value::Array(std::mem::take(&mut records));
                base_ctx.set(c.into, value.clone());
                Some(HashMap::from([(c.into.to_string(), value)]))
            }
        });

        // The caller's own notes first, unprefixed; then each row's, prefixed, so a flat
        // log view still says which row spoke.
        logs.extend(iterations.iter().flat_map(|r| {
            let label = r.row_label.clone().unwrap_or_default();
            r.logs.iter().map(move |l| format!("[{}] {}", label, l))
        }));

        NodeResult {
            node_id: opts.node_id.to_string(),
            teardown: None,
            expected: None,
            // Set by the flow path, which knows the node; a dataset run from the editor
            // has no node to name.
            node_label: None,
            test_case_id: Some(test_case.id.clone()),
            test_case_name: Some(test_case.name.clone()),
            status,
            duration_ms: start.elapsed().as_millis() as u64,
            // Deliberately None: an aggregate has no single request/response, and
            // the UI branches on `iterations` to render the per-row matrix.
            request: None,
            response: None,
            // The collection, when the author named one. A row's *own* exports still die
            // with the row — see the note at the `RowPlan::Rows` arm.
            exports: collected,
            env: if env_writes.is_empty() { None } else { Some(env_writes.clone()) },
            error_message,
            logs,
            row_index: None,
            row_label: None,
            attempts: None,
            iterations_of: None,
            iterations: Some(iterations),
        }
    }

    /// Execute a single test case directly (without flow context)
    /// Used for testing individual test cases from the editor
    pub async fn execute_test_case(
        &self,
        test_case: &TestCase,
        environment: HashMap<String, Value>,
        variables: HashMap<String, Value>,
    ) -> NodeResult {
        let start = std::time::Instant::now();
        let mut logs = Vec::new();
        let mut ctx = ExecutionContext::new(variables, environment, HashMap::new());

        // Accumulates SAT.env writes from pre-test + assertion scripts (persisted by the client)
        let mut env_writes: HashMap<String, Value> = HashMap::new();

        if self.debug_mode {
            logs.push(format!("Executing test case: {}", test_case.name));
        }

        self.run_once(
            test_case,
            None,
            &mut ctx,
            RunOptions {
                node_id: "direct",
                node_check: None,
                extra_exports: &[],
                report_unresolved: true,
                row_index: None,
                row_label: None,
                poll: None,
                watcher: None,
            },
            logs,
            &mut env_writes,
            start,
        )
        .await
    }
}

impl Default for ExecutionEngine {
    fn default() -> Self {
        Self::new(false, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dataset_of(rows: Vec<(&str, Option<&str>, Option<&str>)>) -> crate::db::models::Dataset {
        crate::db::models::Dataset {
            rows: rows
                .into_iter()
                .enumerate()
                .map(|(i, (name, body, status))| DataRow {
                    path: None,
                    needs_flow: false,
                    disabled: false,
                    vars: Default::default(),
                    id: format!("r{}", i),
                    name: Some(name.to_string()),
                    body: body.map(str::to_string),
                    check: status.map(str::to_string),
                })
                .collect(),
        }
    }

    #[test]
    fn test_resolve_body_prefers_the_row() {
        let mut tc = make_test_case("t1", "T", "/x", "POST");
        tc.payload = Some(r#"{"shared":true}"#.to_string());

        // No row, or a row that gave no body: the test case's payload is used.
        assert_eq!(resolve_body(None, &tc), Some(r#"{"shared":true}"#));
        let bare = DataRow::default();
        assert_eq!(resolve_body(Some(&bare), &tc), Some(r#"{"shared":true}"#));
        let blank = DataRow { body: Some("   ".into()), ..Default::default() };
        assert_eq!(resolve_body(Some(&blank), &tc), Some(r#"{"shared":true}"#));

        // A row with a body replaces it.
        let own = DataRow { body: Some("{}".into()), ..Default::default() };
        assert_eq!(resolve_body(Some(&own), &tc), Some("{}"));
    }

    #[test]
    fn test_shared_script_ignores_blanks() {
        let mut tc = make_test_case("t1", "T", "/x", "POST");
        assert_eq!(shared_script(&tc), None);

        tc.assertion_script = Some("   ".to_string());
        assert_eq!(shared_script(&tc), None, "whitespace-only is not a script");

        tc.assertion_script = Some(" response.status == 200 ".to_string());
        assert_eq!(shared_script(&tc), Some("response.status == 200"));
    }

    #[tokio::test]
    async fn test_dataset_runs_once_per_row_with_its_own_body() {
        // Port 1 refuses instantly, but RequestLog is still captured — the same
        // trick test_execute_flow_with_variables uses to assert what was sent
        // without standing up a server.
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc1", "SignUp", "http://127.0.0.1:1/u", "POST");
        tc.payload = Some(r#"{"email":"{{email}}"}"#.to_string());
        tc.dataset = Some(dataset_of(vec![
            ("shared body", None, Some("201")),
            ("empty body", Some("{}"), Some("400")),
            ("interpolated", Some(r#"{"who":"{{email}}"}"#), Some("400")),
        ]));

        let mut env = HashMap::new();
        env.insert("email".to_string(), Value::String("a@b.com".into()));
        let result = engine.execute_test_case_dataset(&tc, env, HashMap::new()).await;
        let its = result.iterations.as_ref().expect("aggregate carries iterations");

        assert_eq!(its.len(), 3);
        // Row 1 fell back to the test case's payload.
        assert_eq!(its[0].request.as_ref().unwrap().body.as_deref(), Some(r#"{"email":"a@b.com"}"#));
        // Row 2 replaced it outright.
        assert_eq!(its[1].request.as_ref().unwrap().body.as_deref(), Some("{}"));
        // Row 3's own body is still interpolated.
        assert_eq!(its[2].request.as_ref().unwrap().body.as_deref(), Some(r#"{"who":"a@b.com"}"#));

        assert_eq!(its[0].row_index, Some(0));
        assert_eq!(its[1].row_label.as_deref(), Some("empty body"));
        // The aggregate has no single request/response; the UI uses `iterations`.
        assert!(result.request.is_none() && result.response.is_none());
    }

    #[test]
    fn test_row_check_forms() {
        // The shorthand and the expression form are told apart by whether the check
        // is nothing but digits.
        let shorthand = DataRow { check: Some("409".into()), ..Default::default() };
        assert_eq!(shorthand.expected_status_code(), Some(409));

        let expression = DataRow {
            check: Some("response.json.token != ()".into()),
            ..Default::default()
        };
        assert_eq!(expression.expected_status_code(), None);
        assert_eq!(expression.check_expr(), Some("response.json.token != ()"));
    }

    #[tokio::test]
    async fn test_dataset_rows_ignore_the_shared_post_test_script() {
        // The Data tab stands alone: a post-test script written for the
        // single-request case must not run during a dataset run, so it can neither
        // decide nor break a row's verdict. Proven with a script that cannot even
        // parse — if it ran, the row would come back as an error.
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc1", "SignUp", "http://127.0.0.1:1/u", "POST");
        tc.assertion_script = Some("this is not valid rhai at all".to_string());
        tc.dataset = Some(dataset_of(vec![("row", Some("{}"), Some("400"))]));

        let result = engine
            .execute_test_case_dataset(&tc, HashMap::new(), HashMap::new())
            .await;
        let it = &result.iterations.as_ref().unwrap()[0];

        // The request can't connect here, so the verdict isn't reachable — what
        // matters is that we failed on the connection, not on the script.
        let msg = it.error_message.clone().unwrap_or_default();
        assert!(msg.contains("HTTP request failed"), "unexpected failure: {msg}");
        assert!(
            !msg.contains("script"),
            "the shared script must not be involved in a dataset run: {msg}"
        );
    }

    #[tokio::test]
    async fn a_node_not_marked_for_rows_ignores_the_dataset() {
        // A flow runs the test case as authored — once, with no row applied — unless
        // the node says otherwise. Adding a dataset never changes an existing flow.
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc1", "SignUp", "http://127.0.0.1:1/u", "POST");
        tc.payload = Some(r#"{"shared":true}"#.to_string());
        tc.dataset = Some(dataset_of(vec![("a", Some("{}"), Some("400"))]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("n1", "testCase", serde_json::json!({"testCaseId": "tc1"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "n1", None),
            make_edge("e2", "n1", "end", Some("success")),
        ]);

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        assert_eq!(result.results.len(), 1, "one node result, not one per row");
        assert!(result.results[0].iterations.is_none());
        // The shared payload was sent, not the row's.
        assert_eq!(result.results[0].request.as_ref().unwrap().body.as_deref(),
                   Some(r#"{"shared":true}"#));
    }

    #[test]
    fn test_last_expression_picks_the_deciding_line() {
        let script = "// save it\nSAT.vars.token = response.json.token;\n\nresponse.status == 230;\n";
        assert_eq!(last_expression(script), "response.status == 230");
        assert_eq!(last_expression(""), "");
    }

    #[test]
    fn test_find_unresolved_reports_literal_placeholders() {
        let mut headers = HashMap::new();
        headers.insert("Authorization".to_string(), "Bearer {{token}}".to_string());
        let found = find_unresolved(
            "http://x/api/{{id}}",
            &headers,
            Some(r#"{"phone":"{{my_phone_number}}","ok":"resolved"}"#),
        );
        assert!(found.contains(&"{{id}}".to_string()));
        assert!(found.contains(&"{{token}}".to_string()));
        assert!(found.contains(&"{{my_phone_number}}".to_string()));
        assert_eq!(found.len(), 3);

        // Nothing left over once everything resolved
        assert!(find_unresolved("http://x/api/1", &HashMap::new(), Some("{}")).is_empty());
    }
    use crate::db::models::{Flow, GraphData, GraphNode, GraphEdge, Position, TestCase, ExportVariable};
    use crate::db::repositories::TestCaseRepository;
    use crate::error::AppError;
    use async_trait::async_trait;
    use std::collections::HashSet;
    use chrono::Utc;

    // =========================================================================
    // Mock Repository
    // =========================================================================

    /// Mock test case repository for testing
    struct MockTestCaseRepository {
        test_cases: HashMap<String, TestCase>,
    }

    impl MockTestCaseRepository {
        fn new() -> Self {
            Self { test_cases: HashMap::new() }
        }

        fn with_test_case(mut self, tc: TestCase) -> Self {
            self.test_cases.insert(tc.id.clone(), tc);
            self
        }
    }

    #[async_trait]
    impl TestCaseRepository for MockTestCaseRepository {
        async fn create(&self, _project_id: &str, _input: crate::db::models::CreateTestCase) -> Result<TestCase, AppError> {
            unimplemented!()
        }
        async fn get_by_id(&self, id: &str) -> Result<Option<TestCase>, AppError> {
            Ok(self.test_cases.get(id).cloned())
        }
        async fn list_by_project(&self, _project_id: &str, _pagination: crate::db::models::Pagination) -> Result<crate::db::models::PaginatedResponse<TestCase>, AppError> {
            Ok(crate::db::models::PaginatedResponse {
                data: self.test_cases.values().cloned().collect(),
                pagination: crate::db::models::PaginationMeta {
                    page: 1,
                    per_page: 100,
                    total: self.test_cases.len() as u64,
                    total_pages: 1,
                },
            })
        }
        async fn update(&self, _id: &str, _input: crate::db::models::UpdateTestCase) -> Result<TestCase, AppError> {
            unimplemented!()
        }
        async fn delete(&self, _id: &str) -> Result<(), AppError> {
            unimplemented!()
        }
        async fn find_existing_ids(&self, ids: &[String]) -> Result<HashSet<String>, AppError> {
            Ok(ids.iter().filter(|id| self.test_cases.contains_key(*id)).cloned().collect())
        }
    }

    // =========================================================================
    // Helper Functions
    // =========================================================================

    fn make_test_case(id: &str, name: &str, endpoint: &str, method: &str) -> TestCase {
        TestCase {
            id: id.to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: name.to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: method.to_string(),
            endpoint: endpoint.to_string(),
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

    fn make_flow(id: &str, nodes: Vec<GraphNode>, edges: Vec<GraphEdge>) -> Flow {
        Flow {
            id: id.to_string(),
            project_id: "proj1".to_string(),
            name: "Test Flow".to_string(),
            description: None,
            graph_data: GraphData { nodes, edges, canvas_settings: serde_json::json!({}), variables: HashMap::new() },
            group_id: None,
            version: 1,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn make_node(id: &str, node_type: &str, data: serde_json::Value) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            position: Position { x: 0.0, y: 0.0 },
            data,
            width: None,
            height: None,
        }
    }

    fn make_edge(id: &str, source: &str, target: &str, edge_type: Option<&str>) -> GraphEdge {
        GraphEdge {
            id: id.to_string(),
            source: source.to_string(),
            target: target.to_string(),
            edge_type: edge_type.map(|s| s.to_string()),
            data: serde_json::json!({}),
        }
    }

    // =========================================================================
    // Basic Tests
    // =========================================================================

    #[test]
    fn test_node_status_display() {
        assert_eq!(NodeStatus::Passed.to_string(), "passed");
        assert_eq!(NodeStatus::Failed.to_string(), "failed");
        assert_eq!(NodeStatus::Error.to_string(), "error");
        assert_eq!(NodeStatus::Skipped.to_string(), "skipped");
    }

    #[test]
    fn test_execution_stats_default() {
        let stats = ExecutionStats::default();
        assert_eq!(stats.total, 0);
        assert_eq!(stats.passed, 0);
        assert_eq!(stats.failed, 0);
        assert_eq!(stats.errors, 0);
        assert_eq!(stats.skipped, 0);
    }

    #[test]
    fn test_engine_creation() {
        let engine = ExecutionEngine::new(false, None);
        assert!(!engine.debug_mode);

        let engine_debug = ExecutionEngine::new(true, None);
        assert!(engine_debug.debug_mode);
    }

    // =========================================================================
    // Edge Routing Tests
    // =========================================================================

    #[test]
    fn test_find_next_node_success_edge() {
        let engine = ExecutionEngine::new(false, None);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({"testCaseId": "tc1"})),
            make_node("end_success", "end", serde_json::json!({})),
            make_node("end_failure", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end_success", Some("success")),
            make_edge("e3", "tc1", "end_failure", Some("failure")),
        ]);

        // Should find success edge
        let next = engine.find_next_node(&flow, "tc1", Some("success"));
        assert_eq!(next, Some("end_success".to_string()));

        // Should find failure edge
        let next = engine.find_next_node(&flow, "tc1", Some("failure"));
        assert_eq!(next, Some("end_failure".to_string()));
    }

    #[test]
    fn test_find_next_node_default_edge() {
        let engine = ExecutionEngine::new(false, None);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", Some("default")),
            make_edge("e2", "tc1", "end", Some("default")),
        ]);

        // Should find default edge when no preferred type matches
        let next = engine.find_next_node(&flow, "tc1", Some("success"));
        assert_eq!(next, Some("end".to_string()));
    }

    #[test]
    fn test_find_next_node_no_type_edge() {
        let engine = ExecutionEngine::new(false, None);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end", None), // No type = implicit default
        ]);

        // Should find edge with no type
        let next = engine.find_next_node(&flow, "tc1", Some("success"));
        assert_eq!(next, Some("end".to_string()));
    }

    #[test]
    fn test_find_next_node_no_edges() {
        let engine = ExecutionEngine::new(false, None);
        let flow = make_flow("flow1", vec![
            make_node("end", "end", serde_json::json!({})),
        ], vec![]);

        let next = engine.find_next_node(&flow, "end", None);
        assert_eq!(next, None);
    }

    // =========================================================================
    // Flow Execution Tests (Integration with Mock)
    // =========================================================================

    #[tokio::test]
    async fn test_execute_empty_flow_no_start() {
        let engine = ExecutionEngine::new(false, None);
        let repo = MockTestCaseRepository::new();

        // Flow with no START node
        let flow = make_flow("flow1", vec![
            make_node("end", "end", serde_json::json!({})),
        ], vec![]);

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(),
            HashMap::new(),
            None,
        ).await;

        assert!(result.is_err());
        match result {
            Err(AppError::BadRequest(msg)) => assert!(msg.contains("START")),
            _ => panic!("Expected BadRequest error"),
        }
    }

    #[tokio::test]
    async fn test_execute_flow_start_to_end() {
        let engine = ExecutionEngine::new(false, None);
        let repo = MockTestCaseRepository::new();

        // Simple flow: START -> END (no test cases)
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "end", None),
        ]);

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(),
            HashMap::new(),
            None,
        ).await.unwrap();

        assert_eq!(result.status, "completed");
        assert_eq!(result.stats.total, 0);
        assert_eq!(result.stats.passed, 0);
    }

    /// A one-shot HTTP server that answers with the given status and body. The
    /// other tests here point at a refused port, which is fine when only the
    /// request log matters — but a verdict needs a real response to judge.
    /// A stub that answers `times` requests before closing. Fan-out sends one request
    /// per row, so a single-shot stub would leave later rows with a refused connection
    /// — which errors before any verdict and hides what the test is checking.
    async fn stub_times(status: u16, body: &'static str, times: usize) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for _ in 0..times {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 8192];
                let _ = socket.read(&mut buf).await; // drain the request
                let response = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status, body.len(), body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        format!("http://{}/", addr)
    }

    /// A stub that answers a different body each time, in order, then repeats the last.
    ///
    /// The shape a poll actually meets: pending, pending, complete. Repeating the last means
    /// a test that gives up does not also fail on a closed socket, so a timeout test reports
    /// the timeout rather than a connection error.
    async fn stub_sequence(responses: Vec<(u16, &'static str)>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut i = 0usize;
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                let (status, body) = responses[i.min(responses.len() - 1)];
                i += 1;
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 8192];
                let _ = socket.read(&mut buf).await;
                let response = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status, body.len(), body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        format!("http://{}", addr)
    }

    /// A flow of one node that polls. The interval is 1ms so the tests do not sleep — the
    /// behaviour under test is the sequence of attempts, not the wall clock.
    fn polling_flow(url: &str, until: &str, timeout_ms: u64, check: Option<&str>) -> Flow {
        let mut config = serde_json::json!({
            "poll": { "until": until, "intervalMs": 1, "timeoutMs": timeout_ms }
        });
        if let Some(check) = check {
            config["check"] = serde_json::json!(check);
        }
        let data = serde_json::json!({ "testCaseId": "poll", "config": config });
        let _ = url;
        make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("p", "testCase", data),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "p", None),
            make_edge("e2", "p", "end", Some("success")),
        ])
    }

    async fn stub_once(status: u16, body: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await; // drain the request
                let response = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status, body.len(), body
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        format!("http://{}/sms", addr)
    }

    /// A `start → … → end` chain whose nodes all answer 200, for the tests that care
    /// about *which* nodes ran rather than what they did.
    async fn stepping_flow(ids: &[&str]) -> (Flow, MockTestCaseRepository) {
        let mut repo = MockTestCaseRepository::new();
        let mut nodes = vec![make_node("start", "start", serde_json::json!({}))];
        let mut edges = vec![make_edge("e-start", "start", ids[0], None)];
        for (i, id) in ids.iter().enumerate() {
            let url = stub_once(200, "{}").await;
            repo = repo.with_test_case(make_test_case(id, id, &url, "POST"));
            nodes.push(make_node(id, "testCase", serde_json::json!({"testCaseId": id})));
            let next = ids.get(i + 1).copied().unwrap_or("end");
            edges.push(make_edge(&format!("e-{}", id), id, next, Some("success")));
        }
        nodes.push(make_node("end", "end", serde_json::json!({})));
        (make_flow("flow1", nodes, edges), repo)
    }

    /// The nodes a run actually got to, in order.
    fn ran(result: &FlowExecutionResult) -> Vec<&str> {
        result.results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or(""))
            .collect()
    }

    /// Pressing "Run step-by-step" should *run a node* and then wait. Waiting for a
    /// Next before anything at all has happened just looks broken.
    #[tokio::test]
    async fn the_first_node_of_a_stepped_run_goes_without_asking() {
        let engine = ExecutionEngine::new(false, None);
        let (flow, repo) = stepping_flow(&["a", "b"]).await;
        let (tx, rx) = mpsc::channel::<StepCommand>(8);
        drop(tx); // not one press

        let result = engine
            .run_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None, Some(rx))
            .await
            .unwrap();

        assert_eq!(ran(&result), vec!["a"], "{:?}", ran(&result));
        assert_eq!(result.status, "stopped");
    }

    /// One press buys exactly one node.
    #[tokio::test]
    async fn a_stepped_run_waits_for_each_next() {
        let engine = ExecutionEngine::new(false, None);
        let (flow, repo) = stepping_flow(&["a", "b", "c"]).await;
        let (tx, rx) = mpsc::channel::<StepCommand>(8);
        // The first node goes free, so this press buys the second — and nothing
        // buys the third.
        tx.send(StepCommand::Next).await.unwrap();
        drop(tx);

        let result = engine
            .run_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None, Some(rx))
            .await
            .unwrap();

        assert_eq!(ran(&result), vec!["a", "b"], "{:?}", ran(&result));
        assert_eq!(result.status, "stopped");
    }

    /// "Run to end" is the way out of pressing Next eleven more times.
    #[tokio::test]
    async fn run_to_end_releases_the_brakes() {
        let engine = ExecutionEngine::new(false, None);
        let (flow, repo) = stepping_flow(&["a", "b", "c"]).await;
        let (tx, rx) = mpsc::channel::<StepCommand>(8);
        tx.send(StepCommand::RunToEnd).await.unwrap();
        // Dropped straight after: the channel must never be consulted again, or the
        // run would stop at c for want of a command.
        drop(tx);

        let result = engine
            .run_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None, Some(rx))
            .await
            .unwrap();

        assert_eq!(ran(&result), vec!["a", "b", "c"], "{:?}", ran(&result));
        assert_eq!(result.status, "completed");
    }

    /// While the author is deciding, the only thing worth pointing at on the canvas is
    /// the node about to run — and which one that is depends on the last verdict and on
    /// teardown nodes being hopped over. So the engine says it rather than leaving the
    /// canvas to re-derive the routing rules.
    #[tokio::test]
    async fn a_pause_names_the_node_it_is_waiting_to_run() {
        let engine = ExecutionEngine::new(false, None);
        let a = make_test_case("a", "a", &stub_once(200, "{}").await, "POST");
        let b = make_test_case("b", "b", &stub_once(200, "{}").await, "POST");
        let t = make_test_case("t", "Cleanup", &stub_once(200, "{}").await, "DELETE");
        let repo = MockTestCaseRepository::new()
            .with_test_case(a).with_test_case(b).with_test_case(t);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("na", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("nb", "testCase", serde_json::json!({"testCaseId": "b"})),
            make_node("nt", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "na", None),
            make_edge("e2", "na", "nb", Some("success")),
            make_edge("e3", "nb", "end", Some("success")),
        ]);

        let (step_tx, step_rx) = mpsc::channel::<StepCommand>(8);
        step_tx.send(StepCommand::Next).await.unwrap();
        drop(step_tx);
        let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(100);

        engine
            .run_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), Some(tx), Some(step_rx))
            .await
            .unwrap();

        // The stream is drained afterwards; nothing was reading it during the run, which
        // is why the channel needs room for the whole flow.
        let mut seen = Vec::new();
        while let Ok(event) = rx.try_recv() {
            seen.push(match event {
                ExecutionEvent::Paused { node_id } => format!("paused:{}", node_id),
                ExecutionEvent::NodeStarted { node_id, .. } => format!("started:{}", node_id),
                ExecutionEvent::NodeCompleted { node_id, .. } => format!("completed:{}", node_id),
                ExecutionEvent::Started { .. } => "run-started".to_string(),
                ExecutionEvent::Completed { status, .. } => format!("run-{}", status),
                ExecutionEvent::Error { .. } => "error".to_string(),
                // Suite-level events; a single flow never emits them.
                other => format!("unexpected:{:?}", other),
            });
        }

        // The first node is not paused before; every later one is, cleanup included.
        assert_eq!(seen, vec![
            "run-started",
            "started:na", "completed:na",
            "paused:nb", "started:nb", "completed:nb",
            "paused:nt", "started:nt", "completed:nt",
            "run-completed",
        ], "{:?}", seen);
    }

    // ---------------------------------------------------------------- poll-until

    const PENDING: &str = r#"{"status":"pending","id":"abc","processed":0,"toProcess":2,"error":0}"#;
    const HALFWAY: &str = r#"{"status":"pending","id":"abc","processed":1,"toProcess":2,"error":0}"#;
    const DONE: &str = r#"{"status":"complete","id":"abc","processed":2,"toProcess":2,"error":0}"#;
    const FAILED: &str = r#"{"status":"failed","id":"abc","processed":1,"toProcess":2,"error":1}"#;

    async fn run_poll(
        url: &str,
        until: &str,
        timeout_ms: u64,
        check: Option<&str>,
    ) -> NodeResult {
        let engine = ExecutionEngine::new(true, None);
        let tc = make_test_case("poll", "Upload Status", &format!("{url}/status"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = polling_flow(url, until, timeout_ms, check);
        let mut results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;
        results.remove(0)
    }

    /// The shape a multi-stage upload actually has: 202 pending, then pending, then complete.
    #[tokio::test]
    async fn a_poll_node_asks_again_until_until_is_met() {
        let url = stub_sequence(vec![(202, PENDING), (200, HALFWAY), (200, DONE)]).await;
        let result = run_poll(&url, r#"response.json.status != "pending""#, 5_000, None).await;

        assert_eq!(result.status, NodeStatus::Passed);
        // One node result, not one per attempt — a poll is one step of the flow.
        assert_eq!(result.attempts, Some(3));
        // …and every attempt is on the record, which is what an author debugging a slow
        // upload is reading.
        let log = result.logs.join("\n");
        assert!(log.contains("poll attempt 1"), "{log}");
        assert!(log.contains("poll attempt 3"), "{log}");
        assert!(log.contains("settled after 3 attempt(s)"), "{log}");
    }

    /// The responsibility split, and the reason `until` and Expect are separate.
    #[tokio::test]
    async fn the_verdict_is_judged_once_against_the_last_response() {
        let url = stub_sequence(vec![(202, PENDING), (200, DONE)]).await;
        let result = run_poll(
            &url,
            r#"response.json.status != "pending""#,
            5_000,
            Some("response.json.processed == response.json.toProcess"),
        )
        .await;

        // The pending attempt would fail this check. It must not be judged at all — only
        // the response that settled is.
        assert_eq!(result.status, NodeStatus::Passed);
        assert_eq!(result.attempts, Some(2));
        // The response kept is the final one, not the first.
        assert!(result.response.unwrap().body.contains("complete"));
    }

    /// The whole argument for two expressions rather than one.
    #[tokio::test]
    async fn a_failed_upload_reports_the_failure_not_a_timeout() {
        // "failed" satisfies `until` — the answer has settled — so Expect judges it at once
        // and says what is wrong. With one expression this would retry to the budget and
        // report "timed out", hiding the real result behind a slow one.
        let url = stub_sequence(vec![(200, FAILED)]).await;
        let result = run_poll(
            &url,
            r#"response.json.status != "pending""#,
            5_000,
            Some("response.json.error == 0"),
        )
        .await;

        assert_eq!(result.status, NodeStatus::Failed);
        assert_eq!(result.attempts, Some(1), "it should not have waited at all");
        let message = result.error_message.unwrap_or_default();
        assert!(!message.contains("gave up"), "reported as a timeout: {message}");
    }

    #[tokio::test]
    async fn a_4xx_stops_polling_at_once() {
        // A 404 means the id is wrong. Sixty attempts would waste the budget and bury the
        // reason behind a timeout.
        let url = stub_sequence(vec![(404, r#"{"message":"not found"}"#)]).await;
        let result = run_poll(&url, r#"response.json.status != "pending""#, 5_000, None).await;

        assert_eq!(result.attempts, Some(1));
        assert_eq!(result.status, NodeStatus::Failed);
        let log = result.logs.join("\n");
        assert!(log.contains("will not change on a retry"), "{log}");
    }

    #[tokio::test]
    async fn running_out_of_budget_fails_rather_than_errors() {
        // The request worked every time; the wait ran out. `Error` would abort the flow and
        // claim something systemic went wrong, which is a different and worse story.
        let url = stub_sequence(vec![(202, PENDING)]).await;
        let result = run_poll(&url, r#"response.json.status != "pending""#, 30, None).await;

        assert_eq!(result.status, NodeStatus::Failed);
        assert!(result.attempts.unwrap() >= 1);
        let log = result.logs.join("\n");
        assert!(log.contains("gave up after"), "{log}");
        assert!(log.contains("never became true"), "{log}");
    }

    #[tokio::test]
    async fn an_until_that_is_not_a_condition_is_refused_at_once() {
        // An expression that yields a value rather than a verdict will not fix itself, so
        // waiting out the budget would only delay a report about the author's mistake.
        let url = stub_sequence(vec![(200, PENDING)]).await;
        let result = run_poll(&url, "response.json.processed", 5_000, None).await;

        assert_eq!(result.status, NodeStatus::Error);
        assert!(
            result.error_message.unwrap_or_default().contains("true or false"),
            "should name the problem"
        );
    }

    #[tokio::test]
    async fn a_node_without_poll_config_asks_exactly_once() {
        // Nothing changes for the requests that are not multi-staged, and the report says
        // nothing about attempts rather than reporting "1".
        let url = stub_once(200, DONE).await;
        let engine = ExecutionEngine::new(false, None);
        let tc = make_test_case("t", "Plain", &format!("{url}/x"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("n", "testCase", serde_json::json!({"testCaseId": "t"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "n", None),
            make_edge("e2", "n", "end", Some("success")),
        ]);

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .remove(0);
        assert_eq!(result.attempts, None);
    }

    #[tokio::test]
    async fn until_is_interpolated_like_every_other_string() {
        // `until` is the third expression beside a row's Expect and a node's, and it gets
        // the same treatment: a name resolves, so one flow can state the settled condition
        // once and the environment supply the value.
        let url = stub_sequence(vec![(202, PENDING), (200, DONE)]).await;
        let engine = ExecutionEngine::new(true, None);
        let tc = make_test_case("poll", "Upload Status", &format!("{url}/status"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = polling_flow(&url, r#"response.json.status == "{{settled}}""#, 5_000, None);
        let environment =
            HashMap::from([("settled".to_string(), serde_json::json!("complete"))]);

        let result = engine
            .execute_flow("exec1", &flow, &repo, environment, HashMap::new(), None)
            .await
            .unwrap()
            .results
            .remove(0);

        // Uninterpolated, `{{settled}}` would never match and this would time out instead.
        assert_eq!(result.status, NodeStatus::Passed);
        assert_eq!(result.attempts, Some(2));
    }

    /// A poll can hold a run open for two minutes, so the rule has to apply inside a node.
    #[tokio::test]
    async fn a_poll_node_notices_the_run_being_abandoned() {
        // Answers "pending" for ever: without the check between attempts this polls its
        // whole budget for a stream that nobody is reading.
        let url = stub_sequence(vec![(202, PENDING)]).await;
        let engine = ExecutionEngine::new(false, None);
        let tc = make_test_case("poll", "Upload Status", &format!("{url}/status"), "GET");
        let cleanup = make_test_case("t", "Cleanup", "http://127.0.0.1:1/t", "DELETE");
        let repo = MockTestCaseRepository::new().with_test_case(tc).with_test_case(cleanup);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("p", "testCase", serde_json::json!({
                "testCaseId": "poll",
                "config": { "poll": {
                    "until": r#"response.json.status != "pending""#,
                    "intervalMs": 1,
                    // Long enough that finishing on the budget would take the test with it.
                    "timeoutMs": 600_000
                }}
            })),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "p", None),
            make_edge("e2", "p", "end", Some("success")),
        ]);

        let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(100);
        tokio::spawn(async move {
            // Watch until the poll is under way, then walk away — what closing the tab does.
            while let Some(event) = rx.recv().await {
                if matches!(event, ExecutionEvent::NodeStarted { .. }) {
                    break;
                }
            }
            drop(rx);
        });

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), Some(tx))
            .await
            .unwrap();

        let poll = &result.results[0];
        // Not a pass: the 202 it stopped on says only "I have your file".
        assert_eq!(poll.status, NodeStatus::Failed);
        assert!(
            poll.logs.iter().any(|l| l.contains("the run was abandoned")),
            "{:?}",
            poll.logs
        );
        // And the account it created is still cleaned up.
        let ran: Vec<&str> = result.results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or("")).collect();
        assert_eq!(ran, vec!["Upload Status", "Cleanup"], "{:?}", ran);
    }

    #[test]
    fn poll_config_is_absent_unless_until_says_something() {
        // Absence is the discriminator, the same habit as rowIds and needs_flow.
        let none = make_node("n", "testCase", serde_json::json!({"testCaseId": "t"}));
        assert!(poll_config(&make_node("n", "testCase", serde_json::json!({
            "testCaseId": "t", "config": {}
        }))).is_none());
        assert!(poll_config(&none).is_none());

        let blank = make_node("n", "testCase", serde_json::json!({
            "testCaseId": "t", "config": { "poll": { "until": "   " } }
        }));
        assert!(poll_config(&blank).is_none(), "a blank until is not a poll");

        // Defaults, so an author who states only the condition gets sensible waiting.
        let defaulted = make_node("n", "testCase", serde_json::json!({
            "testCaseId": "t", "config": { "poll": { "until": "response.status == 200" } }
        }));
        let poll = poll_config(&defaulted).unwrap();
        assert_eq!(poll.interval_ms, POLL_INTERVAL_MS);
        assert_eq!(poll.timeout_ms, POLL_TIMEOUT_MS);

        // A zero interval or budget is nonsense, not a request for a tight loop.
        let zeroed = make_node("n", "testCase", serde_json::json!({
            "testCaseId": "t", "config": { "poll": { "until": "x", "intervalMs": 0, "timeoutMs": 0 } }
        }));
        let poll = poll_config(&zeroed).unwrap();
        assert_eq!(poll.interval_ms, POLL_INTERVAL_MS);
        assert_eq!(poll.timeout_ms, POLL_TIMEOUT_MS);
    }

    // ------------------------------------------------- what a failure does to the rest

    /// A flow of A → B, drawn the way every real flow here is drawn: untyped edges.
    fn linear_flow(url: &str, a_check: Option<&str>) -> Flow {
        let mut a_cfg = serde_json::json!({ "testCaseId": "a" });
        if let Some(check) = a_check {
            a_cfg["config"] = serde_json::json!({ "check": check });
        }
        let _ = url;
        make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", a_cfg),
            make_node("b", "testCase", serde_json::json!({"testCaseId": "b"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "b", None),
            make_edge("e3", "b", "end", None),
        ])
    }

    async fn two_step(a_check: Option<&str>) -> FlowExecutionResult {
        let url = stub_times(200, r#"{"ok":true}"#, 3).await;
        let a = make_test_case("a", "A", &format!("{url}/a"), "GET");
        let b = make_test_case("b", "B", &format!("{url}/b"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(a).with_test_case(b);
        ExecutionEngine::new(false, None)
            .execute_flow("e1", &linear_flow(&url, a_check), &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_failure_stops_the_flow_when_no_failure_edge_is_drawn() {
        // The step that failed is usually the step that was going to export an id, so what
        // follows either fails for a second reason or asserts against a value that never
        // arrived. One root cause became six red nodes.
        //
        // It used to continue: `pick_edge` fell through exact type, `default`, untyped, then
        // *the first edge* — and every edge in a real flow here is untyped, so the happy path
        // was always found.
        let result = two_step(Some("500")).await;

        let ran: Vec<&str> = result.results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or("")).collect();
        assert_eq!(ran, vec!["A"], "B should never have run: {ran:?}");
        assert_eq!(result.status, "failed");
        assert_eq!(result.stats.failed, 1);
    }

    #[tokio::test]
    async fn a_passing_node_still_follows_an_untyped_edge() {
        // The guard on the other side of that change: untyped edges are how every flow here is
        // drawn, and they have to keep meaning "then this".
        let result = two_step(None).await;
        let ran: Vec<&str> = result.results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or("")).collect();
        assert_eq!(ran, vec!["A", "B"]);
        assert_eq!(result.status, "completed");
    }

    #[tokio::test]
    async fn an_explicit_failure_edge_is_still_honoured() {
        // The one exception, and the only one: an author who drew a `failure` edge has a
        // recovery path in mind and is entitled to it.
        let url = stub_times(200, r#"{"ok":true}"#, 3).await;
        let a = make_test_case("a", "A", &format!("{url}/a"), "GET");
        let r = make_test_case("r", "Recover", &format!("{url}/r"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(a).with_test_case(r);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({
                "testCaseId": "a", "config": {"check": "500"}
            })),
            make_node("r", "testCase", serde_json::json!({"testCaseId": "r"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            // Both drawn, so the choice is real rather than a fallback.
            make_edge("e2", "a", "end", Some("success")),
            make_edge("e3", "a", "r", Some("failure")),
        ]);

        let result = ExecutionEngine::new(false, None)
            .execute_flow("e1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        let ran: Vec<&str> = result.results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or("")).collect();
        assert_eq!(ran, vec!["A", "Recover"]);
        // …and the run still failed. Recovering from a failure does not unfail it.
        assert_eq!(result.status, "failed");
    }

    #[tokio::test]
    async fn the_headline_agrees_with_the_tally_underneath_it() {
        // `final_status` was whatever the last node's routing returned, so a flow with a failure
        // three steps back reported "completed" while the run history — which counts — called the
        // same run "failed". Two answers about one run, and the more visible one flattered it.
        let url = stub_times(200, r#"{"ok":true}"#, 3).await;
        let a = make_test_case("a", "A", &format!("{url}/a"), "GET");
        let b = make_test_case("b", "B", &format!("{url}/b"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(a).with_test_case(b);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({
                "testCaseId": "a", "config": {"check": "500"}
            })),
            make_node("b", "testCase", serde_json::json!({"testCaseId": "b"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            // A failure edge, so B runs and passes — the last node's verdict is a pass.
            make_edge("e2", "a", "b", Some("failure")),
            make_edge("e3", "b", "end", None),
        ]);

        let result = ExecutionEngine::new(false, None)
            .execute_flow("e1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        assert_eq!(result.stats.passed, 1);
        assert_eq!(result.stats.failed, 1);
        // The last node passed. The run did not.
        assert_eq!(result.status, "failed");
    }

    #[tokio::test]
    async fn teardown_still_runs_when_a_failure_stops_the_flow() {
        // The whole reason teardown is unconditional: an account created by a run that then
        // went wrong still has to be cleaned up. Stopping earlier must not change that.
        let url = stub_times(200, r#"{"ok":true}"#, 3).await;
        let a = make_test_case("a", "A", &format!("{url}/a"), "GET");
        let b = make_test_case("b", "B", &format!("{url}/b"), "GET");
        let t = make_test_case("t", "Cleanup", &format!("{url}/t"), "DELETE");
        let repo = MockTestCaseRepository::new()
            .with_test_case(a).with_test_case(b).with_test_case(t);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({
                "testCaseId": "a", "config": {"check": "500"}
            })),
            make_node("b", "testCase", serde_json::json!({"testCaseId": "b"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "b", None),
            make_edge("e3", "b", "end", None),
        ]);

        let result = ExecutionEngine::new(false, None)
            .execute_flow("e1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        let ran: Vec<&str> = result.results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or("")).collect();
        // B skipped because A failed; Cleanup ran anyway.
        assert_eq!(ran, vec!["A", "Cleanup"], "{ran:?}");
    }

    /// Ctrl+C stops a run at its next step — and still cleans up after it.
    ///
    /// The server used to receive the signal and carry on: graceful shutdown waits for
    /// open connections, and a suite's stream stays open for as long as the suite runs.
    /// It sat there for minutes still creating accounts. Stopping *without* teardown
    /// would have been the other way to get this wrong.
    #[tokio::test]
    async fn shutting_down_stops_the_run_but_still_tidies_up() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        // This engine's own flag, so the process-wide one is untouched and tests running
        // beside this one are unaffected.
        let stop = Arc::new(AtomicBool::new(false));
        let engine = ExecutionEngine::new(false, None).stopping_on(stop.clone());

        let repo = MockTestCaseRepository::new()
            .with_test_case(make_test_case("a", "Step", "http://127.0.0.1:1/a", "POST"))
            .with_test_case(make_test_case("b", "Later step", "http://127.0.0.1:1/b", "POST"))
            .with_test_case(make_test_case("t", "Delete User", "http://127.0.0.1:1/t", "DELETE"));
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("b", "testCase", serde_json::json!({"testCaseId": "b"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "b", Some("success")),
            make_edge("e3", "b", "t", Some("success")),
            make_edge("e4", "t", "end", Some("success")),
        ]);

        // Raised before the run starts — the same state a run is in the moment the
        // author presses Ctrl+C.
        stop.store(true, Ordering::Relaxed);

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        assert_eq!(result.status, "stopped");
        // Not one scenario node ran…
        assert!(
            !result.results.iter().any(|r| r.test_case_name.as_deref() == Some("Later step")),
            "a stopped run kept working through the flow"
        );
        // …and the cleanup did anyway. There is no version of cancel that leaves the
        // account behind.
        assert!(
            result.results.iter().any(|r| r.test_case_name.as_deref() == Some("Delete User")),
            "shutdown skipped teardown and left whatever the run created"
        );
    }

    /// The assertion that matters about Stop: it abandons the *flow*, not the cleanup.
    /// Whatever the run already created still has to go.
    #[tokio::test]
    async fn stop_abandons_the_run_but_teardown_still_runs() {
        let engine = ExecutionEngine::new(false, None);
        let a = make_test_case("a", "a", &stub_once(200, "{}").await, "POST");
        let b = make_test_case("b", "b", &stub_once(200, "{}").await, "POST");
        let t = make_test_case("t", "Cleanup", &stub_once(200, "{}").await, "DELETE");
        let repo = MockTestCaseRepository::new()
            .with_test_case(a).with_test_case(b).with_test_case(t);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("b", "testCase", serde_json::json!({"testCaseId": "b"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "b", Some("success")),
            make_edge("e3", "b", "end", Some("success")),
        ]);

        let (tx, rx) = mpsc::channel::<StepCommand>(8);
        tx.send(StepCommand::Stop).await.unwrap();
        drop(tx);

        let result = engine
            .run_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None, Some(rx))
            .await
            .unwrap();

        assert_eq!(result.status, "stopped");
        // b never ran; Cleanup did, and without asking for another press.
        assert_eq!(ran(&result), vec!["a", "Cleanup"], "{:?}", ran(&result));
        assert_eq!(result.results[1].teardown, Some(true));
    }

    /// A row fills in the path parameters the endpoint already declares, so the endpoint
    /// stays the URL it documents instead of being chopped down to a prefix the rows can
    /// append to.
    #[tokio::test]
    async fn a_row_supplies_the_endpoints_own_placeholders() {
        let engine = ExecutionEngine::new(false, None);
        let url = stub_times(200, "{}", 3).await;
        let mut tc = make_test_case(
            "tc",
            "Pause",
            &format!("{}campaigns/{{{{channel}}}}/pause/{{{{campaignID}}}}", url),
            "POST",
        );
        let mut dataset = dataset_of(vec![("sms", None, None), ("email", None, None)]);
        dataset.rows[0].vars = [("channel", "sms"), ("campaignID", "c-123")]
            .iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        dataset.rows[1].vars = [("channel", "email"), ("campaignID", "c-456")]
            .iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        tc.dataset = Some(dataset);
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({"forEachRow": true}));

        let rows = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
            .iterations
            .unwrap();

        assert!(rows[0].request.as_ref().unwrap().url.ends_with("campaigns/sms/pause/c-123"),
            "{}", rows[0].request.as_ref().unwrap().url);
        assert!(rows[1].request.as_ref().unwrap().url.ends_with("campaigns/email/pause/c-456"),
            "{}", rows[1].request.as_ref().unwrap().url);
    }

    /// A row is more specific than the node it runs in: the node says what is true for
    /// the whole set, the row says what changes per iteration. And a value one row sets
    /// must not leak into the next, which is what its own context clone is for.
    #[tokio::test]
    async fn a_rows_value_beats_the_nodes_and_does_not_reach_the_next_row() {
        let engine = ExecutionEngine::new(false, None);
        let url = stub_times(200, "{}", 3).await;
        let mut tc = make_test_case("tc", "Pause", &format!("{}{{{{channel}}}}", url), "POST");
        let mut dataset = dataset_of(vec![
            ("sets it", None, None),
            ("leaves it", None, None),
        ]);
        dataset.rows[0].vars =
            [("channel".to_string(), "sms".to_string())].into_iter().collect();
        // Row 2 sets nothing, so it must fall through to the node's value — not inherit
        // row 1's.
        tc.dataset = Some(dataset);
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true,
            "inputVars": [{"key": "channel", "value": "from-the-node"}]
        }));

        let rows = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
            .iterations
            .unwrap();

        assert!(rows[0].request.as_ref().unwrap().url.ends_with("/sms"),
            "{}", rows[0].request.as_ref().unwrap().url);
        assert!(rows[1].request.as_ref().unwrap().url.ends_with("/from-the-node"),
            "{}", rows[1].request.as_ref().unwrap().url);
    }

    /// A blank value is not a value: it must fall through rather than send an empty
    /// path segment, which would quietly produce a different URL.
    #[tokio::test]
    async fn a_blank_row_value_falls_through() {
        let engine = ExecutionEngine::new(false, None);
        let url = stub_times(200, "{}", 2).await;
        let mut tc = make_test_case("tc", "Pause", &format!("{}{{{{channel}}}}", url), "POST");
        let mut dataset = dataset_of(vec![("blank", None, None)]);
        dataset.rows[0].vars =
            [("channel".to_string(), "   ".to_string())].into_iter().collect();
        tc.dataset = Some(dataset);
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true,
            "inputVars": [{"key": "channel", "value": "fallback"}]
        }));

        let rows = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
            .iterations
            .unwrap();

        assert!(rows[0].request.as_ref().unwrap().url.ends_with("/fallback"),
            "{}", rows[0].request.as_ref().unwrap().url);
    }

    /// A stub that answers only once its cue fires, so a test can make something
    /// happen *while* a request is in flight without resorting to a sleep.
    async fn stub_on_cue(cue: tokio::sync::oneshot::Receiver<()>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let _ = socket.read(&mut buf).await; // drain the request
                let _ = cue.await; // the test does its work here
                let _ = socket
                    .write_all(b"HTTP/1.1 200 X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                    .await;
                let _ = socket.flush().await;
            }
        });
        format!("http://{}/a", addr)
    }

    /// Closing the browser tab used to leave the flow running to the end, server side:
    /// the task was detached, its result discarded, and every failed `send` ignored. So
    /// a run you walked away from still created the account, still sent the message and
    /// still issued the deletes — with nobody to see any of it.
    ///
    /// Cleanup is the deliberate exception. Whatever the abandoned run already created
    /// still has to go.
    #[tokio::test]
    async fn a_run_whose_client_vanished_stops_at_the_next_node() {
        let engine = ExecutionEngine::new(false, None);
        let (cue, wait_for_cue) = tokio::sync::oneshot::channel();
        let a = make_test_case("a", "A", &stub_on_cue(wait_for_cue).await, "POST");
        // B and Cleanup point at a refused port. B must never be attempted at all;
        // Cleanup may fail, so long as it is tried.
        let b = make_test_case("b", "B", "http://127.0.0.1:1/b", "POST");
        let t = make_test_case("t", "Cleanup", "http://127.0.0.1:1/t", "DELETE");
        let repo = MockTestCaseRepository::new()
            .with_test_case(a).with_test_case(b).with_test_case(t);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("b", "testCase", serde_json::json!({"testCaseId": "b"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "b", Some("success")),
            make_edge("e3", "b", "end", Some("success")),
        ]);

        let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(100);
        tokio::spawn(async move {
            // Watch until A is under way, then walk away — what closing the tab does.
            while let Some(event) = rx.recv().await {
                if matches!(event, ExecutionEvent::NodeStarted { .. }) {
                    break;
                }
            }
            drop(rx);
            // A is still blocked waiting to answer, so the stream is provably gone
            // before the engine can reach the node after it.
            let _ = cue.send(());
        });

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), Some(tx))
            .await
            .unwrap();

        assert_eq!(result.status, "stopped");
        let ran: Vec<&str> = result.results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or("")).collect();
        assert_eq!(ran, vec!["A", "Cleanup"], "{:?}", ran);
        assert_eq!(result.results[1].teardown, Some(true));
    }

    /// A teardown node may sit anywhere the author drew it. Marking one in the
    /// middle of a chain must lift it out, not cut the chain: the first version of
    /// this ended the traversal at the node before it and dropped the rest of the
    /// flow without a word.
    #[tokio::test]
    async fn a_teardown_node_mid_chain_does_not_sever_the_flow() {
        let engine = ExecutionEngine::new(false, None);
        // A and C must actually pass, or the flow stops for an unrelated reason —
        // a refused port is an *error*, which ends traversal by design.
        let a = make_test_case("a", "A", &stub_once(200, "{}").await, "POST");
        let c = make_test_case("c", "C", &stub_once(200, "{}").await, "POST");
        let t = make_test_case("t", "Cleanup", "http://127.0.0.1:1/t", "DELETE");
        let repo = MockTestCaseRepository::new()
            .with_test_case(a).with_test_case(t).with_test_case(c);
        // start → A → [Cleanup, marked teardown] → C → end
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("c", "testCase", serde_json::json!({"testCaseId": "c"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "t", Some("success")),
            make_edge("e3", "t", "c", Some("success")),
            make_edge("e4", "c", "end", Some("success")),
        ]);
        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await.unwrap().results;
        let names: Vec<&str> = results.iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or("")).collect();
        // C still runs, and Cleanup runs at the end rather than in place.
        assert_eq!(names, vec!["A", "C", "Cleanup"], "{:?}", names);
    }

    /// Each result says what it required, so the matrix can show it without reading the
    /// dataset — which may have been edited since the run.
    #[tokio::test]
    async fn a_result_records_what_it_required() {
        async fn expected_of(check: Option<&str>, script: Option<&str>) -> Option<String> {
            let engine = ExecutionEngine::new(false, None);
            let mut tc = make_test_case("tc", "List", &stub_once(200, r#"{"n":3}"#).await, "GET");
            tc.assertion_script = script.map(str::to_string);
            tc.dataset = Some(dataset_of(vec![("row", None, check)]));
            let repo = MockTestCaseRepository::new().with_test_case(tc);
            let flow = one_node_flow("tc", serde_json::json!({
                "forEachRow": true,
                "inputVars": [{"key": "expected_count", "value": "3"}]
            }));
            engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap()
                .results
                .into_iter()
                .find(|r| r.node_id == "b")
                .unwrap()
                .iterations
                .unwrap()
                .remove(0)
                .expected
        }

        // A status shorthand reads as the status it required.
        assert_eq!(expected_of(Some("200"), None).await.as_deref(), Some("HTTP 200"));
        // A blank check says what it fell back to, rather than nothing.
        assert_eq!(expected_of(None, None).await.as_deref(), Some("any 2xx"));
        // An expression is recorded *interpolated* — the text that actually decided,
        // not the template. Looking it up in the dataset would show "{{expected_count}}".
        assert_eq!(
            expected_of(Some("response.json.n == {{expected_count}}"), None).await.as_deref(),
            Some("response.json.n == 3")
        );
    }

    #[tokio::test]
    async fn a_plain_run_records_what_its_script_asserted() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "List", &stub_once(200, "{}").await, "GET");
        tc.assertion_script = Some("SAT.vars.x = 1;\nresponse.status == 200".to_string());
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let result = engine
            .execute_flow(
                "exec1",
                &one_node_flow("tc", serde_json::json!({})),
                &repo,
                HashMap::new(),
                HashMap::new(),
                None,
            )
            .await
            .unwrap()
            .results
            .remove(0);

        assert_eq!(result.expected.as_deref(), Some("response.status == 200"));
    }

    // ============ rows that can't run cold ("Run dataset" skips them) ============

    fn dataset_with_a_row_needing_a_flow() -> crate::db::models::Dataset {
        let mut d = dataset_of(vec![
            ("runs cold", Some("{}"), Some("401")),
            ("needs a login", Some("{}"), Some("202")),
        ]);
        d.rows[1].needs_flow = true;
        d
    }

    /// A parked row runs **nowhere** — which is what separates it from `needs_flow`, and
    /// the reason both callers are asserted here rather than in two tests.
    #[tokio::test]
    async fn a_disabled_row_is_skipped_everywhere() {
        let engine = ExecutionEngine::new(false, None);
        let url = stub_times(200, "{}", 4).await;
        let mut tc = make_test_case("tc", "Send", &url, "POST");
        let mut dataset = dataset_of(vec![
            ("finished", Some("{}"), Some("200")),
            ("still drafting", Some("{}"), Some("200")),
        ]);
        dataset.rows[1].disabled = true;
        tc.dataset = Some(dataset);

        // 1. The editor's own run.
        let from_editor = engine
            .execute_test_case_dataset(&tc, HashMap::new(), HashMap::new())
            .await;
        let rows = from_editor.iterations.as_ref().unwrap();
        assert_eq!(rows[0].status, NodeStatus::Passed);
        assert_eq!(rows[1].status, NodeStatus::Skipped);
        assert!(rows[1].request.is_none(), "nothing may be sent");
        assert!(
            rows[1].error_message.as_deref().unwrap_or("").contains("Disabled"),
            "{:?}",
            rows[1].error_message
        );

        // 2. A flow node, which honours `needs_flow` in the other direction — the flow is
        //    the precondition — but has no say over a parked row.
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({"forEachRow": true}));
        let from_flow = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();
        let rows = from_flow.iterations.as_ref().unwrap();
        assert_eq!(rows[0].status, NodeStatus::Passed);
        assert_eq!(rows[1].status, NodeStatus::Skipped, "a flow node cannot revive it");
    }

    /// The reported failure, reproduced and then parked: a row whose check is a
    /// placeholder used to error, error the aggregate, and abort the flow before its last
    /// node. Parked, it cannot.
    #[tokio::test]
    async fn a_disabled_row_cannot_abort_a_flow() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", &stub_times(200, "{}", 3).await, "POST");
        let mut dataset = dataset_of(vec![
            ("finished", Some("{}"), Some("200")),
            // `??` is not digits, so it is read as a Rhai expression and will not parse.
            ("still drafting", Some("{}"), Some("??")),
        ]);
        dataset.rows[1].disabled = true;
        tc.dataset = Some(dataset);
        let after = make_test_case("after", "Downstream", &stub_once(200, "{}").await, "POST");
        let repo = MockTestCaseRepository::new().with_test_case(tc).with_test_case(after);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("b", "testCase", serde_json::json!({
                "testCaseId": "tc", "config": {"forEachRow": true}
            })),
            make_node("c", "testCase", serde_json::json!({"testCaseId": "after"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "b", None),
            make_edge("e2", "b", "c", Some("success")),
            make_edge("e3", "c", "end", Some("success")),
        ]);

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        assert_eq!(result.status, "completed");
        assert!(
            result.results.iter().any(|r| r.node_id == "c"),
            "the node after the fan-out must still run"
        );
    }

    /// Nothing was sent, so there is nothing to be green about. Reachable before parking
    /// existed — mark every row `needs_flow` and run the dataset — and routine once a
    /// whole dataset can be parked while it is reworked.
    #[tokio::test]
    async fn a_dataset_with_every_row_parked_is_not_a_pass() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        let mut dataset = dataset_of(vec![("one", Some("{}"), None), ("two", Some("{}"), None)]);
        dataset.rows[0].disabled = true;
        dataset.rows[1].disabled = true;
        tc.dataset = Some(dataset);

        let aggregate = engine
            .execute_test_case_dataset(&tc, HashMap::new(), HashMap::new())
            .await;

        // A refused port: had either row been sent, this would be an error rather than
        // the skip it must be.
        assert_eq!(aggregate.status, NodeStatus::Skipped);
        assert!(
            aggregate.error_message.as_deref().unwrap_or("").contains("No rows ran"),
            "{:?}",
            aggregate.error_message
        );
    }

    /// The serde exception, so a dataset written before parking existed is untouched.
    #[tokio::test]
    async fn an_ordinary_row_stores_nothing_for_disabled() {
        let plain = DataRow { id: "r1".into(), ..Default::default() };
        assert!(!serde_json::to_string(&plain).unwrap().contains("disabled"));

        let parked = DataRow { id: "r1".into(), disabled: true, ..Default::default() };
        let json = serde_json::to_string(&parked).unwrap();
        assert!(json.contains("\"disabled\":true"), "{}", json);
        assert!(serde_json::from_str::<DataRow>(&json).unwrap().disabled);
    }

    /// The point of the feature: the editor's run leaves the marked row alone and stays
    /// green, instead of reporting a failure that says nothing about the request.
    #[tokio::test]
    async fn a_row_that_needs_a_flow_is_skipped_by_the_editors_run() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", &stub_once(401, "{}").await, "POST");
        tc.dataset = Some(dataset_with_a_row_needing_a_flow());

        let aggregate = engine
            .execute_test_case_dataset(&tc, HashMap::new(), HashMap::new())
            .await;
        let rows = aggregate.iterations.as_ref().unwrap();

        assert_eq!(rows.len(), 2, "the skipped row is still reported");
        assert_eq!(rows[0].status, NodeStatus::Passed);

        let skipped = &rows[1];
        assert_eq!(skipped.status, NodeStatus::Skipped);
        assert!(skipped.request.is_none(), "nothing may be sent");
        assert_eq!(skipped.row_index, Some(1));
        assert_eq!(skipped.row_label.as_deref(), Some("needs a login"));
        assert!(
            skipped.error_message.as_deref().unwrap_or("").contains("Needs a flow"),
            "{:?}",
            skipped.error_message
        );

        // And the run is not a failure. Without this the feature would swap one kind of
        // false red for another.
        assert_eq!(aggregate.status, NodeStatus::Passed);
        assert!(aggregate.error_message.is_none(), "{:?}", aggregate.error_message);
    }

    /// The flag says *where* a row can run, so a flow — which is the precondition —
    /// runs it like any other row.
    #[tokio::test]
    async fn a_flow_node_runs_a_row_that_needs_a_flow() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", &stub_times(202, "{}", 2).await, "POST");
        let mut dataset = dataset_with_a_row_needing_a_flow();
        dataset.rows[0].check = Some("202".to_string()); // both pass against the stub
        tc.dataset = Some(dataset);
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let rows = engine
            .execute_flow(
                "exec1",
                &one_node_flow("tc", serde_json::json!({"forEachRow": true})),
                &repo,
                HashMap::new(),
                HashMap::new(),
                None,
            )
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
            .iterations
            .unwrap();

        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter().all(|r| r.status == NodeStatus::Passed),
            "{:?}",
            rows.iter().map(|r| (&r.row_label, &r.status)).collect::<Vec<_>>()
        );
        assert!(rows.iter().all(|r| r.request.is_some()), "both rows were sent");
    }

    #[test]
    fn an_ordinary_row_stores_nothing_for_the_flag() {
        // Every dataset written before the flag existed must behave as it did, which
        // means the default is "runs anywhere" and it isn't serialised.
        let row = DataRow { id: "r0".into(), ..Default::default() };
        assert!(!row.needs_flow);
        let json = serde_json::to_string(&row).unwrap();
        assert!(!json.contains("needs_flow"), "{}", json);

        // And it round-trips when it is set.
        let marked = DataRow { id: "r1".into(), needs_flow: true, ..Default::default() };
        let json = serde_json::to_string(&marked).unwrap();
        assert!(json.contains("\"needs_flow\":true"), "{}", json);
        assert!(serde_json::from_str::<DataRow>(&json).unwrap().needs_flow);
    }

    // ===================== fan-out: a dataset inside a flow =====================

    /// A row that couldn't run at all is systemic, not a per-case outcome — so the
    /// aggregate is Error and the flow stops. Cleanup still happens, which is what makes
    /// stopping safe rather than destructive.
    #[tokio::test]
    async fn one_errored_row_stops_the_flow_but_teardown_still_runs() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        tc.dataset = Some(dataset_of(vec![("one", Some("{}"), None), ("two", Some("{}"), None)]));
        let after = make_test_case("after", "Downstream", &stub_once(200, "{}").await, "POST");
        let cleanup = make_test_case("cleanup", "Cleanup", &stub_once(200, "{}").await, "DELETE");
        let repo = MockTestCaseRepository::new()
            .with_test_case(tc)
            .with_test_case(after)
            .with_test_case(cleanup);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("b", "testCase", serde_json::json!({
                "testCaseId": "tc", "config": {"forEachRow": true}
            })),
            make_node("c", "testCase", serde_json::json!({"testCaseId": "after"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "cleanup", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "b", None),
            make_edge("e2", "b", "c", Some("success")),
            make_edge("e3", "c", "end", Some("success")),
        ]);

        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;

        let fanned = results.iter().find(|r| r.node_id == "b").unwrap();
        assert_eq!(fanned.status, NodeStatus::Error);
        assert!(results.iter().all(|r| r.node_id != "c"), "the flow stopped");
        let cleanup = results.iter().find(|r| r.node_id == "t").expect("cleanup still ran");
        assert_eq!(cleanup.teardown, Some(true));
    }

    /// A fan-out teardown node is guarded per row: a row's own body or URL suffix could
    /// aim a delete at a leftover id the test case knows nothing about.
    #[tokio::test]
    async fn a_fanned_out_teardown_node_is_still_guarded() {
        let engine = ExecutionEngine::new(false, None);
        let mut del = make_test_case("del", "Delete", "http://127.0.0.1:1/accounts", "DELETE");
        let mut dataset = dataset_of(vec![("by id", None, None)]);
        // The id lives in the row's URL suffix, not in the test case's endpoint.
        dataset.rows[0].path = Some("/{{new_account_id}}".to_string());
        del.dataset = Some(dataset);
        let repo = MockTestCaseRepository::new().with_test_case(del);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({
                "testCaseId": "del",
                "config": {"outputVars": [{"name": "new_account_id", "path": "$.id"}]}
            })),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "del", "config": {"teardown": true, "forEachRow": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "end", Some("success")),
        ]);

        // new_account_id is declared by node "a" but never produced (it errors), so the
        // teardown row must not be sent.
        let mut env = HashMap::new();
        env.insert("new_account_id".to_string(), serde_json::json!("acct-from-a-previous-run"));
        let results = engine
            .execute_flow("exec1", &flow, &repo, env, HashMap::new(), None)
            .await
            .unwrap()
            .results;

        let cleanup = results.iter().find(|r| r.node_id == "t").expect("teardown was reached");
        assert_eq!(cleanup.status, NodeStatus::Skipped);
        assert!(cleanup.request.is_none(), "a stale id must never be deleted");
        assert!(
            cleanup.error_message.as_deref().unwrap_or("").contains("environment/globals"),
            "{:?}",
            cleanup.error_message
        );
    }


    /// `start → b → end`, where `b` carries `config`. One node, so nothing upstream
    /// can consume a stub's response or abort traversal before the fan-out runs.
    fn one_node_flow(tc_id: &str, config: serde_json::Value) -> Flow {
        let mut data = serde_json::json!({"testCaseId": tc_id});
        if let Some(o) = data.as_object_mut() { o.insert("config".into(), config); }
        make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("b", "testCase", data),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "b", None),
            make_edge("e2", "b", "end", Some("success")),
        ])
    }

    /// Build `start → a → b → end`, where `b` carries `config`.
    fn fan_out_flow(a_id: &str, b_id: &str, a_config: serde_json::Value, b_config: serde_json::Value) -> Flow {
        let mut a_data = serde_json::json!({"testCaseId": a_id});
        let mut b_data = serde_json::json!({"testCaseId": b_id});
        if let Some(o) = a_data.as_object_mut() { o.insert("config".into(), a_config); }
        if let Some(o) = b_data.as_object_mut() { o.insert("config".into(), b_config); }
        make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", a_data),
            make_node("b", "testCase", b_data),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "b", Some("success")),
            make_edge("e3", "b", "end", Some("success")),
        ])
    }

    #[test]
    fn an_absent_row_list_means_every_row() {
        let off = make_node("n", "testCase", serde_json::json!({}));
        assert_eq!(fan_out(&off), FanOut::Off);

        let all = make_node("n", "testCase", serde_json::json!({"config": {"forEachRow": true}}));
        assert_eq!(fan_out(&all), FanOut::AllRows);

        // An empty list is not "all" — it is "none", and the node says so.
        let none = make_node("n", "testCase", serde_json::json!({
            "config": {"forEachRow": true, "rowIds": []}
        }));
        assert_eq!(fan_out(&none), FanOut::Rows(vec![]));

        // Blanks dropped, duplicates collapsed.
        let some = make_node("n", "testCase", serde_json::json!({
            "config": {"forEachRow": true, "rowIds": ["r1", "  ", "r1", " r0 "]}
        }));
        assert_eq!(fan_out(&some), FanOut::Rows(vec!["r1".into(), "r0".into()]));
    }

    /// The whole point of the feature: a row inherits what an earlier node produced.
    /// Without this, a dataset can only ever test requests that need no setup.
    #[tokio::test]
    async fn a_fanned_out_row_sees_what_an_earlier_node_produced() {
        let engine = ExecutionEngine::new(false, None);

        let login = make_test_case("login", "Login", &stub_once(200, r#"{"token":"T-42"}"#).await, "POST");
        let mut sms = make_test_case("sms", "Send SMS", &stub_times(200, "{}", 2).await, "POST");
        sms.headers = serde_json::json!({"Authorization": "Bearer {{token}}"});
        sms.dataset = Some(dataset_of(vec![
            ("first", Some(r#"{"n":1}"#), None),
            ("second", Some(r#"{"n":2}"#), None),
        ]));
        let repo = MockTestCaseRepository::new().with_test_case(login).with_test_case(sms);

        let flow = fan_out_flow(
            "login",
            "sms",
            serde_json::json!({"outputVars": [{"name": "token", "path": "$.token"}]}),
            serde_json::json!({"forEachRow": true}),
        );
        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;

        let fanned = results.iter().find(|r| r.node_id == "b").expect("the sms node ran");
        let rows = fanned.iterations.as_ref().expect("one result per row");
        assert_eq!(rows.len(), 2);
        for row in rows {
            let auth = row.request.as_ref().unwrap().headers.get("Authorization");
            assert_eq!(auth.map(String::as_str), Some("Bearer T-42"), "{:?}", row.row_label);
        }
        assert_eq!(fanned.status, NodeStatus::Passed);
    }

    #[tokio::test]
    async fn a_node_can_run_a_chosen_subset_of_rows() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        tc.dataset = Some(dataset_of(vec![
            ("one", Some(r#"{"n":1}"#), None),
            ("two", Some(r#"{"n":2}"#), None),
            ("three", Some(r#"{"n":3}"#), None),
        ]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        // Selected out of order on purpose: results come back in dataset order.
        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true, "rowIds": ["r2", "r0"]
        }));
        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;

        let rows = results.iter().find(|r| r.node_id == "b").unwrap().iterations.clone().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter().map(|r| r.row_index).collect::<Vec<_>>(),
            vec![Some(0), Some(2)],
            "dataset order, not selection order"
        );
    }

    /// A row left out of the selection produces no result at all, unlike a parked one
    /// which is reported as skipped. The only other clue is a gap in the row numbers,
    /// and that reads as "the last one didn't run" when it was really a middle one — so
    /// the node says which rows it left out.
    #[tokio::test]
    async fn a_node_says_which_rows_its_selection_left_out() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", &stub_times(200, "{}", 3).await, "POST");
        tc.dataset = Some(dataset_of(vec![
            ("one", Some("{}"), Some("200")),
            ("two", Some("{}"), Some("200")),
            ("three", Some("{}"), Some("200")),
        ]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true, "rowIds": ["r2"]
        }));

        let aggregate = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        let logs = aggregate.logs.join("\n");
        assert!(logs.contains("Running 1 of the 3 data rows"), "{}", logs);
        // Named by their place in the dataset, which is how the results table numbers
        // them — "rows 1, 2" beside results starting at 3.
        assert!(logs.contains("row(s) 1, 2 are not selected"), "{}", logs);
    }

    /// Running every row says nothing: there is nothing left out to report.
    #[tokio::test]
    async fn a_node_running_every_row_says_nothing_about_selection() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", &stub_times(200, "{}", 3).await, "POST");
        tc.dataset = Some(dataset_of(vec![
            ("one", Some("{}"), Some("200")),
            ("two", Some("{}"), Some("200")),
        ]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true, "rowIds": ["r0", "r1"]
        }));

        let aggregate = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        assert!(!aggregate.logs.join("\n").contains("not selected"), "{:?}", aggregate.logs);
    }

    #[tokio::test]
    async fn a_selected_row_that_no_longer_exists_is_named_not_dropped() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        tc.dataset = Some(dataset_of(vec![("one", Some("{}"), None)]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true, "rowIds": ["r0", "ghost"]
        }));
        let node = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        // The surviving row still runs — a stale id doesn't cancel real work.
        assert_eq!(node.iterations.as_ref().unwrap().len(), 1);
        let logs = node.logs.join("\n");
        assert!(logs.contains("ghost"), "{}", logs);
        assert!(logs.contains("no longer"), "{}", logs);
    }

    #[tokio::test]
    async fn a_selection_that_matches_nothing_fails_the_node() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", "http://127.0.0.1:1/send", "POST");
        tc.dataset = Some(dataset_of(vec![("one", Some("{}"), None)]));
        let repo = MockTestCaseRepository::new().with_test_case(tc.clone());

        for row_ids in [serde_json::json!(["ghost"]), serde_json::json!([])] {
            let flow = one_node_flow("tc", serde_json::json!({
                "forEachRow": true, "rowIds": row_ids
            }));
            let node = engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap()
                .results
                .into_iter()
                .find(|r| r.node_id == "b")
                .unwrap();

            // Failed, not Error: nothing broke, and the request must not be sent as
            // authored — that would be a different test reported as this one.
            assert_eq!(node.status, NodeStatus::Failed);
            assert!(node.request.is_none(), "nothing may be sent");
            assert!(node.iterations.is_none(), "an empty matrix is worse than none");
            assert!(
                node.error_message.as_deref().unwrap_or("").contains("nothing ran"),
                "{:?}",
                node.error_message
            );
        }
    }

    #[tokio::test]
    async fn a_node_marked_for_rows_on_a_request_without_any_runs_once() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "Send", &stub_once(200, "{}").await, "POST");
        tc.payload = Some(r#"{"authored":true}"#.to_string());
        tc.dataset = None;
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({"forEachRow": true}));
        let node = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        assert!(node.iterations.is_none());
        assert_eq!(
            node.request.as_ref().unwrap().body.as_deref(),
            Some(r#"{"authored":true}"#)
        );
        assert!(node.logs.join("\n").contains("no data rows"), "{:?}", node.logs);
    }

    /// A row with no Expect of its own falls back to the node's — which is what lets one
    /// dataset serve two actors: 200 for a super user, 403 for an org admin.
    #[tokio::test]
    async fn a_row_without_its_own_expect_falls_back_to_the_nodes() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "List", &stub_times(403, "{}", 2).await, "GET");
        tc.dataset = Some(dataset_of(vec![
            ("inherits the node's", None, None),
            ("states its own", None, Some("200")),
        ]));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true, "check": "403"
        }));
        let rows = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
            .iterations
            .unwrap();

        assert_eq!(rows[0].status, NodeStatus::Passed, "{:?}", rows[0].error_message);
        // The row's own Expect still wins over the node's.
        assert_eq!(rows[1].status, NodeStatus::Failed);
    }

    /// The actor-varying case: one Expect authored on the row, each node supplying the
    /// value. Impossible until a check was interpolated like the URL and body already are.
    #[tokio::test]
    async fn a_check_can_be_parameterised_by_a_node_input_var() {
        async fn verdict(expected: &str) -> NodeStatus {
            let engine = ExecutionEngine::new(false, None);
            let mut tc = make_test_case("tc", "List", &stub_once(200, r#"{"n":3}"#).await, "GET");
            tc.dataset = Some(dataset_of(vec![(
                "count depends on who is asking",
                None,
                Some("response.json.n == {{expected_count}}"),
            )]));
            let repo = MockTestCaseRepository::new().with_test_case(tc);
            let flow = one_node_flow("tc", serde_json::json!({
                "forEachRow": true,
                "inputVars": [{"key": "expected_count", "value": expected}]
            }));
            engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap()
                .results
                .into_iter()
                .find(|r| r.node_id == "b")
                .unwrap()
                .iterations
                .unwrap()
                .remove(0)
                .status
        }

        assert_eq!(verdict("3").await, NodeStatus::Passed);
        assert_eq!(verdict("12").await, NodeStatus::Failed);
    }

    // ------------------------------------------- what a step that runs twice hands forward

    /// Run a one-node fan-out and return its aggregate plus the flow context, which is
    /// what a *later* step would actually read.
    async fn collected(
        responses: Vec<(u16, &'static str)>,
        rows: Vec<(&str, Option<&str>, Option<&str>)>,
        config: serde_json::Value,
    ) -> (NodeResult, HashMap<String, Value>) {
        let url = stub_sequence(responses).await;
        let mut tc = make_test_case("tc", "Launch", &url, "POST");
        tc.dataset = Some(dataset_of(rows));
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let run = ExecutionEngine::new(false, None)
            .execute_flow("exec1", &one_node_flow("tc", config), &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();
        let context = run.context.clone();
        let node = run.results.into_iter().find(|r| r.node_id == "b").unwrap();
        (node, context)
    }

    fn records_of(node: &NodeResult, name: &str) -> Vec<Value> {
        node.exports
            .as_ref()
            .and_then(|e| e.get(name))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_else(|| panic!("no collection named {name}: {:?}", node.exports))
    }

    fn field(record: &Value, key: &str) -> String {
        record.get(key).and_then(|v| v.as_str()).unwrap_or("<absent>").to_string()
    }

    fn launch_config(fields: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "forEachRow": true,
            "collect": { "into": "launched" },
            "outputVars": fields,
        })
    }

    #[tokio::test]
    async fn a_fan_out_collects_one_record_per_row() {
        // The whole complaint: two campaigns launched, and no way to get their ids out.
        // Every row's captures used to be written into a context clone that was dropped
        // at the end of the iteration.
        let (node, context) = collected(
            vec![(202, r#"{"data":{"campaignId":"c-8871"}}"#), (202, r#"{"data":{"campaignId":"c-8872"}}"#)],
            vec![("10 recipients", Some("{}"), None), ("100 recipients", Some("{}"), None)],
            launch_config(serde_json::json!([{"name": "campaignId", "path": "$.data.campaignId"}])),
        )
        .await;

        let records = records_of(&node, "launched");
        assert_eq!(records.len(), 2);
        // In run order, so the list lines up with the report above it.
        assert_eq!(field(&records[0], "campaignId"), "c-8871");
        assert_eq!(field(&records[1], "campaignId"), "c-8872");

        // And it reached the flow context, which is the only reason any of this matters:
        // a later step resolves from there, not from the aggregate.
        assert!(context.contains_key("launched"), "not in the flow context: {context:?}");
    }

    #[tokio::test]
    async fn a_record_keeps_two_captures_from_the_same_row_together() {
        // The author's devil's advocate, and the reason this is a record and not two
        // arrays. Parallel `campaignIds` / `txnIds` would hold the pairing and be unable
        // to express it: the interpolation regex has no brackets, so the second run could
        // never ask for *its* txnId.
        let (node, _) = collected(
            vec![
                (202, r#"{"data":{"campaignId":"c-8871","txnId":"t-41"}}"#),
                (202, r#"{"data":{"campaignId":"c-8872","txnId":"t-42"}}"#),
            ],
            vec![("first", Some("{}"), None), ("second", Some("{}"), None)],
            launch_config(serde_json::json!([
                {"name": "campaignId", "path": "$.data.campaignId"},
                {"name": "txnId", "path": "$.data.txnId"},
            ])),
        )
        .await;

        let records = records_of(&node, "launched");
        // Not "both ids are somewhere in the data" — c-8872 is paired with t-42 and with
        // nothing else.
        assert_eq!(field(&records[1], "campaignId"), "c-8872");
        assert_eq!(field(&records[1], "txnId"), "t-42");
        assert_eq!(field(&records[0], "txnId"), "t-41");
    }

    #[tokio::test]
    async fn a_record_carries_every_field_the_author_picked_out_of_one_response() {
        // "one campaign response returns multiple fields as a json, few of which are
        // useful for a next node, rather than one single like a campaignid."
        let (node, _) = collected(
            vec![(202, r#"{"data":{"campaignId":"c-1","txnId":"t-1","status":"QUEUED","channel":"SMS"}}"#)],
            vec![("one", Some("{}"), None)],
            launch_config(serde_json::json!([
                {"name": "campaignId", "path": "$.data.campaignId"},
                {"name": "txnId", "path": "$.data.txnId"},
                {"name": "status", "path": "$.data.status"},
                {"name": "channel", "path": "$.data.channel"},
            ])),
        )
        .await;

        let records = records_of(&node, "launched");
        assert_eq!(field(&records[0], "campaignId"), "c-1");
        assert_eq!(field(&records[0], "txnId"), "t-1");
        assert_eq!(field(&records[0], "status"), "QUEUED");
        assert_eq!(field(&records[0], "channel"), "SMS");
    }

    #[tokio::test]
    async fn a_collection_is_a_list_even_with_one_row_and_one_field() {
        // A one-row fan-out yielding a bare scalar would silently change shape the day a
        // second row is added — and every step reading it would break at once.
        let (node, _) = collected(
            vec![(202, r#"{"data":{"campaignId":"c-1"}}"#)],
            vec![("only", Some("{}"), None)],
            launch_config(serde_json::json!([{"name": "campaignId", "path": "$.data.campaignId"}])),
        )
        .await;

        let value = node.exports.as_ref().unwrap().get("launched").unwrap();
        assert!(value.is_array(), "should be a list of one, not a scalar: {value}");
        assert_eq!(value.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn each_record_names_the_row_that_produced_it() {
        // So a failure three steps later reads "the 100-recipients campaign's status check
        // failed" rather than "iteration 2 failed".
        let (node, _) = collected(
            vec![(202, r#"{"data":{"campaignId":"c-1"}}"#), (202, r#"{"data":{"campaignId":"c-2"}}"#)],
            vec![("10 recipients", Some("{}"), None), ("100 recipients", Some("{}"), None)],
            launch_config(serde_json::json!([{"name": "campaignId", "path": "$.data.campaignId"}])),
        )
        .await;

        let records = records_of(&node, "launched");
        assert_eq!(field(&records[0], "_row"), "10 recipients");
        assert_eq!(field(&records[1], "_row"), "100 recipients");
    }

    #[tokio::test]
    async fn a_row_that_failed_contributes_no_record_and_the_tally_says_so() {
        // An id from a request that failed is not an id anything can be verified against.
        // The tally is what stops a short list from being mistaken for a complete one.
        let (node, _) = collected(
            vec![(202, r#"{"data":{"campaignId":"c-1"}}"#), (500, r#"{"data":{"campaignId":"c-2"}}"#)],
            vec![("good", Some("{}"), None), ("bad", Some("{}"), None)],
            launch_config(serde_json::json!([{"name": "campaignId", "path": "$.data.campaignId"}])),
        )
        .await;

        let records = records_of(&node, "launched");
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!(field(&records[0], "campaignId"), "c-1");
        let logs = node.logs.join("\n");
        assert!(logs.contains("1 record(s) from 2 row(s)"), "{logs}");
    }

    #[tokio::test]
    async fn a_path_that_matched_nothing_leaves_its_field_out_rather_than_null() {
        // A null would interpolate downstream as the four characters "null" and be sent to
        // a real API. Absent means the consumer's {{txnId}} stays unresolved and is
        // reported as such.
        let (node, _) = collected(
            vec![(202, r#"{"data":{"campaignId":"c-1"}}"#)],
            vec![("one", Some("{}"), None)],
            launch_config(serde_json::json!([
                {"name": "campaignId", "path": "$.data.campaignId"},
                {"name": "txnId", "path": "$.data.txn_id"},
            ])),
        )
        .await;

        let records = records_of(&node, "launched");
        assert_eq!(field(&records[0], "campaignId"), "c-1");
        assert!(records[0].get("txnId").is_none(), "should be absent, not null: {:?}", records[0]);
        let logs = node.logs.join("\n");
        // Named once for the step, not once per run — see the mixed-dataset test below.
        assert!(logs.contains("\"txnId\" is missing from the record for one"), "{logs}");
    }

    #[tokio::test]
    async fn a_path_that_matched_several_takes_the_first_and_says_so() {
        // Making this one field a list while its siblings stay scalars is the
        // shape-varying trap. Take the first and name what happened.
        let (node, _) = collected(
            vec![(202, r#"{"data":{"campaigns":[{"id":"c-1"},{"id":"c-2"},{"id":"c-3"}]}}"#)],
            vec![("one", Some("{}"), None)],
            launch_config(serde_json::json!([{"name": "campaignId", "path": "$.data.campaigns[*].id"}])),
        )
        .await;

        let records = records_of(&node, "launched");
        assert_eq!(records.len(), 1);
        assert_eq!(field(&records[0], "campaignId"), "c-1");
        let logs = node.logs.join("\n");
        assert!(logs.contains("matched more than one value"), "{logs}");
    }

    #[tokio::test]
    async fn runs_that_produced_no_record_are_named_once_not_warned_about_each() {
        // The dataset this feature exists for: negative cases expecting a 400 sitting beside
        // positive ones that launch something. A 400 that was expected *passes* and has no id
        // to give, which is correct — so one warning per such row is a wall of noise about a
        // run doing exactly what it was told, and a warning that is usually wrong is one
        // nobody reads.
        let (node, _) = collected(
            vec![
                (202, r#"{"campaignId":"c-1"}"#),
                (400, r#"{"message":"name is required"}"#),
                (400, r#"{"message":"msg is required"}"#),
                (202, r#"{"campaignId":"c-2"}"#),
            ],
            vec![
                ("good one", Some("{}"), None),
                ("missing name", Some("{}"), Some("400")),
                ("missing msg", Some("{}"), Some("400")),
                ("good two", Some("{}"), None),
            ],
            launch_config(serde_json::json!([{"name": "campaignId", "path": "$.campaignId"}])),
        )
        .await;

        // All four passed; only the two that had an id contributed.
        assert_eq!(node.status, NodeStatus::Passed);
        assert_eq!(records_of(&node, "launched").len(), 2);

        let logs = node.logs.join("\n");
        assert!(logs.contains("2 record(s) from 4 row(s)"), "{logs}");
        // One line, naming both rows.
        assert!(
            logs.contains("2 of 4 run(s) produced none of \"launched\"'s fields"),
            "{logs}"
        );
        assert!(logs.contains("missing name, missing msg"), "{logs}");
        // And emphatically not one per row. Row-scoped lines carry a "[label] " prefix, so
        // *any* collection complaint wearing one means the noise is back — whatever its
        // wording. Pinned this way rather than by counting one phrase, which a differently
        // worded regression would walk straight past.
        let per_row: Vec<&String> = node
            .logs
            .iter()
            .filter(|l| l.starts_with('['))
            .filter(|l| {
                let l = l.to_lowercase();
                l.contains("collect") || l.contains("launched") || l.contains("campaignid")
            })
            .collect();
        assert!(per_row.is_empty(), "said per row after all: {per_row:?}");
    }

    #[tokio::test]
    async fn a_collect_condition_keeps_out_runs_that_passed_without_producing_anything() {
        // The author's point, exactly: "a 400 on a campaign launch means no campaign was
        // created, but the test case assertion passed." Passing is the floor, not the bar.
        //
        // Without a condition this works only by accident — a 400 body happens not to carry a
        // `campaignId`. Here it does carry one, which is the case that breaks the accident: an
        // API echoing the id back in its error body would send every rejected launch to the
        // verify step.
        let (node, _) = collected(
            vec![
                (202, r#"{"campaignId":"real-1"}"#),
                (400, r#"{"campaignId":"echoed-back","message":"name is required"}"#),
                (202, r#"{"campaignId":"real-2"}"#),
            ],
            vec![
                ("good", Some("{}"), None),
                ("missing name", Some("{}"), Some("400")),
                ("also good", Some("{}"), None),
            ],
            serde_json::json!({
                "forEachRow": true,
                "collect": { "into": "launched", "when": "response.status == 202" },
                "outputVars": [{"name": "campaignId", "path": "$.campaignId"}],
            }),
        )
        .await;

        // All three rows passed — the 400 was expected.
        assert_eq!(node.status, NodeStatus::Passed);
        let records = records_of(&node, "launched");
        assert_eq!(records.len(), 2, "the rejected launch must not be in here: {records:?}");
        assert_eq!(field(&records[0], "campaignId"), "real-1");
        assert_eq!(field(&records[1], "campaignId"), "real-2");
        assert!(
            !records.iter().any(|r| field(r, "campaignId") == "echoed-back"),
            "{records:?}"
        );

        // Said once, and not as a warning — the condition doing its job is not a problem.
        let logs = node.logs.join("\n");
        assert!(logs.contains("1 of 3 run(s) did not meet"), "{logs}");
        assert!(logs.contains("missing name"), "{logs}");
    }

    #[tokio::test]
    async fn no_collect_condition_means_any_run_that_passed() {
        // The guard on the other side: every step written before the condition existed has no
        // condition, and must behave exactly as it did.
        let (node, _) = collected(
            vec![(400, r#"{"campaignId":"echoed-back"}"#)],
            vec![("negative", Some("{}"), Some("400"))],
            launch_config(serde_json::json!([{"name": "campaignId", "path": "$.campaignId"}])),
        )
        .await;
        assert_eq!(records_of(&node, "launched").len(), 1);
    }

    #[tokio::test]
    async fn a_broken_collect_condition_collects_nothing_and_says_why_once() {
        // Neither true nor false is a broken condition, not a verdict. The tool does not guess:
        // the collection ends up absent and the consuming step fails naming it.
        let (node, context) = collected(
            vec![(202, r#"{"campaignId":"c-1"}"#), (202, r#"{"campaignId":"c-2"}"#)],
            vec![("one", Some("{}"), None), ("two", Some("{}"), None)],
            serde_json::json!({
                "forEachRow": true,
                "collect": { "into": "launched", "when": "response.status" },
                "outputVars": [{"name": "campaignId", "path": "$.campaignId"}],
            }),
        )
        .await;

        assert!(node.exports.is_none(), "{:?}", node.exports);
        assert!(!context.contains_key("launched"));
        let logs = node.logs.join("\n");
        assert!(logs.contains("could not be judged"), "{logs}");
        // Once for the step, not once per run.
        assert_eq!(logs.matches("could not be judged").count(), 1, "{logs}");
        // The requests themselves were fine, so the step is not failed by a bad condition.
        assert_eq!(node.status, NodeStatus::Passed);
    }

    #[tokio::test]
    async fn a_collect_condition_is_interpolated_like_every_other_expression() {
        let (node, _) = collected(
            vec![(202, r#"{"campaignId":"c-1"}"#), (400, r#"{"campaignId":"nope"}"#)],
            vec![("good", Some("{}"), None), ("bad", Some("{}"), Some("400"))],
            serde_json::json!({
                "forEachRow": true,
                "inputVars": [{"key": "created", "value": "202"}],
                "collect": { "into": "launched", "when": "response.status == {{created}}" },
                "outputVars": [{"name": "campaignId", "path": "$.campaignId"}],
            }),
        )
        .await;
        let records = records_of(&node, "launched");
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!(field(&records[0], "campaignId"), "c-1");
    }

    #[tokio::test]
    async fn a_condition_with_nothing_to_collect_says_it_does_nothing() {
        let (node, _) = collected(
            vec![(202, r#"{"campaignId":"c-1"}"#)],
            vec![("one", Some("{}"), None)],
            serde_json::json!({
                "forEachRow": true,
                "collect": { "when": "response.status == 202" },
            }),
        )
        .await;
        assert!(node.logs.join("\n").contains("condition is set but nothing is being collected"));
    }

    #[tokio::test]
    async fn nothing_collected_leaves_the_variable_absent_rather_than_empty() {
        // An empty list reads as "the API returned nothing" — a different bug with a
        // different fix. Absent is what the consuming step can name and point at.
        let (node, context) = collected(
            vec![(202, r#"{"data":{}}"#)],
            vec![("one", Some("{}"), None)],
            launch_config(serde_json::json!([{"name": "campaignId", "path": "$.data.campaignId"}])),
        )
        .await;

        assert!(node.exports.is_none(), "{:?}", node.exports);
        assert!(!context.contains_key("launched"), "{context:?}");
        let logs = node.logs.join("\n");
        assert!(logs.contains("Nothing was collected into \"launched\""), "{logs}");
    }

    #[tokio::test]
    async fn output_variables_with_no_collection_name_say_where_to_put_them() {
        // Was `output_variables_on_a_fanned_out_node_say_they_captured_nothing`, and the
        // same failure mode: fields with nowhere to go, whose only symptom is {{name}}
        // arriving literally at a later node. The advice now names a control that exists.
        let (node, _) = collected(
            vec![(200, r#"{"token":"T"}"#)],
            vec![("one", Some("{}"), None)],
            serde_json::json!({
                "forEachRow": true,
                "outputVars": [{"name": "token", "path": "$.token"}],
            }),
        )
        .await;

        let logs = node.logs.join("\n");
        assert!(logs.contains("token"), "{logs}");
        assert!(logs.contains("Collect into"), "{logs}");
        assert!(node.exports.is_none(), "nowhere to put it, so nothing is carried forward");
    }

    #[tokio::test]
    async fn a_collection_with_no_fields_says_it_has_nothing_to_gather() {
        // The other half-configured shape: a name and no paths.
        let (node, _) = collected(
            vec![(200, r#"{"token":"T"}"#)],
            vec![("one", Some("{}"), None)],
            serde_json::json!({
                "forEachRow": true,
                "collect": { "into": "launched" },
            }),
        )
        .await;

        let logs = node.logs.join("\n");
        assert!(logs.contains("\"launched\" has no fields to collect"), "{logs}");
        assert!(node.exports.is_none());
    }

    // -------------------------------------------------- walking what the last step collected

    /// Node A fans out over `rows` and collects; node B walks the collection. Returns
    /// both aggregates and every endpoint B actually asked for.
    async fn collect_then_walk(
        launch_responses: Vec<(u16, &'static str)>,
        rows: Vec<(&str, Option<&str>, Option<&str>)>,
        launch_fields: serde_json::Value,
        verify_endpoint: &str,
        verify_config: serde_json::Value,
    ) -> (NodeResult, NodeResult) {
        let launch_url = stub_sequence(launch_responses).await;
        let verify_url = stub_times(200, r#"{"status":"RUNNING"}"#, 8).await;

        let mut a = make_test_case("a", "Launch", &launch_url, "POST");
        a.dataset = Some(dataset_of(rows));
        let b = make_test_case(
            "b",
            "Status",
            &format!("{}{}", verify_url, verify_endpoint),
            "GET",
        );
        let repo = MockTestCaseRepository::new().with_test_case(a).with_test_case(b);

        let flow = fan_out_flow(
            "a",
            "b",
            launch_config_with("launched", launch_fields),
            verify_config,
        );
        let run = ExecutionEngine::new(false, None)
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        let find = |id: &str| run.results.iter().find(|r| r.node_id == id).cloned();
        let launch = find("a").expect("launch node did not run");
        let verify = find("b").unwrap_or_else(|| {
            panic!("verify node did not run; launch said {:?}", launch.logs)
        });
        (launch, verify)
    }

    fn launch_config_with(into: &str, fields: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "forEachRow": true,
            "collect": { "into": into },
            "outputVars": fields,
        })
    }

    fn walked(verify: &NodeResult) -> Vec<NodeResult> {
        verify.iterations.clone().unwrap_or_else(|| {
            panic!("the verify step did not iterate: {:?}", verify.error_message)
        })
    }

    #[tokio::test]
    async fn a_step_runs_once_per_collected_record() {
        // The author's scenario, end to end: two campaigns launched, then a status call for
        // each. Before this, the ids existed only inside two dropped context clones.
        let (launch, verify) = collect_then_walk(
            vec![(202, r#"{"data":{"campaignId":"c-8871"}}"#), (202, r#"{"data":{"campaignId":"c-8872"}}"#)],
            vec![("10 recipients", Some("{}"), None), ("100 recipients", Some("{}"), None)],
            serde_json::json!([{"name": "campaignId", "path": "$.data.campaignId"}]),
            "/campaigns/{{campaignId}}/status",
            serde_json::json!({ "forEach": { "list": "launched" } }),
        )
        .await;

        assert_eq!(launch.status, NodeStatus::Passed);
        let iterations = walked(&verify);
        assert_eq!(iterations.len(), 2, "one per launched campaign");
        assert_eq!(verify.status, NodeStatus::Passed);

        // Each iteration asked about its own campaign, in order.
        let asked: Vec<String> = iterations
            .iter()
            .map(|i| i.request.as_ref().unwrap().url.clone())
            .collect();
        assert!(asked[0].ends_with("/campaigns/c-8871/status"), "{asked:?}");
        assert!(asked[1].ends_with("/campaigns/c-8872/status"), "{asked:?}");
    }

    #[tokio::test]
    async fn an_iteration_sees_every_field_of_its_own_record() {
        // Two captures per response, and the second iteration must get the second row's
        // *pair* — the failure two parallel arrays could not avoid.
        let (_, verify) = collect_then_walk(
            vec![
                (202, r#"{"data":{"campaignId":"c-1","txnId":"t-1"}}"#),
                (202, r#"{"data":{"campaignId":"c-2","txnId":"t-2"}}"#),
            ],
            vec![("first", Some("{}"), None), ("second", Some("{}"), None)],
            serde_json::json!([
                {"name": "campaignId", "path": "$.data.campaignId"},
                {"name": "txnId", "path": "$.data.txnId"},
            ]),
            "/campaigns/{{campaignId}}/txn/{{txnId}}",
            serde_json::json!({ "forEach": { "list": "launched" } }),
        )
        .await;

        let asked: Vec<String> = walked(&verify)
            .iter()
            .map(|i| i.request.as_ref().unwrap().url.clone())
            .collect();
        assert!(asked[0].ends_with("/campaigns/c-1/txn/t-1"), "{asked:?}");
        // Not c-2/t-1, which is what zipping two arrays by index invites.
        assert!(asked[1].ends_with("/campaigns/c-2/txn/t-2"), "{asked:?}");
    }

    #[tokio::test]
    async fn an_iteration_is_labelled_by_the_row_that_produced_it() {
        // So a failing status check reads "100 recipients", not "Row 2".
        let (_, verify) = collect_then_walk(
            vec![(202, r#"{"data":{"campaignId":"c-1"}}"#), (202, r#"{"data":{"campaignId":"c-2"}}"#)],
            vec![("10 recipients", Some("{}"), None), ("100 recipients", Some("{}"), None)],
            serde_json::json!([{"name": "campaignId", "path": "$.data.campaignId"}]),
            "/campaigns/{{campaignId}}/status",
            serde_json::json!({ "forEach": { "list": "launched" } }),
        )
        .await;

        let labels: Vec<Option<String>> =
            walked(&verify).iter().map(|i| i.row_label.clone()).collect();
        assert_eq!(
            labels,
            vec![Some("10 recipients".to_string()), Some("100 recipients".to_string())]
        );
    }

    /// A one-node flow whose only step walks a list handed in as an execution variable.
    async fn walk_a_list(list: Value, config: serde_json::Value) -> NodeResult {
        let url = stub_times(200, r#"{"ok":true}"#, 8).await;
        let tc = make_test_case("tc", "Status", &format!("{url}/items/{{{{id}}}}"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", config);

        ExecutionEngine::new(false, None)
            .execute_flow(
                "exec1",
                &flow,
                &repo,
                HashMap::new(),
                HashMap::from([("things".to_string(), list)]),
                None,
            )
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
    }

    #[tokio::test]
    async fn a_list_of_plain_values_needs_a_name_for_each_one() {
        // A list from somewhere other than a collection — a project variable, a script.
        // Without a name there is no {{…}} for the endpoint to use.
        let list = serde_json::json!(["one", "two"]);
        let unnamed = walk_a_list(list.clone(), serde_json::json!({"forEach": {"list": "things"}})).await;
        assert_eq!(unnamed.status, NodeStatus::Failed);
        assert!(
            unnamed.error_message.as_deref().unwrap_or("").contains("needs a name"),
            "{:?}",
            unnamed.error_message
        );

        // Named, and it walks.
        let named = walk_a_list(list, serde_json::json!({"forEach": {"list": "things", "as": "id"}})).await;
        assert_eq!(named.iterations.as_ref().map(|i| i.len()), Some(2));
    }

    #[tokio::test]
    async fn the_list_name_is_forgiven_its_braces() {
        // Everyone types {{things}}, because that is how a variable is written everywhere
        // else in this app.
        let node = walk_a_list(
            serde_json::json!(["one"]),
            serde_json::json!({"forEach": {"list": "{{things}}", "as": "id"}}),
        )
        .await;
        assert_eq!(node.iterations.as_ref().map(|i| i.len()), Some(1), "{:?}", node.error_message);
    }

    #[tokio::test]
    async fn walking_a_missing_variable_fails_and_names_it() {
        // Not a silent zero-iteration pass: nothing ran, and the reason names the step that
        // should have run first.
        let node = walk_a_list(
            serde_json::json!(["one"]),
            serde_json::json!({"forEach": {"list": "launched", "as": "id"}}),
        )
        .await;
        assert_eq!(node.status, NodeStatus::Failed);
        let msg = node.error_message.unwrap_or_default();
        assert!(msg.contains("launched"), "{msg}");
        assert!(msg.contains("must run before this one"), "{msg}");
    }

    #[tokio::test]
    async fn walking_an_empty_list_fails_rather_than_passing_nothing() {
        // Nothing ran is not a pass — the same rule as a dataset whose every row is parked.
        let node = walk_a_list(
            serde_json::json!([]),
            serde_json::json!({"forEach": {"list": "things", "as": "id"}}),
        )
        .await;
        assert_eq!(node.status, NodeStatus::Failed);
        assert!(node.error_message.unwrap_or_default().contains("is empty"));
    }

    #[tokio::test]
    async fn walking_a_single_value_says_what_it_found() {
        let node = walk_a_list(
            serde_json::json!("c-8871"),
            serde_json::json!({"forEach": {"list": "things", "as": "id"}}),
        )
        .await;
        assert_eq!(node.status, NodeStatus::Failed);
        let msg = node.error_message.unwrap_or_default();
        assert!(msg.contains("single value (c-8871)"), "{msg}");
    }

    #[tokio::test]
    async fn a_blank_field_is_skipped_by_name_not_resolved_from_a_lower_tier() {
        // The dangerous one. Row vars filter blanks, so a blank element would leave {{id}}
        // resolving from the environment and send a confidently wrong request to a real API.
        let node = walk_a_list(
            serde_json::json!([{"id": "real"}, {"id": ""}]),
            serde_json::json!({"forEach": {"list": "things"}}),
        )
        .await;

        let iterations = node.iterations.clone().unwrap_or_default();
        assert_eq!(iterations.len(), 1, "the blank one must not have been sent");
        let logs = node.logs.join("\n");
        assert!(logs.contains("things[1] has no value for id"), "{logs}");
    }

    #[tokio::test]
    async fn the_row_a_record_came_from_labels_it_but_is_not_a_variable() {
        // `_row` is the record's origin, not something the author captured. Spreading it
        // would put a name nobody declared into the highest-priority tier, where it could
        // shadow a real value — and reserved names that behave like ordinary ones are how
        // that becomes a mystery rather than a bug.
        let url = stub_times(200, r#"{"ok":true}"#, 4).await;
        let tc = make_test_case("tc", "Status", &format!("{url}/items/{{{{_row}}}}"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({"forEach": {"list": "things"}}));

        let node = ExecutionEngine::new(true, None)
            .execute_flow(
                "exec1",
                &flow,
                &repo,
                HashMap::new(),
                HashMap::from([(
                    "things".to_string(),
                    serde_json::json!([{"id": "real", "_row": "10 recipients"}]),
                )]),
                None,
            )
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        // Not spread, so `{{_row}}` cannot be filled — and rather than sending those
        // fourteen literal characters to a real API, the item is not sent at all.
        assert!(node.iterations.clone().unwrap_or_default().is_empty(), "{:?}", node.iterations);
        assert_eq!(node.status, NodeStatus::Failed);
        let said = format!("{} {}", node.error_message.clone().unwrap_or_default(), node.logs.join("\n"));
        assert!(said.contains("_row"), "{said}");
    }

    #[tokio::test]
    async fn a_step_says_whether_its_iterations_are_rows_or_items() {
        // Every screen that renders `iterations` is the dataset's, and hard-codes the noun.
        // Without this a step walking a list reports "2/2 rows passed" about something with
        // no rows — in the one place an author looks to find out what ran.
        let items = walk_a_list(
            serde_json::json!(["a", "b"]),
            serde_json::json!({"forEach": {"list": "things", "as": "id"}}),
        )
        .await;
        assert_eq!(items.iterations_of.as_deref(), Some("item"));

        // And a real dataset fan-out leaves it absent, so nothing that reads history today
        // sees a new value.
        let (rows, _) = collected(
            vec![(200, r#"{"ok":true}"#)],
            vec![("one", Some("{}"), None)],
            serde_json::json!({"forEachRow": true}),
        )
        .await;
        assert!(rows.iterations_of.is_none(), "{:?}", rows.iterations_of);
    }

    #[tokio::test]
    async fn an_item_that_cannot_fill_the_request_is_not_sent() {
        // The real run this comes from: a mixed dataset collected with a whole-response field
        // (`$`), so every row produced a record — including the negative ones expecting a 400,
        // which have no campaignId. Seven iterations then sent
        // `/campaigns/{{campaignId}}/status` **literally** to a live API.
        //
        // Blank was only half the guard: a field absent from a record is not a blank value, so
        // the blank check never saw it. The engine warns about a literal placeholder and sends
        // anyway — right for a request an author wrote, wrong here, where the list wrote the
        // iteration and an item that cannot fill the request tests nothing.
        let node = walk_a_list(
            serde_json::json!([
                {"id": "real-1", "_row": "launched one"},
                {"other": "x", "_row": "a 400 with no id"},
                {"id": "real-2", "_row": "launched two"},
            ]),
            serde_json::json!({"forEach": {"list": "things"}}),
        )
        .await;

        let iterations = node.iterations.clone().unwrap_or_default();
        assert_eq!(iterations.len(), 2, "only the items that had an id: {iterations:?}");
        assert_eq!(iterations[0].row_label.as_deref(), Some("launched one"));
        assert_eq!(iterations[1].row_label.as_deref(), Some("launched two"));

        // Nothing went out with a literal placeholder in it.
        for row in &iterations {
            let url = row.request.as_ref().unwrap().url.clone();
            assert!(!url.contains("%7B%7B") && !url.contains("{{"), "{url}");
        }

        // And the one that was dropped is named, by the row that produced it, once.
        let logs = node.logs.join("\n");
        assert!(logs.contains("1 of 3 item(s)"), "{logs}");
        assert!(logs.contains("a 400 with no id (no id)"), "{logs}");
    }

    #[tokio::test]
    async fn a_name_the_flow_already_has_is_not_counted_as_missing() {
        // The other side of that guard: a record need not carry every name the request uses.
        // `{{id}}` comes from the item; anything else the flow already resolved is still
        // resolved, and refusing to send on that basis would break every ordinary case.
        let url = stub_times(200, r#"{"ok":true}"#, 4).await;
        let tc = make_test_case("tc", "Status", &format!("{url}/{{{{tenant}}}}/items/{{{{id}}}}"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({"forEach": {"list": "things", "as": "id"}}));

        let node = ExecutionEngine::new(false, None)
            .execute_flow(
                "exec1",
                &flow,
                &repo,
                HashMap::new(),
                HashMap::from([
                    ("things".to_string(), serde_json::json!(["a"])),
                    ("tenant".to_string(), serde_json::json!("acme")),
                ]),
                None,
            )
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        let iterations = node.iterations.clone().unwrap_or_default();
        assert_eq!(iterations.len(), 1, "{:?}", node.error_message);
        assert!(iterations[0].request.as_ref().unwrap().url.contains("/acme/items/a"));
    }

    #[tokio::test]
    async fn a_builtin_in_the_request_does_not_make_every_item_unfillable() {
        // Built-ins are generated per use, so no record and no tier "has" them. Counted among
        // the names a record must supply, `{{$UUID}}` alone would make every item look
        // unfillable and the whole step would refuse to send — a plausible endpoint
        // (`?nonce={{$UUID}}`) silently disabling the feature.
        let url = stub_times(200, r#"{"ok":true}"#, 4).await;
        let tc = make_test_case(
            "tc",
            "Status",
            &format!("{url}/items/{{{{id}}}}?nonce={{{{$UUID}}}}"),
            "GET",
        );
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({"forEach": {"list": "things", "as": "id"}}));

        let node = ExecutionEngine::new(false, None)
            .execute_flow(
                "exec1",
                &flow,
                &repo,
                HashMap::new(),
                HashMap::from([("things".to_string(), serde_json::json!(["a", "b"]))]),
                None,
            )
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        let iterations = node.iterations.clone().unwrap_or_default();
        assert_eq!(iterations.len(), 2, "{:?}", node.error_message);
        let asked = iterations[0].request.as_ref().unwrap().url.clone();
        assert!(asked.contains("/items/a?nonce="), "{asked}");
        assert!(!asked.contains("UUID"), "the built-in still resolved: {asked}");
    }

    #[tokio::test]
    async fn a_list_of_lists_is_refused() {
        let node = walk_a_list(
            serde_json::json!([["a", "b"]]),
            serde_json::json!({"forEach": {"list": "things", "as": "id"}}),
        )
        .await;
        assert_eq!(node.status, NodeStatus::Failed);
        assert!(node.error_message.unwrap_or_default().contains("holds lists"));
    }

    #[tokio::test]
    async fn both_fan_out_kinds_on_one_node_is_refused() {
        // Unreachable from the panel's three-way toggle, but config is JSON and a
        // hand-edited node must not quietly get one of them.
        let node = walk_a_list(
            serde_json::json!(["one"]),
            serde_json::json!({"forEach": {"list": "things", "as": "id"}, "forEachRow": true}),
        )
        .await;
        assert_eq!(node.status, NodeStatus::Failed);
        assert!(node.error_message.unwrap_or_default().contains("pick one"));
    }

    #[tokio::test]
    async fn a_step_that_walks_a_list_can_itself_collect() {
        // An item fan-out is a fan-out, so a chain of them needs no extra machinery.
        let url = stub_sequence(vec![
            (200, r#"{"detail":{"ref":"r-1"}}"#),
            (200, r#"{"detail":{"ref":"r-2"}}"#),
        ])
        .await;
        let tc = make_test_case("tc", "Status", &format!("{url}/items/{{{{id}}}}"), "GET");
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = one_node_flow("tc", serde_json::json!({
            "forEach": {"list": "things", "as": "id"},
            "collect": {"into": "refs"},
            "outputVars": [{"name": "ref", "path": "$.detail.ref"}],
        }));

        let node = ExecutionEngine::new(false, None)
            .execute_flow(
                "exec1",
                &flow,
                &repo,
                HashMap::new(),
                HashMap::from([("things".to_string(), serde_json::json!(["a", "b"]))]),
                None,
            )
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap();

        let records = records_of(&node, "refs");
        assert_eq!(records.len(), 2, "{records:?}");
        assert_eq!(field(&records[0], "ref"), "r-1");
        assert_eq!(field(&records[1], "ref"), "r-2");
    }

    #[tokio::test]
    async fn a_step_that_runs_once_still_exports_a_scalar() {
        // The guard on the other side: collecting is what a step that runs *more than
        // once* does. A plain step's output variable is still one value under its own
        // name, which is what every existing flow depends on.
        let url = stub_once(200, r#"{"token":"T"}"#).await;
        let repo = MockTestCaseRepository::new()
            .with_test_case(make_test_case("tc", "Login", &url, "POST"));
        let flow = one_node_flow("tc", serde_json::json!({
            "outputVars": [{"name": "token", "path": "$.token"}],
        }));

        let run = ExecutionEngine::new(false, None)
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();

        assert_eq!(run.context.get("token"), Some(&Value::String("T".into())));
    }

    #[tokio::test]
    async fn a_row_can_extend_the_endpoint() {
        let engine = ExecutionEngine::new(false, None);
        let mut tc = make_test_case("tc", "List", "http://127.0.0.1:1/campaigns", "GET");
        let mut dataset = dataset_of(vec![("own org", None, None), ("all orgs", None, None)]);
        dataset.rows[0].path = Some("?org={{my_org}}".to_string());
        dataset.rows[1].path = Some("/all".to_string());
        tc.dataset = Some(dataset);
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = one_node_flow("tc", serde_json::json!({
            "forEachRow": true,
            "inputVars": [{"key": "my_org", "value": "acme"}]
        }));
        let rows = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results
            .into_iter()
            .find(|r| r.node_id == "b")
            .unwrap()
            .iterations
            .unwrap();

        // A row's suffix is interpolated like the endpoint it extends.
        assert!(rows[0].request.as_ref().unwrap().url.ends_with("/campaigns?org=acme"));
        assert!(rows[1].request.as_ref().unwrap().url.ends_with("/campaigns/all"));
    }

    #[test]
    fn a_rows_query_joins_an_endpoint_that_already_has_one() {
        let mut tc = make_test_case("tc", "List", "http://x/campaigns?limit=10", "GET");
        tc.payload = None;
        let mut row = DataRow { path: Some("?org=acme".into()), ..Default::default() };

        // "?limit=10?org=acme" is a URL the server reads as one broken parameter.
        assert_eq!(resolve_endpoint(Some(&row), &tc), "http://x/campaigns?limit=10&org=acme");

        // A path suffix is appended as-is.
        row.path = Some("/all".into());
        assert_eq!(resolve_endpoint(Some(&row), &tc), "http://x/campaigns?limit=10/all");

        // Blank or absent leaves the endpoint alone.
        row.path = Some("   ".into());
        assert_eq!(resolve_endpoint(Some(&row), &tc), "http://x/campaigns?limit=10");
        assert_eq!(resolve_endpoint(None, &tc), "http://x/campaigns?limit=10");
    }

    /// Teardown exists for the run that broke: an account created by a flow that
    /// then failed still has to be deleted. And it must not fire blind — a DELETE
    /// aimed at a leftover id would destroy something this run never created.
    #[tokio::test]
    async fn teardown_runs_after_a_failure_but_not_blind() {
        /// A flow: signup (may fail) → send, then teardown: admin login → delete.
        async fn run(
            signup_url: &str,
            environment: HashMap<String, Value>,
        ) -> Vec<NodeResult> {
            let engine = ExecutionEngine::new(false, None);
            let mut signup = make_test_case("signup", "Signup", signup_url, "POST");
            signup.assertion_script = Some("response.status == 201".to_string());
            let login = make_test_case("login", "Admin login", "http://127.0.0.1:1/login", "POST");
            let del = make_test_case(
                "del",
                "Delete User",
                "http://127.0.0.1:1/accounts/{{new_account_id}}",
                "DELETE",
            );
            let repo = MockTestCaseRepository::new()
                .with_test_case(signup)
                .with_test_case(login)
                .with_test_case(del);

            let flow = make_flow("flow1", vec![
                make_node("start", "start", serde_json::json!({})),
                make_node("a", "testCase", serde_json::json!({
                    "testCaseId": "signup",
                    "config": {"outputVars": [{"name": "new_account_id", "path": "$.accountId"}]}
                })),
                // Teardown, in the order the edges give: login first, then delete.
                make_node("t1", "testCase", serde_json::json!({
                    "testCaseId": "login", "config": {"teardown": true}
                })),
                make_node("t2", "testCase", serde_json::json!({
                    "testCaseId": "del", "config": {"teardown": true}
                })),
                make_node("end", "end", serde_json::json!({})),
            ], vec![
                make_edge("e1", "start", "a", None),
                make_edge("e2", "a", "t1", Some("success")),
                make_edge("e3", "t1", "t2", Some("success")),
                make_edge("e4", "t2", "end", Some("success")),
            ]);

            engine
                .execute_flow("exec1", &flow, &repo, environment, HashMap::new(), None)
                .await
                .unwrap()
                .results
        }

        // Signup fails (connection refused → error, which used to stop the flow
        // dead). Teardown still runs, in edge order, and is labelled as teardown.
        let results = run("http://127.0.0.1:1/signup", HashMap::new()).await;
        let names: Vec<&str> = results
            .iter()
            .map(|r| r.test_case_name.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(names, vec!["Signup", "Admin login", "Delete User"], "{:?}", names);
        assert_eq!(results[1].teardown, Some(true));
        assert_eq!(results[2].teardown, Some(true));

        // Guard 1: new_account_id was never produced, so the DELETE is not sent.
        let del = &results[2];
        assert_eq!(del.status, NodeStatus::Skipped);
        assert!(del.request.is_none(), "nothing may be sent");
        assert!(
            del.error_message.as_deref().unwrap_or("").contains("never produced by this run"),
            "{:?}",
            del.error_message
        );

        // Guard 2: the dangerous one. A leftover new_account_id in the environment
        // resolves cleanly and names a real account this run never created.
        let mut env = HashMap::new();
        env.insert(
            "new_account_id".to_string(),
            serde_json::json!("acct-from-a-previous-run"),
        );
        let results = run("http://127.0.0.1:1/signup", env).await;
        let del = &results[2];
        assert_eq!(del.status, NodeStatus::Skipped);
        assert!(del.request.is_none(), "a stale id must never be deleted");
        assert!(
            del.error_message.as_deref().unwrap_or("").contains("environment/globals"),
            "{:?}",
            del.error_message
        );
    }

    /// Marked nodes leave the normal path: otherwise they would also run inline,
    /// on the happy path only, which is the opposite of always.
    #[tokio::test]
    async fn a_teardown_node_runs_once_not_twice() {
        let engine = ExecutionEngine::new(false, None);
        let a = make_test_case("a", "Step", "http://127.0.0.1:1/a", "POST");
        let t = make_test_case("t", "Cleanup", "http://127.0.0.1:1/t", "DELETE");
        let repo = MockTestCaseRepository::new().with_test_case(a).with_test_case(t);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "t", Some("success")),
            make_edge("e3", "t", "end", Some("success")),
        ]);

        let results = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .results;
        assert_eq!(
            results.iter().filter(|r| r.test_case_name.as_deref() == Some("Cleanup")).count(),
            1
        );
    }

    /// A teardown node counts in the total, not only in the verdict tallies.
    ///
    /// It used to add to passed/failed/errors while leaving `total` behind, so the parts
    /// could exceed the whole: a flow with two cleanup nodes reported eighteen errors out
    /// of sixteen nodes. Harmless while nobody did arithmetic on it, and nonsense the
    /// moment the run history printed "0/14 passed · 18 errored".
    #[tokio::test]
    async fn a_teardown_node_is_counted_in_the_total() {
        let engine = ExecutionEngine::new(false, None);
        let a = make_test_case("a", "Step", "http://127.0.0.1:1/a", "POST");
        let t = make_test_case("t", "Cleanup", "http://127.0.0.1:1/t", "DELETE");
        let repo = MockTestCaseRepository::new().with_test_case(a).with_test_case(t);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("a", "testCase", serde_json::json!({"testCaseId": "a"})),
            make_node("t", "testCase", serde_json::json!({
                "testCaseId": "t", "config": {"teardown": true}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "a", None),
            make_edge("e2", "a", "t", Some("success")),
            make_edge("e3", "t", "end", Some("success")),
        ]);

        let stats = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap()
            .stats;

        // Both nodes ran and neither could reach its endpoint, so both errored — and the
        // denominator has to account for both of them.
        assert_eq!(stats.total, 2, "the teardown node is missing from the total");
        assert_eq!(
            stats.passed + stats.failed + stats.errors + stats.skipped,
            stats.total,
            "the parts must sum to the whole"
        );
    }

    /// Debug mode has to answer "why did it send *that*?" — a value pulled from the
    /// environment when this run was supposed to produce it looks entirely normal.
    #[tokio::test]
    async fn debug_mode_says_where_each_value_came_from() {
        async fn logs_for(debug: bool) -> String {
            let engine = ExecutionEngine::new(debug, None);
            let tc = make_test_case(
                "bal",
                "Balance Enquiry",
                "http://127.0.0.1:1/wallet/{{my_user_id}}/balance",
                "GET",
            );
            let repo = MockTestCaseRepository::new().with_test_case(tc);
            let flow = make_flow("flow1", vec![
                make_node("start", "start", serde_json::json!({})),
                make_node("n1", "testCase", serde_json::json!({"testCaseId": "bal"})),
                make_node("end", "end", serde_json::json!({})),
            ], vec![
                make_edge("e1", "start", "n1", None),
                make_edge("e2", "n1", "end", Some("success")),
            ]);
            let mut env = HashMap::new();
            env.insert("my_user_id".to_string(), serde_json::json!("stale-from-a-previous-run"));
            engine
                .execute_flow("exec1", &flow, &repo, env, HashMap::new(), None)
                .await
                .unwrap()
                .results[0]
                .logs
                .join("\n")
        }

        let debug = logs_for(true).await;
        assert!(
            debug.contains("my_user_id ← environment/globals = stale-from-a-previous-run"),
            "{}",
            debug
        );

        // Quiet by default — this is a diagnostic, not a running commentary.
        let plain = logs_for(false).await;
        assert!(!plain.contains("←"), "{}", plain);
    }

    /// A leftover my_user_id = "null" in Globals sent GET /wallet/null/balance and
    /// nothing said so: it resolved, so the unresolved-variable warning was silent.
    #[tokio::test]
    async fn a_leftover_null_in_the_environment_is_called_out() {
        let engine = ExecutionEngine::new(true, None);
        let tc = make_test_case(
            "bal",
            "Balance Enquiry",
            "http://127.0.0.1:1/wallet/{{my_user_id}}/balance",
            "GET",
        );
        let repo = MockTestCaseRepository::new().with_test_case(tc);
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("n1", "testCase", serde_json::json!({"testCaseId": "bal"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "n1", None),
            make_edge("e2", "n1", "end", Some("success")),
        ]);

        let mut env = HashMap::new();
        env.insert("my_user_id".to_string(), serde_json::json!("null"));
        let result = engine
            .execute_flow("exec1", &flow, &repo, env, HashMap::new(), None)
            .await
            .unwrap();

        let logs = result.results[0].logs.join("\n");
        assert!(logs.contains("resolved to the text"), "{}", logs);
        assert!(logs.contains("my_user_id"), "{}", logs);
        // It really did go out as the four letters, which is the point.
        let url = &result.results[0].request.as_ref().unwrap().url;
        assert!(url.ends_with("/wallet/null/balance"), "{}", url);
    }

    /// "Send SMS" is a 202 in one flow and a 402 in the flow with no balance. The
    /// node says which, and the test case's own assertion — written for the happy
    /// path — must not get a vote on that node.
    #[tokio::test]
    async fn a_nodes_expect_decides_and_the_shared_script_stays_out_of_it() {
        async fn run(node_config: serde_json::Value) -> NodeResult {
            let url = stub_once(402, r#"{"code":"LOW_BALANCE"}"#).await;
            let engine = ExecutionEngine::new(true, None);
            let mut tc = make_test_case("sms", "Send SMS", &url, "POST");
            // The happy-path assertion: would fail this 402, and captures as it goes.
            tc.assertion_script =
                Some("SAT.vars.txn = \"captured\"; response.status == 202".to_string());
            let repo = MockTestCaseRepository::new().with_test_case(tc);

            let mut data = serde_json::json!({"testCaseId": "sms"});
            data.as_object_mut().unwrap().insert("config".into(), node_config);
            let flow = make_flow("flow1", vec![
                make_node("start", "start", serde_json::json!({})),
                make_node("n1", "testCase", data),
                make_node("end", "end", serde_json::json!({})),
            ], vec![
                make_edge("e1", "start", "n1", None),
                make_edge("e2", "n1", "end", Some("success")),
            ]);
            engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap()
                .results
                .remove(0)
        }

        // The node says 402, so the 402 passes even though the test case wanted 202.
        let shorthand = run(serde_json::json!({"check": "402"})).await;
        assert_eq!(shorthand.status, NodeStatus::Passed, "{:?}", shorthand.error_message);

        // An expression can look at the body, and may capture for itself.
        let expr = run(serde_json::json!({
            "check": "SAT.vars.reason = response.json.code; response.status == 402"
        })).await;
        assert_eq!(expr.status, NodeStatus::Passed, "{:?}", expr.error_message);

        // A blank Expect hands the verdict back to the test case, which wants 202.
        let blank = run(serde_json::json!({"check": "   "})).await;
        assert_eq!(blank.status, NodeStatus::Failed);
        assert!(
            blank.error_message.as_deref().unwrap_or("").contains("Assertion returned false"),
            "{:?}",
            blank.error_message
        );

        // No Expect at all behaves exactly as it did before this existed.
        let none = run(serde_json::json!({})).await;
        assert_eq!(none.status, NodeStatus::Failed);

        // A node's wrong Expect names the node, so you know which layer decided.
        let wrong = run(serde_json::json!({"check": "202"})).await;
        assert_eq!(wrong.status, NodeStatus::Failed);
        assert_eq!(
            wrong.error_message.as_deref(),
            Some("Expected HTTP 202, got 402")
        );
    }

    /// The status shorthand and a full expression are read the same way for a node
    /// as for a dataset row — one parser, so they can't drift apart.
    #[test]
    fn a_check_is_a_status_a_expression_or_nothing() {
        assert!(matches!(parse_check(Some("402")), Check::Status(402)));
        assert!(matches!(parse_check(Some("  402  ")), Check::Status(402)));
        assert!(matches!(parse_check(Some("response.status == 402")), Check::Expr(_)));
        // Not a u16, so it can only be an expression.
        assert!(matches!(parse_check(Some("99999")), Check::Expr(_)));
        assert!(matches!(parse_check(Some("   ")), Check::Unstated));
        assert!(matches!(parse_check(None), Check::Unstated));
    }

    /// Two nodes can point at one test case in different roles. Without the node's
    /// own name, both results read "Login" and you can't tell which one failed.
    #[tokio::test]
    async fn a_named_node_carries_its_name_into_the_result() {
        // One node per flow: an errored node halts the run, so two aliases need two.
        async fn label_for(alias: serde_json::Value) -> Option<String> {
            let engine = ExecutionEngine::new(true, None);
            let repo = MockTestCaseRepository::new();
            let mut data = serde_json::json!({"testCaseId": "missing"});
            data["alias"] = alias;
            let flow = make_flow("flow1", vec![
                make_node("start", "start", serde_json::json!({})),
                make_node("n1", "testCase", data),
                make_node("end", "end", serde_json::json!({})),
            ], vec![
                make_edge("e1", "start", "n1", None),
                make_edge("e2", "n1", "end", Some("success")),
            ]);
            let result = engine
                .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
                .await
                .unwrap();
            result.results.first().expect("the node ran").node_label.clone()
        }

        assert_eq!(
            label_for(serde_json::json!("Login as new user")).await.as_deref(),
            Some("Login as new user")
        );
        // Blank is not a name: it must not blank out the test case name downstream.
        assert_eq!(label_for(serde_json::json!("   ")).await, None);
        assert_eq!(label_for(serde_json::Value::Null).await, None);
    }

    #[tokio::test]
    async fn test_execute_flow_missing_test_case() {
        let engine = ExecutionEngine::new(true, None);
        let repo = MockTestCaseRepository::new(); // Empty repo

        // Flow references a test case that doesn't exist
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({"testCaseId": "nonexistent"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end", Some("success")),
        ]);

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(),
            HashMap::new(),
            None,
        ).await.unwrap();

        // Should have 1 error (test case not found)
        assert_eq!(result.stats.total, 1);
        assert_eq!(result.stats.errors, 1);
        assert_eq!(result.results[0].status, NodeStatus::Error);
        assert!(result.results[0].error_message.as_ref().unwrap().contains("not found"));
        // Guards the run_once extraction: node_id must stay the graph node's id,
        // not the standalone path's "direct". Nothing else would catch a slip here.
        assert_eq!(result.results[0].node_id, "tc1");
    }

    #[tokio::test]
    async fn test_standalone_run_is_labelled_direct() {
        // Companion guard to the flow-side node_id assertion above.
        let engine = ExecutionEngine::new(false, None);
        let tc = make_test_case("tc-x", "Standalone", "http://127.0.0.1:1/unreachable", "GET");

        let result = engine
            .execute_test_case(&tc, HashMap::new(), HashMap::new())
            .await;

        assert_eq!(result.node_id, "direct");
        assert_eq!(result.test_case_id.as_deref(), Some("tc-x"));
        // Connection refused, but the request log is still captured.
        assert_eq!(result.status, NodeStatus::Error);
        assert!(result.request.is_some());
    }

    #[tokio::test]
    async fn test_execute_flow_node_missing_test_case_id() {
        let engine = ExecutionEngine::new(true, None);
        let repo = MockTestCaseRepository::new();

        // testCase node without testCaseId in data
        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({})), // Missing testCaseId
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end", Some("success")),
        ]);

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(),
            HashMap::new(),
            None,
        ).await.unwrap();

        assert_eq!(result.stats.errors, 1);
        assert!(result.results[0].error_message.as_ref().unwrap().contains("testCaseId"));
    }

    // =========================================================================
    // Variable Interpolation in Execution
    // =========================================================================

    /// A one-character typo in a JSONPath ($.accesss_token) matched nothing, was
    /// skipped in silence, and surfaced much later as a literal {{my_jwt}} in a
    /// different request. The export itself has to say so, and name the real keys.
    #[test]
    fn an_export_path_that_matches_nothing_says_so() {
        let engine = ExecutionEngine::new(false, None); // not debug: must warn anyway
        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let mut logs = Vec::new();
        let tc = make_test_case("tc1", "Login", "http://x/", "POST");
        let body = serde_json::json!({"access_token": "ey.J", "refresh_token": "ey.R"});

        let exported = engine.process_exports(
            &tc,
            &[ExportVariable { name: "my_jwt".into(), json_path: "$.accesss_token".into() }],
            &Some(body),
            &mut ctx,
            &mut logs,
        );

        assert!(exported.is_none() || exported.unwrap().is_empty());
        let log = logs.join("\n");
        assert!(log.contains("nothing at $.accesss_token"), "{}", log);
        assert!(log.contains("access_token, refresh_token"), "{}", log);
        assert!(log.contains("{{my_jwt}} will not resolve"), "{}", log);
        // And the correct spelling stays quiet and works.
        let mut logs2 = Vec::new();
        let ok = engine.process_exports(
            &tc,
            &[ExportVariable { name: "my_jwt".into(), json_path: "$.access_token".into() }],
            &Some(serde_json::json!({"access_token": "ey.J"})),
            &mut ctx,
            &mut logs2,
        );
        assert_eq!(ok.unwrap().get("my_jwt").and_then(|v| v.as_str()), Some("ey.J"));
        assert!(logs2.is_empty(), "{:?}", logs2);
    }

    #[test]
    fn top_level_keys_names_what_the_body_offered() {
        let body = serde_json::json!({"access_token": "a", "refresh_token": "b"});
        assert_eq!(top_level_keys(&body), " (body has: access_token, refresh_token)");
        // A wide body is summarised rather than dumped into the log.
        let wide: serde_json::Map<String, serde_json::Value> =
            (0..12).map(|i| (format!("k{:02}", i), serde_json::json!(i))).collect();
        let listed = top_level_keys(&serde_json::Value::Object(wide));
        assert!(listed.contains("\u{2026} 4 more"), "{}", listed);
        // Nothing useful to say about a non-object.
        assert_eq!(top_level_keys(&serde_json::json!([1, 2])), "");
        assert_eq!(top_level_keys(&serde_json::json!({})), "");
    }

    /// A "Login as PA" node exported my_jwt with no JSON path. The row was dropped
    /// in silence and a later node sent "Bearer {{my_jwt}}" literally, so the only
    /// evidence was a 500 from the server. Both halves must now say something.
    #[tokio::test]
    async fn a_half_filled_export_and_an_unresolved_variable_both_warn() {
        let engine = ExecutionEngine::new(true, None);
        let tc = TestCase {
            id: "login".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Login".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "DELETE".to_string(),
            // Nothing sets my_jwt, exactly as in the reported flow.
            endpoint: "http://127.0.0.1:1/accounts/1".to_string(),
            headers: serde_json::json!({"Authorization": "Bearer {{my_jwt}}"}),
            payload: None,
            body_type: None,
            exports: vec![],
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("n1", "testCase", serde_json::json!({
                "testCaseId": "login",
                "config": {"outputVars": [
                    {"name": "my_jwt", "path": ""},      // named, no path
                    {"name": "", "path": "$.token"},     // path, no name
                    {"name": "", "path": ""},            // untouched row: no noise
                ]}
            })),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "n1", None),
            make_edge("e2", "n1", "end", Some("success")),
        ]);

        let result = engine
            .execute_flow("exec1", &flow, &repo, HashMap::new(), HashMap::new(), None)
            .await
            .unwrap();
        let logs = result.results[0].logs.join("\n");

        assert!(logs.contains("my_jwt") && logs.contains("no JSON path"), "{}", logs);
        assert!(logs.contains("$.token") && logs.contains("has no name"), "{}", logs);
        // The literal that actually reached the server is now called out.
        assert!(logs.contains("Unresolved variable(s) sent literally"), "{}", logs);
        assert!(logs.contains("my_jwt"), "{}", logs);
        // Exactly two export complaints — the blank row is not one of them.
        assert_eq!(logs.matches("Output variable").count(), 2, "{}", logs);
    }

    #[tokio::test]
    async fn test_execute_flow_with_variables() {
        let engine = ExecutionEngine::new(true, None);

        // Create test case with variable in endpoint
        let tc = TestCase {
            id: "tc1".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Test with Vars".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".to_string(),
            endpoint: "{{baseUrl}}/users/{{userId}}".to_string(),
            headers: serde_json::json!({"Authorization": "Bearer {{token}}"}),
            payload: None,
            body_type: None,
            exports: vec![],
            assertion_script: Some("response.status == 200".to_string()),
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let repo = MockTestCaseRepository::new().with_test_case(tc);

        let flow = make_flow("flow1", vec![
            make_node("start", "start", serde_json::json!({})),
            make_node("tc1", "testCase", serde_json::json!({"testCaseId": "tc1"})),
            make_node("end", "end", serde_json::json!({})),
        ], vec![
            make_edge("e1", "start", "tc1", None),
            make_edge("e2", "tc1", "end", Some("success")),
        ]);

        // Pass variables
        let mut vars = HashMap::new();
        vars.insert("baseUrl".to_string(), Value::String("https://api.example.com".to_string()));
        vars.insert("userId".to_string(), Value::String("123".to_string()));
        vars.insert("token".to_string(), Value::String("secret-token".to_string()));

        let result = engine.execute_flow(
            "exec1",
            &flow,
            &repo,
            HashMap::new(), // environment
            vars,           // execution vars
            None,
        ).await.unwrap();

        // Check that URL was interpolated
        let request = result.results[0].request.as_ref().unwrap();
        assert_eq!(request.url, "https://api.example.com/users/123");
        assert_eq!(request.headers.get("Authorization"), Some(&"Bearer secret-token".to_string()));
    }

    // =========================================================================
    // Export Tests
    // =========================================================================

    #[test]
    fn test_process_exports_simple() {
        let engine = ExecutionEngine::new(true, None);

        let tc = TestCase {
            id: "tc1".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Test".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".to_string(),
            endpoint: "http://test.com".to_string(),
            headers: serde_json::json!({}),
            payload: None,
            body_type: None,
            exports: vec![
                ExportVariable { name: "token".to_string(), json_path: "$.data.token".to_string() },
                ExportVariable { name: "userId".to_string(), json_path: "$.data.user.id".to_string() },
            ],
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let json = Some(serde_json::json!({
            "data": {
                "token": "abc123",
                "user": { "id": 42 }
            }
        }));

        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let mut logs = Vec::new();

        let exports = engine.process_exports(&tc, &[], &json, &mut ctx, &mut logs);

        assert!(exports.is_some());
        let exports = exports.unwrap();
        assert_eq!(exports.get("token"), Some(&Value::String("abc123".to_string())));
        assert_eq!(exports.get("userId"), Some(&Value::Number(42.into())));

        // Check context was updated
        assert_eq!(ctx.resolve("token"), Some(&Value::String("abc123".to_string())));
    }

    #[test]
    fn test_process_exports_no_json() {
        let engine = ExecutionEngine::new(true, None);

        let tc = TestCase {
            id: "tc1".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Test".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".to_string(),
            endpoint: "http://test.com".to_string(),
            headers: serde_json::json!({}),
            payload: None,
            body_type: None,
            exports: vec![
                ExportVariable { name: "token".to_string(), json_path: "$.token".to_string() },
            ],
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let mut logs = Vec::new();

        let exports = engine.process_exports(&tc, &[], &None, &mut ctx, &mut logs);
        assert!(exports.is_none());
    }

    #[test]
    fn test_process_exports_empty_exports() {
        let engine = ExecutionEngine::new(true, None);

        let tc = TestCase {
            id: "tc1".to_string(),
            project_id: "proj1".to_string(),
            group_id: None,
            name: "Test".to_string(),
            given_condition: None,
            when_action: None,
            then_expected: None,
            method: "GET".to_string(),
            endpoint: "http://test.com".to_string(),
            headers: serde_json::json!({}),
            payload: None,
            body_type: None,
            exports: vec![], // No exports
            assertion_script: None,
            pre_test_script: None,
            dataset: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };

        let json = Some(serde_json::json!({"data": "test"}));
        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let mut logs = Vec::new();

        let exports = engine.process_exports(&tc, &[], &json, &mut ctx, &mut logs);
        assert!(exports.is_none());
    }
}
