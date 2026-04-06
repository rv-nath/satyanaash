//! Rhai-based pre-test script engine
//!
//! Executes scripts before HTTP requests. Scripts can set variables
//! via `SAT.vars.variableName = "value"` which are then available
//! for {{variableName}} interpolation in URLs, headers, and payloads.

use rhai::{Engine, Scope, Dynamic, Map};
use std::collections::HashMap;
use serde_json::Value;

use crate::error::AppError;

/// Pre-test script engine using Rhai for variable setup
pub struct PreTestScriptEngine {
    engine: Engine,
}

impl PreTestScriptEngine {
    /// Create a new pre-test script engine with sandbox limits
    pub fn new() -> Self {
        let mut engine = Engine::new();

        // Sandbox limits matching AssertionEngine
        engine.set_max_expr_depths(64, 64);
        engine.set_max_call_levels(32);
        engine.set_max_operations(10_000);
        engine.set_max_string_size(1_000_000);
        engine.set_max_array_size(10_000);
        engine.set_max_map_size(10_000);

        Self { engine }
    }

    /// Execute a pre-test script and return variables set via SAT.vars or vars
    ///
    /// Rhai doesn't support nested map mutation (SAT.vars.x = "v" modifies a copy),
    /// so we expose `vars` as a top-level mutable map and rewrite `SAT.vars.` references.
    pub fn execute(&self, script: &str) -> Result<HashMap<String, Value>, AppError> {
        let mut scope = Scope::new();

        // Expose `vars` as a top-level mutable map (single-level access works in Rhai)
        scope.push("vars", Map::new());

        // Rewrite SAT.vars.xxx → vars.xxx for compatibility with the GUI syntax
        let rewritten = script.replace("SAT.vars.", "vars.");

        // Run the script (we only care about side effects on `vars`)
        self.engine.run_with_scope(&mut scope, &rewritten)
            .map_err(|e| AppError::Internal(format!("Pre-test script error: {}", e)))?;

        // Extract vars that were set during script execution
        let vars: Map = scope.get_value("vars")
            .unwrap_or_default();

        // Convert Rhai Map to HashMap<String, Value>
        let mut result = HashMap::new();
        for (k, v) in vars {
            result.insert(k.to_string(), rhai_to_json(&v));
        }
        Ok(result)
    }
}

impl Default for PreTestScriptEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert a Rhai Dynamic value to serde_json::Value
fn rhai_to_json(dynamic: &Dynamic) -> Value {
    if dynamic.is_unit() {
        Value::Null
    } else if let Some(s) = dynamic.clone().try_cast::<rhai::ImmutableString>() {
        Value::String(s.to_string())
    } else if let Some(i) = dynamic.clone().try_cast::<i64>() {
        Value::Number(i.into())
    } else if let Some(f) = dynamic.clone().try_cast::<f64>() {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    } else if let Some(b) = dynamic.clone().try_cast::<bool>() {
        Value::Bool(b)
    } else if let Some(arr) = dynamic.clone().try_cast::<rhai::Array>() {
        Value::Array(arr.iter().map(rhai_to_json).collect())
    } else if let Some(map) = dynamic.clone().try_cast::<Map>() {
        let obj: serde_json::Map<String, Value> = map.iter()
            .map(|(k, v)| (k.to_string(), rhai_to_json(v)))
            .collect();
        Value::Object(obj)
    } else {
        Value::String(dynamic.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_var_assignment() {
        let engine = PreTestScriptEngine::new();
        let vars = engine.execute(r#"SAT.vars.baseUrl = "http://localhost:3000";"#).unwrap();
        assert_eq!(vars.get("baseUrl"), Some(&Value::String("http://localhost:3000".to_string())));
    }

    #[test]
    fn test_multiple_vars() {
        let engine = PreTestScriptEngine::new();
        let vars = engine.execute(r#"
            SAT.vars.baseUrl = "http://localhost:3000";
            SAT.vars.apiKey = "secret123";
            SAT.vars.timeout = 5000;
        "#).unwrap();
        assert_eq!(vars.get("baseUrl"), Some(&Value::String("http://localhost:3000".to_string())));
        assert_eq!(vars.get("apiKey"), Some(&Value::String("secret123".to_string())));
        assert_eq!(vars.get("timeout"), Some(&Value::Number(5000.into())));
    }

    #[test]
    fn test_computed_var() {
        let engine = PreTestScriptEngine::new();
        let vars = engine.execute(r#"
            let base = "http://localhost";
            let port = 8080;
            SAT.vars.url = base + ":" + port.to_string();
        "#).unwrap();
        assert_eq!(vars.get("url"), Some(&Value::String("http://localhost:8080".to_string())));
    }

    #[test]
    fn test_empty_script() {
        let engine = PreTestScriptEngine::new();
        let vars = engine.execute("").unwrap();
        assert!(vars.is_empty());
    }

    #[test]
    fn test_direct_vars_syntax() {
        let engine = PreTestScriptEngine::new();
        let vars = engine.execute(r#"vars.baseUrl = "http://localhost:3000";"#).unwrap();
        assert_eq!(vars.get("baseUrl"), Some(&Value::String("http://localhost:3000".to_string())));
    }

    #[test]
    fn test_script_error() {
        let engine = PreTestScriptEngine::new();
        let result = engine.execute("this is not valid rhai");
        assert!(result.is_err());
    }
}
