//! Graph validation module
//!
//! Validates flow graphs for structural correctness before execution.

mod graph;

pub use graph::{GraphValidator, ValidationResult};
