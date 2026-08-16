//! Resolving sub-flows into one flat graph, before a run starts.
//!
//! A canvas `group` node names another flow. Until now the engine's arm for it did nothing —
//! it routed onward, executed nothing, and recorded no result, so a flow containing one ran
//! green having skipped it.
//!
//! **The sub-flow's steps are spliced into the parent's graph here, and the engine then runs
//! one flat flow.** It never learns a sub-flow was involved, which is the whole point: teardown,
//! stats, progress, stepping, the variable context and result persistence all keep working
//! because there is only ever one flow. In particular:
//!
//! - A sub-flow's **cleanup becomes the parent's cleanup**. `find_next_node` hops over
//!   teardown-marked nodes during traversal and `teardown_sequence` scans the whole flow, so an
//!   inlined `Delete User` runs at the end of the *parent* run — the only correct time, since
//!   the account has to outlive the tests that use it. Running the sub-flow as a separate nested
//!   run would have torn it down first, and deferring that would have been new code.
//! - A `forEachRow` node inside a sub-flow still produces one aggregate with `iterations`, so
//!   `run_results`' single level of `parent_id` is never exceeded.
//!
//! The interesting half is a pure function: the caller supplies the flows, so a test hands it a
//! literal map and needs no database — the shape `plan_items` and `resolve_members` already use.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::db::models::{Flow, GraphEdge, GraphNode};
use crate::db::repositories::FlowRepository;
use crate::error::AppError;

/// Separates a group node's id from the id of a node inside the flow it names.
///
/// A unit separator rather than `::`, because an authored node id could contain `::` and this
/// must not be forgeable. **Nothing anywhere recovers provenance by splitting on it** — that is
/// what [`NodeOrigin`] is for; this only has to be unique.
const SEP: char = '\u{1F}';

/// Node types the splice introduces where a sub-flow's `start` and `end` were.
///
/// Both fall to the engine's existing pass-through arm: routed over, executed nothing, and not
/// counted by `total_nodes` (which counts only `testCase | group | awaitCallback`). Rewriting
/// the boundary nodes rather than rewiring around them is what makes multiple exits, an
/// unreachable end node, and a teardown node next to the boundary all work without
/// reimplementing `pick_edge`'s fallback chain.
const ENTRY_TYPE: &str = "inlineEntry";
const EXIT_TYPE: &str = "inlineExit";

pub struct InlineLimits {
    pub max_depth: usize,
    pub max_nodes: usize,
}

impl Default for InlineLimits {
    fn default() -> Self {
        Self { max_depth: 5, max_nodes: 500 }
    }
}

/// Where one node of the flat graph came from.
///
/// **The authority on provenance.** Nothing may recover this by parsing a synthetic id.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeOrigin {
    /// Its id in the flat graph.
    pub node_id: String,
    /// The group node on the *root* canvas — what the author can actually see and click.
    pub group_node_id: String,
    pub flow_id: String,
    pub flow_name: String,
    /// Its id on its own flow's canvas.
    pub inner_node_id: String,
}

/// A group node that cannot be resolved.
///
/// Every variant names the group node, so every message can point at something on the author's
/// own canvas rather than at a synthetic id they have never seen.
#[derive(Debug, Clone, PartialEq)]
pub enum InlineProblem {
    NoFlowRef { group_node_id: String },
    MissingFlow { group_node_id: String, flow_id: String },
    ForeignProject { group_node_id: String, flow_id: String },
    Cycle { group_node_id: String, flow_id: String, path: Vec<String> },
    TooDeep { group_node_id: String, depth: usize },
    TooLarge { nodes: usize },
    SubFlowNoStart { group_node_id: String, flow_id: String },
}

impl InlineProblem {
    /// What an author reads. Names the step, and says what to do about it.
    pub fn message(&self) -> String {
        match self {
            Self::NoFlowRef { .. } => {
                "This step runs another flow, but no flow is chosen — open it and pick one"
                    .to_string()
            }
            Self::MissingFlow { flow_id, .. } => format!(
                "This step runs flow \"{}\", which no longer exists — point it at another flow \
                 or remove the step",
                flow_id
            ),
            Self::ForeignProject { flow_id, .. } => format!(
                "This step runs flow \"{}\", which belongs to another project. The base URL and \
                 project variables come from *this* project, so it would run against the wrong \
                 host",
                flow_id
            ),
            Self::Cycle { path, .. } => format!(
                "These flows run each other in a loop, so this can never finish: {}",
                path.join(" → ")
            ),
            Self::TooDeep { depth, .. } => format!(
                "Flows are nested more than {} deep here — flatten some of them",
                depth
            ),
            Self::TooLarge { nodes } => format!(
                "Resolving the flows this one runs would produce more than {} steps",
                nodes
            ),
            Self::SubFlowNoStart { flow_id, .. } => format!(
                "This step runs flow \"{}\", which has no START node, so there is nowhere to \
                 begin",
                flow_id
            ),
        }
    }

