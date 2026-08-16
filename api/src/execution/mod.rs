//! Execution engine module
//!
//! Responsible for executing test flows:
//! - Graph traversal
//! - HTTP request execution
//! - Variable interpolation
//! - Assertion evaluation

mod variables;
mod assertions;
mod body;
mod http;
mod engine;
mod inline;
mod history;
mod pre_test_script;
mod suite;
mod generators;
mod script_log;

pub use variables::{ExecutionContext, VarSource};
pub use assertions::AssertionEngine;
// Named in `HttpExecutor::execute`'s signature and in a test case's stored body, so they
// belong in this list for the same reason `ResponseLog` does.
#[allow(unused_imports)]
pub use body::{BodyType, FormField};
// `ResponseLog` and `ResolvedMember` are the types of a public field and a public
// return value, so they belong in this list even though nothing outside names them yet
// — hiding a type that appears in a signature is worse than an unused-import warning.
#[allow(unused_imports)]
pub use http::{HttpExecutor, RequestLog, ResponseLog};
pub use history::{record_single, MemberRef};
// The splice that turns a graph containing sub-flow nodes into one flat graph the engine can
// run. `InlinedGroup` is a field of the Started event, so it belongs in this list.
#[allow(unused_imports)]
pub use inline::{resolve_for_run, InlineLimits, InlinedGroup};
#[allow(unused_imports)]
pub use suite::{resolve_members, ResolvedMember, SuiteRun};
pub use pre_test_script::PreTestScriptEngine;
pub use engine::{
    ExecutionEngine, ExecutionEvent, ExecutionStats, FlowExecutionResult, NodeResult, NodeStatus,
    StepCommand, POLL_INTERVAL_MS, POLL_TIMEOUT_MS,
};
