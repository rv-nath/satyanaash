//! Rhai-based assertion engine for evaluating test assertions
//!
//! The `response` object is exposed to scripts with:
//! - response.status (HTTP status code)
//! - response.body (raw response body string)
//! - response.json (parsed JSON as dynamic map)
//! - response.headers (response headers map)

use rhai::{Engine, Scope, Dynamic, Map, Array};
use serde_json::Value;

use crate::error::AppError;

/// Assertion engine using Rhai for script evaluation
pub struct AssertionEngine {
    engine: Engine,
}

impl AssertionEngine {
    /// Create a new assertion engine
    pub fn new() -> Self {
        let mut engine = Engine::new();

        // Disable potentially dangerous features for sandboxing
        engine.set_max_expr_depths(64, 64);
        engine.set_max_call_levels(32);
        engine.set_max_operations(10_000);
        engine.set_max_string_size(1_000_000);
        engine.set_max_array_size(10_000);
        engine.set_max_map_size(10_000);

        Self { engine }
    }

    /// Evaluate an assertion script
    /// Returns Ok(true) if passed, Ok(false) if failed
    /// Returns Err if script has syntax/runtime errors
    pub fn evaluate(
        &self,
        script: &str,
        status: u16,
        body: &str,
        json: &Option<Value>,
        headers: &std::collections::HashMap<String, String>,
    ) -> Result<bool, AppError> {
        let mut scope = Scope::new();

        // Build response object
        let mut response = Map::new();
        response.insert("status".into(), Dynamic::from(status as i64));
        response.insert("body".into(), Dynamic::from(body.to_string()));

        if let Some(json_val) = json {
            response.insert("json".into(), json_to_rhai(json_val));
        } else {
            response.insert("json".into(), Dynamic::UNIT);
        }

        // Convert headers to Rhai map
        let mut headers_map = Map::new();
        for (k, v) in headers {
            headers_map.insert(k.clone().into(), Dynamic::from(v.clone()));
        }
        response.insert("headers".into(), Dynamic::from(headers_map));

        scope.push("response", response);

        // Evaluate the script
        match self.engine.eval_with_scope::<bool>(&mut scope, script) {
            Ok(result) => Ok(result),
            Err(e) => Err(AppError::AssertionError(format!("Assertion script error: {}", e))),
        }
    }

    /// Default assertion: pass if status is 2xx
    pub fn default_assertion(status: u16) -> bool {
        (200..300).contains(&status)
    }
}

impl Default for AssertionEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert JSON Value to Rhai Dynamic type
fn json_to_rhai(value: &Value) -> Dynamic {
    match value {
        Value::Null => Dynamic::UNIT,
        Value::Bool(b) => Dynamic::from(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Dynamic::from(i)
            } else if let Some(f) = n.as_f64() {
                Dynamic::from(f)
            } else {
                Dynamic::UNIT
            }
        }
        Value::String(s) => Dynamic::from(s.clone()),
        Value::Array(arr) => {
            let rhai_arr: Array = arr.iter().map(json_to_rhai).collect();
            Dynamic::from(rhai_arr)
        }
        Value::Object(obj) => {
            let mut map = Map::new();
            for (k, v) in obj {
                map.insert(k.clone().into(), json_to_rhai(v));
            }
            Dynamic::from(map)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_json(s: &str) -> Option<Value> {
        serde_json::from_str(s).ok()
    }

    #[test]
    fn test_simple_status_check() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();

        let result = engine.evaluate(
            "response.status == 200",
            200,
            "",
            &None,
            &headers
        ).unwrap();
        assert!(result);

        let result = engine.evaluate(
            "response.status == 200",
            404,
            "",
            &None,
            &headers
        ).unwrap();
        assert!(!result);
    }

    #[test]
    fn test_json_field_check() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"success": true, "data": {"id": 42}}"#);

        let result = engine.evaluate(
            "response.json.success == true",
            200,
            "",
            &json,
            &headers
        ).unwrap();
        assert!(result);

        let result = engine.evaluate(
            "response.json.data.id == 42",
            200,
            "",
            &json,
            &headers
        ).unwrap();
        assert!(result);
    }

    #[test]
    fn test_array_check() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"items": [1, 2, 3]}"#);

        let result = engine.evaluate(
            "response.json.items.len() == 3",
            200,
            "",
            &json,
            &headers
        ).unwrap();
        assert!(result);
    }

    #[test]
    fn test_string_contains() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"message": "User created successfully"}"#);

        let result = engine.evaluate(
            r#"response.json.message.contains("created")"#,
            201,
            "",
            &json,
            &headers
        ).unwrap();
        assert!(result);
    }

    #[test]
    fn test_complex_assertion() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"user": {"email": "test@example.com", "id": 123}}"#);

        let result = engine.evaluate(
            r#"response.status == 200 && response.json.user.email.contains("@") && response.json.user.id > 0"#,
            200,
            "",
            &json,
            &headers
        ).unwrap();
        assert!(result);
    }

    #[test]
    fn test_default_assertion() {
        assert!(AssertionEngine::default_assertion(200));
        assert!(AssertionEngine::default_assertion(201));
        assert!(AssertionEngine::default_assertion(299));
        assert!(!AssertionEngine::default_assertion(400));
        assert!(!AssertionEngine::default_assertion(500));
    }
}
