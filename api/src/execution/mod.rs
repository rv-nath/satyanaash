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

pub use variables::ExecutionContext;
pub use assertions::AssertionEngine;
pub use http::HttpExecutor;
pub use engine::{ExecutionEngine, NodeResult, ExecutionEvent, FlowExecutionResult, ExecutionStats, NodeStatus};