    /// The group node to point at, when there is one.
    pub fn group_node_id(&self) -> Option<&str> {
        match self {
            Self::NoFlowRef { group_node_id }
            | Self::MissingFlow { group_node_id, .. }
            | Self::ForeignProject { group_node_id, .. }
            | Self::Cycle { group_node_id, .. }
            | Self::TooDeep { group_node_id, .. }
            | Self::SubFlowNoStart { group_node_id, .. } => Some(group_node_id),
            Self::TooLarge { .. } => None,
        }
    }
}

/// Worth saying in the run log, not worth refusing over.
#[derive(Debug, Clone, PartialEq)]
pub enum InlineNote {
    FlowVarShadowed { name: String, flow_name: String },
}

impl InlineNote {
    pub fn message(&self) -> String {
        match self {
            Self::FlowVarShadowed { name, flow_name } => format!(
                "⚠ Flow variable \"{}\" is set by both this flow and \"{}\" — this flow's value \
                 is the one in force",
                name, flow_name
            ),
        }
    }
}

/// One group node on the root canvas, and the steps it turned into.
///
/// Sent to the client so it can roll those steps' results back onto the node the author can see,
/// and name the sub-flow in the console — **without ever splitting a synthetic id**.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct InlinedGroup {
    pub group_node_id: String,
    pub flow_id: String,
    pub flow_name: String,
    pub node_ids: Vec<String>,
}

pub struct Inlined {
    pub flow: Flow,
    pub origins: Vec<NodeOrigin>,
    pub problems: Vec<InlineProblem>,
    pub notes: Vec<InlineNote>,
}

impl Inlined {
    /// One entry per group node on the root canvas, for the client.
    ///
    /// Only the steps that will **report** — the boundary nodes a sub-flow was spliced through
    /// are inert pass-throughs that emit nothing. Counting them made the canvas read "2 of 5
    /// steps" about a sub-flow with three, which is the one number this exists to get right.
    pub fn groups(&self) -> Vec<InlinedGroup> {
        let reports: HashSet<&str> = self
            .flow
            .graph_data
            .nodes
            .iter()
            .filter(|n| matches!(n.node_type.as_str(), "testCase" | "awaitCallback"))
            .map(|n| n.id.as_str())
            .collect();

        let mut order: Vec<&str> = Vec::new();
        let mut by_group: HashMap<&str, InlinedGroup> = HashMap::new();
        for origin in &self.origins {
            if !reports.contains(origin.node_id.as_str()) {
                continue;
            }
            let entry = by_group.entry(&origin.group_node_id).or_insert_with(|| {
                order.push(&origin.group_node_id);
                InlinedGroup {
                    group_node_id: origin.group_node_id.clone(),
                    flow_id: origin.flow_id.clone(),
                    flow_name: origin.flow_name.clone(),
                    node_ids: Vec::new(),
                }
            });
            entry.node_ids.push(origin.node_id.clone());
        }
        order.into_iter().filter_map(|id| by_group.remove(id)).collect()
    }
}

