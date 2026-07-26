//! Execution engine module
//!
//! Responsible for executing test flows:
//! - Graph traversal
//! - HTTP request execution
//! - Variable interpolation
//! - Assertion evaluation

mod variables;
mod assertions;
mod http;
mod engine;
mod pre_test_script;
mod generators;
mod script_log;

pub use variables::ExecutionContext;
pub use assertions::AssertionEngine;
pub use http::HttpExecutor;
pub use pre_test_script::PreTestScriptEngine;
pub use engine::{ExecutionEngine, NodeResult, ExecutionEvent, FlowExecutionResult};