/// The flow ids a node names, reading both spellings the canvas has used.
pub fn extract_flow_id(data: &Value) -> Option<String> {
    data.get("flowId")
        .or_else(|| data.get("flow_id"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn is_group(node: &GraphNode) -> bool {
    node.node_type == "group"
}

fn is_teardown(node: &GraphNode) -> bool {
    node.data
        .get("config")
        .and_then(|c| c.get("teardown"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Does this graph reference another flow at all?
///
/// The common case is "no", and it must cost one scan and zero queries.
pub fn has_groups(flow: &Flow) -> bool {
    flow.graph_data.nodes.iter().any(is_group)
}

/// Splice every group node into one flat graph.
///
/// Pure. `loaded` is every flow the graph transitively names, supplied by the caller — a missing
/// entry is reported as [`InlineProblem::MissingFlow`], never fetched.
pub fn inline_groups(root: &Flow, loaded: &HashMap<String, Flow>, limits: &InlineLimits) -> Inlined {
    let mut acc = Acc {
        nodes: Vec::new(),
        edges: Vec::new(),
        variables: root.graph_data.variables.clone(),
        origins: Vec::new(),
        problems: Vec::new(),
        notes: Vec::new(),
    };

    splice(root, root, "", &[], 0, loaded, limits, &mut acc, false);

    let mut flow = root.clone();
    flow.graph_data.nodes = acc.nodes;
    flow.graph_data.edges = acc.edges;
    flow.graph_data.variables = acc.variables;

    Inlined {
        flow,
        origins: acc.origins,
        problems: acc.problems,
        notes: acc.notes,
    }
}

struct Acc {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    variables: HashMap<String, Value>,
    origins: Vec<NodeOrigin>,
    problems: Vec<InlineProblem>,
    notes: Vec<InlineNote>,
}

/// Copy one flow's graph under `prefix`, then resolve its own group nodes.
///
/// `path` is the stack of flow ids on the way here — a **stack, not a visited set**, because a
/// diamond (A runs B and C, both of which run D) is legal and must splice D twice. Only a
/// repeat *on the current path* is a cycle.
#[allow(clippy::too_many_arguments)]
fn splice(
    root: &Flow,
    frame: &Flow,
    prefix: &str,
    path: &[String],
    depth: usize,
    loaded: &HashMap<String, Flow>,
    limits: &InlineLimits,
    acc: &mut Acc,
    // Set when an ancestor group node was itself marked teardown: the whole sub-flow is cleanup.
    inherit_teardown: bool,
) {
    let at_root = prefix.is_empty();
    let id_of = |inner: &str| format!("{}{}", prefix, inner);

    for node in &frame.graph_data.nodes {
        if is_group(node) {
            continue; // resolved below, and never copied
        }
        let mut copy = node.clone();
        copy.id = id_of(&node.id);

        if !at_root {
            // A sub-flow's own boundary nodes become inert pass-throughs rather than a second
            // start/end in the flat graph.
            if copy.node_type == "start" {
                copy.node_type = ENTRY_TYPE.to_string();
            } else if copy.node_type == "end" {
                copy.node_type = EXIT_TYPE.to_string();
            }

            if let Some(obj) = copy.data.as_object_mut() {
                obj.insert("sourceFlow".into(), Value::String(frame.name.clone()));
                obj.insert("sourceNodeId".into(), Value::String(node.id.clone()));
            }
            if inherit_teardown {
                mark_teardown(&mut copy);
            }
            acc.origins.push(NodeOrigin {
                node_id: copy.id.clone(),
                group_node_id: root_group_of(prefix),
                flow_id: frame.id.clone(),
                flow_name: frame.name.clone(),
                inner_node_id: node.id.clone(),
            });
        }
        acc.nodes.push(copy);
    }

    for edge in &frame.graph_data.edges {
        acc.edges.push(GraphEdge {
            id: id_of(&edge.id),
            source: id_of(&edge.source),
            target: id_of(&edge.target),
            edge_type: edge.edge_type.clone(),
            data: edge.data.clone(),
        });
    }

    for node in frame.graph_data.nodes.iter().filter(|n| is_group(n)) {
        let group_id = id_of(&node.id);
        resolve_one(
            root, frame, node, &group_id, path, depth, loaded, limits, acc,
            inherit_teardown || is_teardown(node),
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_one(
    root: &Flow,
    frame: &Flow,
    group: &GraphNode,
    group_id: &str,
    path: &[String],
    depth: usize,
    loaded: &HashMap<String, Flow>,
    limits: &InlineLimits,
    acc: &mut Acc,
    inherit_teardown: bool,
) {
    let visible = root_group_of(&format!("{}{}", group_id, SEP));

    let Some(flow_id) = extract_flow_id(&group.data) else {
        acc.problems.push(InlineProblem::NoFlowRef { group_node_id: visible });
        return;
    };

    // A repeat on the current path only. `check_circular_recursive` in the validator cannot be
    // relied on here: it runs when *one* flow is saved, so editing B to point at A never
    // re-validates A, and the cycle reaches the runner.
    if path.contains(&flow_id) || flow_id == frame.id {
        let mut chain: Vec<String> = path.to_vec();
        chain.push(frame.id.clone());
        chain.push(flow_id.clone());
        acc.problems.push(InlineProblem::Cycle {
            group_node_id: visible,
            flow_id,
            path: chain,
        });
        return;
    }

    if depth + 1 > limits.max_depth {
        acc.problems.push(InlineProblem::TooDeep { group_node_id: visible, depth: limits.max_depth });
        return;
    }

    let Some(sub) = loaded.get(&flow_id) else {
        acc.problems.push(InlineProblem::MissingFlow { group_node_id: visible, flow_id });
        return;
    };

    // The base URL and project variables come from the *root's* project, so a sub-flow from
    // another one would silently run against the wrong host.
    if sub.project_id != root.project_id {
        acc.problems.push(InlineProblem::ForeignProject { group_node_id: visible, flow_id });
        return;
    }

    let Some(start) = sub.graph_data.nodes.iter().find(|n| n.node_type == "start") else {
        acc.problems.push(InlineProblem::SubFlowNoStart { group_node_id: visible, flow_id });
        return;
    };

    if acc.nodes.len() + sub.graph_data.nodes.len() > limits.max_nodes {
        acc.problems.push(InlineProblem::TooLarge { nodes: limits.max_nodes });
        return;
    }

    // Its own flow variables fill gaps the parent left; the parent wins a collision, matching
    // the outer-wins ordering the whole variable model follows.
    for (name, value) in &sub.graph_data.variables {
        if let Some(existing) = acc.variables.get(name) {
            if existing != value {
                acc.notes.push(InlineNote::FlowVarShadowed {
                    name: name.clone(),
                    flow_name: sub.name.clone(),
                });
            }
        } else {
            acc.variables.insert(name.clone(), value.clone());
        }
    }

    let sub_prefix = format!("{}{}", group_id, SEP);
    let mut sub_path: Vec<String> = path.to_vec();
    sub_path.push(frame.id.clone());

    splice(root, sub, &sub_prefix, &sub_path, depth + 1, loaded, limits, acc, inherit_teardown);

    // Edges into the group node now lead to the sub-flow's entry; edges out of it now leave from
    // each exit. `edge_type` is carried through both ways, so a `failure` edge into a sub-flow
    // still routes there.
    let entry_id = format!("{}{}", sub_prefix, start.id);
    let exits: Vec<String> = sub
        .graph_data
        .nodes
        .iter()
        .filter(|n| n.node_type == "end")
        .map(|n| format!("{}{}", sub_prefix, n.id))
        .collect();

    let mut rewired: Vec<GraphEdge> = Vec::new();
    acc.edges.retain(|edge| {
        if edge.target == group_id {
            let mut e = edge.clone();
            e.target = entry_id.clone();
            rewired.push(e);
            return false;
        }
        if edge.source == group_id {
            // Once per exit: whatever the group node continued to, every exit continues to.
            for (n, exit) in exits.iter().enumerate() {
                rewired.push(GraphEdge {
                    id: format!("{}{}exit{}", edge.id, SEP, n),
                    source: exit.clone(),
                    target: edge.target.clone(),
                    edge_type: edge.edge_type.clone(),
                    data: edge.data.clone(),
                });
            }
            return false;
        }
        true
    });
    acc.edges.extend(rewired);

    // The group node itself is gone — its steps are the flow now.
    acc.nodes.retain(|n| n.id != group_id);
}

/// A group node marked "runs after the flow" means its whole sub-flow is cleanup.
///
/// Without this the marking is silently lost in the splice. It is also a trap today: traversal
/// hops over a marked node of any type, but the teardown loop only runs `testCase` nodes, so a
/// group node marked teardown never runs at all.
fn mark_teardown(node: &mut GraphNode) {
    if !node.data.is_object() {
        node.data = Value::Object(Default::default());
    }
    let obj = node.data.as_object_mut().expect("just ensured an object");
    let config = obj.entry("config").or_insert_with(|| Value::Object(Default::default()));
    if !config.is_object() {
        *config = Value::Object(Default::default());
    }
    config
        .as_object_mut()
        .expect("just ensured an object")
        .insert("teardown".into(), Value::Bool(true));
}

/// The outermost group node id in a prefix — the one on the canvas the author is looking at.
fn root_group_of(prefix: &str) -> String {
    prefix.split(SEP).next().unwrap_or("").to_string()
}

/// Every flow `root` transitively names.
///
/// Breadth-first with a visited set — here the set is right, because this only needs each flow
/// once; the cycle *check* belongs to the splice, which knows the path.
pub async fn load_referenced(
    root: &Flow,
    repo: &dyn FlowRepository,
    limits: &InlineLimits,
) -> Result<HashMap<String, Flow>, AppError> {
    let mut loaded: HashMap<String, Flow> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::from([root.id.clone()]);
    let mut queue: Vec<String> = referenced(root);
    let mut rounds = 0usize;

    while let Some(id) = queue.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        rounds += 1;
        // A cycle is caught by `seen`; this only stops a pathological graph from fetching for
        // ever, and is reported by the splice as TooDeep/TooLarge rather than here.
        if rounds > limits.max_nodes {
            break;
        }
        if let Some(flow) = repo.get_by_id(&id).await? {
            queue.extend(referenced(&flow));
            loaded.insert(id, flow);
        }
        // A missing flow is deliberately not an error here — the splice reports it against the
        // group node that named it, which is something the author can see.
    }
    Ok(loaded)
}

fn referenced(flow: &Flow) -> Vec<String> {
    flow.graph_data
        .nodes
        .iter()
        .filter(|n| is_group(n))
        .filter_map(|n| extract_flow_id(&n.data))
        .collect()
}

/// What the run entry points call: one flat flow, the groups it came from, and any notes.
///
/// A flow with no group nodes is returned untouched, having asked the database nothing.
pub async fn resolve_for_run(
    root: Flow,
    repo: &dyn FlowRepository,
) -> Result<(Flow, Vec<InlinedGroup>, Vec<String>), AppError> {
    if !has_groups(&root) {
        return Ok((root, Vec::new(), Vec::new()));
    }

    let limits = InlineLimits::default();
    let loaded = load_referenced(&root, repo, &limits).await?;
    let inlined = inline_groups(&root, &loaded, &limits);

    if let Some(problem) = inlined.problems.first() {
        // Before anything runs, naming a node on the author's canvas — the same rule the
        // unfillable-list check follows, and for the same reason: a report sixty seconds into a
        // run is a worse report.
        return Err(AppError::BadRequest(problem.message()));
    }

    let groups = inlined.groups();
    let notes = inlined.notes.iter().map(InlineNote::message).collect();
    Ok((inlined.flow, groups, notes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{GraphData, Position};
    use chrono::Utc;

    fn node(id: &str, node_type: &str, data: Value) -> GraphNode {
        GraphNode {
            id: id.to_string(),
            node_type: node_type.to_string(),
            position: Position { x: 0.0, y: 0.0 },
            data,
            width: None,
            height: None,
        }
    }

    fn step(id: &str) -> GraphNode {
        node(id, "testCase", serde_json::json!({ "testCaseId": id }))
    }

    fn group(id: &str, flow_id: &str) -> GraphNode {
        node(id, "group", serde_json::json!({ "flowId": flow_id }))
    }

    fn edge(source: &str, target: &str) -> GraphEdge {
        typed_edge(source, target, None)
    }

    fn typed_edge(source: &str, target: &str, edge_type: Option<&str>) -> GraphEdge {
        GraphEdge {
            id: format!("{}->{}", source, target),
            source: source.to_string(),
            target: target.to_string(),
            edge_type: edge_type.map(str::to_string),
            data: Value::Null,
        }
    }

    fn flow(id: &str, nodes: Vec<GraphNode>, edges: Vec<GraphEdge>) -> Flow {
        Flow {
            id: id.to_string(),
            project_id: "proj".to_string(),
            name: format!("flow {}", id),
            description: None,
            graph_data: GraphData {
                nodes,
                edges,
                canvas_settings: serde_json::json!({}),
                variables: HashMap::new(),
            },
            version: 1,
            group_id: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// A sub-flow shaped like the author's onboarding: start → two steps → end.
    fn onboarding() -> Flow {
        let mut f = flow(
            "sub",
            vec![node("s", "start", Value::Null), step("signup"), step("login"), node("e", "end", Value::Null)],
            vec![edge("s", "signup"), edge("signup", "login"), edge("login", "e")],
        );
        f.name = "Onboarding".to_string();
        f
    }

    fn ids(inlined: &Inlined) -> Vec<String> {
        inlined.flow.graph_data.nodes.iter().map(|n| n.id.clone()).collect()
    }

    /// Walk the flat graph from its start, the way the engine would, following edges.
    fn walk(inlined: &Inlined) -> Vec<String> {
        let g = &inlined.flow.graph_data;
        let start = g.nodes.iter().find(|n| n.node_type == "start").expect("a start node");
        let mut seen = Vec::new();
        let mut at = start.id.clone();
        for _ in 0..g.nodes.len() + 1 {
            let Some(next) = g.edges.iter().find(|e| e.source == at) else { break };
            at = next.target.clone();
            let node = g.nodes.iter().find(|n| n.id == at).expect("edge points at a real node");
            if node.node_type == "testCase" {
                seen.push(at.clone());
            }
        }
        seen
    }

    fn resolve(root: &Flow, subs: Vec<Flow>) -> Inlined {
        let loaded: HashMap<String, Flow> = subs.into_iter().map(|f| (f.id.clone(), f)).collect();
        inline_groups(root, &loaded, &InlineLimits::default())
    }

    #[test]
    fn a_sub_flows_steps_run_in_the_parents_order() {
        // The whole point: a step that names another flow becomes that flow's steps, in place.
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), step("send"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "send"), edge("send", "e")],
        );
        let out = resolve(&root, vec![onboarding()]);

        assert!(out.problems.is_empty(), "{:?}", out.problems);
        let ran: Vec<String> = walk(&out)
            .iter()
            .map(|id| id.rsplit(SEP).next().unwrap().to_string())
            .collect();
        assert_eq!(ran, vec!["signup", "login", "send"]);
    }

    #[test]
    fn root_node_ids_are_never_renamed() {
        // They key `nodeRuns[flowId][nodeId]`, the canvas decoration, the paused event and
        // stored run_results rows. Renaming one would silently detach a node from its own result.
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), step("send"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "send"), edge("send", "e")],
        );
        let out = resolve(&root, vec![onboarding()]);

        for id in ["s", "send", "e"] {
            assert!(ids(&out).contains(&id.to_string()), "{} was renamed: {:?}", id, ids(&out));
        }
        // And the group node itself is gone — its steps are the flow now.
        assert!(!ids(&out).contains(&"g".to_string()));
    }

    #[test]
    fn two_nodes_referencing_one_flow_get_disjoint_ids_and_both_run() {
        // Safe by construction: the prefix carries the group node's id, unique in the parent.
        let root = flow(
            "root",
            vec![
                node("s", "start", Value::Null),
                group("g1", "sub"),
                group("g2", "sub"),
                node("e", "end", Value::Null),
            ],
            vec![edge("s", "g1"), edge("g1", "g2"), edge("g2", "e")],
        );
        let out = resolve(&root, vec![onboarding()]);

        assert!(out.problems.is_empty(), "{:?}", out.problems);
        let ran = walk(&out);
        assert_eq!(ran.len(), 4, "both invocations run: {:?}", ran);
        assert_eq!(ran.iter().collect::<HashSet<_>>().len(), 4, "and their ids are distinct");
        assert!(ran[0].starts_with("g1"), "{:?}", ran);
        assert!(ran[2].starts_with("g2"), "{:?}", ran);
    }

    #[test]
    fn a_diamond_splices_the_shared_flow_twice() {
        // A runs B and C; both run D. Legal — a *visited set* would wrongly skip the second D,
        // which is why the cycle guard is a path stack instead.
        let d = flow(
            "d",
            vec![node("s", "start", Value::Null), step("leaf"), node("e", "end", Value::Null)],
            vec![edge("s", "leaf"), edge("leaf", "e")],
        );
        let mid = |id: &str| {
            flow(
                id,
                vec![node("s", "start", Value::Null), group("gd", "d"), node("e", "end", Value::Null)],
                vec![edge("s", "gd"), edge("gd", "e")],
            )
        };
        let root = flow(
            "root",
            vec![
                node("s", "start", Value::Null),
                group("gb", "b"),
                group("gc", "c"),
                node("e", "end", Value::Null),
            ],
            vec![edge("s", "gb"), edge("gb", "gc"), edge("gc", "e")],
        );
        let out = resolve(&root, vec![mid("b"), mid("c"), d]);

        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(walk(&out).len(), 2, "the leaf runs once per path");
    }

    #[test]
    fn a_cycle_is_refused_even_though_validation_would_not_have_seen_it() {
        // The validator checks on save of *one* flow, so editing the sub-flow to point back at
        // its parent never re-validates the parent. The cycle reaches the runner; the splice is
        // the only thing standing in front of it.
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        let mut sub = onboarding();
        sub.graph_data.nodes.push(group("back", "root"));
        sub.graph_data.edges.push(edge("login", "back"));

        let out = resolve(&root, vec![sub]);
        assert!(
            matches!(out.problems.first(), Some(InlineProblem::Cycle { .. })),
            "{:?}",
            out.problems
        );
        assert!(out.problems[0].message().contains("loop"), "{}", out.problems[0].message());
    }

    #[test]
    fn a_flow_that_runs_itself_is_refused() {
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "root"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        let out = resolve(&root, vec![]);
        assert!(matches!(out.problems.first(), Some(InlineProblem::Cycle { .. })), "{:?}", out.problems);
    }

    #[test]
    fn a_sub_flow_with_no_edge_to_its_end_node_still_continues() {
        // A real shape in the author's project: a flow whose last step has no edge to `end`.
        // The end node becomes an inert orphan, and the parent continues from it — which is
        // nothing, so the parent's next step is unreachable. Refusing would be wrong; this is
        // the sub-flow's own shape.
        let mut sub = onboarding();
        sub.graph_data.edges.retain(|e| e.target != "e");
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), step("send"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "send"), edge("send", "e")],
        );
        let out = resolve(&root, vec![sub]);

        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(walk(&out), vec![format!("g{}signup", SEP), format!("g{}login", SEP)]);
    }

    #[test]
    fn a_sub_flow_with_two_exits_continues_from_both() {
        let mut sub = onboarding();
        sub.graph_data.nodes.push(node("e2", "end", Value::Null));
        sub.graph_data.edges.push(edge("signup", "e2"));
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), step("send"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "send"), edge("send", "e")],
        );
        let out = resolve(&root, vec![sub]);

        let into_send: Vec<&GraphEdge> =
            out.flow.graph_data.edges.iter().filter(|e| e.target == "send").collect();
        assert_eq!(into_send.len(), 2, "one per exit: {:?}", into_send);
        let sources: HashSet<&str> = into_send.iter().map(|e| e.source.as_str()).collect();
        assert!(sources.contains(format!("g{}e", SEP).as_str()));
        assert!(sources.contains(format!("g{}e2", SEP).as_str()));
    }

    #[test]
    fn edge_types_survive_the_splice_on_both_sides() {
        // A `failure` edge into a sub-flow must still route there on failure, and the edges an
        // inner step draws among its own siblings must keep their type too.
        let mut sub = onboarding();
        sub.graph_data.edges.push(typed_edge("signup", "login", Some("failure")));
        let root = flow(
            "root",
            vec![
                node("s", "start", Value::Null),
                step("first"),
                group("g", "sub"),
                node("e", "end", Value::Null),
            ],
            vec![edge("s", "first"), typed_edge("first", "g", Some("failure")), edge("g", "e")],
        );
        let out = resolve(&root, vec![sub]);

        let into_entry = out
            .flow
            .graph_data
            .edges
            .iter()
            .find(|e| e.source == "first")
            .expect("the edge into the sub-flow survives");
        assert_eq!(into_entry.edge_type.as_deref(), Some("failure"));
        assert_eq!(into_entry.target, format!("g{}s", SEP), "it leads to the sub-flow's entry");

        let inner = out
            .flow
            .graph_data
            .edges
            .iter()
            .find(|e| e.source == format!("g{}signup", SEP) && e.edge_type.as_deref() == Some("failure"));
        assert!(inner.is_some(), "an inner failure edge survives");
    }

    #[test]
    fn a_sub_flows_boundary_nodes_become_inert_pass_throughs() {
        // Not a second start/end in the flat graph — the engine finds exactly one start, and
        // `total_nodes` counts neither of these.
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        let out = resolve(&root, vec![onboarding()]);

        let starts = out.flow.graph_data.nodes.iter().filter(|n| n.node_type == "start").count();
        assert_eq!(starts, 1, "only the root's start");
        assert_eq!(
            out.flow.graph_data.nodes.iter().filter(|n| n.node_type == ENTRY_TYPE).count(),
            1
        );
        assert_eq!(out.flow.graph_data.nodes.iter().filter(|n| n.node_type == EXIT_TYPE).count(), 1);
    }

    #[test]
    fn a_sub_flow_node_marked_teardown_marks_every_step_it_inlines() {
        // Otherwise the marking is silently lost in the splice. It is also a trap today:
        // traversal hops over a marked node of any type, but the teardown loop only runs
        // testCase nodes, so a group node marked teardown never runs at all.
        let mut g = group("g", "sub");
        g.data = serde_json::json!({ "flowId": "sub", "config": { "teardown": true } });
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), step("main"), g, node("e", "end", Value::Null)],
            vec![edge("s", "main"), edge("main", "g"), edge("g", "e")],
        );
        let out = resolve(&root, vec![onboarding()]);

        for id in [format!("g{}signup", SEP), format!("g{}login", SEP)] {
            let n = out.flow.graph_data.nodes.iter().find(|n| n.id == id).expect("inlined");
            assert!(is_teardown(n), "{} should be cleanup", id);
        }
        let main = out.flow.graph_data.nodes.iter().find(|n| n.id == "main").unwrap();
        assert!(!is_teardown(main), "the parent's own step is untouched");
    }

    #[test]
    fn a_sub_flows_own_flow_vars_lose_to_the_parents() {
        let mut root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        root.graph_data.variables.insert("shared".into(), Value::String("parent".into()));
        let mut sub = onboarding();
        sub.graph_data.variables.insert("shared".into(), Value::String("sub".into()));
        sub.graph_data.variables.insert("only_sub".into(), Value::String("kept".into()));

        let out = resolve(&root, vec![sub]);
        assert_eq!(out.flow.graph_data.variables["shared"], Value::String("parent".into()));
        assert_eq!(out.flow.graph_data.variables["only_sub"], Value::String("kept".into()));
        assert!(
            matches!(out.notes.first(), Some(InlineNote::FlowVarShadowed { name, .. }) if name == "shared"),
            "{:?}",
            out.notes
        );
    }

    #[test]
    fn a_missing_or_unchosen_flow_is_named_by_its_step() {
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "gone"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        let out = resolve(&root, vec![]);
        assert!(matches!(out.problems.first(), Some(InlineProblem::MissingFlow { .. })));
        assert_eq!(out.problems[0].group_node_id(), Some("g"), "points at a node on the canvas");

        let bare = flow(
            "root",
            vec![node("s", "start", Value::Null), node("g", "group", serde_json::json!({})), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        let out = resolve(&bare, vec![]);
        assert!(matches!(out.problems.first(), Some(InlineProblem::NoFlowRef { .. })));
    }

    #[test]
    fn a_sub_flow_from_another_project_is_refused() {
        // The base URL comes from the root's project, so this would run against the wrong host.
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        let mut sub = onboarding();
        sub.project_id = "somebody-else".to_string();
        let out = resolve(&root, vec![sub]);
        assert!(matches!(out.problems.first(), Some(InlineProblem::ForeignProject { .. })), "{:?}", out.problems);
    }

    #[test]
    fn depth_and_node_budget_are_refused_by_name() {
        let chain = |id: &str, next: &str| {
            flow(
                id,
                vec![node("s", "start", Value::Null), group("g", next), node("e", "end", Value::Null)],
                vec![edge("s", "g"), edge("g", "e")],
            )
        };
        let root = chain("root", "a");
        let loaded: HashMap<String, Flow> = [chain("a", "b"), chain("b", "c"), onboarding()]
            .into_iter()
            .map(|f| (f.id.clone(), f))
            .collect();

        let shallow = inline_groups(&root, &loaded, &InlineLimits { max_depth: 2, max_nodes: 500 });
        assert!(matches!(shallow.problems.first(), Some(InlineProblem::TooDeep { .. })), "{:?}", shallow.problems);

        let tight = inline_groups(&root, &loaded, &InlineLimits { max_depth: 9, max_nodes: 4 });
        assert!(matches!(tight.problems.first(), Some(InlineProblem::TooLarge { .. })), "{:?}", tight.problems);
    }

    #[test]
    fn a_flow_with_no_sub_flows_is_returned_untouched() {
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), step("only"), node("e", "end", Value::Null)],
            vec![edge("s", "only"), edge("only", "e")],
        );
        assert!(!has_groups(&root));
        let out = resolve(&root, vec![]);
        assert_eq!(ids(&out), vec!["s", "only", "e"]);
        assert!(out.origins.is_empty());
    }

    #[test]
    fn the_client_is_told_which_steps_each_sub_flow_node_became() {
        // So the canvas can roll their verdicts back onto the node the author can see, and the
        // console can name the sub-flow — without ever splitting a synthetic id.
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        let out = resolve(&root, vec![onboarding()]);
        let groups = out.groups();

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].group_node_id, "g");
        assert_eq!(groups[0].flow_name, "Onboarding");
        // Only the steps that report. The boundary nodes a sub-flow is spliced through emit
        // nothing at all, and counting them made the canvas say "2 of 5 steps" about a sub-flow
        // with two — found by running one, not by reading this.
        assert_eq!(
            groups[0].node_ids,
            vec![format!("g{}signup", SEP), format!("g{}login", SEP)],
        );
    }

    #[test]
    fn every_inlined_step_carries_the_flow_it_came_from() {
        // The stored half of provenance: a run reopened from history has no Started event.
        let root = flow(
            "root",
            vec![node("s", "start", Value::Null), group("g", "sub"), node("e", "end", Value::Null)],
            vec![edge("s", "g"), edge("g", "e")],
        );
        let out = resolve(&root, vec![onboarding()]);
        let signup = out
            .flow
            .graph_data
            .nodes
            .iter()
            .find(|n| n.id == format!("g{}signup", SEP))
            .unwrap();
        assert_eq!(signup.data["sourceFlow"], Value::String("Onboarding".into()));
        assert_eq!(signup.data["sourceNodeId"], Value::String("signup".into()));
        // And the node's own data is intact.
        assert_eq!(signup.data["testCaseId"], Value::String("signup".into()));
    }
}
